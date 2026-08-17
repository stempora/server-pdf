'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

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

class MetricsQueryError extends Error {
  constructor(message = 'Metrics temporarily unavailable') {
    super(message);
    this.name = 'MetricsQueryError';
    this.status = 503;
  }
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
    this.worker = null;
    this.requests = new Map();
    this.nextRequestId = 1;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 1000;
    this.workerTimeoutMs = options.workerTimeoutMs ?? 6000;
    this.flushPromise = null;
    this.timer = null;
  }

  async initialize() {
    if (!this.enabled) return;
    try {
      this.startWorker();
      const initialized = await this.request('init', {}, this.queryTimeoutMs);
      this.schemaVersion = initialized.schemaVersion;
      this.lastError = null;
    } catch (error) {
      this.lastError = 'Metrics storage unavailable';
      console.error(`[METRICS] Initialization failed: ${error.message}`);
    }
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  startWorker() {
    if (this.worker) return;
    const worker = new Worker(path.join(__dirname, 'metrics-worker.js'), { workerData: { file: this.file } });
    this.worker = worker;
    worker.on('message', message => {
      const pending = this.requests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.requests.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Metrics worker operation failed'));
    });
    worker.on('error', error => this.workerFailed(worker, error));
    worker.on('exit', code => {
      if (this.worker === worker && code !== 0) this.workerFailed(worker, new Error(`Metrics worker exited with code ${code}`));
    });
  }

  workerFailed(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.lastError = 'Metrics worker unavailable';
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.requests.clear();
    console.error(`[METRICS] Worker failed: ${error.message}`);
  }

  request(type, payload = {}, timeoutMs = this.workerTimeoutMs) {
    if (!this.worker) return Promise.reject(new Error('Metrics worker unavailable'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('Metrics worker operation timed out'));
      }, timeoutMs);
      timer.unref?.();
      this.requests.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
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

  flush() {
    if (!this.enabled || this.pending.length === 0) return Promise.resolve();
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushBatch().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  async flushBatch() {
    const batch = this.pending.splice(0, this.pending.length);
    try {
      if (!this.worker) this.startWorker();
      const result = await this.request('flush', { events: batch });
      this.lastFlushAt = result.lastFlushAt;
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
    if (!this.enabled || fingerprints.length === 0) return new Map();
    void this.flush();
    try { return new Map(await this.request('fingerprints', { fingerprints }, this.queryTimeoutMs)); }
    catch (_error) { throw new MetricsQueryError(); }
  }

  async summary(limit = 100, offset = 0) {
    if (!this.enabled) return [];
    void this.flush();
    try { return await this.request('summary', { limit, offset }, this.queryTimeoutMs); }
    catch (_error) { throw new MetricsQueryError(); }
  }

  async daily(from, to, fingerprint) {
    if (!this.enabled) return [];
    void this.flush();
    try { return await this.request('daily', { from, to, fingerprint }, this.queryTimeoutMs); }
    catch (_error) { throw new MetricsQueryError(); }
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
    const worker = this.worker;
    if (!worker) return;
    try { await Promise.race([this.request('shutdown', {}, timeoutMs), new Promise(resolve => setTimeout(resolve, timeoutMs))]); }
    catch (_error) {}
    if (this.worker === worker) this.worker = null;
    await worker.terminate().catch(() => {});
  }
}

module.exports = {
  MetricsStore, SCHEMA_VERSION, fingerprintApiKey, initializeMetricsDatabase,
  validateSchema, metricResponse, emptyMetric, COUNTERS, addEvent, MetricsQueryError
};
