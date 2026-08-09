const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { calculateFingerprint } = require('./task-fingerprint.cjs');
const {
  API_IMAGE,
  PLATFORM,
  POSTGRES_IMAGE,
} = require('./validate-production-compose.cjs');

const EXPECTED_ARTIFACTS = [
  {
    path: 'compose.production.yml',
    sourcePath: 'compose.production.yml',
    mode: '0644',
  },
  {
    path: 'config/production.env.example',
    sourcePath: '.env.production.example',
    mode: '0644',
  },
  {
    path: 'docker/postgres/init-runtime-role.sh',
    sourcePath: 'docker/postgres/init-runtime-role.sh',
    mode: '0644',
  },
  {
    path: 'docker/production/api-entrypoint.sh',
    sourcePath: 'docker/production/api-entrypoint.sh',
    mode: '0644',
  },
  {
    path: 'docker/production/migrate-entrypoint.sh',
    sourcePath: 'docker/production/migrate-entrypoint.sh',
    mode: '0644',
  },
].sort((left, right) => left.path.localeCompare(right.path));
const EXPECTED_FILES = [
  ...EXPECTED_ARTIFACTS.map((entry) => entry.path),
  'release-manifest.json',
].sort();
const CONTRACT_VERSION = '0.8-MVP-05A.v2';
const POSTGRES_LINUX_AMD64_MANIFEST =
  'sha256:af194ccf3e2d7fe367012c7b88ce8b816c5c889b18a5b316799a1f0d7eac746a';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function listFiles(root, current = '') {
  const entries = [];
  const absolute = current ? join(root, ...current.split('/')) : root;
  for (const name of readdirSync(absolute).sort()) {
    const path = current ? `${current}/${name}` : name;
    const stats = lstatSync(join(root, ...path.split('/')));
    if (stats.isDirectory()) entries.push(...listFiles(root, path));
    else entries.push({ path, regular: stats.isFile() });
  }
  return entries;
}

function obviousSecretFailure(path, source) {
  const basename = path.split('/').at(-1).toLowerCase();
  if (basename === '.env' || basename.startsWith('.env.')) {
    return `${path} uses a forbidden environment filename`;
  }
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u.test(
      source,
    )
  ) {
    return `${path} contains a high-confidence credential pattern`;
  }
  for (const line of source.split(/\r?\n/u)) {
    const assignment = line.match(
      /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:PASSWORD(?:_FILE)?|SECRET|PEPPER|KEYS|API_?KEY))\s*[:=]\s*(.*)$/u,
    );
    if (!assignment) continue;
    const value = assignment[2].trim();
    if (
      value === '' ||
      value === '$secret_value' ||
      value.startsWith('/run/secrets/') ||
      (path.endsWith('.sh') && /^\$[a-z_][a-z0-9_]*$/u.test(value))
    ) {
      continue;
    }
    return `${path} contains a sensitive assignment with a value`;
  }
  return null;
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function gitOutput(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function readGitArtifact(commit, expected, cwd) {
  const treeEntry = gitOutput(
    ['ls-tree', '-z', commit, '--', expected.sourcePath],
    cwd,
    'utf8',
  );
  const match = /^(100644|100755) blob [a-f0-9]{40}\t([^\0]+)\0$/u.exec(
    treeEntry,
  );
  if (!match || match[2] !== expected.sourcePath) {
    throw new Error(`commit does not contain ${expected.sourcePath}`);
  }
  return {
    content: gitOutput(
      ['cat-file', 'blob', `${commit}:${expected.sourcePath}`],
      cwd,
      null,
    ),
    mode: match[1] === '100755' ? '0755' : '0644',
  };
}

function validateCandidateIdentity(manifest, cwd, failures) {
  check(
    manifest.operational === false,
    'candidate must be non-operational',
    failures,
  );
  check(
    manifest.sourceCommit === undefined,
    'candidate must not declare sourceCommit',
    failures,
  );
  check(
    /^[a-f0-9]{40}$/u.test(manifest.baseSha ?? ''),
    'candidate base SHA is invalid',
    failures,
  );
  check(
    /^[a-f0-9]{64}$/u.test(manifest.candidateId ?? ''),
    'candidate ID is invalid',
    failures,
  );
  check(
    /^[a-f0-9]{64}$/u.test(manifest.contentFingerprint ?? ''),
    'candidate content fingerprint is invalid',
    failures,
  );
  let current;
  try {
    current = calculateFingerprint({ cwd });
  } catch (error) {
    failures.push(`candidate bindings cannot be recomputed: ${error.message}`);
    return;
  }
  check(
    manifest.baseSha === current.baseSha,
    'candidate base SHA binding mismatch',
    failures,
  );
  check(
    manifest.candidateId === current.candidateId,
    'candidate ID binding mismatch',
    failures,
  );
  check(
    manifest.contentFingerprint === current.contentFingerprint,
    'candidate content fingerprint binding mismatch',
    failures,
  );
}

function validateReleaseIdentity(manifest, artifactsByPath, cwd, failures) {
  check(
    manifest.operational === true,
    'committed release must be operational',
    failures,
  );
  check(
    manifest.baseSha === undefined,
    'committed release must not declare baseSha',
    failures,
  );
  check(
    manifest.candidateId === undefined,
    'committed release must not declare candidateId',
    failures,
  );
  check(
    manifest.contentFingerprint === undefined,
    'committed release must not declare contentFingerprint',
    failures,
  );
  if (!/^[a-f0-9]{40}$/u.test(manifest.sourceCommit ?? '')) {
    failures.push('source commit is invalid');
    return;
  }
  try {
    gitOutput(['cat-file', '-e', `${manifest.sourceCommit}^{commit}`], cwd);
  } catch {
    failures.push('source commit cannot be resolved');
    return;
  }
  for (const expected of EXPECTED_ARTIFACTS) {
    let snapshot;
    try {
      snapshot = readGitArtifact(manifest.sourceCommit, expected, cwd);
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    const artifact = artifactsByPath.get(expected.path);
    if (artifact) {
      check(
        snapshot.mode === artifact.mode,
        `${expected.path} mode diverges from source commit`,
        failures,
      );
      check(
        sha256(snapshot.content) === artifact.sha256,
        `${expected.path} blob diverges from source commit`,
        failures,
      );
    }
    const worktreePath = join(cwd, ...expected.sourcePath.split('/'));
    try {
      check(
        lstatSync(worktreePath).isFile() &&
          readFileSync(worktreePath).equals(snapshot.content),
        `release worktree differs from source commit: ${expected.sourcePath}`,
        failures,
      );
    } catch {
      failures.push(
        `release worktree artifact is missing or irregular: ${expected.sourcePath}`,
      );
    }
  }
}

function validateProductionBundle(
  bundlePath,
  { cwd = process.cwd(), requiredMode = null } = {},
) {
  const failures = [];
  const root = resolve(bundlePath);
  let listed;
  try {
    listed = listFiles(root);
  } catch (error) {
    return {
      status: 'failed',
      files: [],
      failures: [`bundle cannot be enumerated: ${error.message}`],
    };
  }
  const files = listed.map((entry) => entry.path).sort();
  check(
    JSON.stringify(files) === JSON.stringify(EXPECTED_FILES),
    'bundle file allowlist mismatch',
    failures,
  );
  for (const entry of listed) {
    check(
      entry.regular,
      `bundle entry must be a regular file: ${entry.path}`,
      failures,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(root, 'release-manifest.json'), 'utf8'),
    );
  } catch (error) {
    failures.push(`release manifest is invalid: ${error.message}`);
    return { status: 'failed', files, failures };
  }
  check(
    manifest.contractVersion === CONTRACT_VERSION,
    'contract version mismatch',
    failures,
  );
  check(
    ['candidate', 'committed-release'].includes(manifest.bundleMode),
    'bundle mode is invalid',
    failures,
  );
  if (requiredMode !== null) {
    check(
      manifest.bundleMode === requiredMode,
      `bundle mode does not satisfy required mode: ${requiredMode}`,
      failures,
    );
  }
  const timestampSemantics =
    manifest.bundleMode === 'candidate'
      ? ['base-commit-timestamp', 'source-date-epoch']
      : ['source-commit-timestamp', 'source-date-epoch'];
  check(
    timestampSemantics.includes(manifest.generatedAtSemantics),
    'generation timestamp semantics are invalid',
    failures,
  );
  check(
    typeof manifest.generatedAt === 'string' &&
      !Number.isNaN(Date.parse(manifest.generatedAt)),
    'generatedAt is invalid',
    failures,
  );
  check(manifest.platform === PLATFORM, 'bundle platform mismatch', failures);
  check(
    manifest.images?.api?.reference === API_IMAGE,
    'API reference mismatch',
    failures,
  );
  check(
    manifest.images?.api?.digest === API_IMAGE.split('@')[1],
    'API digest mismatch',
    failures,
  );
  check(
    manifest.images?.postgres?.reference === POSTGRES_IMAGE,
    'PostgreSQL reference mismatch',
    failures,
  );
  check(
    manifest.images?.postgres?.indexDigest === POSTGRES_IMAGE.split('@')[1],
    'PostgreSQL index digest mismatch',
    failures,
  );
  check(
    manifest.images?.postgres?.platformManifestDigest ===
      POSTGRES_LINUX_AMD64_MANIFEST,
    'PostgreSQL linux/amd64 manifest mismatch',
    failures,
  );
  for (const [name, image] of [
    ['API', manifest.images?.api?.reference],
    ['PostgreSQL', manifest.images?.postgres?.reference],
  ]) {
    check(
      typeof image === 'string' && /@sha256:[a-f0-9]{64}$/u.test(image),
      `${name} image is not immutable`,
      failures,
    );
  }

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  check(
    JSON.stringify(artifacts.map((entry) => entry.path)) ===
      JSON.stringify(EXPECTED_ARTIFACTS.map((entry) => entry.path)),
    'manifest artifact allowlist or order mismatch',
    failures,
  );
  const artifactsByPath = new Map();
  for (const artifact of artifacts) {
    const expected = EXPECTED_ARTIFACTS.find(
      (entry) => entry.path === artifact.path,
    );
    if (!expected) continue;
    artifactsByPath.set(artifact.path, artifact);
    check(
      artifact.sourcePath === expected.sourcePath,
      `${artifact.path} source path mismatch`,
      failures,
    );
    check(
      artifact.mode === expected.mode,
      `${artifact.path} mode mismatch`,
      failures,
    );
    const absolute = join(root, ...artifact.path.split('/'));
    let content;
    try {
      content = readFileSync(absolute);
    } catch (error) {
      failures.push(
        `artifact cannot be read: ${artifact.path}: ${error.message}`,
      );
      continue;
    }
    check(
      /^[a-f0-9]{64}$/u.test(artifact.sha256 ?? ''),
      `${artifact.path} hash is invalid`,
      failures,
    );
    check(
      sha256(content) === artifact.sha256,
      `${artifact.path} hash mismatch`,
      failures,
    );
    const secretFailure = obviousSecretFailure(
      artifact.path,
      content.toString('utf8'),
    );
    if (secretFailure) failures.push(secretFailure);
  }

  if (manifest.bundleMode === 'candidate') {
    validateCandidateIdentity(manifest, cwd, failures);
  } else if (manifest.bundleMode === 'committed-release') {
    validateReleaseIdentity(manifest, artifactsByPath, cwd, failures);
  }
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    files,
    failures: [...new Set(failures)].sort(),
    bundleMode: manifest.bundleMode,
    operational: manifest.operational,
    sourceCommit: manifest.sourceCommit ?? null,
    baseSha: manifest.baseSha ?? null,
    candidateId: manifest.candidateId ?? null,
    contentFingerprint: manifest.contentFingerprint ?? null,
    contractVersion: manifest.contractVersion,
  };
}

function parseArguments(argv) {
  if (argv.length === 0) throw new Error('bundle path is required.');
  const result = { bundlePath: argv[0], requiredMode: null };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--require-mode') result.requiredMode = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (
    result.requiredMode !== null &&
    !['candidate', 'committed-release'].includes(result.requiredMode)
  ) {
    throw new Error('required bundle mode is invalid.');
  }
  return result;
}

function main() {
  try {
    const { bundlePath, requiredMode } = parseArguments(process.argv.slice(2));
    const result = validateProductionBundle(bundlePath, { requiredMode });
    for (const failure of result.failures) console.error(`FAIL: ${failure}`);
    console.log(
      JSON.stringify({ command: 'validate-production-bundle', ...result }),
    );
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  CONTRACT_VERSION,
  EXPECTED_ARTIFACTS,
  EXPECTED_FILES,
  listFiles,
  obviousSecretFailure,
  readGitArtifact,
  validateProductionBundle,
};
