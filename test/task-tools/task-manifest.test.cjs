const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  ManifestValidationError,
  loadTaskManifest,
  matchesAny,
  validateManifest,
} = require('../../scripts/lib/task-manifest.cjs');
const { DEFAULT_SCRIPTS, defaultManifest } = require('./helpers.cjs');

const SHA = 'a'.repeat(40);
const PACKAGE_JSON = { scripts: DEFAULT_SCRIPTS };

function validate(overrides = {}) {
  return validateManifest(defaultManifest(SHA, overrides), PACKAGE_JSON);
}

test('accepts a valid manifest', () => {
  const manifest = validate();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.git.baseSha, SHA);
  assert.equal(manifest.git.requireCleanStage, true);
});

test('rejects invalid JSON', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'manifest-json-'));
  const manifestPath = join(cwd, 'manifest.json');
  const packagePath = join(cwd, 'package.json');
  writeFileSync(manifestPath, '{invalid');
  writeFileSync(packagePath, JSON.stringify(PACKAGE_JSON));
  assert.throws(
    () => loadTaskManifest({ manifestPath, packageJsonPath: packagePath }),
    /invalid JSON/u,
  );
});

test('rejects unsupported version and unknown relevant fields', () => {
  assert.throws(() => validate({ version: 2 }), /version must be 1/u);
  const raw = defaultManifest(SHA);
  raw.scope.unreviewed = true;
  assert.throws(
    () => validateManifest(raw, PACKAGE_JSON),
    /unknown field.*unreviewed/u,
  );
});

test('rejects incomplete SHA and unknown class or profile', () => {
  assert.throws(
    () => validate({ git: { branch: 'task/test-tools', baseSha: 'abc' } }),
    /full lowercase 40-character SHA/u,
  );
  assert.throws(
    () =>
      validate({
        task: { id: 'test.1', title: 'Test', class: 'urgent' },
      }),
    /class is unknown/u,
  );
  assert.throws(
    () =>
      validate({
        validation: { profile: 'fast', focusedScripts: [] },
      }),
    /profile is unknown/u,
  );
});

test('rejects absolute, parent and repository-wide paths', () => {
  for (const path of [
    '/etc/passwd',
    'C:/Windows/System32',
    '../outside',
    ':(top)outside',
  ]) {
    assert.throws(
      () =>
        validate({
          scope: { allowedPaths: [path], protectedPaths: ['src/auth/**'] },
        }),
      ManifestValidationError,
    );
  }
  assert.throws(
    () =>
      validate({
        scope: { allowedPaths: ['**'], protectedPaths: ['src/auth/**'] },
      }),
    /without allowBroadPaths/u,
  );
});

test('allows an explicitly declared repository-wide path', () => {
  const manifest = validate({
    scope: {
      allowedPaths: ['**'],
      protectedPaths: ['src/auth/**'],
      allowBroadPaths: true,
    },
  });
  assert.deepEqual(manifest.scope.allowedPaths, ['**']);
});

test('rejects overlap and missing focused scripts', () => {
  assert.throws(
    () =>
      validate({
        scope: {
          allowedPaths: ['docs/**'],
          protectedPaths: ['docs/**'],
        },
      }),
    /overlap/u,
  );
  assert.throws(
    () =>
      validate({
        validation: { profile: 'focused', focusedScripts: ['shell command'] },
      }),
    /does not exist/u,
  );
  assert.throws(
    () =>
      validate({
        validation: { profile: 'focused', focusedScripts: [] },
      }),
    /requires at least one/u,
  );
});

test('rejects mutating, destructive, recursive and lifecycle focused scripts', () => {
  for (const script of ['format', 'migration:revert', 'task:validate']) {
    assert.throws(
      () =>
        validate({
          validation: { profile: 'focused', focusedScripts: [script] },
        }),
      /read-only validation allowlist/u,
    );
  }
  assert.throws(
    () =>
      validateManifest(
        defaultManifest(SHA, {
          validation: { profile: 'focused', focusedScripts: ['test'] },
        }),
        { scripts: { ...DEFAULT_SCRIPTS, pretest: 'node mutate.js' } },
      ),
    /lifecycle hook/u,
  );
});

test('requires Critical tasks to use a Task Packet and critical profile', () => {
  const task = { id: 'test.critical', title: 'Critical', class: 'critical' };
  assert.throws(
    () =>
      validate({
        task,
        validation: { profile: 'docs', focusedScripts: [] },
      }),
    /critical validation profile/u,
  );
  assert.throws(
    () =>
      validate({
        task,
        validation: { profile: 'critical', focusedScripts: [] },
      }),
    /requires a Task Packet/u,
  );
  const valid = validate({
    task,
    artifacts: { taskPacket: '.codex/task-packets/test.critical.md' },
    validation: { profile: 'critical', focusedScripts: [] },
  });
  assert.equal(valid.validation.profile, 'critical');
});

test('rejects semantic repository-wide glob variants', () => {
  for (const glob of ['**/**', '**/**/**']) {
    assert.throws(
      () =>
        validate({
          scope: { allowedPaths: [glob], protectedPaths: ['src/auth/**'] },
        }),
      /without allowBroadPaths/u,
    );
  }
});

test('matches repository paths consistently on Windows and Unix', () => {
  assert.equal(matchesAny('scripts/task.cjs', ['scripts/**']), true);
  assert.equal(matchesAny('scripts\\task.cjs', ['scripts/**']), true);
  assert.equal(matchesAny('src/auth/token.ts', ['src/**']), true);
  assert.equal(matchesAny('src/auth/token.ts', ['docs/**']), false);
});
