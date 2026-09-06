const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { MANIFEST_PATH } = require('./lib/task-candidate.cjs');
const { inspectCandidate } = require('./lib/task-candidate.cjs');
const {
  SURFACE_ORDER,
  classifyPaths,
} = require('./lib/ci-surface-classifier.cjs');
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

function buildSurfaceValidationPlan(
  manifest,
  env = process.env,
  { surfaces = manifest.validation.surfaces, modifiers = {} } = {},
) {
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
      npm(
        'exec',
        '--',
        'prettier',
        '--check',
        'compose.production.yml',
        'scripts/validate-production-compose.cjs',
        'test/production/functional-proxy-contract.test.cjs',
        'test/production/production-compose.test.cjs',
        'test/production/production-image.test.cjs',
        'test/production/production-runtime.test.cjs',
        'test/production/production-secret-wrappers.test.cjs',
        'test/production/deploy-api-simple-linux.test.cjs',
      ),
      directCommand('node', [
        '--test',
        'test/production/functional-proxy-contract.test.cjs',
        'test/production/production-compose.test.cjs',
        'test/production/production-image.test.cjs',
        'test/production/production-runtime.test.cjs',
        'test/production/production-secret-wrappers.test.cjs',
        'test/production/deploy-api-simple-linux.test.cjs',
      ]),
      ...(modifiers.recovery
        ? [
            npm('run', 'format:check:recovery'),
            npm('run', 'recovery:validate'),
            npm('run', 'test:recovery'),
            ...(manifest.task.class === 'critical'
              ? [npm('run', 'test:recovery:integration')]
              : []),
          ]
        : []),
      ...(modifiers.legacyProduction
        ? [
            directCommand('node', [
              '--test',
              'test/production/production-bundle.test.cjs',
              'test/production/deploy-api-release-linux.test.cjs',
              'test/production/release-tree-manager-linux.test.cjs',
            ]),
          ]
        : []),
      ...(modifiers.imageBuildScan
        ? [
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
    tooling: [
      taskFormat,
      npm('run', 'test:task-tools'),
      npm('run', 'ci:contract:validate'),
      npm('run', 'format:check:ci'),
      npm('run', 'test:ci'),
    ],
  };
  const selected = surfaces.flatMap((surface) => surfacePlans[surface]);
  return deduplicateCommands([
    npm('run', 'task:preflight'),
    npm('run', 'task:contracts'),
    ...selected,
    directCommand('git', ['diff', '--check']),
    npm('run', 'task:fingerprint', '--', '--json'),
  ]);
}

function buildValidationPlan(manifest, env = process.env, selection) {
  return manifest.validation.mode === 'legacy-profile'
    ? buildLegacyValidationPlan(manifest, env)
    : buildSurfaceValidationPlan(manifest, env, selection);
}

function validationSelection(manifest) {
  return manifest.validation.mode === 'legacy-profile'
    ? `legacy-profile:${manifest.validation.profile}`
    : `surfaces:${manifest.validation.surfaces.join('+')}`;
}

function fullValidationEnvironment(env = process.env) {
  return {
    ...env,
    TEST_DATABASE_HOST: env.TEST_DATABASE_HOST ?? 'localhost',
    TEST_DATABASE_PORT: env.TEST_DATABASE_PORT ?? '5433',
    TEST_DATABASE_NAME: env.TEST_DATABASE_NAME ?? 'genesis_platform_test',
    TEST_DATABASE_USER: env.TEST_DATABASE_USER ?? 'genesis_test',
    TEST_DATABASE_PASSWORD: env.TEST_DATABASE_PASSWORD ?? 'test-only',
    DATABASE_HOST: env.DATABASE_HOST ?? 'localhost',
    DATABASE_PORT: env.DATABASE_PORT ?? '5433',
    DATABASE_NAME: env.DATABASE_NAME ?? 'genesis_platform_test',
    DATABASE_USER: env.DATABASE_USER ?? 'genesis_runtime_test',
    DATABASE_PASSWORD: env.DATABASE_PASSWORD ?? 'runtime-test-only',
    DATABASE_RUNTIME_ROLE: env.DATABASE_RUNTIME_ROLE ?? 'genesis_runtime_test',
    DATABASE_MIGRATION_USER: env.DATABASE_MIGRATION_USER ?? 'genesis_test',
    DATABASE_MIGRATION_PASSWORD: env.DATABASE_MIGRATION_PASSWORD ?? 'test-only',
  };
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
    const full = process.argv.slice(2).includes('--full');
    const candidate = inspectCandidate(manifest, cwd);
    const classification = classifyPaths(
      [...candidate.tracked, ...candidate.untracked],
      'api',
    );
    const selection = full
      ? {
          surfaces: [...SURFACE_ORDER],
          modifiers: {
            recovery: true,
            imageBuildScan: true,
            legacyProduction: false,
          },
        }
      : {
          surfaces: manifest.validation.surfaces,
          modifiers: classification.modifiers,
        };
    const plan = buildValidationPlan(manifest, process.env, selection);
    const selectedLabel = full
      ? 'surfaces:memory+app+production+tooling (full active)'
      : validationSelection(manifest);
    const result = runValidationPlan(selectedLabel, plan, {
      cwd,
      env: full ? fullValidationEnvironment() : process.env,
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
  fullValidationEnvironment,
  npmCommand,
  runValidationPlan,
  validationSelection,
};
