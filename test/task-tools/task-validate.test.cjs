const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildValidationPlan,
  npmCommand,
  runValidationPlan,
} = require('../../scripts/task-validate.cjs');
const { validateManifest } = require('../../scripts/lib/task-manifest.cjs');
const { DEFAULT_SCRIPTS, defaultManifest } = require('./helpers.cjs');

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

test('critical delegates to the existing full Gate 2 validation', () => {
  const plan = buildValidationPlan(manifest('critical'), {
    npm_execpath: '/npm/cli.js',
  });
  assert.deepEqual(
    plan.map((entry) => entry.label),
    ['npm run gate2:validate'],
  );
});

test('focused runs only preflight and declared allowlisted package scripts', () => {
  const plan = buildValidationPlan(manifest('focused', ['test:task-tools']), {
    npm_execpath: '/npm/cli.js',
  });
  assert.deepEqual(
    plan.map((entry) => entry.label),
    ['npm run task:preflight', 'npm run test:task-tools'],
  );
});

test('normal includes static checks, build, task-tool tests and unit tests', () => {
  const labels = buildValidationPlan(manifest('normal'), {
    npm_execpath: '/npm/cli.js',
  }).map((entry) => entry.label);
  assert.deepEqual(labels, [
    'npm run task:preflight',
    'npm run format:check:task-tools',
    'npm run format:check',
    'npm run lint',
    'npm run build',
    'npm run test:task-tools',
    'npm test -- --runInBand',
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
  assert.match(output.join(''), /Validation profile: focused/u);
});
