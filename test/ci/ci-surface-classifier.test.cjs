const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SURFACE_ORDER,
  buildSelection,
  classifyPaths,
  validateDeclaredSurfaces,
} = require('../../scripts/lib/ci-surface-classifier.cjs');
const { buildIntegrityPlan } = require('../../scripts/ci-main-integrity.cjs');
const {
  changedPaths,
  githubOutputs,
  run,
  verifyPullRequestCheckout,
  verifyTreeIdentity,
} = require('../../scripts/ci-surface-classify.cjs');

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const repository = packageJson.name.endsWith('-web') ? 'web' : 'api';

function surfaces(paths, selectedRepository = repository) {
  return classifyPaths(paths, selectedRepository).surfaces;
}

test('classifies the four validation surfaces independently', () => {
  const cases =
    repository === 'api'
      ? [
          ['docs/memory/project-state.v2.json', ['memory']],
          ['src/main.ts', ['app']],
          ['compose.production.yml', ['production']],
          ['scripts/task-validate.cjs', ['tooling']],
        ]
      : [
          ['docs/memory/project-state-pointer.v1.json', ['memory']],
          ['src/main.tsx', ['app']],
          ['vercel.json', ['production']],
          ['scripts/task-validate.cjs', ['tooling']],
        ];
  for (const [path, expected] of cases) {
    assert.deepEqual(surfaces([path]), expected, path);
  }
});

test('classifies required real path families and mixed deltas', () => {
  const apiPaths = [
    'docs/memory/project-state.v2.json',
    'scripts/validate-project-memory.cjs',
    'src/main.ts',
    'Dockerfile',
    'compose.production.yml',
    'docker/production/deploy-api-simple.py',
    'docker/recovery/backup-runner.cjs',
    'test/recovery/recovery-contract.test.cjs',
    '.github/workflows/ci.yml',
    'scripts/task-validate.cjs',
    'schemas/development-operations/task-manifest.v3.schema.json',
    'package.json',
    'package-lock.json',
  ];
  const result = classifyPaths(apiPaths, 'api');
  assert.deepEqual(result.surfaces, SURFACE_ORDER);
  assert.equal(result.modifiers.recovery, true);
  assert.equal(result.modifiers.imageBuildScan, true);
  assert.deepEqual(result.unknownPaths, []);

  const webResult = classifyPaths(
    [
      'docs/memory/project-state-pointer.v1.json',
      'src/main.tsx',
      'scripts/deployment/web-smoke-harness.cjs',
      '.github/workflows/ci.yml',
    ],
    'web',
  );
  assert.deepEqual(webResult.surfaces, SURFACE_ORDER);
});

test('composes app plus production and memory plus tooling without duplicates', () => {
  assert.deepEqual(surfaces(['src/main.ts', 'Dockerfile'], 'api'), [
    'app',
    'production',
  ]);
  assert.deepEqual(
    surfaces(
      ['docs/memory/project-state.v2.json', 'scripts/task-validate.cjs'],
      'api',
    ),
    ['memory', 'tooling'],
  );
});

test('fails closed for unknown paths', () => {
  const classification = classifyPaths(['new-area/unknown.file'], repository);
  assert.deepEqual(classification.surfaces, []);
  assert.deepEqual(classification.unknownPaths, ['new-area/unknown.file']);
  assert.match(
    validateDeclaredSurfaces(classification, ['tooling']).failures.join('\n'),
    /UNKNOWN_CI_SURFACE_PATH/u,
  );
});

test('rejects manifest under-declaration and allows over-declaration', () => {
  const classification = classifyPaths(
    [repository === 'api' ? 'src/main.ts' : 'src/main.tsx'],
    repository,
  );
  assert.match(
    validateDeclaredSurfaces(classification, ['tooling']).failures.join('\n'),
    /MANIFEST_SURFACE_UNDER_DECLARED/u,
  );
  const elevated = buildSelection(classification, ['app', 'production']);
  assert.deepEqual(elevated.failures, []);
  assert.deepEqual(elevated.surfaces, ['app', 'production']);
});

test('full selection is active union with recovery and image proof, not legacy', () => {
  const selection = buildSelection(classifyPaths([], repository), [], {
    full: true,
  });
  assert.deepEqual(selection.surfaces, SURFACE_ORDER);
  assert.equal(selection.modifiers.recovery, true);
  assert.equal(selection.modifiers.imageBuildScan, true);
  assert.equal(selection.modifiers.legacyProduction, false);
});

test('dependency manifests conservatively select app, production and tooling', () => {
  for (const path of ['package.json', 'package-lock.json']) {
    const classification = classifyPaths([path], repository);
    assert.deepEqual(classification.surfaces, ['app', 'production', 'tooling']);
    assert.equal(classification.modifiers.imageBuildScan, true);
  }
});

test('release image workflow adds tooling without widening container files', () => {
  const workflow = classifyPaths(
    ['.github/workflows/release-image.yml'],
    'api',
  );
  assert.deepEqual(workflow.surfaces, ['production', 'tooling']);
  assert.equal(workflow.modifiers.imageBuildScan, true);

  for (const path of ['Dockerfile', '.dockerignore']) {
    const containerFile = classifyPaths([path], 'api');
    assert.deepEqual(containerFile.surfaces, ['production']);
    assert.equal(containerFile.modifiers.imageBuildScan, true);
  }
});

test('ADR-018 paths are explicit legacy Production while ADR-020 stays active', () => {
  const legacy = classifyPaths(
    ['test/production/production-bundle.test.cjs'],
    'api',
  );
  assert.deepEqual(legacy.surfaces, ['production']);
  assert.equal(legacy.modifiers.legacyProduction, true);
  const active = classifyPaths(
    ['docker/production/deploy-api-simple.py'],
    'api',
  );
  assert.deepEqual(active.surfaces, ['production']);
  assert.equal(active.modifiers.legacyProduction, false);
});

test('main integrity plan uses Node built-ins without heavy validation', () => {
  const labels = buildIntegrityPlan(repository).map(([command, args]) =>
    [command, ...args].join(' '),
  );
  assert.ok(labels.includes('node scripts/task-contracts.cjs'));
  assert.ok(
    labels.includes('node scripts/validate-project-memory.cjs --mode local'),
  );
  assert.doesNotMatch(
    labels.join('\n'),
    /npm ci|playwright|docker|trivy|test:e2e|test:integration/u,
  );
});

test('every currently tracked repository path has an explicit classification', () => {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const paths = result.stdout.split('\0').filter(Boolean);
  const classification = classifyPaths(paths, repository);
  assert.deepEqual(classification.unknownPaths, []);
});

test('memory and tooling output never requests a Playwright installation', () => {
  const output = githubOutputs({
    repository: 'web',
    surfaces: ['memory', 'tooling'],
    modifiers: {
      recovery: false,
      imageBuildScan: false,
      legacyProduction: false,
    },
  });
  assert.match(output, /^playwright=false$/mu);
  assert.match(output, /^needs_dependencies=true$/mu);
});

test('verifies merge-ref parent identity and squash tree equivalence', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-ci-identity-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI Contract');
  writeFileSync(join(cwd, 'file.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'candidate');
  writeFileSync(join(cwd, 'file.txt'), 'candidate\n');
  git('commit', '-am', 'candidate');
  const head = git('rev-parse', 'HEAD');
  git('switch', 'main');
  git('merge', '--no-ff', 'candidate', '-m', 'merge ref');
  const merge = git('rev-parse', 'HEAD');
  assert.deepEqual(verifyPullRequestCheckout(base, head, cwd), {
    checkoutSha: merge,
    baseSha: base,
    headSha: head,
  });
  git('reset', '--hard', base);
  git('merge', '--squash', 'candidate');
  git('commit', '-m', 'squash integration');
  const integrated = git('rev-parse', 'HEAD');
  assert.equal(verifyTreeIdentity(head, integrated, cwd).treeSha.length, 40);
});

test('classifies a stale-head PR from the current base to its merge ref', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-ci-stale-base-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'CI Contract');
  writeFileSync(join(cwd, 'seed.txt'), 'base 0\n');
  git('add', '.');
  git('commit', '-m', 'base 0');

  git('switch', '-c', 'candidate');
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(join(cwd, 'scripts', 'task-validate.cjs'), 'feature\n');
  git('add', '.');
  git('commit', '-m', 'feature');
  const head = git('rev-parse', 'HEAD');

  git('switch', 'main');
  writeFileSync(join(cwd, 'base-only-unknown.txt'), 'base 1\n');
  git('add', '.');
  git('commit', '-m', 'base 1');
  const base = git('rev-parse', 'HEAD');
  git('merge', '--no-ff', 'candidate', '-m', 'merge ref');
  const merge = git('rev-parse', 'HEAD');

  assert.deepEqual(changedPaths(base, head, cwd), [
    'base-only-unknown.txt',
    'scripts/task-validate.cjs',
  ]);
  const result = run({ repository, base, head, verifyPullRequest: true }, cwd);
  assert.deepEqual(result.identity, {
    checkoutSha: merge,
    baseSha: base,
    headSha: head,
  });
  assert.deepEqual(result.surfaces, ['tooling']);
  assert.deepEqual(result.unknownPaths, []);
  assert.deepEqual(
    result.reasons.map((reason) => reason.path),
    ['scripts/task-validate.cjs'],
  );
});
