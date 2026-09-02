const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const test = require('node:test');

test('versioned deployment operator passes its adversarial Python suite on Linux', (t) => {
  if (process.platform !== 'linux') {
    t.skip(
      'Linux-only operator contract; CI and the Linux local gate execute it.',
    );
    return;
  }
  const testPath = join(
    process.cwd(),
    'test',
    'production',
    'deploy-api-release.test.py',
  );
  const result = spawnSync('python3', [testPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /OK/u);
});
