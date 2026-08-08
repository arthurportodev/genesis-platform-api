const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('builds a deterministic non-operational candidate with current bindings', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const options = {
    cwd: process.cwd(),
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
  assert.match(builtFirst.manifest.baseSha, /^[a-f0-9]{40}$/u);
  assert.match(builtFirst.manifest.candidateId, /^[a-f0-9]{64}$/u);
  assert.match(builtFirst.manifest.contentFingerprint, /^[a-f0-9]{64}$/u);
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
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = buildProductionBundle({
    cwd: process.cwd(),
    output: join(root, 'bundle'),
    mode: 'candidate',
    env: {},
  });
  assert.equal(built.manifest.generatedAtSemantics, 'base-commit-timestamp');
  assert.equal(built.manifest.sourceCommit, undefined);
});

test('rejects the current uncommitted candidate as a committed release', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: process.cwd(),
        output: join(root, 'release'),
        mode: 'committed-release',
        sourceCommit: '876aa4ae5a7f88bfbfd65ff4e40e3dab33c4079b',
      }),
    /does not contain required artifact|worktree differs/u,
  );
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
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const drift = join(root, 'binding-drift');
  buildProductionBundle({ cwd: process.cwd(), output: drift });
  const manifestPath = join(drift, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.candidateId = '0'.repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(drift, { cwd: process.cwd() }).failures.join('\n'),
    /candidate ID binding mismatch/u,
  );

  const candidate = join(root, 'candidate-as-release');
  buildProductionBundle({ cwd: process.cwd(), output: candidate });
  assert.match(
    validateProductionBundle(candidate, {
      cwd: process.cwd(),
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /required mode: committed-release/u,
  );
});

test('rejects unexpected files, hash drift and mutable image references', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const extra = join(root, 'extra');
  buildProductionBundle({ cwd: process.cwd(), output: extra });
  writeFileSync(join(extra, 'unexpected.txt'), 'unexpected\n');
  assert.equal(validateProductionBundle(extra).status, 'failed');

  const drift = join(root, 'drift');
  buildProductionBundle({ cwd: process.cwd(), output: drift });
  writeFileSync(join(drift, 'compose.production.yml'), 'changed\n');
  assert.match(
    validateProductionBundle(drift).failures.join('\n'),
    /hash mismatch/u,
  );

  const tag = join(root, 'tag');
  buildProductionBundle({ cwd: process.cwd(), output: tag });
  const manifestPath = join(tag, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.images.api.reference = 'ghcr.io/example/api:latest';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(tag).failures.join('\n'),
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
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: process.cwd(),
        output: join(root, 'bad-epoch'),
        env: { SOURCE_DATE_EPOCH: 'not-a-number' },
      }),
    /SOURCE_DATE_EPOCH/u,
  );
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: process.cwd(),
        output: join(root, 'bad-mode'),
        mode: 'release',
      }),
    /bundle mode is invalid/u,
  );
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: process.cwd(),
        output: join(root, 'candidate-commit'),
        sourceCommit: '876aa4ae5a7f88bfbfd65ff4e40e3dab33c4079b',
      }),
    /candidate bundles cannot declare/u,
  );
  const existing = join(root, 'existing');
  mkdirSync(existing);
  assert.throws(
    () => buildProductionBundle({ cwd: process.cwd(), output: existing }),
    /must not already exist/u,
  );
});
