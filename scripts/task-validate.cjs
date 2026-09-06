const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { MANIFEST_PATH } = require('./lib/task-candidate.cjs');
const { loadTaskManifest } = require('./lib/task-manifest.cjs');

function npmCommand(args, env = process.env, platform = process.platform) {
  if (env.npm_execpath) {
    return {
      label: `npm ${args.join(' ')}`,
      command: process.execPath,
      args: [env.npm_execpath, ...args],
    };
  }
  return {
    label: `npm ${args.join(' ')}`,
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
  };
}

function directCommand(command, args) {
  return { label: [command, ...args].join(' '), command, args };
}

function deduplicateCommands(commands) {
  const labels = new Set();
  return commands.filter((entry) => {
    if (labels.has(entry.label)) return false;
    labels.add(entry.label);
    return true;
  });
}

function buildLegacyValidationPlan(manifest, env = process.env) {
  const npm = (...args) => npmCommand(args, env);
  const preflight = npm('run', 'task:preflight');
  const contracts = npm('run', 'task:contracts');
  const taskFormat = npm('run', 'format:check:task-tools');
  const fingerprint = npm('run', 'task:fingerprint', '--', '--json');
  switch (manifest.validation.profile) {
    case 'docs':
      return [
        preflight,
        contracts,
        taskFormat,
        {
          label: 'git diff --check',
          command: 'git',
          args: ['diff', '--check'],
        },
        fingerprint,
      ];
    case 'focused':
      return [
        preflight,
        contracts,
        ...manifest.validation.focusedScripts.map((script) =>
          npm('run', script),
        ),
        fingerprint,
      ];
    case 'normal':
      return [
        preflight,
        contracts,
        taskFormat,
        npm('run', 'format:check'),
        npm('run', 'lint'),
        npm('run', 'build'),
        npm('run', 'test:task-tools'),
        npm('test', '--', '--runInBand'),
        fingerprint,
      ];
    case 'critical':
      return [npm('run', 'gate2:validate')];
    default:
      throw new Error(
        `unsupported validation profile: ${manifest.validation.profile}`,
      );
  }
}

function buildSurfaceValidationPlan(manifest, env = process.env) {
  const npm = (...args) => npmCommand(args, env);
  const taskFormat = npm('run', 'format:check:task-tools');
  const surfacePlans = {
    memory: [
      taskFormat,
      directCommand('node', [
        'scripts/validate-project-memory.cjs',
        '--mode',
        'local',
      ]),
      directCommand('node', [
        '--test',
        'test/project-memory/project-memory.test.cjs',
      ]),
    ],
    app: [
      npm('run', 'format:check'),
      npm('run', 'lint'),
      npm('run', 'build'),
      npm('test', '--', '--runInBand'),
      ...(manifest.task.class === 'simple'
        ? []
        : [npm('run', 'test:integration')]),
      ...(manifest.task.class === 'critical'
        ? [npm('run', 'test:e2e', '--', '--runInBand')]
        : []),
    ],
    production: [
      npm('run', 'format:check:production'),
      npm('run', 'test:production'),
      npm('run', 'format:check:recovery'),
      npm('run', 'recovery:validate'),
      npm('run', 'test:recovery'),
      ...(manifest.task.class === 'critical'
        ? [
            npm('run', 'test:recovery:integration'),
            directCommand('docker', [
              'build',
              '--target',
              'production',
              '-t',
              'genesis-platform-api:task-validation',
              '.',
            ]),
          ]
        : []),
    ],
    tooling: [taskFormat, npm('run', 'test:task-tools')],
  };
  const selected = manifest.validation.surfaces.flatMap(
    (surface) => surfacePlans[surface],
  );
  return deduplicateCommands([
    npm('run', 'task:preflight'),
    npm('run', 'task:contracts'),
    ...selected,
    directCommand('git', ['diff', '--check']),
    npm('run', 'task:fingerprint', '--', '--json'),
  ]);
}

function buildValidationPlan(manifest, env = process.env) {
  return manifest.validation.mode === 'legacy-profile'
    ? buildLegacyValidationPlan(manifest, env)
    : buildSurfaceValidationPlan(manifest, env);
}

function validationSelection(manifest) {
  return manifest.validation.mode === 'legacy-profile'
    ? `legacy-profile:${manifest.validation.profile}`
    : `surfaces:${manifest.validation.surfaces.join('+')}`;
}

function runValidationPlan(
  selection,
  plan,
  {
    cwd = process.cwd(),
    env = process.env,
    spawn = spawnSync,
    now = Date.now,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  stdout.write(`Validation selection: ${selection}\n`);
  stdout.write('Commands:\n');
  for (const entry of plan) stdout.write(`- ${entry.label}\n`);

  const totalStartedAt = now();
  const results = [];
  for (const entry of plan) {
    const startedAt = now();
    stdout.write(`\n$ ${entry.label}\n`);
    const result = spawn(entry.command, entry.args, {
      cwd,
      env,
      stdio: 'inherit',
    });
    const exitCode = result.status ?? 1;
    const commandResult = {
      command: entry.label,
      durationMs: now() - startedAt,
      exitCode,
      status: exitCode === 0 ? 'passed' : 'failed',
    };
    results.push(commandResult);
    stdout.write(`${JSON.stringify(commandResult)}\n`);
    if (result.error) stderr.write(`${result.error.message}\n`);
    if (exitCode !== 0) {
      return {
        selection,
        status: 'failed',
        exitCode,
        durationMs: now() - totalStartedAt,
        results,
      };
    }
  }
  return {
    selection,
    status: 'passed',
    exitCode: 0,
    durationMs: now() - totalStartedAt,
    results,
  };
}

function main() {
  try {
    const cwd = process.cwd();
    const manifest = loadTaskManifest({
      manifestPath: join(cwd, ...MANIFEST_PATH.split('/')),
      packageJsonPath: join(cwd, 'package.json'),
    });
    const plan = buildValidationPlan(manifest);
    const result = runValidationPlan(validationSelection(manifest), plan, {
      cwd,
    });
    console.log(
      JSON.stringify({ command: 'npm run task:validate', ...result }),
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  buildValidationPlan,
  buildLegacyValidationPlan,
  buildSurfaceValidationPlan,
  deduplicateCommands,
  npmCommand,
  runValidationPlan,
  validationSelection,
};
