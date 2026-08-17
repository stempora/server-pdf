const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  MetricsStore, SCHEMA_VERSION, fingerprintApiKey, initializeMetricsDatabase
} = require('../metrics-store');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-metrics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'data', 'metrics.sqlite') };
}

function store(file, overrides = {}) {
  return new MetricsStore({
    file, enabled: true, flushIntervalMs: 10000,
    flushMaxEvents: 100, maxPendingEvents: 10000, ...overrides
  });
}

test('database auto-creates, migrates to a versioned schema, and is idempotent', async t => {
  const files = temporary(t);
  let initialized = await initializeMetricsDatabase(files.file);
  assert.equal(initialized.schemaVersion, SCHEMA_VERSION);
  assert.equal(initialized.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(initialized.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(initialized.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(initialized.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const objects = initialized.db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index')"
  ).all().map(row => row.name);
  for (const object of [
    'api_key_metrics', 'api_key_daily_metrics', 'idx_api_key_daily_metric_date',
    'idx_api_key_metrics_last_used_at', 'idx_api_key_metrics_deleted_at'
  ]) assert.ok(objects.includes(object));
  initialized.db.prepare(`
    INSERT INTO api_key_metrics (key_fingerprint, created_at, updated_at) VALUES (?, ?, ?)
  `).run('a'.repeat(64), new Date().toISOString(), new Date().toISOString());
  initialized.db.close();
  initialized = await initializeMetricsDatabase(files.file);
  assert.equal(initialized.db.prepare('SELECT COUNT(*) AS count FROM api_key_metrics').get().count, 1);
  initialized.db.close();
  assert.equal(fs.statSync(files.file).mode & 0o777, process.platform === 'win32' ? fs.statSync(files.file).mode & 0o777 : 0o600);
});

test('init CLI migrate, check, and status are idempotent and disclose no metrics', t => {
  const files = temporary(t);
  const script = path.join(__dirname, '..', 'scripts', 'init-metrics-db.js');
  const env = { ...process.env, METRICS_DB_FILE: files.file };
  assert.match(execFileSync(process.execPath, [script], { env, encoding: 'utf8' }), /version 1/);
  assert.match(execFileSync(process.execPath, [script, '--check'], { env, encoding: 'utf8' }), /version 1/);
  const status = JSON.parse(execFileSync(process.execPath, [script, '--status'], { env, encoding: 'utf8' }));
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.journalMode, 'wal');
  assert.deepEqual(status.tables, ['api_key_daily_metrics', 'api_key_metrics']);
  assert.equal(JSON.stringify(status).includes('fingerprint'), false);
});

test('an existing pre-migration database receives a consistent SQLite backup', async t => {
  const files = temporary(t);
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  const legacy = new DatabaseSync(files.file);
  legacy.exec('CREATE TABLE legacy_marker (value TEXT); INSERT INTO legacy_marker VALUES (\'keep\');');
  legacy.close();
  const backupFile = path.join(files.directory, 'backup', 'metrics.sqlite');
  const initialized = await initializeMetricsDatabase(files.file, { backupFile });
  initialized.db.close();
  const backedUp = new DatabaseSync(backupFile, { readOnly: true });
  assert.equal(backedUp.prepare('SELECT value FROM legacy_marker').get().value, 'keep');
  backedUp.close();
});

test('fingerprints, batching, UTC daily data, durations, delete retention, and queue cap work', async t => {
  const files = temporary(t);
  const metrics = store(files.file, { maxPendingEvents: 3 });
  await metrics.initialize();
  for (const type of ['request', 'started', 'success']) metrics.record('complete-secret-key', 'main', type, type === 'success' ? 42 : undefined);
  metrics.record('complete-secret-key', 'main', 'error', 20);
  assert.equal(metrics.pending.length, 3);
  assert.equal(metrics.droppedEvents, 1);
  await metrics.flush();
  metrics.markDeleted('complete-secret-key', 'main');
  await metrics.flush();
  const rows = await metrics.summary();
  assert.equal(rows[0].key_fingerprint, fingerprintApiKey('complete-secret-key'));
  assert.equal(rows[0].deleted_at !== null, true);
  assert.equal(rows[0].min_duration_ms, 20);
  assert.equal(rows[0].max_duration_ms, 42);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await metrics.daily(day, day, rows[0].key_fingerprint)).length, 1);
  await metrics.shutdown();
  const bytes = fs.readFileSync(files.file);
  assert.equal(bytes.includes(Buffer.from('complete-secret-key')), false);
});

test('threshold, periodic, and shutdown flushes persist pending events', async t => {
  const files = temporary(t);
  const metrics = store(files.file, { flushMaxEvents: 2, flushIntervalMs: 100 });
  await metrics.initialize();
  metrics.record('key', null, 'request');
  metrics.record('key', null, 'started');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await metrics.summary())[0].request_count, 1);
  metrics.record('key', null, 'success', 10);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await metrics.summary())[0].success_count, 1);
  metrics.record('key', null, 'request');
  await metrics.shutdown();
  const db = new DatabaseSync(files.file, { readOnly: true });
  assert.equal(db.prepare('SELECT request_count FROM api_key_metrics').get().request_count, 2);
  db.close();
});

test('the production threshold flushes at 100 events', async t => {
  const files = temporary(t);
  const metrics = store(files.file, { flushMaxEvents: 100 });
  await metrics.initialize();
  for (let index = 0; index < 99; index += 1) metrics.record('threshold-key', null, 'request');
  assert.equal(metrics.pending.length, 99);
  metrics.record('threshold-key', null, 'request');
  await new Promise(resolve => setTimeout(resolve, 25));
  const db = new DatabaseSync(files.file, { readOnly: true });
  assert.equal(db.prepare('SELECT request_count FROM api_key_metrics').get().request_count, 100);
  db.close();
  await metrics.shutdown();
});

test('temporary SQLite lock retains events and succeeds on retry', async t => {
  const files = temporary(t);
  const initialized = await initializeMetricsDatabase(files.file);
  initialized.db.close();
  const locker = spawn(process.execPath, ['-e', `
    const { DatabaseSync }=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE');
    console.log('locked'); setTimeout(()=>{db.exec('ROLLBACK');db.close();},6500);
  `, files.file], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => locker.stdout.once('data', resolve));
  const metrics = store(files.file);
  await metrics.initialize();
  metrics.record('locked-key', null, 'request');
  await metrics.flush();
  assert.equal(metrics.pending.length, 1);
  assert.equal(metrics.health().status, 'error');
  await new Promise(resolve => locker.once('exit', resolve));
  await metrics.flush();
  assert.equal((await metrics.summary())[0].request_count, 1);
  await metrics.shutdown();
});

test('unavailable SQLite is fail-open and bounds pending memory', async t => {
  const files = temporary(t);
  fs.mkdirSync(files.file, { recursive: true });
  const metrics = store(files.file, { maxPendingEvents: 2 });
  await metrics.initialize();
  for (let index = 0; index < 5; index += 1) metrics.record(`key-${index}`, null, 'request');
  await metrics.flush();
  assert.equal(metrics.pending.length, 2);
  assert.equal(metrics.droppedEvents, 3);
  assert.equal(metrics.health().status, 'error');
  await metrics.shutdown(10);
});

test('disabled metrics creates no database and reports disabled health', async t => {
  const files = temporary(t);
  const metrics = new MetricsStore({
    file: files.file, enabled: false, flushIntervalMs: 100,
    flushMaxEvents: 1, maxPendingEvents: 100
  });
  await metrics.initialize();
  metrics.record('secret', null, 'request');
  assert.equal(fs.existsSync(files.file), false);
  assert.equal(metrics.health().status, 'disabled');
  await metrics.shutdown();
});

test('worker death degrades metrics without rejecting records', async t => {
  const files = temporary(t);
  const metrics = store(files.file);
  await metrics.initialize();
  await metrics.worker.terminate();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => metrics.record('still-converts', null, 'request'));
  assert.equal(metrics.pending.length, 1);
  assert.equal(metrics.health().status, 'error');
  assert.match(metrics.health().lastError, /worker unavailable/i);
  await metrics.shutdown(10);
});
