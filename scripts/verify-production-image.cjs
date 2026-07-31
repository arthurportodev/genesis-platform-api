const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { dirname, resolve } = require('node:path');
const { calculateFingerprint } = require('./task-fingerprint.cjs');
const {
  validateEnvironmentEvidence,
} = require('./verify-environment-evidence.cjs');

const BASE_SHA = 'aedafa41eff756ce0e66ed559e91e0ae2d610847';
const BASE_REFERENCE =
  'gcr.io/distroless/nodejs24-debian13:nonroot-amd64@sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514';
const BASE_INDEX_DIGEST =
  'sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212';
const BASE_MANIFEST_DIGEST =
  'sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514';
const RUNTIME_NODE = '/nodejs/bin/node';
const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:af194ccf3e2d7fe367012c7b88ce8b816c5c889b18a5b316799a1f0d7eac746a';
const REQUIRED_INVARIANTS = [
  'linux-runtime',
  'amd64-image',
  'base-digest',
  'runtime-files',
  'production-dependencies-only',
  'non-root',
  'read-only-app',
  'writable-tmp',
  'capabilities-dropped',
  'no-new-privileges',
  'node-pid-1',
  'liveness',
  'readiness',
  'postgres-unavailable',
  'postgres-recovery',
  'dns',
  'ca-certificates',
  'secret-absence',
  'sigterm',
  'shutdown-deadline',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    timeout: options.timeout ?? 60_000,
  });
  const completedAt = new Date().toISOString();
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${options.displayCommand ?? `${command} ${args.join(' ')}`} failed: ${stderr || stdout}`,
    );
  }
  return {
    stdout,
    stderr,
    status: result.status ?? 1,
    evidence: {
      command: options.displayCommand ?? `${command} ${args.join(' ')}`,
      startedAt,
      completedAt,
      exitCode: result.status ?? 1,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
    },
  };
}

function docker(args, options = {}) {
  return run('docker', args, options);
}

function dockerExec(container, source, displayCommand) {
  return docker(['exec', container, RUNTIME_NODE, '-e', source], {
    displayCommand,
  });
}

function waitFor(description, operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error(
    `${description} timed out: ${lastError?.message ?? 'unknown'}`,
  );
}

function invariant(name, evidence) {
  return { name, required: true, result: 'passed', evidence };
}

function main() {
  const image =
    process.env.PRODUCTION_IMAGE ?? 'genesis-platform-api:gate2-local';
  const outputPath =
    process.env.ENVIRONMENT_EVIDENCE_PATH ??
    '.codex/task-packets/0.8.2-environment.json';
  const sbomPath = process.env.SBOM_PATH;
  const scanPath = process.env.SCAN_PATH;
  if (!sbomPath || !existsSync(sbomPath)) {
    throw new Error('SBOM_PATH must reference the final image SPDX JSON.');
  }
  if (!scanPath || !existsSync(scanPath)) {
    throw new Error('SCAN_PATH must reference the final image scan JSON.');
  }

  const fingerprint = calculateFingerprint();
  const candidateId =
    process.env.EXPECTED_CANDIDATE_ID ?? fingerprint.candidateId;
  const suffix = `${process.pid}-${Date.now()}`;
  const network = `genesis-gate2-${suffix}`;
  const postgres = `genesis-postgres-${suffix}`;
  const api = `genesis-api-${suffix}`;
  const commands = [];
  const invariants = [];
  const startedAt = new Date().toISOString();
  let runtimeLogs = '';
  let imageInspect;
  let dockerInfo;
  let buildxVersion;

  try {
    const info = docker(['info', '--format', '{{json .}}'], {
      displayCommand: 'docker info --format <json>',
    });
    commands.push(info.evidence);
    dockerInfo = JSON.parse(info.stdout);
    if (dockerInfo.OSType !== 'linux')
      throw new Error('Docker server is not Linux.');
    invariants.push(
      invariant('linux-runtime', `kernel=${dockerInfo.KernelVersion}`),
    );

    const buildx = docker(['buildx', 'version']);
    commands.push(buildx.evidence);
    buildxVersion = buildx.stdout.trim();

    const inspect = docker(['image', 'inspect', image]);
    commands.push(inspect.evidence);
    [imageInspect] = JSON.parse(inspect.stdout);
    if (imageInspect.Os !== 'linux' || imageInspect.Architecture !== 'amd64') {
      throw new Error('candidate image is not linux/amd64.');
    }
    invariants.push(
      invariant(
        'amd64-image',
        `${imageInspect.Os}/${imageInspect.Architecture}`,
      ),
    );
    if (
      !imageInspect.RepoDigests?.some((entry) =>
        entry.includes(BASE_MANIFEST_DIGEST),
      )
    ) {
      const history = docker([
        'history',
        '--no-trunc',
        '--format',
        '{{.CreatedBy}}',
        image,
      ]);
      commands.push(history.evidence);
      if (!history.stdout.includes(BASE_MANIFEST_DIGEST)) {
        const dockerfile = readFileSync('Dockerfile', 'utf8');
        if (!dockerfile.includes(BASE_REFERENCE)) {
          throw new Error(
            'approved base manifest is not bound to the image definition.',
          );
        }
      }
    }
    invariants.push(invariant('base-digest', BASE_MANIFEST_DIGEST));

    const history = docker(['history', '--no-trunc', image]);
    commands.push(history.evidence);
    const metadata = JSON.stringify({
      env: imageInspect.Config.Env,
      labels: imageInspect.Config.Labels,
      history: history.stdout,
    });
    if (
      /replace-with|change-runtime|password=|secret=|token=/iu.test(metadata)
    ) {
      throw new Error('candidate image metadata contains a secret-like value.');
    }
    invariants.push(
      invariant('secret-absence', 'history/env/labels sanitized'),
    );

    const createNetwork = docker(['network', 'create', network]);
    commands.push(createNetwork.evidence);
    const startPostgres = docker(
      [
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
      ],
      { displayCommand: 'docker run <postgres-runtime-env-redacted>' },
    );
    commands.push(startPostgres.evidence);
    waitFor('PostgreSQL readiness', () =>
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

    const startApi = docker(
      [
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
      ],
      { displayCommand: 'docker run <api-runtime-env-redacted>' },
    );
    commands.push(startApi.evidence);

    const live = waitFor('API liveness', () =>
      dockerExec(
        api,
        'fetch(\'http://127.0.0.1:3000/api/v1/health/live\').then(async r=>{if(r.status!==200||JSON.stringify(await r.json())!==\'{"status":"ok"}\')process.exit(1)}).catch(()=>process.exit(1))',
        'docker exec api <liveness assertion>',
      ),
    );
    commands.push(live.evidence);
    invariants.push(invariant('liveness', '200 {status:ok}'));

    const ready = waitFor('API readiness', () =>
      dockerExec(
        api,
        'fetch(\'http://127.0.0.1:3000/api/v1/health/ready\').then(async r=>{if(r.status!==200||JSON.stringify(await r.json())!==\'{"status":"ok"}\')process.exit(1)}).catch(()=>process.exit(1))',
        'docker exec api <readiness assertion>',
      ),
    );
    commands.push(ready.evidence);
    invariants.push(invariant('readiness', '200 {status:ok}'));

    const identity = dockerExec(
      api,
      'console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))',
      'docker exec api <uid/gid assertion>',
    );
    commands.push(identity.evidence);
    const ids = JSON.parse(identity.stdout);
    if (ids.uid === 0 || ids.gid === 0) throw new Error('runtime is root.');
    invariants.push(invariant('non-root', `uid=${ids.uid} gid=${ids.gid}`));

    const paths = dockerExec(
      api,
      'const fs=require(\'fs\');const names=fs.readdirSync(\'/app\').sort();if(JSON.stringify(names)!==\'["dist","node_modules","package.json"]\')process.exit(1)',
      'docker exec api <runtime file allowlist>',
    );
    commands.push(paths.evidence);
    invariants.push(
      invariant('runtime-files', 'dist,node_modules,package.json'),
    );

    const productionDependencies = dockerExec(
      api,
      "try{require.resolve('@nestjs/cli');process.exit(1)}catch(error){if(error.code!=='MODULE_NOT_FOUND')process.exit(1)};if(require('fs').existsSync('/usr/local/bin/npm'))process.exit(1)",
      'docker exec api <production dependency assertion>',
    );
    commands.push(productionDependencies.evidence);
    invariants.push(
      invariant('production-dependencies-only', 'Nest CLI and npm absent'),
    );

    const readOnly = dockerExec(
      api,
      "try{require('fs').writeFileSync('/app/write-probe','x');process.exit(1)}catch(error){if(!['EROFS','EACCES'].includes(error.code))process.exit(1)}",
      'docker exec api <read-only /app assertion>',
    );
    commands.push(readOnly.evidence);
    invariants.push(invariant('read-only-app', 'write rejected'));

    const writableTmp = dockerExec(
      api,
      "const fs=require('fs');fs.writeFileSync('/tmp/write-probe','x');fs.unlinkSync('/tmp/write-probe')",
      'docker exec api <writable /tmp assertion>',
    );
    commands.push(writableTmp.evidence);
    invariants.push(invariant('writable-tmp', 'write and delete succeeded'));

    const processState = dockerExec(
      api,
      "const fs=require('fs');const status=fs.readFileSync('/proc/1/status','utf8');const cmd=fs.readFileSync('/proc/1/cmdline','utf8');const cap=status.match(/^CapEff:\\s*(.+)$/m)?.[1];const nnp=status.match(/^NoNewPrivs:\\s*(.+)$/m)?.[1];console.log(JSON.stringify({cap,nnp,cmd}))",
      'docker exec api <PID 1 security assertion>',
    );
    commands.push(processState.evidence);
    const state = JSON.parse(processState.stdout);
    if (!/^0+$/u.test(state.cap))
      throw new Error('effective capabilities are not zero.');
    if (state.nnp !== '1') throw new Error('no-new-privileges is not active.');
    if (!state.cmd.startsWith(`${RUNTIME_NODE}\u0000dist/main.js`))
      throw new Error('Distroless Node is not PID 1.');
    invariants.push(invariant('capabilities-dropped', `CapEff=${state.cap}`));
    invariants.push(invariant('no-new-privileges', 'NoNewPrivs=1'));
    invariants.push(invariant('node-pid-1', `${RUNTIME_NODE} dist/main.js`));

    const dns = dockerExec(
      api,
      "require('dns').promises.lookup('postgres').then(()=>{}).catch(()=>process.exit(1))",
      'docker exec api <DNS assertion>',
    );
    commands.push(dns.evidence);
    invariants.push(invariant('dns', 'postgres resolved on synthetic network'));

    const certificates = dockerExec(
      api,
      "const fs=require('fs');const tls=require('tls');if(!fs.statSync('/etc/ssl/certs/ca-certificates.crt').size||tls.rootCertificates.length<1)process.exit(1)",
      'docker exec api <CA certificate assertion>',
    );
    commands.push(certificates.evidence);
    invariants.push(
      invariant('ca-certificates', 'Debian CA bundle and Node roots present'),
    );

    const stopPostgres = docker(['stop', '--time', '5', postgres]);
    commands.push(stopPostgres.evidence);
    const unavailable = waitFor('readiness after PostgreSQL loss', () =>
      dockerExec(
        api,
        'fetch(\'http://127.0.0.1:3000/api/v1/health/ready\').then(async r=>{if(r.status!==503||JSON.stringify(await r.json())!==\'{"status":"unavailable"}\')process.exit(1)}).catch(()=>process.exit(1))',
        'docker exec api <PostgreSQL unavailable assertion>',
      ),
    );
    commands.push(unavailable.evidence);
    invariants.push(
      invariant('postgres-unavailable', '503 {status:unavailable}'),
    );

    const restartPostgres = docker(['start', postgres]);
    commands.push(restartPostgres.evidence);
    waitFor('PostgreSQL recovery', () =>
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
    const recovered = waitFor(
      'API readiness recovery',
      () =>
        dockerExec(
          api,
          "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))",
          'docker exec api <PostgreSQL recovery assertion>',
        ),
      45_000,
    );
    commands.push(recovered.evidence);
    invariants.push(
      invariant('postgres-recovery', 'readiness returned to 200'),
    );

    const shutdownStarted = Date.now();
    const stopApi = docker(['stop', '--time', '15', api], { timeout: 20_000 });
    const shutdownDuration = Date.now() - shutdownStarted;
    commands.push(stopApi.evidence);
    const stopped = docker(['inspect', api]);
    commands.push(stopped.evidence);
    const [stoppedInspect] = JSON.parse(stopped.stdout);
    if (stoppedInspect.State.ExitCode !== 0)
      throw new Error('SIGTERM exit code is not zero.');
    if (shutdownDuration > 15_000)
      throw new Error('shutdown exceeded 15 seconds.');
    runtimeLogs = docker(['logs', api], { allowFailure: true }).stdout;
    if (
      !runtimeLogs.includes('runtime.draining') ||
      !runtimeLogs.includes('runtime.stopped')
    ) {
      throw new Error(
        'shutdown lifecycle events are absent from runtime logs.',
      );
    }
    invariants.push(
      invariant('sigterm', 'exitCode=0 with draining/stopped events'),
    );
    invariants.push(
      invariant('shutdown-deadline', `durationMs=${shutdownDuration}`),
    );

    const completedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: 'environment-evidence.v1',
      taskId: '0.8.2',
      baseSha: BASE_SHA,
      candidateId,
      builderExecutorId: process.env.BUILDER_EXECUTOR_ID ?? 'codex-builder',
      executor: {
        id: process.env.ENVIRONMENT_EXECUTOR_ID ?? 'codex-builder',
        role: process.env.ENVIRONMENT_EXECUTOR_ROLE ?? 'builder',
        readOnly: process.env.ENVIRONMENT_EXECUTOR_ROLE === 'verifier',
        writeOperations:
          process.env.ENVIRONMENT_EXECUTOR_ROLE === 'verifier' ? 0 : 1,
      },
      environment: {
        os: 'linux',
        kernel: dockerInfo.KernelVersion,
        architecture: 'amd64',
        dockerVersion: dockerInfo.ServerVersion,
        buildxVersion,
      },
      baseImage: {
        reference: BASE_REFERENCE,
        indexDigest: BASE_INDEX_DIGEST,
        manifestDigest: BASE_MANIFEST_DIGEST,
      },
      candidateImage: {
        reference: image,
        imageId: imageInspect.Id,
        platform: 'linux/amd64',
      },
      commands,
      artifacts: {
        runtimeLogSha256: sha256(runtimeLogs),
        sbomSha256: sha256(readFileSync(resolve(sbomPath))),
        scanSha256: sha256(readFileSync(resolve(scanPath))),
        ...(process.env.SOURCE_EVIDENCE_PATH
          ? {
              sourceEvidenceSha256: sha256(
                readFileSync(resolve(process.env.SOURCE_EVIDENCE_PATH)),
              ),
            }
          : {}),
      },
      invariants,
      startedAt,
      completedAt,
    };
    const missing = REQUIRED_INVARIANTS.filter(
      (name) => !invariants.some((entry) => entry.name === name),
    );
    if (missing.length > 0)
      throw new Error(`missing invariants: ${missing.join(', ')}`);
    validateEnvironmentEvidence(evidence, {
      expectedCandidateId: candidateId,
      expectedBaseSha: BASE_SHA,
    });
    const resolvedOutputPath = resolve(outputPath);
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(
      resolvedOutputPath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    console.log(
      JSON.stringify({
        command: 'npm run image:verify',
        status: 'passed',
        candidateId,
        imageId: imageInspect.Id,
        invariants: invariants.length,
        evidence: outputPath,
      }),
    );
  } finally {
    docker(['rm', '-f', api], {
      allowFailure: true,
      displayCommand: 'docker rm -f api',
    });
    docker(['rm', '-f', postgres], {
      allowFailure: true,
      displayCommand: 'docker rm -f postgres',
    });
    docker(['network', 'rm', network], {
      allowFailure: true,
      displayCommand: 'docker network rm test-network',
    });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BASE_INDEX_DIGEST,
  BASE_MANIFEST_DIGEST,
  BASE_REFERENCE,
  POSTGRES_IMAGE,
  REQUIRED_INVARIANTS,
};
