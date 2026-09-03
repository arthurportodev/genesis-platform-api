const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');
const { calculateFingerprint } = require('./task-fingerprint.cjs');
const {
  BUNDLE_CONTRACT_VERSION,
  RELEASE_DIRECTORIES,
  RELEASE_MANIFEST_ENTRY,
  RELEASE_TREE,
} = require('./lib/release-tree-contract.cjs');
const {
  API_RELEASE_BINDINGS,
  BASELINE_REPAIR_BINDINGS,
  BASELINE_REPAIR_PROFILE,
  PLATFORM,
  POSTGRES_IMAGE,
  TRAEFIK_IMAGE,
} = require('./validate-production-compose.cjs');

const CONTRACT_VERSION = BUNDLE_CONTRACT_VERSION;
const BUNDLE_MODES = new Set(['candidate', 'committed-release']);
const RELEASE_ROLES = new Set(['current', 'rollback']);
const POSTGRES_LINUX_AMD64_MANIFEST =
  'sha256:af194ccf3e2d7fe367012c7b88ce8b816c5c889b18a5b316799a1f0d7eac746a';
const POSTGRES_VERSION = '17.10-alpine3.24';
const POSTGRES_SOURCE_REVISION = '4f9ced003ba58a854656ba150d146243d27ae3ac';
const MIGRATION_DIRECTORY = 'src/database/migrations';
const MIGRATION_FILE_PATTERN = /^(\d{13})-([A-Za-z][A-Za-z0-9]*)\.ts$/u;
const ARTIFACTS = [
  {
    source: 'compose.production.yml',
    path: 'compose.production.yml',
    mode: '0644',
  },
  {
    source: 'compose.production.functional.yml',
    path: 'compose.production.functional.yml',
    mode: '0644',
  },
  {
    source: '.env.production.example',
    path: 'config/production.env.example',
    mode: '0644',
  },
  {
    source: 'compose.traefik-internal.yml',
    path: 'compose.traefik-internal.yml',
    mode: '0644',
  },
  {
    source: 'compose.traefik-public-http.yml',
    path: 'compose.traefik-public-http.yml',
    mode: '0644',
  },
  {
    source: 'compose.traefik-public-full.yml',
    path: 'compose.traefik-public-full.yml',
    mode: '0644',
  },
  {
    source: 'docker/postgres/init-runtime-role.sh',
    path: 'docker/postgres/init-runtime-role.sh',
    mode: '0644',
  },
  {
    source: 'docker/production/api-entrypoint.sh',
    path: 'docker/production/api-entrypoint.sh',
    mode: '0644',
  },
  {
    source: 'docker/production/migrate-entrypoint.sh',
    path: 'docker/production/migrate-entrypoint.sh',
    mode: '0644',
  },
  {
    source: 'docker/production/deploy-api-release.py',
    path: 'docker/production/deploy-api-release.py',
    mode: '0644',
  },
  {
    source: 'docker/production/release-tree-manager.py',
    path: 'docker/production/release-tree-manager.py',
    mode: '0644',
  },
  {
    source: 'docker/traefik/render-static-config.sh',
    path: 'docker/traefik/render-static-config.sh',
    mode: '0644',
  },
  {
    source: 'docker/traefik/traefik-internal.yml',
    path: 'docker/traefik/traefik-internal.yml',
    mode: '0644',
  },
  {
    source: 'docker/traefik/traefik-acme-staging.yml',
    path: 'docker/traefik/traefik-acme-staging.yml',
    mode: '0644',
  },
  {
    source: 'docker/traefik/traefik-acme-production.yml',
    path: 'docker/traefik/traefik-acme-production.yml',
    mode: '0644',
  },
  {
    source: 'docker/traefik/dynamic/api-health-only.yml',
    path: 'docker/traefik/dynamic/api-health-only.yml',
    mode: '0644',
  },
  {
    source: 'docker/traefik/dynamic/api-functional.template.yml',
    path: 'docker/traefik/dynamic/api-functional.template.yml',
    mode: '0644',
  },
  {
    source: 'config/recovery/backup-restore.v1.json',
    path: 'config/recovery/backup-restore.v1.json',
    mode: '0644',
  },
  {
    source: 'config/recovery/recovery.env.example',
    path: 'config/recovery/recovery.env.example',
    mode: '0644',
  },
  {
    source: 'config/recovery/window-r-plan.v1.json',
    path: 'config/recovery/window-r-plan.v1.json',
    mode: '0644',
  },
  {
    source: 'docker/recovery/backup-runner.sh',
    path: 'docker/recovery/backup-runner.sh',
    mode: '0644',
  },
  {
    source: 'docker/recovery/check-status.sh',
    path: 'docker/recovery/check-status.sh',
    mode: '0644',
  },
  {
    source: 'docker/recovery/common.sh',
    path: 'docker/recovery/common.sh',
    mode: '0644',
  },
  {
    source: 'docker/recovery/install-pinned-tools.sh',
    path: 'docker/recovery/install-pinned-tools.sh',
    mode: '0644',
  },
  {
    source: 'docker/recovery/oauth-evidence-preflight.cjs',
    path: 'docker/recovery/oauth-evidence-preflight.cjs',
    mode: '0644',
  },
  {
    source: 'docker/recovery/provision-backup-role.sh',
    path: 'docker/recovery/provision-backup-role.sh',
    mode: '0644',
  },
  {
    source: 'docker/recovery/restore-proof-runner.sh',
    path: 'docker/recovery/restore-proof-runner.sh',
    mode: '0644',
  },
  {
    source: 'docker/recovery/retention-runner.sh',
    path: 'docker/recovery/retention-runner.sh',
    mode: '0644',
  },
  {
    source: 'docker/recovery/systemd/genesis-backup.service',
    path: 'docker/recovery/systemd/genesis-backup.service',
    mode: '0644',
  },
  {
    source: 'docker/recovery/systemd/genesis-backup.timer',
    path: 'docker/recovery/systemd/genesis-backup.timer',
    mode: '0644',
  },
  {
    source: 'docs/RECOVERY_RUNBOOK.md',
    path: 'docs/RECOVERY_RUNBOOK.md',
    mode: '0644',
  },
].sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function obviousSecretFailure(path, source) {
  const normalized = path.replaceAll('\\', '/');
  const basename = normalized.split('/').at(-1).toLowerCase();
  if (basename === '.env' || basename.startsWith('.env.')) {
    return `${normalized} uses a forbidden environment filename`;
  }
  const highConfidence = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  ];
  if (highConfidence.some((pattern) => pattern.test(source))) {
    return `${normalized} contains a high-confidence credential pattern`;
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
      (normalized.endsWith('.sh') && /^\$[a-z_][a-z0-9_]*$/u.test(value))
    ) {
      continue;
    }
    return `${normalized} contains a sensitive assignment with a value`;
  }
  return null;
}

function gitOutput(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function gitText(args, cwd) {
  return gitOutput(args, cwd, 'utf8').trim();
}

function migrationInventory({ cwd, mode, sourceCommit = null }) {
  let paths;
  if (mode === 'committed-release') {
    paths = gitOutput(
      [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        sourceCommit,
        '--',
        MIGRATION_DIRECTORY,
      ],
      cwd,
      'utf8',
    )
      .split('\0')
      .filter(Boolean);
  } else {
    paths = readdirSync(join(cwd, ...MIGRATION_DIRECTORY.split('/')), {
      withFileTypes: true,
    }).map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `migration source contains an irregular entry: ${entry.name}`,
        );
      }
      return `${MIGRATION_DIRECTORY}/${entry.name}`;
    });
  }
  if (paths.length === 0) throw new Error('migration inventory is empty.');
  const entries = paths.map((path) => {
    const filename = path.slice(MIGRATION_DIRECTORY.length + 1);
    const match = MIGRATION_FILE_PATTERN.exec(filename);
    if (!match || path !== `${MIGRATION_DIRECTORY}/${filename}`) {
      throw new Error(`migration source path is invalid: ${path}`);
    }
    const className = `${match[2]}${match[1]}`;
    const content =
      mode === 'committed-release'
        ? gitOutput(['show', `${sourceCommit}:${path}`], cwd, 'utf8')
        : readFileSync(join(cwd, ...path.split('/')), 'utf8');
    const classPattern = new RegExp(
      `export\\s+class\\s+${className}\\s+implements\\s+MigrationInterface\\b`,
      'u',
    );
    if (!classPattern.test(content)) {
      throw new Error(
        `migration class does not match its source path: ${path}`,
      );
    }
    return { timestamp: match[1], name: className, path };
  });
  entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  if (
    new Set(entries.map((entry) => entry.timestamp)).size !== entries.length
  ) {
    throw new Error('migration timestamps are not unique.');
  }
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error('migration class names are not unique.');
  }
  return {
    sourcePath: MIGRATION_DIRECTORY,
    orderedNames: entries.map((entry) => entry.name),
  };
}

function validateCommit(value, cwd) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) {
    throw new Error('source commit must be a full lowercase SHA.');
  }
  gitText(['cat-file', '-e', `${value}^{commit}`], cwd);
  return value;
}

function readCommittedArtifact(commit, artifact, cwd) {
  let treeEntry;
  let content;
  try {
    treeEntry = gitOutput(
      ['ls-tree', '-z', commit, '--', artifact.source],
      cwd,
      'utf8',
    );
    content = gitOutput(
      ['cat-file', 'blob', `${commit}:${artifact.source}`],
      cwd,
      null,
    );
  } catch {
    throw new Error(
      `source commit does not contain required artifact: ${artifact.source}`,
    );
  }
  const match = /^(100644|100755) blob [a-f0-9]{40}\t([^\0]+)\0$/u.exec(
    treeEntry,
  );
  if (!match || match[2] !== artifact.source) {
    throw new Error(
      `source commit has an invalid tree entry for: ${artifact.source}`,
    );
  }
  const mode = match[1] === '100755' ? '0755' : '0644';
  if (mode !== artifact.mode) {
    throw new Error(
      `source commit mode mismatch for ${artifact.source}: expected ${artifact.mode}, got ${mode}`,
    );
  }
  const worktreePath = join(cwd, ...artifact.source.split('/'));
  let worktree;
  try {
    if (!lstatSync(worktreePath).isFile()) throw new Error('not regular');
    worktree = readFileSync(worktreePath);
  } catch {
    throw new Error(
      `release worktree artifact is missing or irregular: ${artifact.source}`,
    );
  }
  if (!worktree.equals(content)) {
    throw new Error(
      `release worktree differs from source commit: ${artifact.source}`,
    );
  }
  return { content, mode };
}

function resolveGenerationTime(referenceCommit, mode, cwd, env) {
  if (env.SOURCE_DATE_EPOCH !== undefined) {
    if (!/^\d+$/u.test(env.SOURCE_DATE_EPOCH)) {
      throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer.');
    }
    const seconds = Number(env.SOURCE_DATE_EPOCH);
    const generatedAt = new Date(seconds * 1000);
    if (Number.isNaN(generatedAt.valueOf())) {
      throw new Error('SOURCE_DATE_EPOCH is outside the supported date range.');
    }
    return {
      generatedAt: generatedAt.toISOString(),
      generatedAtSemantics: 'source-date-epoch',
    };
  }
  const seconds = gitText(
    ['show', '-s', '--format=%ct', referenceCommit, '--'],
    cwd,
  );
  if (!/^\d+$/u.test(seconds)) {
    throw new Error('reference commit timestamp is unavailable.');
  }
  return {
    generatedAt: new Date(Number(seconds) * 1000).toISOString(),
    generatedAtSemantics:
      mode === 'candidate'
        ? 'base-commit-timestamp'
        : 'source-commit-timestamp',
  };
}

function assertOutputBoundary(output, cwd) {
  const absolute = resolve(output);
  if (absolute === resolve(cwd)) {
    throw new Error('bundle output cannot be the repository root.');
  }
  if (existsSync(absolute)) {
    throw new Error('bundle output must not already exist.');
  }
  const relativePath = relative(resolve(cwd), absolute).replaceAll('\\', '/');
  if (
    !isAbsolute(relativePath) &&
    !relativePath.startsWith('../') &&
    !relativePath.startsWith('.codex/evidence/0.8-MVP-05A/')
  ) {
    throw new Error(
      'bundle output inside the repository is allowed only under the ignored task evidence directory.',
    );
  }
  return absolute;
}

function candidateProvenance(cwd) {
  const fingerprint = calculateFingerprint({ cwd });
  return {
    baseSha: fingerprint.baseSha,
    candidateId: fingerprint.candidateId,
    contentFingerprint: fingerprint.contentFingerprint,
  };
}

function releaseBindings(releaseRole, profile) {
  if (profile === undefined || profile === null) {
    return {
      selected: API_RELEASE_BINDINGS[releaseRole],
      previousApproved: API_RELEASE_BINDINGS.rollback,
    };
  }
  if (profile !== BASELINE_REPAIR_PROFILE) {
    throw new Error('release profile is invalid.');
  }
  if (releaseRole !== 'current') {
    throw new Error(
      'baseline repair profile requires the current release role.',
    );
  }
  return {
    selected: BASELINE_REPAIR_BINDINGS.current,
    previousApproved: BASELINE_REPAIR_BINDINGS.previousApproved,
  };
}

function materializeArtifact(content, artifact, releaseRole, profile = null) {
  const baselineRepair = profile === BASELINE_REPAIR_PROFILE;
  if (
    artifact.path !== 'compose.production.yml' ||
    (releaseRole !== 'rollback' && !baselineRepair)
  ) {
    return { content, derivation: undefined };
  }
  if (profile !== null && !baselineRepair) {
    throw new Error('release profile is invalid.');
  }
  const source = content.toString('utf8');
  const occurrences =
    source.split(API_RELEASE_BINDINGS.current.image).length - 1;
  const target = baselineRepair
    ? BASELINE_REPAIR_BINDINGS.current.image
    : API_RELEASE_BINDINGS.rollback.image;
  if (occurrences !== 2 || source.includes(target)) {
    throw new Error(
      `${baselineRepair ? 'baseline repair' : 'rollback'} Compose derivation requires exactly two current API image bindings and no pre-existing target binding.`,
    );
  }
  const derived = Buffer.from(
    source.replaceAll(API_RELEASE_BINDINGS.current.image, target),
  );
  return {
    content: derived,
    derivation: {
      kind: baselineRepair
        ? 'exact-baseline-repair-image-replacement'
        : 'exact-api-image-replacement',
      sourceSha256: sha256(content),
      from: API_RELEASE_BINDINGS.current.image,
      to: target,
      replacements: 2,
    },
  };
}

function buildProductionBundle({
  cwd = process.cwd(),
  output,
  mode = 'candidate',
  releaseRole = 'current',
  profile = null,
  sourceCommit = null,
  env = process.env,
} = {}) {
  if (!output) throw new Error('bundle output is required.');
  if (!BUNDLE_MODES.has(mode)) throw new Error('bundle mode is invalid.');
  if (!RELEASE_ROLES.has(releaseRole)) {
    throw new Error('release role is invalid.');
  }
  if (profile !== null && profile !== BASELINE_REPAIR_PROFILE) {
    throw new Error('release profile is invalid.');
  }
  if (
    profile === BASELINE_REPAIR_PROFILE &&
    (mode !== 'committed-release' || releaseRole !== 'current')
  ) {
    throw new Error(
      'baseline repair profile requires committed-release mode and the current release role.',
    );
  }
  if (mode === 'candidate' && sourceCommit !== null) {
    throw new Error('candidate bundles cannot declare a source commit.');
  }
  if (mode === 'candidate' && releaseRole !== 'current') {
    throw new Error(
      'candidate bundles can describe only the current release role.',
    );
  }
  const absoluteOutput = assertOutputBoundary(output, cwd);
  const identity =
    mode === 'candidate'
      ? candidateProvenance(cwd)
      : {
          sourceCommit: validateCommit(
            sourceCommit ?? gitText(['rev-parse', 'HEAD'], cwd),
            cwd,
          ),
        };
  const referenceCommit =
    mode === 'candidate' ? identity.baseSha : identity.sourceCommit;
  const generation = resolveGenerationTime(referenceCommit, mode, cwd, env);
  const entries = [];
  let created = false;
  try {
    mkdirSync(absoluteOutput, { recursive: false });
    created = true;
    for (const artifact of ARTIFACTS) {
      let content;
      if (mode === 'committed-release') {
        ({ content } = readCommittedArtifact(
          identity.sourceCommit,
          artifact,
          cwd,
        ));
      } else {
        const sourcePath = join(cwd, ...artifact.source.split('/'));
        if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
          throw new Error(
            `required candidate artifact is missing or irregular: ${artifact.source}`,
          );
        }
        content = readFileSync(sourcePath);
      }
      if (content.includes(0)) {
        throw new Error(`bundle source must be text: ${artifact.source}`);
      }
      const materialized = materializeArtifact(
        content,
        artifact,
        releaseRole,
        profile,
      );
      content = materialized.content;
      const secretFailure = obviousSecretFailure(
        artifact.path,
        content.toString('utf8'),
      );
      if (secretFailure) throw new Error(secretFailure);
      const target = join(absoluteOutput, ...artifact.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      chmodSync(target, artifact.mode === '0755' ? 0o755 : 0o644);
      entries.push({
        path: artifact.path,
        sourcePath: artifact.source,
        type: 'file',
        owner: 0,
        group: 0,
        mode: artifact.mode,
        sha256: sha256(content),
        ...(materialized.derivation
          ? { derivation: materialized.derivation }
          : {}),
      });
    }

    const bindings = releaseBindings(releaseRole, profile);
    const selectedApiBinding = bindings.selected;
    const apiMetadata = {
      reference: selectedApiBinding.image,
      digest: selectedApiBinding.image.split('@')[1],
      configDigest: selectedApiBinding.configDigest,
      applicationRevision: selectedApiBinding.applicationRevision,
      platform: PLATFORM,
      ...(releaseRole === 'rollback' ? { relation: 'previous-approved' } : {}),
    };

    const manifest = {
      contractVersion: CONTRACT_VERSION,
      bundleMode: mode,
      releaseRole,
      ...(profile === null ? {} : { releaseProfile: profile }),
      operational: mode === 'committed-release',
      ...identity,
      ...generation,
      platform: PLATFORM,
      images: {
        api: apiMetadata,
        postgres: {
          reference: POSTGRES_IMAGE,
          indexDigest: POSTGRES_IMAGE.split('@')[1],
          platformManifestDigest: POSTGRES_LINUX_AMD64_MANIFEST,
          version: POSTGRES_VERSION,
          sourceRevision: POSTGRES_SOURCE_REVISION,
        },
        traefik: {
          reference: TRAEFIK_IMAGE,
          digest: TRAEFIK_IMAGE.split('@')[1],
          platform: PLATFORM,
          version: 'v3.7.9',
          tag: 'v3.7.9',
          source: 'https://github.com/traefik/traefik',
          imageCreatedAt: '2026-07-24T19:31:24.4220685Z',
          selectedAt: '2026-08-10',
        },
      },
      rollback: {
        api: {
          reference: bindings.previousApproved.image,
          digest: bindings.previousApproved.image.split('@')[1],
          configDigest: bindings.previousApproved.configDigest,
          applicationRevision: bindings.previousApproved.applicationRevision,
          relation: 'previous-approved',
          platform: PLATFORM,
        },
      },
      recovery: {
        contractVersion: '0.8-MVP-07A.v2',
        lifecycle: 'incorporated-not-activated',
        windowPlanVersion: '0.8-MVP-07B.window-r.v2',
        productionMutationCount: 0,
        driveMutationCount: 0,
      },
      migrations: migrationInventory({
        cwd,
        mode,
        sourceCommit: identity.sourceCommit ?? null,
      }),
      releaseTree: RELEASE_TREE,
      directories: RELEASE_DIRECTORIES,
      manifestEntry: RELEASE_MANIFEST_ENTRY,
      artifacts: entries,
    };
    writeFileSync(
      join(absoluteOutput, 'release-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o644 },
    );

    const {
      validateProductionBundle,
    } = require('./validate-production-bundle.cjs');
    const validation = validateProductionBundle(absoluteOutput, {
      cwd,
      requiredMode: mode,
    });
    if (validation.status !== 'passed') {
      throw new Error(
        `built bundle is invalid: ${validation.failures.join('; ')}`,
      );
    }
    return {
      status: 'passed',
      output: absoluteOutput,
      manifest,
      files: validation.files,
    };
  } catch (error) {
    if (created) rmSync(absoluteOutput, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') result.output = argv[++index];
    else if (argument === '--mode') result.mode = argv[++index];
    else if (argument === '--release-role') result.releaseRole = argv[++index];
    else if (argument === '--profile') result.profile = argv[++index];
    else if (argument === '--source-commit')
      result.sourceCommit = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

function main() {
  try {
    const result = buildProductionBundle(parseArguments(process.argv.slice(2)));
    console.log(
      JSON.stringify({
        command: 'build-production-bundle',
        status: result.status,
        output: result.output,
        bundleMode: result.manifest.bundleMode,
        releaseRole: result.manifest.releaseRole,
        releaseProfile: result.manifest.releaseProfile ?? null,
        operational: result.manifest.operational,
        sourceCommit: result.manifest.sourceCommit ?? null,
        baseSha: result.manifest.baseSha ?? null,
        candidateId: result.manifest.candidateId ?? null,
        contentFingerprint: result.manifest.contentFingerprint ?? null,
        generatedAt: result.manifest.generatedAt,
        generatedAtSemantics: result.manifest.generatedAtSemantics,
        files: result.files,
      }),
    );
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ARTIFACTS,
  BUNDLE_MODES,
  RELEASE_ROLES,
  CONTRACT_VERSION,
  POSTGRES_LINUX_AMD64_MANIFEST,
  POSTGRES_SOURCE_REVISION,
  POSTGRES_VERSION,
  MIGRATION_DIRECTORY,
  buildProductionBundle,
  candidateProvenance,
  materializeArtifact,
  migrationInventory,
  obviousSecretFailure,
  readCommittedArtifact,
  releaseBindings,
  resolveGenerationTime,
  sha256,
};

if (require.main === module) main();
