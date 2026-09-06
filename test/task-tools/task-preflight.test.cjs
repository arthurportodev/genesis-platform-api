const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { runPreflight } = require('../../scripts/task-preflight.cjs');
const {
  createTestRepository,
  git,
  v2Manifest,
  v3Manifest,
  write,
} = require('./helpers.cjs');

test('passes a valid scoped candidate', () => {
  const { cwd } = createTestRepository();
  write(cwd, 'docs/change.md', 'valid\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'passed');
  assert.equal(result.normalizedManifestVersion, 3);
  assert.equal(result.untrackedFiles, 1);
});

test('reports normalized validation surfaces for a V3 manifest', () => {
  const { cwd, baseSha } = createTestRepository();
  write(
    cwd,
    '.codex/task-manifest.json',
    `${JSON.stringify(
      v3Manifest(baseSha, {
        validation: { surfaces: ['tooling', 'memory'] },
      }),
      null,
      2,
    )}\n`,
  );
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'passed');
  assert.equal(result.validationMode, 'surfaces');
  assert.deepEqual(result.validationSurfaces, ['memory', 'tooling']);
  assert.deepEqual(result.validationLevels, []);
});

test('fails when a V3 manifest under-declares delta surfaces', () => {
  const { cwd, baseSha } = createTestRepository();
  write(
    cwd,
    '.codex/task-manifest.json',
    `${JSON.stringify(
      v3Manifest(baseSha, {
        scope: {
          allowedPaths: ['docs/**', 'src/**'],
          protectedPaths: ['src/auth/**'],
        },
        validation: { surfaces: ['tooling'] },
      }),
      null,
      2,
    )}\n`,
  );
  write(cwd, 'src/feature.ts', 'export const feature = true;\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.requiredValidationSurfaces, ['app']);
  assert.match(result.failures.join('\n'), /MANIFEST_SURFACE_UNDER_DECLARED/u);
});

test('allows a V3 manifest to over-declare delta surfaces', () => {
  const { cwd, baseSha } = createTestRepository();
  write(
    cwd,
    '.codex/task-manifest.json',
    `${JSON.stringify(
      v3Manifest(baseSha, {
        validation: { surfaces: ['app', 'tooling'] },
      }),
      null,
      2,
    )}\n`,
  );
  write(cwd, 'docs/change.md', 'tooling documentation\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.requiredValidationSurfaces, ['tooling']);
});

test('fails closed when an allowed candidate path has no CI surface rule', () => {
  const { cwd } = createTestRepository({
    manifestOverrides: {
      scope: {
        allowedPaths: ['new-area/**'],
        protectedPaths: ['src/auth/**'],
      },
    },
  });
  write(cwd, 'new-area/unknown.file', 'unknown\n');
  const result = runPreflight({ cwd });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /UNKNOWN_CI_SURFACE_PATH/u);
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

test('cannot hide a tracked candidate behind a V2 artifact path', () => {
  const { cwd, baseSha } = createTestRepository();
  write(
    cwd,
    '.codex/task-manifest.json',
    `${JSON.stringify(
      v2Manifest(baseSha, {
        artifacts: { verifierEvidence: 'docs/evidence.json' },
      }),
      null,
      2,
    )}\n`,
  );
  write(cwd, 'docs/evidence.json', '{"candidate":"hidden"}\n');
  git(cwd, 'add', 'docs/evidence.json');

  const result = runPreflight({ cwd });

  assert.equal(result.status, 'failed');
  assert.ok(result.candidatePaths.includes('docs/evidence.json'));
  assert.match(
    result.failures.join('\n'),
    /verifier evidence artifact is tracked/u,
  );
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
