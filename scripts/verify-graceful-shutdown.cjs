const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const RUNTIME_NODE = '/nodejs/bin/node';
const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:af194ccf3e2d7fe367012c7b88ce8b816c5c889b18a5b316799a1f0d7eac746a';
const EXTERNAL_DEADLINE_MS = 15_000;
const DEFAULT_RUNS = 10;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function runAsync(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function docker(args, options) {
  return run('docker', args, options);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, operation, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `${description} timed out: ${lastError?.message ?? 'unknown'}`,
  );
}

function count(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function lifecycleProbeSource(apiName) {
  return `
const http = require('node:http');
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const fail = (reason) => { console.error(reason); process.exit(1); };
const timeout = setTimeout(() => fail('probe-timeout'), 14500);
const pass = () => {
  clearTimeout(timeout);
  agent.destroy();
  console.log('PROBE_PASSED');
};
const request = http.request({
  host: ${JSON.stringify(apiName)},
  port: 3000,
  path: '/api/v1/health/ready',
  method: 'POST',
  agent,
  headers: {
    'content-type': 'application/json',
    'content-length': '2',
    connection: 'keep-alive',
  },
}, (response) => {
  response.resume();
  response.once('end', () => {
    const next = http.get({
      host: ${JSON.stringify(apiName)},
      port: 3000,
      path: '/api/v1/health/ready',
      agent,
    }, (drainingResponse) => {
      if (drainingResponse.statusCode !== 503) {
        drainingResponse.resume();
        fail('new-request-not-rejected-during-draining:' + drainingResponse.statusCode);
        return;
      }
      const drainingSocket = drainingResponse.socket;
      drainingResponse.resume();
      drainingResponse.once('end', () => {
        if (drainingSocket.destroyed) pass();
        else drainingSocket.once('close', pass);
      });
    });
    next.once('error', () => {
      pass();
    });
  });
});
request.once('error', (error) => fail('inflight-request-failed:' + error.code));
request.write('{');
console.log('INFLIGHT_READY');
setTimeout(() => request.end('}'), 1500);
`;
}

async function main() {
  const image =
    process.env.PRODUCTION_IMAGE ?? 'genesis-platform-api:gate2-f011-corrected';
  const runs = Number(process.env.SHUTDOWN_RUNS ?? DEFAULT_RUNS);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error('SHUTDOWN_RUNS must be a positive integer.');
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const network = `genesis-f011-${suffix}`;
  const postgres = `genesis-f011-postgres-${suffix}`;
  const results = [];

  try {
    docker(['network', 'create', network]);
    docker([
      'run',
      '-d',
      '--name',
      postgres,
      '--network',
      network,
      '--network-alias',
      'postgres',
      '-e',
      'POSTGRES_DB=genesis_platform_test',
      '-e',
      'POSTGRES_USER=genesis_test',
      '-e',
      'POSTGRES_PASSWORD=synthetic-test-only',
      POSTGRES_IMAGE,
    ]);
    await waitFor('PostgreSQL readiness', () =>
      docker([
        'exec',
        postgres,
        'pg_isready',
        '-U',
        'genesis_test',
        '-d',
        'genesis_platform_test',
      ]),
    );

    for (let index = 1; index <= runs; index += 1) {
      const api = `genesis-f011-api-${suffix}-${index}`;
      const probe = `genesis-f011-probe-${suffix}-${index}`;
      try {
        docker([
          'run',
          '-d',
          '--name',
          api,
          '--network',
          network,
          '--read-only',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=16m',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--pids-limit',
          '100',
          '-e',
          'NODE_ENV=production',
          '-e',
          'APP_NAME=Genesis Platform API',
          '-e',
          'APP_VERSION=0.1.0',
          '-e',
          'DATABASE_HOST=postgres',
          '-e',
          'DATABASE_NAME=genesis_platform_test',
          '-e',
          'DATABASE_USER=genesis_test',
          '-e',
          'DATABASE_PASSWORD=synthetic-test-only',
          '-e',
          'DATABASE_RUNTIME_ROLE=genesis_test',
          '-e',
          'FRONTEND_URL=https://app.example.com',
          '-e',
          'JWT_ACCESS_SECRET=synthetic-access-secret-with-at-least-32-characters',
          '-e',
          'REFRESH_TOKEN_PEPPER=synthetic-refresh-pepper-with-at-least-32-characters',
          image,
        ]);
        await waitFor(`API readiness run ${index}`, () =>
          docker([
            'exec',
            api,
            RUNTIME_NODE,
            '-e',
            "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(response=>process.exit(response.status===200?0:1)).catch(()=>process.exit(1))",
          ]),
        );

        docker([
          'run',
          '-d',
          '--name',
          probe,
          '--network',
          network,
          '--entrypoint',
          RUNTIME_NODE,
          image,
          '-e',
          lifecycleProbeSource(api),
        ]);
        await waitFor(`in-flight probe run ${index}`, () => {
          const logs = docker(['logs', probe]).stdout;
          if (!logs.includes('INFLIGHT_READY')) {
            throw new Error('probe has not opened its in-flight request');
          }
          return logs;
        });

        const started = performance.now();
        const stop = runAsync(
          'docker',
          ['stop', '--time', '15', api],
          EXTERNAL_DEADLINE_MS + 5_000,
        );
        await delay(50);
        docker(['kill', '--signal', 'SIGINT', api]);
        await stop;
        const durationMs = performance.now() - started;

        const state = JSON.parse(
          docker(['inspect', api, '--format', '{{json .State}}']).stdout,
        );
        const logs = docker(['logs', api]).stdout;
        const probeExitCode = Number(docker(['wait', probe]).stdout.trim());
        const probeLogResult = docker(['logs', probe]);
        const probeLogs = probeLogResult.stdout + probeLogResult.stderr;
        const drainingEvents = count(logs, /"event":"runtime\.draining"/gu);
        const stoppedEvents = count(logs, /"event":"runtime\.stopped"/gu);
        const timeoutEvents = count(
          logs,
          /"event":"runtime\.shutdown_timeout"/gu,
        );

        if (state.ExitCode !== 0) throw new Error(`run ${index}: exit code`);
        if (durationMs >= EXTERNAL_DEADLINE_MS) {
          throw new Error(`run ${index}: external deadline exceeded`);
        }
        if (
          drainingEvents !== 1 ||
          stoppedEvents !== 1 ||
          timeoutEvents !== 0
        ) {
          throw new Error(`run ${index}: lifecycle log cardinality`);
        }
        if (probeExitCode !== 0 || !probeLogs.includes('PROBE_PASSED')) {
          throw new Error(
            `run ${index}: request/keep-alive probe failed ` +
              `(exit=${probeExitCode}, logs=${JSON.stringify(probeLogs)})`,
          );
        }

        results.push({
          run: index,
          durationMs: Number(durationMs.toFixed(3)),
          exitCode: state.ExitCode,
          drainingEvents,
          stoppedEvents,
          timeoutEvents,
          secondSignal: 'SIGINT',
          inFlightRequest: 'completed',
          newRequestAfterDraining: 'rejected',
          keepAlive: 'closed',
        });
      } finally {
        docker(['rm', '-f', probe], { allowFailure: true });
        docker(['rm', '-f', api], { allowFailure: true });
      }
    }
  } finally {
    docker(['rm', '-f', postgres], { allowFailure: true });
    docker(['network', 'rm', network], { allowFailure: true });
  }

  const durations = results.map((result) => result.durationMs);
  const evidence = {
    taskId: '0.8.2',
    findingId: '0.8.2-F011',
    image,
    externalDeadlineMs: EXTERNAL_DEADLINE_MS,
    runs: results.length,
    minimumMs: Math.min(...durations),
    maximumMs: Math.max(...durations),
    meanMs: Number(
      (
        durations.reduce((total, value) => total + value, 0) / durations.length
      ).toFixed(3),
    ),
    p95Ms: percentile95(durations),
    failures: 0,
    exitCodes: results.map((result) => result.exitCode),
    results,
  };
  process.stdout.write(`F011_SHUTDOWN_EVIDENCE=${JSON.stringify(evidence)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
