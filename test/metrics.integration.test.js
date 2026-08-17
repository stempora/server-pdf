const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fingerprintApiKey } = require('../metrics-store');

const root = path.join(__dirname, '..');

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function start(t, overrides = {}, corruptMetrics = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-metrics-http-'));
  const port = await unusedPort();
  const metricsFile = path.join(directory, 'data', 'metrics.sqlite');
  const stateFile = path.join(directory, 'mock.json');
  fs.writeFileSync(path.join(directory, 'apikeys.json'), '["metrics-key"]');
  fs.writeFileSync(path.join(directory, 'master-key.json'), '{"key":"master"}');
  fs.mkdirSync(path.join(directory, 'logs'));
  if (corruptMetrics) {
    fs.mkdirSync(path.dirname(metricsFile));
    fs.writeFileSync(metricsFile, 'not sqlite');
  }
  const child = spawn(process.execPath, [
    '-r', path.join(root, 'test-support', 'mock-puppeteer.js'), path.join(root, 'server.js')
  ], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      API_KEYS_FILE: path.join(directory, 'apikeys.json'),
      MASTER_KEY_FILE: path.join(directory, 'master-key.json'),
      API_KEY_METADATA_FILE: path.join(directory, 'api-key-metadata.json'),
      LOG_DIR: path.join(directory, 'logs'),
      METRICS_DB_FILE: metricsFile,
      METRICS_FLUSH_INTERVAL_MS: '100',
      METRICS_FLUSH_MAX_EVENTS: '1',
      METRICS_MAX_PENDING_EVENTS: '100',
      MOCK_PUPPETEER_STATE_FILE: stateFile,
      MOCK_SIGNAL_STDIN: '1',
      RENDER_DELAY_MS: '0',
      ...overrides
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.stdin.write('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return {
    base, child, output: () => output,
    pdf: (target, key = 'metrics-key') => fetch(
      `${base}/pdf?url=${encodeURIComponent(target)}`,
      { headers: { 'X-API-Key': key, Connection: 'close' } }
    ),
    admin: (url, options = {}) => fetch(`${base}${url}`, {
      ...options,
      headers: { Authorization: 'Bearer master', ...(options.headers || {}) }
    })
  };
}

test('PDF outcomes are batched per key and exposed through protected admin endpoints', async t => {
  const server = await start(t, {
    MAX_CONCURRENT_REQUESTS: '1', MAX_QUEUE_SIZE: '1', PDF_REQUEST_TIMEOUT_MS: '1000'
  });
  assert.equal((await server.pdf('https://example.com/')).status, 200);
  assert.equal((await server.pdf('https://example.com/?mockError=recoverable')).status, 200);
  assert.equal((await server.pdf('https://example.com/?mockError=normal')).status, 500);
  assert.equal((await fetch(`${server.base}/pdf?url=broken`, { headers: { 'X-API-Key': 'metrics-key' } })).status, 400);
  assert.equal((await server.pdf('https://example.com/?mockDelay=3000')).status, 504);

  const first = server.pdf('https://example.com/?mockDelay=300');
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = server.pdf('https://example.org/?mockDelay=100');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await server.pdf('https://example.net/')).status, 503);
  await Promise.all([first, second]);

  const abortUrl = `${server.base}/pdf?url=${encodeURIComponent('https://example.com/?mockDelay=500')}`;
  await new Promise(resolve => {
    const request = http.get(abortUrl, { headers: { 'X-API-Key': 'metrics-key' } });
    request.on('error', () => resolve());
    setTimeout(() => request.destroy(), 50);
  });
  await new Promise(resolve => setTimeout(resolve, 900));

  const metricsResponse = await server.admin('/admin/metrics');
  assert.equal(metricsResponse.status, 200, `${await metricsResponse.text()}\n${server.output()}`);
  const summary = await (await server.admin('/admin/metrics')).json();
  const metric = summary.metrics.find(item => item.key_fingerprint === fingerprintApiKey('metrics-key'));
  assert.equal(metric.key, 'metrics-key');
  assert.equal(metric.request_count, 9);
  assert.equal(metric.started_count, 7);
  assert.equal(metric.success_count, 5);
  assert.equal(metric.error_count, 1);
  assert.equal(metric.timeout_count, 1);
  assert.equal(metric.queue_rejected_count, 1);
  assert.equal(metric.validation_error_count, 1);
  assert.equal(metric.client_aborted_count, 1);
  assert.ok(metric.min_duration_ms <= metric.max_duration_ms);
  assert.ok(metric.average_duration_ms >= 0);

  const listed = await (await server.admin('/admin/list-keys')).json();
  assert.equal(listed.keys[0].request_count, 9);
  const day = new Date().toISOString().slice(0, 10);
  const daily = await (await server.admin(
    `/admin/metrics/daily?from=${day}&to=${day}&fingerprint=${fingerprintApiKey('metrics-key')}`
  )).json();
  assert.equal(daily.metrics[0].request_count, 9);
  assert.equal((await server.admin('/admin/metrics/daily?fingerprint=bad')).status, 400);
  assert.equal((await fetch(`${server.base}/admin/metrics`)).status, 401);
  assert.equal(server.output().match(/Chrome ready; retrying request/g)?.length, 1);
});

test('new and deleted keys retain zero/default and historical metrics without storing the key', async t => {
  const server = await start(t);
  const created = await (await server.admin('/admin/create-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"temporary"}'
  })).json();
  const listResponse = await server.admin('/admin/list-keys');
  assert.equal(listResponse.status, 200, `${await listResponse.clone().text()}\n${server.output()}`);
  let listed = await listResponse.json();
  const newKey = listed.keys.find(item => item.key === created.key);
  assert.equal(newKey.request_count, 0);
  assert.equal(newKey.average_duration_ms, null);
  assert.equal((await server.pdf('https://example.com/', created.key)).status, 200);
  assert.equal((await server.admin(`/admin/delete-key/${created.key}`, { method: 'DELETE' })).status, 200);
  const summary = await (await server.admin('/admin/metrics')).json();
  const deleted = summary.metrics.find(item => item.key_fingerprint === fingerprintApiKey(created.key));
  assert.equal(deleted.key, null);
  assert.equal(deleted.key_name, 'temporary');
  assert.ok(deleted.deleted_at);
});

test('corrupt metrics database is fail-open for PDF and health', async t => {
  const server = await start(t, {}, true);
  assert.equal((await server.pdf('https://example.com/')).status, 200);
  const health = await (await fetch(`${server.base}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.browser, 'connected');
  assert.equal(health.metrics.status, 'error');
  assert.equal(typeof health.metrics.lastError, 'string');
});
