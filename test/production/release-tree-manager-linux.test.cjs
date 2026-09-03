const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('release-tree contract passes the destructive matrix on a disposable Linux filesystem', (t) => {
  if (process.platform !== 'linux') {
    t.skip(
      'Linux-only filesystem contract; CI and the Linux local gate execute it.',
    );
    return;
  }
  const testPath = join(
    process.cwd(),
    'test',
    'production',
    'release-tree-manager.test.py',
  );
  const managerPath = join(
    process.cwd(),
    'docker',
    'production',
    'release-tree-manager.py',
  );
  const managerSource = readFileSync(managerPath, 'utf8');
  assert.match(managerSource, /repair-baseline/u);
  assert.match(managerSource, /restore-baseline-repair/u);
  assert.doesNotMatch(
    managerSource,
    /^\s*(?:import|from)\s+subprocess\b|\b(?:subprocess\.|os\.(?:system|popen|exec))/mu,
    'release-tree manager must remain filesystem-only',
  );
  const command = process.getuid?.() === 0 ? 'python3' : 'sudo';
  const arguments =
    command === 'python3' ? [testPath] : ['-n', 'python3', testPath];
  const result = spawnSync(command, arguments, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT' && process.env.CI !== 'true') {
    t.skip('passwordless sudo is unavailable outside CI');
    return;
  }
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /OK/u);
});
