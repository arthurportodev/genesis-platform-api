const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildValidationPlan,
  fullValidationEnvironment,
  npmCommand,
  runValidationPlan,
} = require('../../scripts/task-validate.cjs');
const { validateManifest } = require('../../scripts/lib/task-manifest.cjs');
const {
  DEFAULT_SCRIPTS,
  defaultManifest,
  v3Manifest,
} = require('./helpers.cjs');

const SHA = 'a'.repeat(40);

function manifest(profile, focusedScripts = []) {
  const isCritical = profile === 'critical';
  return validateManifest(
    defaultManifest(SHA, {
      task: {
        id: 'test.1',
        title: 'Task tools test',
        class: isCritical ? 'critical' : 'normal',
      },
      artifacts: isCritical
        ? { taskPacket: '.codex/task-packets/test.1.md' }
        : {},
      validation: { profile, focusedScripts },
    }),
    { scripts: DEFAULT_SCRIPTS },
  );
}

function surfaceManifest(taskClass, surfaces) {
  const critical = taskClass === 'critical';
  return validateManifest(
    v3Manifest(SHA, {
      task: { id: 'surface.1', title: 'Surface task', class: taskClass },
      artifacts: critical
        ? { taskPacket: '.codex/task-packets/surface.1.md' }
        : {},
      validation: { surfaces },
      autonomy: {
        allowHighCorrections: true,
        requireIndependentReverification: critical,
      },
    }),
    { scripts: DEFAULT_SCRIPTS },
  );
}

function labels(taskClass, surfaces) {
  return buildValidationPlan(surfaceManifest(taskClass, surfaces), {
    npm_execpath: '/npm/cli.js',
  }).map((entry) => entry.label);
}

test('critical delegates to the existing full Gate 2 validation', () => {
  const plan = buildValidationPlan(manifest('critical'), {
    npm_execpath: '/npm/cli.js',
  });
  assert.deepEqual(
    plan.map((entry) => entry.label),
    ['npm run gate2:validate'],
  );
});

test('focused runs contracts, declared scripts and candidate fingerprint', () => {
  const plan = buildValidationPlan(manifest('focused', ['test:task-tools']), {
    npm_execpath: '/npm/cli.js',
  });
  assert.deepEqual(
    plan.map((entry) => entry.label),
    [
      'npm run task:preflight',
      'npm run task:contracts',
      'npm run test:task-tools',
      'npm run task:fingerprint -- --json',
    ],
  );
});

test('normal includes static checks, build, task-tool tests and unit tests', () => {
  const labels = buildValidationPlan(manifest('normal'), {
    npm_execpath: '/npm/cli.js',
  }).map((entry) => entry.label);
  assert.deepEqual(labels, [
    'npm run task:preflight',
    'npm run task:contracts',
    'npm run format:check:task-tools',
    'npm run format:check',
    'npm run lint',
    'npm run build',
    'npm run test:task-tools',
    'npm test -- --runInBand',
    'npm run task:fingerprint -- --json',
  ]);
});

test('uses npm_execpath without a shell when available', () => {
  const command = npmCommand(['run', 'test:task-tools'], {
    npm_execpath: 'C:\\npm\\cli.js',
  });
  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args, ['C:\\npm\\cli.js', 'run', 'test:task-tools']);
});

test('uses platform-specific npm executable without npm_execpath', () => {
  assert.equal(npmCommand(['test'], {}, 'win32').command, 'npm.cmd');
  assert.equal(npmCommand(['test'], {}, 'linux').command, 'npm');
});

test('full API validation supplies the isolated database contract without overriding explicit values', () => {
  const defaults = fullValidationEnvironment({ PATH: 'test-path' });
  assert.equal(defaults.DATABASE_HOST, 'localhost');
  assert.equal(defaults.DATABASE_PORT, '5433');
  assert.equal(defaults.TEST_DATABASE_USER, 'genesis_test');
  assert.equal(defaults.PATH, 'test-path');
  assert.equal(
    fullValidationEnvironment({ DATABASE_HOST: 'explicit' }).DATABASE_HOST,
    'explicit',
  );
});

test('stops on first failure and preserves exit code and durations', () => {
  const calls = [];
  const output = [];
  const times = [0, 0, 12, 12, 31, 31];
  const result = runValidationPlan(
    'focused',
    [
      { label: 'first', command: 'first', args: [] },
      { label: 'second', command: 'second', args: [] },
      { label: 'never', command: 'never', args: [] },
    ],
    {
      spawn(command) {
        calls.push(command);
        return { status: command === 'second' ? 7 : 0 };
      },
      now: () => times.shift(),
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => output.push(value) },
    },
  );
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.results[0].durationMs, 12);
  assert.equal(result.results[1].durationMs, 19);
  assert.equal(result.durationMs, 31);
  assert.match(output.join(''), /Validation selection: focused/u);
});

test('Critical plus Tooling includes only tooling surface validation', () => {
  assert.deepEqual(labels('critical', ['tooling']), [
    'npm run task:preflight',
    'npm run task:contracts',
    'npm run format:check:task-tools',
    'npm run test:task-tools',
    'npm run ci:contract:validate',
    'npm run format:check:ci',
    'npm run test:ci',
    'git diff --check',
    'npm run task:fingerprint -- --json',
  ]);
});

test('Critical plus App applies Critical App depth without Production', () => {
  const plan = labels('critical', ['app']);
  assert.deepEqual(plan, [
    'npm run task:preflight',
    'npm run task:contracts',
    'npm run format:check',
    'npm run lint',
    'npm run build',
    'npm test -- --runInBand',
    'npm run test:integration',
    'npm run test:e2e -- --runInBand',
    'git diff --check',
    'npm run task:fingerprint -- --json',
  ]);
  assert.equal(
    plan.some((label) => label.includes('production')),
    false,
  );
  assert.equal(
    plan.some((label) => label.includes('recovery')),
    false,
  );
});

test('Normal plus Memory includes Memory without App or Production', () => {
  assert.deepEqual(labels('normal', ['memory']), [
    'npm run task:preflight',
    'npm run task:contracts',
    'npm run format:check:task-tools',
    'node scripts/validate-project-memory.cjs --mode local',
    'node --test test/project-memory/project-memory.test.cjs',
    'git diff --check',
    'npm run task:fingerprint -- --json',
  ]);
});

test('Critical plus Memory keeps the Memory-only technical plan', () => {
  assert.deepEqual(labels('critical', ['memory']), [
    'npm run task:preflight',
    'npm run task:contracts',
    'npm run format:check:task-tools',
    'node scripts/validate-project-memory.cjs --mode local',
    'node --test test/project-memory/project-memory.test.cjs',
    'git diff --check',
    'npm run task:fingerprint -- --json',
  ]);
});

test('App plus Production composes a deterministic union without duplication', () => {
  const plan = labels('critical', ['production', 'app']);
  assert.equal(plan.includes('npm run test:e2e -- --runInBand'), true);
  assert.equal(
    plan.some((label) =>
      label.includes('test/production/deploy-api-simple-linux.test.cjs'),
    ),
    true,
  );
  assert.equal(
    plan.some((label) => label.includes('recovery')),
    false,
  );
  assert.equal(
    plan.some((label) => label.includes('release-tree')),
    false,
  );
  assert.equal(
    plan.some((label) => label.startsWith('docker build')),
    false,
  );
  assert.equal(new Set(plan).size, plan.length);
});

test('Production modifiers enable Recovery, legacy, and image checks independently', () => {
  const manifest = surfaceManifest('critical', ['production']);
  const plan = buildValidationPlan(
    manifest,
    { npm_execpath: '/npm/cli.js' },
    {
      surfaces: ['production'],
      modifiers: {
        recovery: true,
        legacyProduction: true,
        imageBuildScan: true,
      },
    },
  ).map((entry) => entry.label);
  assert.equal(plan.includes('npm run test:recovery:integration'), true);
  assert.equal(
    plan.some((label) => label.includes('release-tree')),
    true,
  );
  assert.equal(
    plan.includes(
      'docker build --target production -t genesis-platform-api:task-validation .',
    ),
    true,
  );
});

test('full active union keeps ADR-018 legacy validation excluded', () => {
  const manifest = surfaceManifest('critical', ['tooling']);
  const plan = buildValidationPlan(
    manifest,
    { npm_execpath: '/npm/cli.js' },
    {
      surfaces: ['memory', 'app', 'production', 'tooling'],
      modifiers: {
        recovery: true,
        legacyProduction: false,
        imageBuildScan: true,
      },
    },
  ).map((entry) => entry.label);
  assert.equal(
    plan.some((label) => label.includes('release-tree')),
    false,
  );
  assert.equal(
    plan.some((label) => label.includes('production-bundle')),
    false,
  );
  assert.equal(plan.includes('npm run test:recovery:integration'), true);
});

test('base validation runs once for mixed surfaces', () => {
  const plan = labels('critical', ['app', 'tooling']);
  for (const label of [
    'npm run task:preflight',
    'npm run task:contracts',
    'git diff --check',
    'npm run task:fingerprint -- --json',
  ]) {
    assert.equal(plan.filter((entry) => entry === label).length, 1);
  }
});
