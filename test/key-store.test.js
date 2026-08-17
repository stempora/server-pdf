const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  KeyStore,
  KeyStoreError,
  isBearerAuthorized,
  normalizeName,
  writeJsonAtomic
} = require('../key-store');

function fixture(keys = ['legacy-key'], metadata) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-test-'));
  const keysFile = path.join(directory, 'apikeys.json');
  const metadataFile = path.join(directory, 'api-key-metadata.json');
  fs.writeFileSync(keysFile, JSON.stringify(keys));
  if (metadata !== undefined) fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  return { directory, keysFile, metadataFile };
}

test('legacy apikeys.json starts without metadata and remains active', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const store = new KeyStore(files.keysFile, files.metadataFile);
  assert.equal(store.isValid('legacy-key'), true);
  assert.deepEqual(store.list(), {
    success: true,
    keys: [{ key: 'legacy-key', name: null, enabled: true, created_at: null }]
  });
  assert.equal(fs.existsSync(files.metadataFile), false);
});

test('master authorization accepts only the complete correct bearer key', () => {
  assert.equal(isBearerAuthorized('Bearer complete-master-key', 'complete-master-key'), true);
  assert.equal(isBearerAuthorized('Bearer wrong', 'complete-master-key'), false);
  assert.equal(isBearerAuthorized(undefined, 'complete-master-key'), false);
  assert.equal(isBearerAuthorized('complete-master-key', 'complete-master-key'), false);
});

test('name normalization rejects invalid payloads', () => {
  assert.equal(normalizeName('  main   app  '), 'main app');
  for (const value of ['', '   ', null, 42, 'x'.repeat(101)]) {
    assert.throws(() => normalizeName(value), error =>
      error instanceof KeyStoreError && error.statusCode === 400
    );
  }
});

test('create, list, disable, enable and delete update files and memory immediately', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const store = new KeyStore(files.keysFile, files.metadataFile);
  const created = store.create('main-app');

  assert.equal(created.success, true);
  assert.match(created.key, /^[a-f0-9]{64}$/);
  assert.equal(store.list().keys.find(item => item.key === created.key).key, created.key);

  const disabled = store.setEnabled(created.key, false);
  assert.equal(disabled.enabled, false);
  assert.equal(store.isValid(created.key), false);
  assert.equal(JSON.parse(fs.readFileSync(files.keysFile, 'utf8')).includes(created.key), true);

  const enabled = store.setEnabled(created.key, true);
  assert.equal(enabled.enabled, true);
  assert.equal(store.isValid(created.key), true);

  assert.equal(store.delete(created.key).success, true);
  assert.equal(store.isValid(created.key), false);
  assert.equal(store.list().keys.some(item => item.key === created.key), false);
  assert.equal(JSON.parse(fs.readFileSync(files.keysFile, 'utf8')).includes('legacy-key'), true);
});

test('atomic writer leaves valid old JSON and no temporary file on rename failure', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const before = fs.readFileSync(files.keysFile, 'utf8');
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated rename failure'); };
  try {
    assert.throws(() => writeJsonAtomic(files.keysFile, ['replacement']), /simulated/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(files.keysFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(files.directory).sort(), ['apikeys.json']);
});

test('corrupt JSON is rejected without overwriting existing data', t => {
  const files = fixture(['existing-key'], {});
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  fs.writeFileSync(files.metadataFile, '{broken');
  const keysBefore = fs.readFileSync(files.keysFile, 'utf8');
  const metadataBefore = fs.readFileSync(files.metadataFile, 'utf8');
  assert.throws(() => new KeyStore(files.keysFile, files.metadataFile), SyntaxError);
  assert.equal(fs.readFileSync(files.keysFile, 'utf8'), keysBefore);
  assert.equal(fs.readFileSync(files.metadataFile, 'utf8'), metadataBefore);
});

test('missing keys return 404 and cannot delete all keys through wildcard-like values', t => {
  const files = fixture(['safe-key'], {});
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const store = new KeyStore(files.keysFile, files.metadataFile);
  for (const value of ['', '*', 'safe', undefined]) {
    assert.throws(() => store.delete(value), error =>
      error instanceof KeyStoreError && error.statusCode === 404
    );
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(files.keysFile, 'utf8')), ['safe-key']);
});
