const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitUntilReady(child, port) {
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${output}`);
}

test('admin lifecycle is immediate and preserves legacy PDF authentication', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-http-'));
  const port = await unusedPort();
  const masterKey = 'master-key-for-integration-test';
  const legacyKey = 'legacy-api-key';
  fs.writeFileSync(path.join(directory, 'apikeys.json'), JSON.stringify([legacyKey]));
  fs.writeFileSync(path.join(directory, 'master-key.json'), JSON.stringify({
    key: masterKey,
    created_at: new Date().toISOString()
  }));
  fs.mkdirSync(path.join(directory, 'logs'));

  const child = spawn(process.execPath, ['-r', path.join(root, 'test-support', 'mock-puppeteer.js'), path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      API_KEYS_FILE: path.join(directory, 'apikeys.json'),
      MASTER_KEY_FILE: path.join(directory, 'master-key.json'),
      API_KEY_METADATA_FILE: path.join(directory, 'api-key-metadata.json'),
      LOG_DIR: path.join(directory, 'logs'),
      RENDER_DELAY_MS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitUntilReady(child, port);

  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { Authorization: `Bearer ${masterKey}` };
  assert.equal((await fetch(`${base}/admin/list-keys`)).status, 401);
  assert.equal((await fetch(`${base}/admin/list-keys`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);

  const invalid = await fetch(`${base}/admin/create-key`, {
    method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ' ' })
  });
  assert.equal(invalid.status, 400);
  const malformed = await fetch(`${base}/admin/create-key`, {
    method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: '{broken'
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { success: false, error: 'Invalid JSON payload' });
  assert.equal((await fetch(`${base}/admin/disable-key/not-a-key`, { method: 'POST', headers: adminHeaders })).status, 404);

  const createdResponse = await fetch(`${base}/admin/create-key`, {
    method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ' main   app ' })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.success, true);
  assert.equal(created.name, 'main app');
  assert.match(created.key, /^[a-f0-9]{64}$/);

  let listed = await (await fetch(`${base}/admin/list-keys`, { headers: adminHeaders })).json();
  assert.deepEqual(listed.keys.find(item => item.key === legacyKey), {
    key: legacyKey, name: null, enabled: true, created_at: null
  });
  assert.equal(listed.keys.some(item => item.key === created.key), true);

  const metadataFile = path.join(directory, 'api-key-metadata.json');
  const metadataBeforeFailure = fs.readFileSync(metadataFile, 'utf8');
  fs.rmSync(metadataFile);
  fs.mkdirSync(metadataFile);
  const failedWrite = await fetch(`${base}/admin/disable-key/${created.key}`, { method: 'POST', headers: adminHeaders });
  assert.equal(failedWrite.status, 500);
  assert.deepEqual(await failedWrite.json(), { success: false, error: 'Internal server error' });
  assert.equal((await fetch(`${base}/pdf?url=https://example.com`, { headers: { 'X-API-Key': created.key } })).status, 200);
  fs.rmSync(metadataFile, { recursive: true });
  fs.writeFileSync(metadataFile, metadataBeforeFailure);

  assert.equal((await fetch(`${base}/pdf?url=https://example.com&apikey=${legacyKey}`)).status, 200);
  assert.equal((await fetch(`${base}/pdf?url=https://example.com`, { headers: { 'X-API-Key': legacyKey } })).status, 200);

  let changed = await (await fetch(`${base}/admin/disable-key/${created.key}`, { method: 'POST', headers: adminHeaders })).json();
  assert.equal(changed.enabled, false);
  assert.equal((await fetch(`${base}/pdf?url=https://example.com`, { headers: { 'X-API-Key': created.key } })).status, 401);

  changed = await (await fetch(`${base}/admin/enable-key/${created.key}`, { method: 'POST', headers: adminHeaders })).json();
  assert.equal(changed.enabled, true);
  assert.equal((await fetch(`${base}/pdf?url=https://example.com`, { headers: { 'X-API-Key': created.key } })).status, 200);

  const deleted = await (await fetch(`${base}/admin/delete-key/${created.key}`, { method: 'DELETE', headers: adminHeaders })).json();
  assert.equal(deleted.success, true);
  assert.equal((await fetch(`${base}/pdf?url=https://example.com`, { headers: { 'X-API-Key': created.key } })).status, 401);
  listed = await (await fetch(`${base}/admin/list-keys`, { headers: adminHeaders })).json();
  assert.equal(listed.keys.some(item => item.key === created.key), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'apikeys.json'), 'utf8')), [legacyKey]);
});

test('corrupt metadata prevents startup without overwriting key files', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-corrupt-'));
  const keysFile = path.join(directory, 'apikeys.json');
  const metadataFile = path.join(directory, 'api-key-metadata.json');
  const keysContent = JSON.stringify(['existing-key']);
  fs.writeFileSync(keysFile, keysContent);
  fs.writeFileSync(metadataFile, '{broken');
  fs.writeFileSync(path.join(directory, 'master-key.json'), JSON.stringify({ key: 'master' }));
  fs.mkdirSync(path.join(directory, 'logs'));

  const child = spawn(process.execPath, ['-r', path.join(root, 'test-support', 'mock-puppeteer.js'), path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      API_KEYS_FILE: keysFile,
      MASTER_KEY_FILE: path.join(directory, 'master-key.json'),
      API_KEY_METADATA_FILE: metadataFile,
      LOG_DIR: path.join(directory, 'logs')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const exitCode = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exitCode, 1);
  assert.equal(fs.readFileSync(keysFile, 'utf8'), keysContent);
  assert.equal(fs.readFileSync(metadataFile, 'utf8'), '{broken');
});

test('missing master key prevents startup and is never generated by the server', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-no-master-'));
  const masterFile = path.join(directory, 'master-key.json');
  fs.writeFileSync(path.join(directory, 'apikeys.json'), '[]');
  fs.mkdirSync(path.join(directory, 'logs'));

  const child = spawn(process.execPath, ['-r', path.join(root, 'test-support', 'mock-puppeteer.js'), path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      API_KEYS_FILE: path.join(directory, 'apikeys.json'),
      MASTER_KEY_FILE: masterFile,
      API_KEY_METADATA_FILE: path.join(directory, 'api-key-metadata.json'),
      LOG_DIR: path.join(directory, 'logs')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const exitCode = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(masterFile), false);
});
