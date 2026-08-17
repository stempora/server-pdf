const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function waitFor(predicate, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function startServer(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-stability-'));
  const port = await unusedPort();
  const stateFile = path.join(directory, 'mock-state.json');
  fs.writeFileSync(path.join(directory, 'apikeys.json'), '["test-key"]');
  fs.writeFileSync(path.join(directory, 'master-key.json'), '{"key":"master"}');
  fs.mkdirSync(path.join(directory, 'logs'));
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
      MOCK_PUPPETEER_STATE_FILE: stateFile,
      MOCK_SIGNAL_STDIN: '1',
      RENDER_DELAY_MS: '0',
      BROWSER_MAX_REQUESTS: '0',
      BROWSER_MAX_UPTIME_SECONDS: '0',
      ...overrides
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).launches > 0; } catch (_error) { return false; }
  }, `Browser did not launch. Output:\n${output}`);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) {
        ready = true;
        break;
      }
    } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!ready) throw new Error(`Server did not become healthy. Output:\n${output}`);
  return {
    child, base,
    signal: signal => child.stdin.write(signal),
    output: () => output,
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    pdf: target => fetch(`${base}/pdf?url=${encodeURIComponent(target)}&apikey=test-key`, {
      headers: { Connection: 'close' }
    })
  };
}

test('total request timeout returns 504, closes its page, and releases the slot', async t => {
  const server = await startServer(t, { PDF_REQUEST_TIMEOUT_MS: '1000', MAX_CONCURRENT_REQUESTS: '1' });
  const timedOut = await server.pdf('https://example.com/?mockDelay=3000&mockError=recoverable');
  assert.equal(timedOut.status, 504);
  assert.equal((await server.pdf('https://example.com/')).status, 200);
  await waitFor(() => server.state().events.some(event => event.type === 'page-close'), 'Timed-out page was not closed');
  assert.equal(server.state().launches, 1, 'Timeout must not trigger browser recovery');
});

test('recoverable browser failures share one relaunch and get one retry', async t => {
  const server = await startServer(t, { PDF_REQUEST_TIMEOUT_MS: '5000' });
  const responses = await Promise.all([
    server.pdf('https://example.com/?mockError=recoverable'),
    server.pdf('https://example.org/?mockError=recoverable')
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(server.state().launches, 2);
  assert.match(server.output(), /\[BROWSER RECOVERY\] Chrome ready; retrying request/);
  assert.equal((await server.pdf('https://example.com/?mockError=normal')).status, 500);
  assert.equal(server.state().launches, 2, 'Normal page errors must not be retried');
});

test('request-count recycle waits for active pages and zero disables recycling', async t => {
  const server = await startServer(t, { BROWSER_MAX_REQUESTS: '1', PDF_REQUEST_TIMEOUT_MS: '5000' });
  const slow = server.pdf('https://example.com/?mockDelay=300');
  await waitFor(() => server.state().events.filter(event => event.type === 'page-open').length === 1, 'Page did not open');
  const fast = server.pdf('https://example.org/');
  assert.equal((await fast).status, 200);
  assert.equal((await slow).status, 200);
  await waitFor(() => server.state().launches === 2, 'Browser was not recycled');
  const close = server.state().events.find(event => event.type === 'browser-close');
  assert.equal(close.activePages, 0);
});

test('uptime recycle is disabled by zero and enabled by a positive limit', async t => {
  const disabled = await startServer(t, { BROWSER_MAX_UPTIME_SECONDS: '0' });
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal((await disabled.pdf('https://example.com/')).status, 200);
  assert.equal(disabled.state().launches, 1);

  const enabled = await startServer(t, { BROWSER_MAX_UPTIME_SECONDS: '1' });
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal((await enabled.pdf('https://example.com/')).status, 200);
  assert.equal(enabled.state().launches, 2);
});

test('shutdown drains active work, rejects queued work, then closes Chrome', async t => {
  const server = await startServer(t, { MAX_CONCURRENT_REQUESTS: '1', SHUTDOWN_TIMEOUT_MS: '3000' });
  const active = server.pdf('https://example.com/?mockDelay=300');
  await waitFor(() => server.state().events.some(event => event.type === 'page-open'), 'Active page did not open');
  const queued = server.pdf('https://example.org/');
  let pending = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const health = await (await fetch(`${server.base}/health`)).json();
    if (health.queue.pending === 1) { pending = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(pending, true, 'Second request never entered the queue');
  server.signal('SIGTERM');
  const [queuedResult, activeResult] = await Promise.allSettled([queued, active]);
  assert.equal(queuedResult.status, 'fulfilled', `Queued request failed: ${queuedResult.reason}`);
  assert.equal(activeResult.status, 'fulfilled', `Active request failed: ${activeResult.reason}`);
  assert.equal(queuedResult.value.status, 503);
  assert.equal(activeResult.value.status, 200);
  const exitCode = await new Promise(resolve => server.child.once('exit', resolve));
  assert.equal(exitCode, 0);
  const events = server.state().events;
  assert.ok(events.findIndex(event => event.type === 'browser-close') > events.findIndex(event => event.type === 'page-close'));
  assert.match(server.output(), /\[SHUTDOWN\] Complete/);
});

test('shutdown timeout forces a non-zero exit while work remains active', async t => {
  const server = await startServer(t, { SHUTDOWN_TIMEOUT_MS: '100', PDF_REQUEST_TIMEOUT_MS: '5000' });
  void server.pdf('https://example.com/?mockDelay=3000').catch(() => {});
  await waitFor(() => server.state().events.some(event => event.type === 'page-open'), 'Active page did not open');
  server.signal('SIGTERM');
  const exitCode = await new Promise(resolve => server.child.once('exit', resolve));
  assert.equal(exitCode, 1);
  assert.match(server.output(), /\[SHUTDOWN\] Timed out; forcing exit/);
});
