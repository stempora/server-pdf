'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const {
  initializeMetricsDatabase, emptyMetric, metricResponse,
  COUNTERS, addEvent
} = require('./metrics-store');

let db;

async function open() {
  if (!db) db = (await initializeMetricsDatabase(workerData.file)).db;
  return db;
}

async function flush(events) {
  const database = await open();
  const totals = new Map();
  const daily = new Map();
  for (const event of events) {
    if (!totals.has(event.fingerprint)) totals.set(event.fingerprint, { ...emptyMetric(), key_name: event.keyName, deleted_at: null });
    addEvent(totals.get(event.fingerprint), event);
    if (event.type !== 'registered' && event.type !== 'deleted') {
      const dayKey = `${event.fingerprint}:${event.at.slice(0, 10)}`;
      if (!daily.has(dayKey)) daily.set(dayKey, { ...emptyMetric(), fingerprint: event.fingerprint, date: event.at.slice(0, 10) });
      addEvent(daily.get(dayKey), event);
    }
  }
  const totalStatement = database.prepare(`
    INSERT INTO api_key_metrics (
      key_fingerprint, key_name, request_count, started_count, success_count,
      error_count, timeout_count, queue_rejected_count, client_aborted_count,
      validation_error_count, total_duration_ms, min_duration_ms, max_duration_ms,
      last_used_at, last_success_at, last_error_at, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key_fingerprint) DO UPDATE SET
      key_name=COALESCE(excluded.key_name, key_name), request_count=request_count+excluded.request_count,
      started_count=started_count+excluded.started_count, success_count=success_count+excluded.success_count,
      error_count=error_count+excluded.error_count, timeout_count=timeout_count+excluded.timeout_count,
      queue_rejected_count=queue_rejected_count+excluded.queue_rejected_count,
      client_aborted_count=client_aborted_count+excluded.client_aborted_count,
      validation_error_count=validation_error_count+excluded.validation_error_count,
      total_duration_ms=total_duration_ms+excluded.total_duration_ms,
      min_duration_ms=CASE WHEN excluded.min_duration_ms IS NULL THEN min_duration_ms WHEN min_duration_ms IS NULL THEN excluded.min_duration_ms ELSE MIN(min_duration_ms, excluded.min_duration_ms) END,
      max_duration_ms=CASE WHEN excluded.max_duration_ms IS NULL THEN max_duration_ms WHEN max_duration_ms IS NULL THEN excluded.max_duration_ms ELSE MAX(max_duration_ms, excluded.max_duration_ms) END,
      last_used_at=COALESCE(excluded.last_used_at, last_used_at), last_success_at=COALESCE(excluded.last_success_at, last_success_at),
      last_error_at=COALESCE(excluded.last_error_at, last_error_at), deleted_at=COALESCE(excluded.deleted_at, deleted_at), updated_at=excluded.updated_at
  `);
  const dailyStatement = database.prepare(`
    INSERT INTO api_key_daily_metrics (
      key_fingerprint, metric_date, request_count, started_count, success_count,
      error_count, timeout_count, queue_rejected_count, client_aborted_count,
      validation_error_count, total_duration_ms, min_duration_ms, max_duration_ms, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key_fingerprint, metric_date) DO UPDATE SET
      request_count=request_count+excluded.request_count, started_count=started_count+excluded.started_count,
      success_count=success_count+excluded.success_count, error_count=error_count+excluded.error_count,
      timeout_count=timeout_count+excluded.timeout_count, queue_rejected_count=queue_rejected_count+excluded.queue_rejected_count,
      client_aborted_count=client_aborted_count+excluded.client_aborted_count,
      validation_error_count=validation_error_count+excluded.validation_error_count,
      total_duration_ms=total_duration_ms+excluded.total_duration_ms,
      min_duration_ms=CASE WHEN excluded.min_duration_ms IS NULL THEN min_duration_ms WHEN min_duration_ms IS NULL THEN excluded.min_duration_ms ELSE MIN(min_duration_ms, excluded.min_duration_ms) END,
      max_duration_ms=CASE WHEN excluded.max_duration_ms IS NULL THEN max_duration_ms WHEN max_duration_ms IS NULL THEN excluded.max_duration_ms ELSE MAX(max_duration_ms, excluded.max_duration_ms) END,
      last_used_at=COALESCE(excluded.last_used_at, last_used_at)
  `);
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const [fingerprint, metric] of totals) totalStatement.run(
      fingerprint, metric.key_name, ...COUNTERS.map(name => metric[name]), metric.total_duration_ms,
      metric.min_duration_ms, metric.max_duration_ms, metric.last_used_at, metric.last_success_at,
      metric.last_error_at, metric.deleted_at, now, now
    );
    for (const metric of daily.values()) dailyStatement.run(
      metric.fingerprint, metric.date, ...COUNTERS.map(name => metric[name]), metric.total_duration_ms,
      metric.min_duration_ms, metric.max_duration_ms, metric.last_used_at
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { lastFlushAt: now };
}

async function handle(message) {
  const database = message.type === 'init' ? await open() : await open();
  if (message.type === 'init') return { schemaVersion: Number(database.prepare('PRAGMA user_version').get().user_version) };
  if (message.type === 'flush') return flush(message.events);
  if (message.type === 'fingerprints') {
    const statement = database.prepare('SELECT * FROM api_key_metrics WHERE key_fingerprint = ?');
    return message.fingerprints.map(fingerprint => [fingerprint, metricResponse(statement.get(fingerprint))]);
  }
  if (message.type === 'summary') return database.prepare(`SELECT * FROM api_key_metrics ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ? OFFSET ?`).all(message.limit, message.offset).map(metricResponse);
  if (message.type === 'daily') {
    const rows = message.fingerprint
      ? database.prepare(`SELECT * FROM api_key_daily_metrics WHERE metric_date BETWEEN ? AND ? AND key_fingerprint = ? ORDER BY metric_date DESC`).all(message.from, message.to, message.fingerprint)
      : database.prepare(`SELECT * FROM api_key_daily_metrics WHERE metric_date BETWEEN ? AND ? ORDER BY metric_date DESC, key_fingerprint`).all(message.from, message.to);
    return rows.map(metricResponse);
  }
  if (message.type === 'shutdown') { database.close(); db = null; return null; }
  throw new Error(`Unknown metrics worker operation: ${message.type}`);
}

let chain = Promise.resolve();
parentPort.on('message', message => {
  chain = chain.then(async () => {
    try { parentPort.postMessage({ id: message.id, ok: true, result: await handle(message) }); }
    catch (error) { parentPort.postMessage({ id: message.id, ok: false, error: error.message }); }
  }).catch(error => console.error(`[METRICS-WORKER] ${error.message}`));
});
