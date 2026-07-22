const { spawnSync } = require('node:child_process');

const npmCli = process.env.npm_execpath;
const results = [];
let databaseStarted = false;

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const suites = combined.match(/Test Suites:\s+([^\r\n]+)/u)?.[1] ?? null;
  const tests = combined.match(/Tests:\s+([^\r\n]+)/u)?.[1] ?? null;
  const entry = {
    command: options.displayCommand ?? [command, ...args].join(' '),
    durationMs: Date.now() - startedAt,
    suites,
    tests,
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status ?? 1,
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
  if (result.status !== 0 && !options.cleanup) {
    throw Object.assign(new Error(entry.command), {
      exitCode: result.status ?? 1,
    });
  }
  return entry;
}

function runNpm(args, options = {}) {
  if (!npmCli) {
    throw Object.assign(new Error('npm_execpath is unavailable.'), {
      exitCode: 1,
    });
  }
  return run(process.execPath, [npmCli, ...args], {
    ...options,
    displayCommand: ['npm', ...args].join(' '),
  });
}

let exitCode = 0;
try {
  runNpm(['run', 'task:preflight']);
  runNpm(['run', 'db:test:env']);
  runNpm(['run', 'test:db:up']);
  databaseStarted = true;
  runNpm(['run', 'format:check']);
  runNpm(['run', 'lint']);
  runNpm(['run', 'build']);
  runNpm(['test', '--', '--runInBand']);
  runNpm(['run', 'test:integration']);
  runNpm(['run', 'test:e2e', '--', '--runInBand']);
  run('docker', [
    'build',
    '--target',
    'production',
    '-t',
    'genesis-platform-api:gate2-local',
    '.',
  ]);
} catch (error) {
  exitCode = Number(error.exitCode) || 1;
} finally {
  if (databaseStarted) {
    try {
      const cleanup = runNpm(['run', 'test:db:down'], { cleanup: true });
      if (cleanup.exitCode !== 0 && exitCode === 0) exitCode = cleanup.exitCode;
    } catch {
      if (exitCode === 0) exitCode = 1;
    }
  }
  console.log(
    JSON.stringify({
      command: 'npm run gate2:validate',
      status: exitCode === 0 ? 'passed' : 'failed',
      sha: spawnSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).stdout.trim(),
      results,
    }),
  );
}
process.exit(exitCode);
