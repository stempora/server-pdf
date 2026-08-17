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
const watchdogInstaller = read('scripts/install-watchdog.sh');

test('installer uses only the production application path', () => {
  assert.match(installer, /SERVICE_USER="pdf"/);
  assert.match(installer, /INSTALL_DIR="\/home\/pdf\/server"/);
  assert.doesNotMatch(installer, /\/opt\/html2pdf|\/etc\/html2pdf/);
  assert.doesNotMatch(updater, /\/opt\/html2pdf|\/etc\/html2pdf/);
  assert.match(installer, /Clone the repository into \/home\/pdf\/server/);
  assert.match(installer, /\.deployed-commit/);
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

test('installer adds stability defaults only to a newly created environment and enables watchdog after health', () => {
  for (const setting of [
    'PDF_REQUEST_TIMEOUT_MS=60000',
    'PDF_TIMEOUT_CLEANUP_MS=3000',
    'BROWSER_MAX_REQUESTS=5000',
    'BROWSER_MAX_UPTIME_SECONDS=21600',
    'WATCHDOG_FAILURE_THRESHOLD=2',
    'WATCHDOG_RESTART_COOLDOWN_SECONDS=60'
  ]) assert.ok(installer.includes(setting), `Missing ${setting}`);
  assert.ok(installer.indexOf('scripts/install-watchdog.sh') > installer.indexOf('curl --silent --fail http://127.0.0.1:8214/health'));
  assert.doesNotMatch(updater, /install-watchdog|html2pdf-watchdog/);
  assert.doesNotMatch(watchdogInstaller, /(?:restart|start) html2pdf\.service/);
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

test('update runs in-place with commit-based preflight and no application copying', () => {
  assert.match(updater, /\[\[ "\$\(pwd -P\)" == "\/home\/pdf\/server" \]\]/);
  assert.match(updater, /\[\[ -d \.git \]\]/);
  assert.match(updater, /status --porcelain --untracked-files=all/);
  assert.match(updater, /MARKER_FILE="\$\{INSTALL_DIR\}\/\.deployed-commit"/);
  assert.match(updater, /DEPLOYED_COMMIT=SHA/);
  assert.match(updater, /ORIG_HEAD\^\{commit\}/);
  assert.match(updater, /merge-base --is-ancestor/);
  assert.match(updater, /cat-file -e "\$\{OLD_COMMIT\}\^\{commit\}"/);
  assert.match(updater, /Nothing to update/);
  assert.match(updater, /git_safe diff --quiet "\$\{OLD_COMMIT\}" "\$\{NEW_COMMIT\}" -- package\.json package-lock\.json/);
  assert.doesNotMatch(updater, /install[^\n]+(server\.js|key-store\.js|package\.json|package-lock\.json|postman)/i);
  assert.doesNotMatch(updater, /cp[^\n]+(server\.js|key-store\.js|package\.json|package-lock\.json|postman)/i);
});

test('update backs up dependencies, marks success, and rolls back safely', () => {
  assert.match(updater, /BACKUP_ROOT="\/home\/pdf\/server-backups"/);
  assert.match(updater, /trap rollback ERR/);
  assert.match(updater, /curl --silent --fail http:\/\/127\.0\.0\.1:8214\/health/);
  assert.match(updater, /npm ci --omit=dev --ignore-scripts/);
  assert.match(updater, /Dependencies unchanged; skipping npm ci/);
  assert.match(updater, /git_safe reset --hard "\$\{OLD_COMMIT\}"/);
  assert.match(updater, /status --porcelain --untracked-files=no/);
  assert.match(updater, /rollback safety checks failed; git reset was not executed/);
  assert.doesNotMatch(updater, /git(?:_safe)? clean|rsync\s+[^\n]*--delete/);
  assert.ok(updater.indexOf('wait_for_health\nwrite_deployed_commit "${NEW_COMMIT}"') > updater.indexOf('systemctl restart "${SERVICE}"'));
  assert.match(updater, /write_deployed_commit "\$\{OLD_COMMIT\}"/);
  assert.match(updater, /Retry with: git pull --ff-only && sudo \.\/update\.sh/);
  assert.ok(updater.indexOf('Nothing to update') < updater.indexOf('timestamp="$(date -u'));
});

test('secret and runtime files are ignored without removing existing rules', () => {
  for (const rule of [
    'logs/',
    'node_modules/',
    'apikeys.json',
    'master-key.json',
    'api-key-metadata.json',
    'environment',
    '.deployed-commit'
  ]) assert.ok(ignore.split(/\r?\n/).includes(rule), `Missing ${rule}`);
});
