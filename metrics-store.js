'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const COUNTERS = [
  'request_count', 'started_count', 'success_count', 'error_count',
  'timeout_count', 'queue_rejected_count', 'client_aborted_count',
  'validation_error_count'
];
const EVENT_COUNTER = {
  request: 'request_count', started: 'started_count', success: 'success_count',
  error: 'error_count', timeout: 'timeout_count', queue_rejected: 'queue_rejected_count',
  client_aborted: 'client_aborted_count', validation_error: 'validation_error_count'
};

function fingerprintApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function configureDatabase(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
}

function schemaObjects(db) {
  return new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"
  ).all().map(row => row.name));
}

function validateSchema(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported metrics schema version ${version}`);
  }
  const objects = schemaObjects(db);
  for (const name of [
    'api_key_metrics', 'api_key_daily_metrics',
    'idx_api_key_daily_metric_date', 'idx_api_key_metrics_last_used_at',
    'idx_api_key_metrics_deleted_at'
  ]) {
    if (!objects.has(name)) throw new Error(`Metrics schema object missing: ${name}`);
  }
  return version;
}

function migrateDatabase(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (current > SCHEMA_VERSION) {
    throw new Error(`Metrics schema ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (current === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE api_key_metrics (
        key_fingerprint TEXT PRIMARY KEY,
        key_name TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        started_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        timeout_count INTEGER NOT NULL DEFAULT 0,
        queue_rejected_count INTEGER NOT NULL DEFAULT 0,
        client_aborted_count INTEGER NOT NULL DEFAULT 0,
        validation_error_count INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        min_duration_ms INTEGER,
        max_duration_ms INTEGER,
        last_used_at TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE api_key_daily_metrics (
        key_fingerprint TEXT NOT NULL,
        metric_date TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        started_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        timeout_count INTEGER NOT NULL DEFAULT 0,
        queue_rejected_count INTEGER NOT NULL DEFAULT 0,
        client_aborted_count INTEGER NOT NULL DEFAULT 0,
        validation_error_count INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        min_duration_ms INTEGER,
        max_duration_ms INTEGER,
        last_used_at TEXT,
        PRIMARY KEY (key_fingerprint, metric_date)
      );
      CREATE INDEX idx_api_key_daily_metric_date ON api_key_daily_metrics(metric_date);
      CREATE INDEX idx_api_key_metrics_last_used_at ON api_key_metrics(last_used_at);
      CREATE INDEX idx_api_key_metrics_deleted_at ON api_key_metrics(deleted_at);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  return validateSchema(db);
}

async function initializeMetricsDatabase(file, options = {}) {
  const directory = path.dirname(file);
  const existedBeforeOpen = fs.existsSync(file);
  if (!options.checkOnly) fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  if (options.checkOnly && !fs.existsSync(file)) throw new Error('Metrics database does not exist');
  const db = options.checkOnly
    ? new DatabaseSync(file, { readOnly: true })
    : new DatabaseSync(file);
  try {
    if (options.checkOnly) {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    } else {
      configureDatabase(db);
    }
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (options.backupFile && existedBeforeOpen && current < SCHEMA_VERSION) {
      fs.mkdirSync(path.dirname(options.backupFile), { recursive: true });
      await backup(db, options.backupFile);
      fs.chmodSync(options.backupFile, 0o600);
    }
    const schemaVersion = options.checkOnly ? validateSchema(db) : migrateDatabase(db);
    if (!options.checkOnly) fs.chmodSync(file, 0o600);
    return { db, schemaVersion };
  } catch (error) {
    db.close();
    throw error;
  }
}

function emptyMetric() {
  return Object.fromEntries([
    ...COUNTERS.map(name => [name, 0]),
    ['total_duration_ms', 0], ['min_duration_ms', null], ['max_duration_ms', null],
    ['average_duration_ms', null], ['last_used_at', null],
    ['last_success_at', null], ['last_error_at', null]
  ]);
}

function addEvent(aggregate, event) {
  const counter = EVENT_COUNTER[event.type];
  if (counter) aggregate[counter] += 1;
  if (event.type === 'request') aggregate.last_used_at = event.at;
  if (event.type === 'success') aggregate.last_success_at = event.at;
  if (event.type === 'error' || event.type === 'timeout') aggregate.last_error_at = event.at;
  if (Number.isFinite(event.durationMs)) {
    const duration = Math.max(0, Math.round(event.durationMs));
    aggregate.total_duration_ms += duration;
    aggregate.min_duration_ms = aggregate.min_duration_ms === null
      ? duration : Math.min(aggregate.min_duration_ms, duration);
    aggregate.max_duration_ms = aggregate.max_duration_ms === null
      ? duration : Math.max(aggregate.max_duration_ms, duration);
  }
  if (event.type === 'deleted') {
    aggregate.deleted_at = event.at;
    aggregate.key_name = event.keyName ?? aggregate.key_name;
  }
}

function metricResponse(row = {}) {
  const result = { ...emptyMetric(), ...row };
  result.average_duration_ms = result.success_count + result.error_count + result.timeout_count > 0
    ? Math.round(result.total_duration_ms /
      (result.success_count + result.error_count + result.timeout_count))
    : null;
  return result;
}

class MetricsStore {
  constructor(options) {
    this.file = options.file;
    this.enabled = options.enabled;
    this.flushIntervalMs = options.flushIntervalMs;
    this.flushMaxEvents = options.flushMaxEvents;
    this.maxPendingEvents = options.maxPendingEvents;
    this.pending = [];
    this.droppedEvents = 0;
    this.lastFlushAt = null;
    this.lastError = null;
    this.schemaVersion = null;
    this.db = null;
    this.flushPromise = null;
    this.timer = null;
  }

  async initialize() {
    if (!this.enabled) return;
    try {
      const initialized = await initializeMetricsDatabase(this.file);
      this.db = initialized.db;
      this.schemaVersion = initialized.schemaVersion;
      this.lastError = null;
    } catch (error) {
      this.lastError = 'Metrics storage unavailable';
      console.error(`[METRICS] Initialization failed: ${error.message}`);
    }
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  record(apiKey, keyName, type, durationMs) {
    if (!this.enabled || typeof apiKey !== 'string') return;
    this.pending.push({
      fingerprint: fingerprintApiKey(apiKey), keyName: keyName ?? null,
      type, durationMs, at: new Date().toISOString()
    });
    while (this.pending.length > this.maxPendingEvents) {
      this.pending.shift();
      this.droppedEvents += 1;
    }
    if (this.pending.length >= this.flushMaxEvents) void this.flush();
  }

  markDeleted(apiKey, keyName) {
    this.record(apiKey, keyName, 'deleted');
  }

  async ensureOpen() {
    if (this.db || !this.enabled) return;
    const initialized = await initializeMetricsDatabase(this.file);
    this.db = initialized.db;
    this.schemaVersion = initialized.schemaVersion;
  }

  flush() {
    if (!this.enabled || this.pending.length === 0) return Promise.resolve();
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushBatch().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  async flushBatch() {
    const batch = this.pending.splice(0, this.pending.length);
    try {
      await this.ensureOpen();
      const totals = new Map();
      const daily = new Map();
      for (const event of batch) {
        if (!totals.has(event.fingerprint)) {
          totals.set(event.fingerprint, { ...emptyMetric(), key_name: event.keyName, deleted_at: null });
        }
        addEvent(totals.get(event.fingerprint), event);
        if (event.type !== 'registered' && event.type !== 'deleted') {
          const dayKey = `${event.fingerprint}:${event.at.slice(0, 10)}`;
          if (!daily.has(dayKey)) daily.set(dayKey, { ...emptyMetric(), fingerprint: event.fingerprint, date: event.at.slice(0, 10) });
          addEvent(daily.get(dayKey), event);
        }
      }
      const totalStatement = this.db.prepare(`
        INSERT INTO api_key_metrics (
          key_fingerprint, key_name, request_count, started_count, success_count,
          error_count, timeout_count, queue_rejected_count, client_aborted_count,
          validation_error_count, total_duration_ms, min_duration_ms, max_duration_ms,
          last_used_at, last_success_at, last_error_at, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_fingerprint) DO UPDATE SET
          key_name=COALESCE(excluded.key_name, key_name),
          request_count=request_count+excluded.request_count,
          started_count=started_count+excluded.started_count,
          success_count=success_count+excluded.success_count,
          error_count=error_count+excluded.error_count,
          timeout_count=timeout_count+excluded.timeout_count,
          queue_rejected_count=queue_rejected_count+excluded.queue_rejected_count,
          client_aborted_count=client_aborted_count+excluded.client_aborted_count,
          validation_error_count=validation_error_count+excluded.validation_error_count,
          total_duration_ms=total_duration_ms+excluded.total_duration_ms,
          min_duration_ms=CASE WHEN excluded.min_duration_ms IS NULL THEN min_duration_ms WHEN min_duration_ms IS NULL THEN excluded.min_duration_ms ELSE MIN(min_duration_ms, excluded.min_duration_ms) END,
          max_duration_ms=CASE WHEN excluded.max_duration_ms IS NULL THEN max_duration_ms WHEN max_duration_ms IS NULL THEN excluded.max_duration_ms ELSE MAX(max_duration_ms, excluded.max_duration_ms) END,
          last_used_at=COALESCE(excluded.last_used_at, last_used_at),
          last_success_at=COALESCE(excluded.last_success_at, last_success_at),
          last_error_at=COALESCE(excluded.last_error_at, last_error_at),
          deleted_at=COALESCE(excluded.deleted_at, deleted_at), updated_at=excluded.updated_at
      `);
      const dailyStatement = this.db.prepare(`
        INSERT INTO api_key_daily_metrics (
          key_fingerprint, metric_date, request_count, started_count, success_count,
          error_count, timeout_count, queue_rejected_count, client_aborted_count,
          validation_error_count, total_duration_ms, min_duration_ms, max_duration_ms, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_fingerprint, metric_date) DO UPDATE SET
          request_count=request_count+excluded.request_count,
          started_count=started_count+excluded.started_count,
          success_count=success_count+excluded.success_count,
          error_count=error_count+excluded.error_count,
          timeout_count=timeout_count+excluded.timeout_count,
          queue_rejected_count=queue_rejected_count+excluded.queue_rejected_count,
          client_aborted_count=client_aborted_count+excluded.client_aborted_count,
          validation_error_count=validation_error_count+excluded.validation_error_count,
          total_duration_ms=total_duration_ms+excluded.total_duration_ms,
          min_duration_ms=CASE WHEN excluded.min_duration_ms IS NULL THEN min_duration_ms WHEN min_duration_ms IS NULL THEN excluded.min_duration_ms ELSE MIN(min_duration_ms, excluded.min_duration_ms) END,
          max_duration_ms=CASE WHEN excluded.max_duration_ms IS NULL THEN max_duration_ms WHEN max_duration_ms IS NULL THEN excluded.max_duration_ms ELSE MAX(max_duration_ms, excluded.max_duration_ms) END,
          last_used_at=COALESCE(excluded.last_used_at, last_used_at)
      `);
      const now = new Date().toISOString();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const [fingerprint, metric] of totals) {
          totalStatement.run(
            fingerprint, metric.key_name, ...COUNTERS.map(name => metric[name]),
            metric.total_duration_ms, metric.min_duration_ms, metric.max_duration_ms,
            metric.last_used_at, metric.last_success_at, metric.last_error_at,
            metric.deleted_at, now, now
          );
        }
        for (const metric of daily.values()) {
          dailyStatement.run(
            metric.fingerprint, metric.date, ...COUNTERS.map(name => metric[name]),
            metric.total_duration_ms, metric.min_duration_ms, metric.max_duration_ms,
            metric.last_used_at
          );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.lastFlushAt = now;
      this.lastError = null;
    } catch (error) {
      this.lastError = 'Metrics flush failed';
      console.error(`[METRICS] Flush failed: ${error.message}`);
      this.pending = [...batch, ...this.pending];
      while (this.pending.length > this.maxPendingEvents) {
        this.pending.shift();
        this.droppedEvents += 1;
      }
    }
  }

  async metricsForFingerprints(fingerprints) {
    if (!this.enabled || !this.db || fingerprints.length === 0) return new Map();
    await this.flush();
    const statement = this.db.prepare('SELECT * FROM api_key_metrics WHERE key_fingerprint = ?');
    return new Map(fingerprints.map(fingerprint => [fingerprint, metricResponse(statement.get(fingerprint))]));
  }

  async summary(limit = 100, offset = 0) {
    if (!this.enabled || !this.db) return [];
    await this.flush();
    return this.db.prepare(`
      SELECT * FROM api_key_metrics ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ? OFFSET ?
    `).all(limit, offset).map(metricResponse);
  }

  async daily(from, to, fingerprint) {
    if (!this.enabled || !this.db) return [];
    await this.flush();
    if (fingerprint) {
      return this.db.prepare(`
        SELECT * FROM api_key_daily_metrics
        WHERE metric_date BETWEEN ? AND ? AND key_fingerprint = ?
        ORDER BY metric_date DESC
      `).all(from, to, fingerprint).map(metricResponse);
    }
    return this.db.prepare(`
      SELECT * FROM api_key_daily_metrics WHERE metric_date BETWEEN ? AND ?
      ORDER BY metric_date DESC, key_fingerprint
    `).all(from, to).map(metricResponse);
  }

  health() {
    return {
      enabled: this.enabled,
      status: !this.enabled ? 'disabled' : this.lastError ? 'error' : 'ok',
      pendingEvents: this.pending.length,
      droppedEvents: this.droppedEvents,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
      schemaVersion: this.schemaVersion
    };
  }

  async shutdown(timeoutMs = 2000) {
    if (this.timer) clearInterval(this.timer);
    await Promise.race([
      this.flush().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
    if (this.db) {
      try { this.db.close(); } catch (_error) {}
      this.db = null;
    }
  }
}

module.exports = {
  MetricsStore, SCHEMA_VERSION, fingerprintApiKey, initializeMetricsDatabase,
  validateSchema, metricResponse, emptyMetric
};
