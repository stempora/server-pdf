const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

function commitAll(directory, message) {
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

test('commit comparison detects dependencies and hard rollback preserves ignored production data', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pdf-update-git-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init');
  git(directory, 'config', 'user.email', 'test@example.invalid');
  git(directory, 'config', 'user.name', 'server-pdf test');
  git(directory, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(directory, '.gitignore'), 'environment\napikeys.json\nlogs/\n.deployed-commit\n');
  fs.writeFileSync(path.join(directory, 'server.js'), 'old\n');
  fs.writeFileSync(path.join(directory, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(directory, 'package-lock.json'), '{}\n');
  const oldCommit = commitAll(directory, 'old');

  fs.writeFileSync(path.join(directory, 'environment'), 'PORT=8214\n');
  fs.writeFileSync(path.join(directory, 'apikeys.json'), '["existing-key"]\n');
  fs.mkdirSync(path.join(directory, 'logs'));
  fs.writeFileSync(path.join(directory, 'logs', 'production.log'), 'keep\n');
  fs.writeFileSync(path.join(directory, '.deployed-commit'), `${oldCommit}\n`);

  fs.writeFileSync(path.join(directory, 'server.js'), 'new\n');
  const codeOnlyCommit = commitAll(directory, 'code only');
  assert.equal(spawnSync('git', ['diff', '--quiet', oldCommit, codeOnlyCommit, '--', 'package.json', 'package-lock.json'], { cwd: directory }).status, 0);

  fs.writeFileSync(path.join(directory, 'package.json'), '{"version":"2"}\n');
  const dependencyCommit = commitAll(directory, 'dependencies');
  assert.equal(spawnSync('git', ['diff', '--quiet', codeOnlyCommit, dependencyCommit, '--', 'package.json', 'package-lock.json'], { cwd: directory }).status, 1);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', oldCommit, dependencyCommit], { cwd: directory }).status, 0);

  git(directory, 'reset', '--hard', oldCommit);
  assert.equal(fs.readFileSync(path.join(directory, 'server.js'), 'utf8'), 'old\n');
  assert.equal(fs.readFileSync(path.join(directory, 'environment'), 'utf8'), 'PORT=8214\n');
  assert.equal(fs.readFileSync(path.join(directory, 'apikeys.json'), 'utf8'), '["existing-key"]\n');
  assert.equal(fs.readFileSync(path.join(directory, 'logs', 'production.log'), 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(path.join(directory, '.deployed-commit'), 'utf8'), `${oldCommit}\n`);
  assert.equal(git(directory, 'status', '--porcelain', '--untracked-files=all'), '');
  fs.writeFileSync(path.join(directory, 'server.js'), 'dirty\n');
  assert.notEqual(git(directory, 'status', '--porcelain', '--untracked-files=all'), '');
  git(directory, 'reset', '--hard', oldCommit);
  assert.notEqual(spawnSync('git', ['cat-file', '-e', 'deadbee^{commit}'], { cwd: directory }).status, 0);
});
