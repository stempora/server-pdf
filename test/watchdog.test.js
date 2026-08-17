const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const toBashPath = value => process.platform === 'win32'
  ? `/${value[0].toLowerCase()}${value.slice(2).replaceAll('\\', '/')}`
  : value;

test('watchdog units and installer preserve the intended systemd boundary', () => {
  const watchdog = read('scripts/watchdog.sh');
  const installer = read('scripts/install-watchdog.sh');
  const service = read('systemd/html2pdf-watchdog.service');
  const timer = read('systemd/html2pdf-watchdog.timer');
  assert.match(watchdog, /STATE_DIR="\/run\/html2pdf-watchdog"/);
  assert.match(watchdog, /systemctl is-active --quiet html2pdf\.service/);
  assert.match(watchdog, /value\.status !== "ok" \|\| value\.browser !== "connected"/);
  assert.match(watchdog, /flock -n 9/);
  assert.doesNotMatch(watchdog, /\bjq\b/);
  assert.match(installer, /systemctl enable --now html2pdf-watchdog\.timer/);
  assert.doesNotMatch(installer, /(?:restart|start) html2pdf\.service/);
  for (const setting of [
    'Type=oneshot', 'User=root', 'WorkingDirectory=/home/pdf/server',
    'EnvironmentFile=-/home/pdf/server/environment',
    'ExecStart=/home/pdf/server/scripts/watchdog.sh'
  ]) assert.ok(service.includes(setting), `Missing ${setting}`);
  for (const setting of [
    'OnBootSec=30s', 'OnUnitActiveSec=30s', 'AccuracySec=1s',
    'Persistent=false', 'Unit=html2pdf-watchdog.service'
  ]) assert.ok(timer.includes(setting), `Missing ${setting}`);
});

test('watchdog confirms failures, restarts once, rechecks health, and respects inactive service', t => {
  if (process.platform === 'win32') {
    return t.skip('watchdog process mocks require a Linux systemd target');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-watchdog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const token = path.basename(directory).replace(/[^a-zA-Z0-9_-]/g, '');
  const state = `/tmp/${token}-state`;
  fs.mkdirSync(bin);
  const log = `/tmp/${token}-systemctl.log`;
  const restarted = `/tmp/${token}-restarted`;
  t.after(() => {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(log, { force: true });
    fs.rmSync(restarted, { force: true });
  });
  const script = read('scripts/watchdog.sh').replace(
    'STATE_DIR="/run/html2pdf-watchdog"', `STATE_DIR="${state}"`
  ).replace(
    'install -d -o root -g root -m 0755 "${STATE_DIR}"',
    'mkdir -p "${STATE_DIR}"'
  );
  const scriptFile = path.join(directory, 'watchdog.sh');
  fs.writeFileSync(scriptFile, script);
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [[ "$1" == "is-active" ]]; then [[ "\${MOCK_ACTIVE:-1}" == "1" ]]; exit; fi
if [[ "$1" == "restart" ]]; then touch "${restarted}"; fi
`);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
output=''
while (( $# )); do
  if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi
done
if [[ -e "${restarted}" ]]; then
  printf '{"status":"ok","browser":"connected"}' > "$output"
else
  printf '{"status":"error","browser":"disconnected"}' > "$output"
fi
printf '200'
`);
  fs.writeFileSync(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  for (const file of ['systemctl', 'curl', 'flock']) fs.chmodSync(path.join(bin, file), 0o755);
  fs.chmodSync(scriptFile, 0o755);

  const env = {
    ...process.env,
    PATH: process.platform === 'win32'
      ? `${toBashPath(bin)}:${process.env.PATH}`
      : `${bin}${path.delimiter}${process.env.PATH}`,
    WATCHDOG_FAILURE_THRESHOLD: '2'
  };
  const windowsBash = path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe');
  const bash = fs.existsSync(windowsBash) ? windowsBash : 'bash';
  let result = spawnSync(bash, [scriptFile], { env, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return t.skip('bash is unavailable on this platform');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /failed \(1\/2\)/);
  result = spawnSync(bash, [scriptFile], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Service healthy after restart/);
  assert.match(result.stdout, /restarting html2pdf\.service/);

  result = spawnSync(bash, [scriptFile], { env: { ...env, MOCK_ACTIVE: '0' }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /inactive; not starting it/);
});
