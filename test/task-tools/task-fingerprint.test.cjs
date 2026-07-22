const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  calculateFingerprint,
  serializeUntrackedEntry,
} = require('../../scripts/task-fingerprint.cjs');
const { createTestRepository, write } = require('./helpers.cjs');

test('is deterministic and includes legitimate untracked content', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/change.md', 'first\n');
  const first = calculateFingerprint({ cwd });
  const second = calculateFingerprint({ cwd });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.untrackedFiles, 1);

  write(cwd, 'docs/change.md', 'second\n');
  const changed = calculateFingerprint({ cwd });
  assert.notEqual(first.fingerprint, changed.fingerprint);
});

test('does not change when only Task Packet content changes', () => {
  const { cwd } = createTestRepository({
    packetIgnored: true,
    manifestOverrides: {
      artifacts: { taskPacket: '.codex/task-packets/test.1.md' },
    },
  });
  write(cwd, '.codex/task-packets/test.1.md', 'first\n');
  write(cwd, 'docs/change.md', 'candidate\n');
  const first = calculateFingerprint({ cwd });
  write(cwd, '.codex/task-packets/test.1.md', 'second\n');
  const second = calculateFingerprint({ cwd });
  assert.equal(first.fingerprint, second.fingerprint);
});

test('ignores non-identity changes to the local manifest', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/change.md', 'candidate\n');
  const first = calculateFingerprint({ cwd });
  const path = join(cwd, '.codex', 'task-manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.task.title = 'A clearer local title';
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  const second = calculateFingerprint({ cwd });
  assert.equal(first.fingerprint, second.fingerprint);
});

test('distinguishes regular files, symlinks and executable mode', () => {
  const content = Buffer.from('SYMLINK\0../outside', 'utf8');
  const regular = serializeUntrackedEntry('docs/link', {
    type: 'file',
    mode: '100644',
    content,
  });
  const executable = serializeUntrackedEntry('docs/link', {
    type: 'file',
    mode: '100755',
    content,
  });
  const symlink = serializeUntrackedEntry('docs/link', {
    type: 'symlink',
    mode: '120000',
    content: Buffer.from('../outside', 'utf8'),
  });
  assert.notDeepEqual(regular, symlink);
  assert.notDeepEqual(regular, executable);
});
