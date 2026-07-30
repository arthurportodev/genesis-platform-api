const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  calculateFingerprint,
  serializeCanonicalEntry,
  serializeUntrackedEntry,
  verifyExpectedGitTransition,
} = require('../../scripts/task-fingerprint.cjs');
const {
  createTestRepository,
  git,
  v2Manifest,
  write,
} = require('./helpers.cjs');

function setManifestBase(cwd, baseSha) {
  const path = join(cwd, '.codex', 'task-manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.git.baseSha = baseSha;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('is deterministic and includes legitimate untracked content', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/change.md', 'first\n');
  const first = calculateFingerprint({ cwd });
  const second = calculateFingerprint({ cwd });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.contentFingerprint, second.contentFingerprint);
  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.untrackedFiles, 1);

  write(cwd, 'docs/change.md', 'second\n');
  const changed = calculateFingerprint({ cwd });
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.notEqual(first.contentFingerprint, changed.contentFingerprint);
});

test('keeps content identity stable across untracked to tracked', () => {
  const { cwd, baseSha } = createTestRepository();
  write(
    cwd,
    '.codex/task-manifest.json',
    `${JSON.stringify(v2Manifest(baseSha), null, 2)}\n`,
  );
  write(cwd, 'docs/change.md', 'candidate\n');
  const untracked = calculateFingerprint({ cwd });
  git(cwd, 'add', 'docs/change.md');
  const tracked = calculateFingerprint({ cwd });
  assert.equal(untracked.contentFingerprint, tracked.contentFingerprint);
  assert.equal(untracked.candidateId, tracked.candidateId);
  assert.notEqual(untracked.gitStateFingerprint, tracked.gitStateFingerprint);
  assert.notEqual(untracked.legacyFingerprint, tracked.legacyFingerprint);
  assert.equal(verifyExpectedGitTransition(untracked, tracked).allowed, false);
  assert.deepEqual(
    verifyExpectedGitTransition(untracked, tracked, ['untracked-to-tracked']),
    { allowed: true, stateChanged: true, failures: [] },
  );

  const referencePath = join(cwd, '.git', 'approved-candidate.json');
  writeFileSync(referencePath, JSON.stringify(untracked));
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'task-fingerprint.cjs'),
        '--verify-transition',
        referencePath,
      ],
      { cwd, encoding: 'utf8' },
    ),
  );
  assert.equal(cli.verification.allowed, true);

  const changedDeclaration = {
    ...tracked,
    expectedTransitions: [],
  };
  assert.match(
    verifyExpectedGitTransition(
      untracked,
      changedDeclaration,
      untracked.expectedTransitions,
    ).failures.join('\n'),
    /declared Git transitions changed/u,
  );
});

test('rejects a stale or partially staged index even when worktree content is unchanged', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/change.md', 'base\n');
  git(cwd, 'add', 'docs/change.md');
  git(cwd, 'commit', '-m', 'tracked fixture');
  setManifestBase(cwd, git(cwd, 'rev-parse', 'HEAD'));

  write(cwd, 'docs/change.md', 'approved candidate\n');
  const approved = calculateFingerprint({ cwd });
  git(cwd, 'add', 'docs/change.md');
  git(cwd, 'reset', 'HEAD', '--', 'docs/change.md');
  const staleIndex = calculateFingerprint({ cwd });
  const verification = verifyExpectedGitTransition(approved, staleIndex, [
    'untracked-to-tracked',
  ]);

  assert.equal(approved.contentFingerprint, staleIndex.contentFingerprint);
  assert.notEqual(
    approved.contentFingerprint,
    staleIndex.indexSnapshot.contentFingerprint,
  );
  assert.equal(verification.allowed, false);
  assert.match(verification.failures.join('\n'), /index\/commit content/u);
});

test('uses Git clean-filter identity across EOL normalization', () => {
  const { cwd } = createTestRepository();
  write(cwd, '.gitattributes', '* text=auto eol=lf\n');
  git(cwd, 'add', '.gitattributes');
  git(cwd, 'commit', '-m', 'canonical line endings');
  setManifestBase(cwd, git(cwd, 'rev-parse', 'HEAD'));

  write(cwd, 'docs/eol.md', 'first\r\nsecond\r\n');
  const untracked = calculateFingerprint({ cwd });
  git(cwd, 'add', 'docs/eol.md');
  const staged = calculateFingerprint({ cwd });

  assert.equal(untracked.contentFingerprint, staged.contentFingerprint);
  assert.equal(
    untracked.contentFingerprint,
    staged.indexSnapshot.contentFingerprint,
  );
});

test('detects additional paths and executable mode changes', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/change.md', 'candidate\n');
  git(cwd, 'add', 'docs/change.md');
  const regular = calculateFingerprint({ cwd });
  write(cwd, 'docs/additional.md', 'additional\n');
  const additional = calculateFingerprint({ cwd });
  assert.notEqual(regular.contentFingerprint, additional.contentFingerprint);

  require('node:fs').unlinkSync(join(cwd, 'docs', 'additional.md'));
  git(cwd, 'update-index', '--chmod=+x', 'docs/change.md');
  const executable = calculateFingerprint({ cwd });
  assert.notEqual(regular.contentFingerprint, executable.contentFingerprint);
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
  assert.deepEqual(
    serializeCanonicalEntry(
      'docs/link',
      symlink && {
        type: 'symlink',
        mode: '120000',
        content: Buffer.from('../outside', 'utf8'),
      },
    ),
    symlink,
  );
});

test('represents deleted and irregular entries distinctly', () => {
  const deleted = serializeCanonicalEntry('docs/value', {
    type: 'deleted',
    mode: '000000',
    content: Buffer.alloc(0),
  });
  const irregular = serializeCanonicalEntry('docs/value', {
    type: 'other',
    mode: null,
    content: Buffer.alloc(0),
  });
  assert.notDeepEqual(deleted, irregular);
  const { cwd } = createTestRepository();
  mkdirSync(join(cwd, 'docs'));
  const entry =
    require('../../scripts/lib/task-candidate.cjs').readCandidateEntry(
      cwd,
      'docs',
    );
  assert.equal(entry.type, 'other');
});
