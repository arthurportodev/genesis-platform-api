const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const test = require('node:test');

test('simple VPS deployment passes its Python and real Linux mechanism suite', (t) => {
  if (process.platform !== 'linux') {
    t.skip('Linux-only filesystem, flock, fsync, and subprocess contract.');
    return;
  }
  const result = spawnSync(
    'python3',
    [join(process.cwd(), 'test', 'production', 'deploy-api-simple.test.py')],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /OK/u);
});
