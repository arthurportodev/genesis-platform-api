const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { runPreflight } = require('../../scripts/task-preflight.cjs');
const { createTestRepository, git, write } = require('./helpers.cjs');

test('passes a valid scoped candidate', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/change.md', 'valid\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'passed');
  assert.equal(result.untrackedFiles, 1);
});

test('detects a branch mismatch', () => {
  const { cwd } = createTestRepository();
  git(cwd, 'switch', '-c', 'wrong-branch');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /branch mismatch/u);
});

test('detects when HEAD is not based on the declared base SHA', () => {
  const { cwd } = createTestRepository();
  const path = join(cwd, '.codex', 'task-manifest.json');
  const manifest = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
  manifest.git.baseSha = 'f'.repeat(40);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /HEAD is not based/u);
});

test('detects a file outside allowed scope', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'outside.txt', 'outside\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /outside allowed scope/u);
});

test('detects a protected path even when a broader path is allowed', () => {
  const { cwd } = createTestRepository({
    manifestOverrides: {
      scope: {
        allowedPaths: ['src/**'],
        protectedPaths: ['src/auth/**'],
      },
    },
  });
  write(cwd, 'src/auth/token.ts', 'protected\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /protected path changed/u);
});

test('detects a non-ignored Task Packet', () => {
  const { cwd } = createTestRepository({
    manifestOverrides: {
      artifacts: { taskPacket: '.codex/task-packets/test.1.md' },
    },
  });
  write(cwd, '.codex/task-packets/test.1.md', '# Packet\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /Task Packet is not ignored/u);
});

test('detects staged files when a clean stage is required', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/staged.md', 'staged\n');
  git(cwd, 'add', 'docs/staged.md');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /stage is not empty/u);
});

test('detects real environment files and obvious secrets', () => {
  const { cwd } = createTestRepository({
    manifestOverrides: {
      scope: {
        allowedPaths: ['docs/**', '.env.local'],
        protectedPaths: ['src/auth/**'],
      },
    },
  });
  write(cwd, '.env.local', 'TOKEN=not-a-real-token\n');
  let result = runPreflight({ cwd });
  assert.match(result.failures.join('\n'), /environment file/u);

  mkdirSync(join(cwd, 'docs'), { recursive: true });
  writeFileSync(
    join(cwd, 'docs', 'secret.md'),
    `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\nfixture\n`,
  );
  result = runPreflight({ cwd });
  assert.match(result.failures.join('\n'), /possible secret/u);
});
