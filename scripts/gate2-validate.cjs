const { spawnSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const npmCli = process.env.npm_execpath;
const results = [];
let databaseStarted = false;

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
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

function runToFile(command, args, outputPath, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
  });
  const resolvedOutputPath = resolve(outputPath);
  mkdirSync(dirname(resolvedOutputPath), { recursive: true });
  writeFileSync(resolvedOutputPath, result.stdout ?? '', 'utf8');
  process.stderr.write(result.stderr ?? '');
  const entry = {
    command: options.displayCommand ?? [command, ...args].join(' '),
    durationMs: Date.now() - startedAt,
    output: outputPath,
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status ?? 1,
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
  if (result.status !== 0) {
    throw Object.assign(new Error(entry.command), { exitCode: entry.exitCode });
  }
  return entry;
}

function runExpectedFailure(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const passed = result.status !== 0;
  const entry = {
    command: options.displayCommand ?? [command, ...args].join(' '),
    durationMs: Date.now() - startedAt,
    status: passed ? 'passed' : 'failed',
    expectedResult: 'blocked',
    exitCode: result.status ?? 1,
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
  if (!passed) {
    throw Object.assign(new Error(entry.command), { exitCode: 1 });
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
  const candidateImage =
    process.env.PRODUCTION_IMAGE ?? 'genesis-platform-api:gate2-local';
  const sbomPath =
    process.env.SBOM_PATH ?? '.codex/task-packets/0.8.2-sbom.spdx.json';
  const scanPath =
    process.env.SCAN_PATH ?? '.codex/task-packets/0.8.2-grype.json';
  const environmentEvidencePath =
    process.env.ENVIRONMENT_EVIDENCE_PATH ??
    '.codex/task-packets/0.8.2-environment.json';
  const acceptancePath =
    process.env.RISK_ACCEPTANCE_PATH ??
    'security/risk-acceptances/0.8.2-f012.json';
  const policyEvidencePath =
    process.env.POLICY_EVIDENCE_PATH ??
    '.codex/task-packets/0.8.2-vulnerability-policy.json';
  const publicationPolicyEvidencePath =
    process.env.PUBLICATION_POLICY_EVIDENCE_PATH ??
    '.codex/task-packets/0.8.2-vulnerability-policy-publication.json';
  const syft = process.env.SYFT_COMMAND ?? 'syft';
  const grype = process.env.GRYPE_COMMAND ?? 'grype';
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const created = spawnSync('git', ['show', '-s', '--format=%cI', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

  runNpm(['run', 'task:preflight']);
  runNpm(['run', 'task:contracts']);
  runNpm(['run', 'format:check:task-tools']);
  runNpm(['run', 'test:task-tools']);
  runNpm(['run', 'test:production-tools']);
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
    'buildx',
    'build',
    '--platform',
    'linux/amd64',
    '--target',
    'runtime',
    '--load',
    '-t',
    candidateImage,
    '--build-arg',
    `OCI_REVISION=${headSha}`,
    '--build-arg',
    `OCI_VERSION=${version}`,
    '--build-arg',
    `OCI_CREATED=${created}`,
    '.',
  ]);
  runNpm(['audit', '--omit=dev', '--audit-level=high']);
  runToFile(syft, [candidateImage, '-o', 'spdx-json'], sbomPath, {
    displayCommand: 'syft <candidate-image> -o spdx-json',
  });
  runToFile(
    grype,
    [candidateImage, '--config', '.grype.yaml', '--output', 'json'],
    scanPath,
    {
      displayCommand:
        'grype <candidate-image> --config .grype.yaml --output json',
    },
  );
  runNpm(['run', 'image:verify'], {
    env: {
      ...process.env,
      PRODUCTION_IMAGE: candidateImage,
      SBOM_PATH: sbomPath,
      SCAN_PATH: scanPath,
      ENVIRONMENT_EVIDENCE_PATH: environmentEvidencePath,
    },
  });
  runNpm(['run', 'environment:evidence:verify', '--', environmentEvidencePath]);
  run(process.execPath, [
    'scripts/verify-vulnerability-policy.cjs',
    '--image',
    candidateImage,
    '--sbom',
    sbomPath,
    '--scan',
    scanPath,
    '--acceptance',
    acceptancePath,
    '--environment-evidence',
    environmentEvidencePath,
    '--output',
    policyEvidencePath,
    '--mode',
    'ci-validation',
  ]);
  runExpectedFailure(
    process.execPath,
    [
      'scripts/verify-vulnerability-policy.cjs',
      '--image',
      candidateImage,
      '--sbom',
      sbomPath,
      '--scan',
      scanPath,
      '--acceptance',
      acceptancePath,
      '--environment-evidence',
      environmentEvidencePath,
      '--output',
      publicationPolicyEvidencePath,
      '--mode',
      'publication',
    ],
    { displayCommand: 'verify vulnerability policy --mode publication' },
  );
  runNpm(['run', 'task:fingerprint', '--', '--json']);
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
