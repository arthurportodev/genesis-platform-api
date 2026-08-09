const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');
const {
  ARTIFACTS,
  buildProductionBundle,
  obviousSecretFailure,
} = require('../../scripts/build-production-bundle.cjs');
const {
  EXPECTED_FILES,
  validateProductionBundle,
} = require('../../scripts/validate-production-bundle.cjs');
const { calculateFingerprint } = require('../../scripts/task-fingerprint.cjs');

const VERSIONED_FIXTURE_INPUTS = [
  ...ARTIFACTS.map((artifact) => artifact.source),
  'package.json',
].sort();

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'genesis-mvp05a-bundle-'));
}

function runGit(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  }).trim();
}

function committedFixture(root) {
  const repository = join(root, 'repository');
  mkdirSync(repository);
  for (const artifact of ARTIFACTS) {
    const target = join(repository, ...artifact.source.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(join(process.cwd(), ...artifact.source.split('/'))),
    );
  }
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.name', 'Genesis Test']);
  runGit(repository, ['config', 'user.email', 'genesis-test@example.invalid']);
  runGit(repository, ['config', 'core.autocrlf', 'false']);
  runGit(repository, ['add', '--all']);
  for (const artifact of ARTIFACTS.filter((entry) => entry.mode === '0755')) {
    runGit(repository, ['update-index', '--chmod=+x', artifact.source]);
  }
  const commitEnvironment = {
    ...process.env,
    GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
    GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
  };
  runGit(repository, ['commit', '--quiet', '-m', 'production contract'], {
    env: commitEnvironment,
  });
  return {
    repository,
    sourceCommit: runGit(repository, ['rev-parse', 'HEAD']),
    commitEnvironment,
  };
}

function versionedInputHashes() {
  return Object.fromEntries(
    VERSIONED_FIXTURE_INPUTS.map((path) => [
      path,
      sha256(readFileSync(join(process.cwd(), ...path.split('/')))),
    ]),
  );
}

function candidateFixture(t) {
  const root = tempRoot();
  const sourceHashes = versionedInputHashes();
  t.after(() => {
    try {
      assert.deepEqual(versionedInputHashes(), sourceHashes);
    } finally {
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
  });

  const repository = join(root, 'repository');
  mkdirSync(repository);
  for (const path of VERSIONED_FIXTURE_INPUTS) {
    const target = join(repository, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(join(process.cwd(), ...path.split('/'))),
    );
  }

  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['checkout', '--quiet', '-b', 'fixture/candidate']);
  runGit(repository, ['config', 'user.name', 'Genesis Candidate Fixture']);
  runGit(repository, [
    'config',
    'user.email',
    'genesis-candidate-fixture@example.invalid',
  ]);
  runGit(repository, ['config', 'core.autocrlf', 'false']);
  runGit(repository, ['add', '--all']);
  const commitEnvironment = {
    ...process.env,
    GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
    GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
  };
  runGit(repository, ['commit', '--quiet', '-m', 'candidate fixture base'], {
    env: commitEnvironment,
  });
  const baseSha = runGit(repository, ['rev-parse', 'HEAD']);
  const branch = runGit(repository, ['branch', '--show-current']);

  const taskPacket = '.codex/task-packets/candidate-fixture.md';
  const manifestPath = join(repository, '.codex', 'task-manifest.json');
  const taskPacketPath = join(repository, ...taskPacket.split('/'));
  mkdirSync(dirname(taskPacketPath), { recursive: true });
  appendFileSync(
    join(repository, '.git', 'info', 'exclude'),
    `\n.codex/task-manifest.json\n${taskPacket}\n`,
  );
  writeFileSync(taskPacketPath, '# Candidate fixture Task Packet\n');
  const manifest = {
    version: 2,
    contractVersion: '2.0.0',
    task: {
      id: 'test-production-bundle-candidate-fixture',
      title: 'Production bundle candidate fixture',
      class: 'critical',
    },
    git: {
      branch,
      baseSha,
      requireCleanStage: true,
      expectedTransitions: [],
    },
    scope: {
      allowedPaths: ['compose.production.yml'],
      protectedPaths: ['package.json'],
    },
    artifacts: { taskPacket },
    validation: {
      profile: 'critical',
      focusedScripts: [],
      levels: ['immediate', 'focused', 'integration', 'complete'],
    },
    rehydration: {
      directSources: ['compose.production.yml'],
      expansionTriggers: ['fixture drift'],
    },
    autonomy: {
      allowHighCorrections: false,
      requireIndependentReverification: true,
    },
    contracts: {
      authorityRepository: 'arthurportodev/genesis-platform-api',
      contractSet: 'schemas/development-operations/contract-set.json',
    },
  };
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestSource);
  assert.equal(
    runGit(repository, ['check-ignore', '--', '.codex/task-manifest.json']),
    '.codex/task-manifest.json',
  );
  assert.equal(
    runGit(repository, ['check-ignore', '--', taskPacket]),
    taskPacket,
  );

  appendFileSync(
    join(repository, 'compose.production.yml'),
    '\n# candidate fixture change\n',
  );
  const fingerprint = calculateFingerprint({ cwd: repository });
  assert.deepEqual(fingerprint.candidatePaths, ['compose.production.yml']);
  return {
    root,
    repository,
    branch,
    baseSha,
    manifestPath,
    manifestSource,
    fingerprint,
    commitEnvironment,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('builds a deterministic non-operational candidate with current bindings', (t) => {
  const fixture = candidateFixture(t);
  const first = join(fixture.root, 'first');
  const second = join(fixture.root, 'second');
  const options = {
    cwd: fixture.repository,
    mode: 'candidate',
    env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
  };
  const builtFirst = buildProductionBundle({ ...options, output: first });
  const builtSecond = buildProductionBundle({ ...options, output: second });
  assert.equal(builtFirst.status, 'passed');
  assert.deepEqual(builtFirst.files, EXPECTED_FILES);
  assert.equal(builtFirst.manifest.bundleMode, 'candidate');
  assert.equal(builtFirst.manifest.operational, false);
  assert.equal(builtFirst.manifest.sourceCommit, undefined);
  assert.equal(builtFirst.manifest.baseSha, fixture.baseSha);
  assert.equal(
    builtFirst.manifest.candidateId,
    fixture.fingerprint.candidateId,
  );
  assert.equal(
    builtFirst.manifest.contentFingerprint,
    fixture.fingerprint.contentFingerprint,
  );
  assert.deepEqual(
    readFileSync(join(first, 'release-manifest.json')),
    readFileSync(join(second, 'release-manifest.json')),
  );
  for (const path of EXPECTED_FILES) {
    assert.deepEqual(
      readFileSync(join(first, ...path.split('/'))),
      readFileSync(join(second, ...path.split('/'))),
    );
  }
  assert.equal(builtFirst.manifest.generatedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(builtFirst.manifest.generatedAtSemantics, 'source-date-epoch');
});

test('derives candidate time from the base commit without claiming artifact provenance', (t) => {
  const fixture = candidateFixture(t);
  const built = buildProductionBundle({
    cwd: fixture.repository,
    output: join(fixture.root, 'bundle'),
    mode: 'candidate',
    env: {},
  });
  assert.equal(built.manifest.generatedAtSemantics, 'base-commit-timestamp');
  assert.equal(built.manifest.generatedAt, '2024-01-02T03:04:05.000Z');
  assert.equal(built.manifest.sourceCommit, undefined);
});

test('rejects the current uncommitted candidate as a committed release', (t) => {
  const fixture = candidateFixture(t);
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(fixture.root, 'release'),
        mode: 'committed-release',
        sourceCommit: fixture.baseSha,
      }),
    /worktree differs/u,
  );
});

test('requires a fixture-owned valid manifest for candidate provenance', (t) => {
  const fixture = candidateFixture(t);
  rmSync(fixture.manifestPath);
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(fixture.root, 'missing-manifest'),
      }),
    /task-manifest\.json could not be read.*ENOENT/u,
  );

  const invalid = JSON.parse(fixture.manifestSource);
  invalid.git.baseSha = 'not-a-sha';
  writeFileSync(fixture.manifestPath, `${JSON.stringify(invalid, null, 2)}\n`);
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(fixture.root, 'invalid-manifest'),
      }),
    /baseSha must be a full lowercase 40-character SHA/u,
  );

  writeFileSync(fixture.manifestPath, fixture.manifestSource);
  assert.equal(
    buildProductionBundle({
      cwd: fixture.repository,
      output: join(fixture.root, 'restored-manifest'),
    }).status,
    'passed',
  );
});

test('changes candidate identity after a controlled fixture change', (t) => {
  const fixture = candidateFixture(t);
  const before = fixture.fingerprint;
  appendFileSync(
    join(fixture.repository, 'compose.production.yml'),
    '# second controlled candidate change\n',
  );
  const after = calculateFingerprint({ cwd: fixture.repository });
  assert.notEqual(after.contentFingerprint, before.contentFingerprint);
  assert.notEqual(after.candidateId, before.candidateId);
  const built = buildProductionBundle({
    cwd: fixture.repository,
    output: join(fixture.root, 'changed-candidate'),
  });
  assert.equal(built.manifest.contentFingerprint, after.contentFingerprint);
  assert.equal(built.manifest.candidateId, after.candidateId);
});

test('builds and validates a committed release only from a matching Git snapshot', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  const output = join(root, 'release');
  const built = buildProductionBundle({
    cwd: fixture.repository,
    output,
    mode: 'committed-release',
    sourceCommit: fixture.sourceCommit,
    env: {},
  });
  assert.equal(built.manifest.bundleMode, 'committed-release');
  assert.equal(built.manifest.operational, true);
  assert.equal(built.manifest.sourceCommit, fixture.sourceCommit);
  assert.equal(built.manifest.baseSha, undefined);
  assert.equal(built.manifest.candidateId, undefined);
  assert.deepEqual(
    built.manifest.artifacts.map((artifact) => artifact.mode),
    Array(ARTIFACTS.length).fill('0644'),
  );
  assert.equal(built.manifest.generatedAtSemantics, 'source-commit-timestamp');
  assert.equal(
    validateProductionBundle(output, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).status,
    'passed',
  );
});

test('rejects dirty release worktree bytes in builder and validator', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  const output = join(root, 'release');
  buildProductionBundle({
    cwd: fixture.repository,
    output,
    mode: 'committed-release',
    sourceCommit: fixture.sourceCommit,
  });
  writeFileSync(
    join(fixture.repository, 'compose.production.yml'),
    'dirty release worktree\n',
  );
  assert.match(
    validateProductionBundle(output, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /release worktree differs from source commit/u,
  );
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(root, 'dirty-release'),
        mode: 'committed-release',
        sourceCommit: fixture.sourceCommit,
      }),
    /release worktree differs from source commit/u,
  );
});

test('rejects a commit missing a required artifact', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  const missing = ARTIFACTS.at(-1).source;
  rmSync(join(fixture.repository, ...missing.split('/')));
  runGit(fixture.repository, ['add', '--all']);
  runGit(fixture.repository, ['commit', '--quiet', '-m', 'remove artifact'], {
    env: fixture.commitEnvironment,
  });
  const incompleteCommit = runGit(fixture.repository, ['rev-parse', 'HEAD']);
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(root, 'incomplete'),
        mode: 'committed-release',
        sourceCommit: incompleteCommit,
      }),
    /does not contain required artifact/u,
  );
});

test('rejects release blob and manifest mode divergence even with self-consistent hashes', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);

  const blobOutput = join(root, 'blob-drift');
  buildProductionBundle({
    cwd: fixture.repository,
    output: blobOutput,
    mode: 'committed-release',
    sourceCommit: fixture.sourceCommit,
  });
  const changed = Buffer.from('changed but locally rehashed\n');
  writeFileSync(join(blobOutput, 'compose.production.yml'), changed);
  const blobManifestPath = join(blobOutput, 'release-manifest.json');
  const blobManifest = JSON.parse(readFileSync(blobManifestPath, 'utf8'));
  blobManifest.artifacts.find(
    (entry) => entry.path === 'compose.production.yml',
  ).sha256 = sha256(changed);
  writeFileSync(blobManifestPath, `${JSON.stringify(blobManifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(blobOutput, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /blob diverges from source commit/u,
  );

  const modeOutput = join(root, 'mode-drift');
  buildProductionBundle({
    cwd: fixture.repository,
    output: modeOutput,
    mode: 'committed-release',
    sourceCommit: fixture.sourceCommit,
  });
  const modeManifestPath = join(modeOutput, 'release-manifest.json');
  const modeManifest = JSON.parse(readFileSync(modeManifestPath, 'utf8'));
  modeManifest.artifacts.find(
    (entry) => entry.path === 'docker/production/api-entrypoint.sh',
  ).mode = '0755';
  writeFileSync(modeManifestPath, `${JSON.stringify(modeManifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(modeOutput, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /mode mismatch|mode diverges from source commit/u,
  );
  modeManifest.artifacts.find(
    (entry) => entry.path === 'docker/production/api-entrypoint.sh',
  ).mode = '0600';
  writeFileSync(modeManifestPath, `${JSON.stringify(modeManifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(modeOutput, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /mode mismatch|mode diverges from source commit/u,
  );
});

test('rejects executable Git mode for scripts whose contract is 0644', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  const script = 'docker/production/api-entrypoint.sh';
  runGit(fixture.repository, ['update-index', '--chmod=+x', script]);
  runGit(
    fixture.repository,
    ['commit', '--quiet', '-m', 'make script executable'],
    {
      env: fixture.commitEnvironment,
    },
  );
  const executableCommit = runGit(fixture.repository, ['rev-parse', 'HEAD']);
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(root, 'executable-mode'),
        mode: 'committed-release',
        sourceCommit: executableCommit,
      }),
    /expected 0644, got 0755/u,
  );
});

test('rejects divergent candidate bindings and candidate-as-release use', (t) => {
  const fixture = candidateFixture(t);

  const drift = join(fixture.root, 'binding-drift');
  buildProductionBundle({ cwd: fixture.repository, output: drift });
  const manifestPath = join(drift, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.candidateId = '0'.repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(drift, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /candidate ID binding mismatch/u,
  );

  const candidate = join(fixture.root, 'candidate-as-release');
  buildProductionBundle({ cwd: fixture.repository, output: candidate });
  assert.match(
    validateProductionBundle(candidate, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /required mode: committed-release/u,
  );
});

test('rejects unexpected files, hash drift and mutable image references', (t) => {
  const fixture = candidateFixture(t);

  const extra = join(fixture.root, 'extra');
  buildProductionBundle({ cwd: fixture.repository, output: extra });
  writeFileSync(join(extra, 'unexpected.txt'), 'unexpected\n');
  assert.equal(
    validateProductionBundle(extra, { cwd: fixture.repository }).status,
    'failed',
  );

  const drift = join(fixture.root, 'drift');
  buildProductionBundle({ cwd: fixture.repository, output: drift });
  writeFileSync(join(drift, 'compose.production.yml'), 'changed\n');
  assert.match(
    validateProductionBundle(drift, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /hash mismatch/u,
  );

  const tag = join(fixture.root, 'tag');
  buildProductionBundle({ cwd: fixture.repository, output: tag });
  const manifestPath = join(tag, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.images.api.reference = 'ghcr.io/example/api:latest';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(tag, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /API reference mismatch|API image is not immutable/u,
  );
});

test('rejects secret-like values without rejecting approved names and paths', () => {
  assert.equal(
    obviousSecretFailure(
      'wrapper.sh',
      'export DATABASE_PASSWORD=$secret_value\nPOSTGRES_PASSWORD_FILE=/run/secrets/postgres_bootstrap_password\n',
    ),
    null,
  );
  assert.match(
    obviousSecretFailure('config.txt', 'JWT_ACCESS_SECRET=literal-value\n'),
    /sensitive assignment/u,
  );
  assert.match(
    obviousSecretFailure(
      'private.txt',
      `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\nexample\n`,
    ),
    /credential pattern/u,
  );
});

test('rejects invalid mode, output boundaries and nondeterministic epoch input', (t) => {
  const fixture = candidateFixture(t);
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(fixture.root, 'bad-epoch'),
        env: { SOURCE_DATE_EPOCH: 'not-a-number' },
      }),
    /SOURCE_DATE_EPOCH/u,
  );
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(fixture.root, 'bad-mode'),
        mode: 'release',
      }),
    /bundle mode is invalid/u,
  );
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(fixture.root, 'candidate-commit'),
        sourceCommit: fixture.baseSha,
      }),
    /candidate bundles cannot declare/u,
  );
  const existing = join(fixture.root, 'existing');
  mkdirSync(existing);
  assert.throws(
    () => buildProductionBundle({ cwd: fixture.repository, output: existing }),
    /must not already exist/u,
  );
});
