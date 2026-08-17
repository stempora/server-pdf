const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const installer = read('install.sh');
const updater = read('update.sh');
const service = read('html2pdf.service');
const ignore = read('.gitignore');

test('installer uses only the production application path', () => {
  assert.match(installer, /SERVICE_USER="pdf"/);
  assert.match(installer, /INSTALL_DIR="\/home\/pdf\/server"/);
  assert.doesNotMatch(installer, /\/opt\/html2pdf|\/etc\/html2pdf/);
  assert.doesNotMatch(updater, /\/opt\/html2pdf|\/etc\/html2pdf/);
  assert.match(installer, /existing installation was found; use update\.sh instead/i);
});

test('installer has separate DEB and RPM paths for supported distributions', () => {
  assert.match(installer, /source \/etc\/os-release/);
  assert.match(installer, /debian\|ubuntu/);
  assert.match(installer, /almalinux\|rocky\|rhel/);
  assert.match(installer, /apt-get install/);
  assert.match(installer, /dnf install -y/);
  assert.match(installer, /https:\/\/deb\.nodesource\.com\/setup_22\.x/);
  assert.match(installer, /https:\/\/rpm\.nodesource\.com\/setup_22\.x/);
  assert.match(installer, /google-chrome-stable_current_amd64\.deb/);
  assert.match(installer, /google-chrome-stable_current_x86_64\.rpm/);
  assert.match(installer, /Node\.js 22 installation verification failed/);
});

test('installer creates secrets only when absent and secures them', () => {
  for (const file of ['master-key.json', 'apikeys.json', 'api-key-metadata.json']) {
    assert.ok(installer.includes(`if [[ ! -e \"\${INSTALL_DIR}/${file}\" ]]`));
  }
  assert.match(installer, /openssl rand -hex 32/);
  assert.match(installer, /chmod 0600 .*master-key\.json.*apikeys\.json.*api-key-metadata\.json/);
  assert.match(installer, /Master key \(save it now; it will not be shown again\)/);
});

test('systemd unit retains all existing production tuning', () => {
  for (const setting of [
    'User=pdf',
    'Group=pdf',
    'WorkingDirectory=/home/pdf/server',
    'EnvironmentFile=/home/pdf/server/environment',
    'ExecStart=/usr/bin/node /home/pdf/server/server.js',
    'MemoryHigh=48G',
    'MemoryMax=56G',
    'TasksMax=4096',
    'LimitNOFILE=65535'
  ]) assert.ok(service.includes(setting), `Missing ${setting}`);
});

test('update has clean-tree preflight, backup, health check and rollback', () => {
  assert.match(updater, /status --porcelain --untracked-files=all/);
  assert.match(updater, /BACKUP_ROOT="\/home\/pdf\/server-backups"/);
  assert.match(updater, /trap rollback ERR/);
  assert.match(updater, /curl --silent --fail http:\/\/127\.0\.0\.1:8214\/health/);
  assert.match(updater, /Dependencies unchanged; skipping npm ci/);
  assert.doesNotMatch(updater, /install\.sh|rsync\s+[^\n]*--delete/);

  for (const preserved of ['environment', 'master-key.json', 'apikeys.json', 'api-key-metadata.json']) {
    assert.doesNotMatch(updater, new RegExp(`install[^\\n]+${preserved.replace('.', '\\.')}[^\\n]+\\$\\{INSTALL_DIR\\}`));
  }
  assert.ok(updater.indexOf('node --check "${SCRIPT_DIR}/server.js"') < updater.indexOf('CHANGES_STARTED=1'));
  assert.ok(updater.indexOf('validate_json "${INSTALL_DIR}/apikeys.json"') < updater.indexOf('CHANGES_STARTED=1'));
});

test('secret and runtime files are ignored without removing existing rules', () => {
  for (const rule of [
    'logs/',
    'node_modules/',
    'apikeys.json',
    'master-key.json',
    'api-key-metadata.json',
    'environment'
  ]) assert.ok(ignore.split(/\r?\n/).includes(rule), `Missing ${rule}`);
});
