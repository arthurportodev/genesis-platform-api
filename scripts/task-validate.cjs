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

function buildValidationPlan(manifest, env = process.env) {
  const npm = (...args) => npmCommand(args, env);
  const preflight = npm('run', 'task:preflight');
  const taskFormat = npm('run', 'format:check:task-tools');
  switch (manifest.validation.profile) {
    case 'docs':
      return [
        preflight,
        taskFormat,
        {
          label: 'git diff --check',
          command: 'git',
          args: ['diff', '--check'],
        },
      ];
    case 'focused':
      return [
        preflight,
        ...manifest.validation.focusedScripts.map((script) =>
          npm('run', script),
        ),
      ];
    case 'normal':
      return [
        preflight,
        taskFormat,
        npm('run', 'format:check'),
        npm('run', 'lint'),
        npm('run', 'build'),
        npm('run', 'test:task-tools'),
        npm('test', '--', '--runInBand'),
      ];
    case 'critical':
      return [npm('run', 'gate2:validate')];
    default:
      throw new Error(
        `unsupported validation profile: ${manifest.validation.profile}`,
      );
  }
}

function runValidationPlan(
  profile,
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
  stdout.write(`Validation profile: ${profile}\n`);
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
        profile,
        status: 'failed',
        exitCode,
        durationMs: now() - totalStartedAt,
        results,
      };
    }
  }
  return {
    profile,
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
    const result = runValidationPlan(manifest.validation.profile, plan, {
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
  npmCommand,
  runValidationPlan,
};
