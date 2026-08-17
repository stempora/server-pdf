const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'postman');
const collection = JSON.parse(fs.readFileSync(path.join(root, 'server-pdf.postman_collection.json'), 'utf8'));
const environment = JSON.parse(fs.readFileSync(path.join(root, 'server-pdf.local.postman_environment.json'), 'utf8'));

test('Postman collection contains required folders and requests', () => {
  assert.deepEqual(collection.item.map(item => item.name), ['Health', 'PDF', 'Admin Keys']);
  const requests = collection.item.flatMap(folder => folder.item.map(item => item.name));
  for (const name of ['Health', 'Generate PDF', 'Create API key', 'List API keys', 'Disable API key', 'Enable API key', 'Delete API key']) {
    assert.ok(requests.includes(name), `Missing ${name}`);
  }
});

test('Postman environment has no real secrets and all required variables', () => {
  const values = Object.fromEntries(environment.values.map(item => [item.key, item.value]));
  assert.deepEqual(values, {
    base_url: 'http://127.0.0.1:8214',
    master_key: '',
    api_key: '',
    key_name: 'postman-test',
    pdf_url: 'https://example.com'
  });
});
