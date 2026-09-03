const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');
const {
  ARTIFACTS,
  buildProductionBundle,
  MIGRATION_DIRECTORY,
  obviousSecretFailure,
} = require('../../scripts/build-production-bundle.cjs');
const {
  EXPECTED_FILES,
  RELEASE_DIRECTORIES,
  RELEASE_MANIFEST_ENTRY,
  RELEASE_TREE,
  validateProductionBundle,
} = require('../../scripts/validate-production-bundle.cjs');
const { calculateFingerprint } = require('../../scripts/task-fingerprint.cjs');
const {
  API_RELEASE_BINDINGS,
  BASELINE_REPAIR_BINDINGS,
  BASELINE_REPAIR_PROFILE,
} = require('../../scripts/validate-production-compose.cjs');

const MIGRATION_FIXTURE_INPUTS = readdirSync(
  join(process.cwd(), ...MIGRATION_DIRECTORY.split('/')),
)
  .map((name) => `${MIGRATION_DIRECTORY}/${name}`)
  .sort();
const VERSIONED_FIXTURE_INPUTS = [
  ...ARTIFACTS.map((artifact) => artifact.source),
  ...MIGRATION_FIXTURE_INPUTS,
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
  for (const source of MIGRATION_FIXTURE_INPUTS) {
    const target = join(repository, ...source.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(join(process.cwd(), ...source.split('/'))),
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
  assert.equal(builtFirst.manifest.releaseRole, 'current');
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
  assert.deepEqual(builtFirst.manifest.images.api, {
    reference:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:c53b283571955fa4ad2a056270bbc4b03222028e56d5177208c1a788696149f7',
    digest:
      'sha256:c53b283571955fa4ad2a056270bbc4b03222028e56d5177208c1a788696149f7',
    configDigest:
      'sha256:17e5b82451b78a20c6934b5dc2bb0cc00fa10252665245ed49b2f7c09a7fc629',
    applicationRevision: 'ac2f8cd96ae02c1cad52366871bdde8ca651631d',
    platform: 'linux/amd64',
  });
  assert.deepEqual(builtFirst.manifest.rollback.api, {
    reference:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb',
    digest:
      'sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb',
    configDigest:
      'sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24',
    applicationRevision: '0a56a8aee7c64bda59a1981888418e1ad03950c0',
    relation: 'previous-approved',
    platform: 'linux/amd64',
  });
  assert.equal(builtFirst.manifest.contractVersion, '0.8-MVP-08.v2');
  assert.deepEqual(builtFirst.manifest.migrations, {
    sourcePath: MIGRATION_DIRECTORY,
    orderedNames: [
      'CreateMultiTenantCore1784400000000',
      'CreateAuthSessions1784486400000',
      'CreateOrganizationInvitations1785004800000',
      'DeliverInvitationAcceptance1785087600000',
      'ActivateNewInvitationUser1785174000000',
      'ManageMembershipOwnership1785260400000',
      'CreateLeadFoundation1785346800000',
      'ManageLeadCommercialPipeline1785433200000',
      'ManageLeadActivitiesFollowUp1785519600000',
      'AddLeadOperationalReadIndexes1785606000000',
      'ManageLeadCommercialCycleExpectedValue1788289200000',
    ],
  });
  assert.deepEqual(builtFirst.manifest.releaseTree, RELEASE_TREE);
  assert.deepEqual(builtFirst.manifest.directories, RELEASE_DIRECTORIES);
  assert.deepEqual(builtFirst.manifest.manifestEntry, RELEASE_MANIFEST_ENTRY);
  assert.equal(builtFirst.manifest.directories.length, 11);
  assert.ok(
    builtFirst.manifest.artifacts.every(
      (entry) =>
        entry.type === 'file' && entry.owner === 0 && entry.group === 0,
    ),
  );
  const operator = builtFirst.manifest.artifacts.find(
    (entry) => entry.path === 'docker/production/deploy-api-release.py',
  );
  assert.equal(operator?.mode, '0644');
  assert.equal(
    operator?.sha256,
    sha256(
      readFileSync(
        join(first, 'docker', 'production', 'deploy-api-release.py'),
      ),
    ),
  );
  assert.deepEqual(builtFirst.manifest.images.traefik, {
    reference:
      'traefik@sha256:652929a140a32d7cafafb13c6cdfab5376cfeff800f51397b87b524501ed02a8',
    digest:
      'sha256:652929a140a32d7cafafb13c6cdfab5376cfeff800f51397b87b524501ed02a8',
    platform: 'linux/amd64',
    version: 'v3.7.9',
    tag: 'v3.7.9',
    source: 'https://github.com/traefik/traefik',
    imageCreatedAt: '2026-07-24T19:31:24.4220685Z',
    selectedAt: '2026-08-10',
  });
  for (const path of [
    'compose.traefik-internal.yml',
    'compose.traefik-public-http.yml',
    'compose.traefik-public-full.yml',
    'docker/traefik/traefik-internal.yml',
    'docker/traefik/traefik-acme-staging.yml',
    'docker/traefik/traefik-acme-production.yml',
    'docker/traefik/dynamic/api-health-only.yml',
    'docker/traefik/dynamic/api-functional.template.yml',
  ]) {
    assert.ok(
      EXPECTED_FILES.includes(path),
      `${path} is absent from the bundle`,
    );
  }
});

test('rejects migration inventory drift independently of manifest self-hash', (t) => {
  const fixture = candidateFixture(t);
  const output = join(fixture.root, 'migration-drift');
  buildProductionBundle({
    cwd: fixture.repository,
    output,
    mode: 'candidate',
    env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
  });
  const manifestPath = join(output, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.migrations.orderedNames.push('UnapprovedMigration');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.match(
    validateProductionBundle(output, { cwd: fixture.repository }).failures.join(
      '\n',
    ),
    /migration inventory mismatch/u,
  );
});

test('bundle generation cannot execute migration, database or container operations', () => {
  const source = readFileSync(
    join(process.cwd(), 'scripts', 'build-production-bundle.cjs'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /execFileSync\(\s*['"](?:docker(?:\.exe)?|psql)['"]/iu,
  );
  assert.doesNotMatch(source, /\bmigration:run\b/iu);
  assert.doesNotMatch(source, /\bGENESIS_ORIGIN_KEY\b/u);
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
  assert.equal(built.manifest.releaseRole, 'current');
  assert.equal(built.manifest.operational, true);
  assert.equal(built.manifest.sourceCommit, fixture.sourceCommit);
  assert.notEqual(
    built.manifest.sourceCommit,
    built.manifest.images.api.applicationRevision,
  );
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

test('builds only the closed deterministic 09E baseline repair current release', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  const first = join(root, 'baseline-repair-first');
  const second = join(root, 'baseline-repair-second');
  const options = {
    cwd: fixture.repository,
    mode: 'committed-release',
    releaseRole: 'current',
    profile: BASELINE_REPAIR_PROFILE,
    sourceCommit: fixture.sourceCommit,
    env: {},
  };
  const builtFirst = buildProductionBundle({ ...options, output: first });
  const builtSecond = buildProductionBundle({ ...options, output: second });
  assert.equal(builtFirst.manifest.releaseProfile, BASELINE_REPAIR_PROFILE);
  assert.equal(builtFirst.manifest.bundleMode, 'committed-release');
  assert.equal(builtFirst.manifest.releaseRole, 'current');
  assert.equal(builtFirst.manifest.sourceCommit, fixture.sourceCommit);
  assert.deepEqual(builtFirst.manifest.images.api, {
    reference: BASELINE_REPAIR_BINDINGS.current.image,
    digest: BASELINE_REPAIR_BINDINGS.current.image.split('@')[1],
    configDigest: BASELINE_REPAIR_BINDINGS.current.configDigest,
    applicationRevision: BASELINE_REPAIR_BINDINGS.current.applicationRevision,
    platform: 'linux/amd64',
  });
  assert.deepEqual(builtFirst.manifest.rollback.api, {
    reference: BASELINE_REPAIR_BINDINGS.previousApproved.image,
    digest: BASELINE_REPAIR_BINDINGS.previousApproved.image.split('@')[1],
    configDigest: BASELINE_REPAIR_BINDINGS.previousApproved.configDigest,
    applicationRevision:
      BASELINE_REPAIR_BINDINGS.previousApproved.applicationRevision,
    relation: 'previous-approved',
    platform: 'linux/amd64',
  });
  const compose = readFileSync(join(first, 'compose.production.yml'), 'utf8');
  assert.equal(compose.includes(API_RELEASE_BINDINGS.current.image), false);
  assert.equal(
    compose.split(BASELINE_REPAIR_BINDINGS.current.image).length - 1,
    2,
  );
  const composeEntry = builtFirst.manifest.artifacts.find(
    (entry) => entry.path === 'compose.production.yml',
  );
  assert.deepEqual(composeEntry.derivation, {
    kind: 'exact-baseline-repair-image-replacement',
    sourceSha256: sha256(
      readFileSync(join(fixture.repository, 'compose.production.yml')),
    ),
    from: API_RELEASE_BINDINGS.current.image,
    to: BASELINE_REPAIR_BINDINGS.current.image,
    replacements: 2,
  });
  assert.equal(existsSync(join(first, 'deployment-state')), false);
  assert.equal(
    readFileSync(join(first, 'release-manifest.json'), 'utf8'),
    readFileSync(join(second, 'release-manifest.json'), 'utf8'),
  );
  assert.equal(
    validateProductionBundle(first, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).status,
    'passed',
  );
});

test('rejects every open or malformed baseline repair binding', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(root, 'candidate-profile'),
        profile: BASELINE_REPAIR_PROFILE,
      }),
    /requires committed-release mode and the current release role/u,
  );
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(root, 'rollback-profile'),
        mode: 'committed-release',
        releaseRole: 'rollback',
        profile: BASELINE_REPAIR_PROFILE,
        sourceCommit: fixture.sourceCommit,
      }),
    /requires committed-release mode and the current release role/u,
  );
  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(root, 'arbitrary-profile'),
        mode: 'committed-release',
        profile: 'arbitrary-image-profile',
        sourceCommit: fixture.sourceCommit,
      }),
    /release profile is invalid/u,
  );

  const scenarios = [
    {
      name: 'prospective-current',
      mutate: (manifest) => {
        manifest.images.api = {
          ...manifest.images.api,
          ...API_RELEASE_BINDINGS.current,
          digest: API_RELEASE_BINDINGS.current.image.split('@')[1],
        };
      },
      expected: /API reference mismatch|API application revision mismatch/u,
    },
    {
      name: 'wrong-current-config',
      mutate: (manifest) => {
        manifest.images.api.configDigest = `sha256:${'2'.repeat(64)}`;
      },
      expected: /API config digest mismatch/u,
    },
    {
      name: 'wrong-previous-approved',
      mutate: (manifest) => {
        manifest.rollback.api.applicationRevision = '1'.repeat(40);
      },
      expected: /rollback API metadata mismatch/u,
    },
    {
      name: 'malformed-derivation',
      mutate: (manifest) => {
        manifest.artifacts.find(
          (entry) => entry.path === 'compose.production.yml',
        ).derivation.to = API_RELEASE_BINDINGS.current.image;
      },
      expected: /derivation metadata mismatch/u,
    },
    {
      name: 'free-form-manifest-override',
      mutate: (manifest) => {
        manifest.currentImageOverride = `ghcr.io/example/api@sha256:${'f'.repeat(64)}`;
      },
      expected: /manifest fields are not closed/u,
    },
  ];
  for (const scenario of scenarios) {
    const output = join(root, scenario.name);
    buildProductionBundle({
      cwd: fixture.repository,
      output,
      mode: 'committed-release',
      releaseRole: 'current',
      profile: BASELINE_REPAIR_PROFILE,
      sourceCommit: fixture.sourceCommit,
      env: {},
    });
    const manifestPath = join(output, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    scenario.mutate(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.match(
      validateProductionBundle(output, {
        cwd: fixture.repository,
        requiredMode: 'committed-release',
      }).failures.join('\n'),
      scenario.expected,
    );
  }

  const extra = join(root, 'deployment-state-extra');
  buildProductionBundle({
    cwd: fixture.repository,
    output: extra,
    mode: 'committed-release',
    releaseRole: 'current',
    profile: BASELINE_REPAIR_PROFILE,
    sourceCommit: fixture.sourceCommit,
    env: {},
  });
  mkdirSync(join(extra, 'deployment-state'));
  writeFileSync(join(extra, 'deployment-state', 'pointers.json'), '{}\n');
  assert.match(
    validateProductionBundle(extra, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /bundle file allowlist mismatch/u,
  );

  const script = join(process.cwd(), 'scripts', 'build-production-bundle.cjs');
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          script,
          '--output',
          join(root, 'free-image-override'),
          '--mode',
          'committed-release',
          '--profile',
          BASELINE_REPAIR_PROFILE,
          '--current-image',
          `ghcr.io/example/api@sha256:${'f'.repeat(64)}`,
        ],
        { cwd: fixture.repository, encoding: 'utf8', windowsHide: true },
      ),
    /Command failed/u,
  );
});

test('builds a candidate through the operational CLI without circular exports', (t) => {
  const fixture = candidateFixture(t);
  const output = join(fixture.root, 'cli-candidate');
  const script = join(process.cwd(), 'scripts', 'build-production-bundle.cjs');
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [script, '--output', output, '--mode', 'candidate'],
      {
        cwd: fixture.repository,
        encoding: 'utf8',
        windowsHide: true,
      },
    ),
  );
  assert.equal(result.status, 'passed');
  assert.equal(result.bundleMode, 'candidate');
  assert.equal(result.releaseRole, 'current');
  assert.equal(result.candidateId, fixture.fingerprint.candidateId);
});

test('builds a real rollback committed release accepted by validator and manager', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  const currentOutput = join(root, 'current-release');
  const rollbackOutput = join(root, 'rollback-release');
  const current = buildProductionBundle({
    cwd: fixture.repository,
    output: currentOutput,
    mode: 'committed-release',
    releaseRole: 'current',
    sourceCommit: fixture.sourceCommit,
    env: {},
  });
  const rollback = buildProductionBundle({
    cwd: fixture.repository,
    output: rollbackOutput,
    mode: 'committed-release',
    releaseRole: 'rollback',
    sourceCommit: fixture.sourceCommit,
    env: {},
  });
  assert.equal(current.manifest.releaseRole, 'current');
  assert.equal(rollback.manifest.releaseRole, 'rollback');
  assert.equal(
    rollback.manifest.images.api.reference,
    rollback.manifest.rollback.api.reference,
  );
  assert.equal(rollback.manifest.images.api.relation, 'previous-approved');
  assert.equal(
    rollback.manifest.images.api.configDigest,
    'sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24',
  );
  assert.equal(
    rollback.manifest.images.api.applicationRevision,
    '0a56a8aee7c64bda59a1981888418e1ad03950c0',
  );
  assert.equal(current.manifest.sourceCommit, rollback.manifest.sourceCommit);
  assert.notEqual(
    current.manifest.sourceCommit,
    current.manifest.images.api.applicationRevision,
  );
  assert.notEqual(
    rollback.manifest.sourceCommit,
    rollback.manifest.images.api.applicationRevision,
  );
  const rollbackCompose = readFileSync(
    join(rollbackOutput, 'compose.production.yml'),
    'utf8',
  );
  assert.equal(
    rollbackCompose.includes(current.manifest.images.api.reference),
    false,
  );
  assert.equal(
    rollbackCompose.split(rollback.manifest.images.api.reference).length - 1,
    2,
  );
  const composeEntry = rollback.manifest.artifacts.find(
    (entry) => entry.path === 'compose.production.yml',
  );
  assert.deepEqual(composeEntry.derivation, {
    kind: 'exact-api-image-replacement',
    sourceSha256: sha256(
      readFileSync(join(fixture.repository, 'compose.production.yml')),
    ),
    from: current.manifest.images.api.reference,
    to: rollback.manifest.images.api.reference,
    replacements: 2,
  });
  assert.notEqual(
    sha256(readFileSync(join(currentOutput, 'release-manifest.json'))),
    sha256(readFileSync(join(rollbackOutput, 'release-manifest.json'))),
  );
  assert.equal(
    validateProductionBundle(rollbackOutput, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).status,
    'passed',
  );
  if (process.platform === 'linux') {
    const currentManifest = readFileSync(
      join(currentOutput, 'release-manifest.json'),
    );
    const rollbackManifest = readFileSync(
      join(rollbackOutput, 'release-manifest.json'),
    );
    const output = execFileSync(
      'python3',
      [
        join(process.cwd(), 'docker', 'production', 'release-tree-manager.py'),
        'verify-pair',
        '--current-bundle',
        currentOutput,
        '--current-fingerprint',
        `sha256:${sha256(currentManifest)}`,
        '--current-image',
        current.manifest.images.api.reference,
        '--rollback-bundle',
        rollbackOutput,
        '--rollback-fingerprint',
        `sha256:${sha256(rollbackManifest)}`,
        '--rollback-image',
        rollback.manifest.images.api.reference,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.deepEqual(JSON.parse(output), {
      command: 'verify-pair',
      currentRole: 'current',
      rollbackRole: 'rollback',
      status: 'passed',
    });
  }
  const rollbackManifestPath = join(rollbackOutput, 'release-manifest.json');
  const mutated = JSON.parse(readFileSync(rollbackManifestPath, 'utf8'));
  mutated.artifacts.find(
    (entry) => entry.path === 'compose.production.yml',
  ).derivation.replacements = 1;
  writeFileSync(rollbackManifestPath, `${JSON.stringify(mutated, null, 2)}\n`);
  assert.match(
    validateProductionBundle(rollbackOutput, {
      cwd: fixture.repository,
      requiredMode: 'committed-release',
    }).failures.join('\n'),
    /derivation metadata mismatch/u,
  );
});

test('rejects stale or mismatched rollback provenance for the next release pair', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = committedFixture(root);
  const output = join(root, 'rollback-release');
  buildProductionBundle({
    cwd: fixture.repository,
    output,
    mode: 'committed-release',
    releaseRole: 'rollback',
    sourceCommit: fixture.sourceCommit,
    env: {},
  });
  const manifestPath = join(output, 'release-manifest.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const cases = [
    {
      mutate: (manifest) => {
        manifest.images.api.applicationRevision = '1'.repeat(40);
      },
      expected: /API application revision mismatch/u,
    },
    {
      mutate: (manifest) => {
        manifest.images.api.configDigest = `sha256:${'2'.repeat(64)}`;
      },
      expected: /API config digest mismatch/u,
    },
    {
      mutate: (manifest) => {
        const stale =
          'ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659';
        manifest.images.api.reference = stale;
        manifest.images.api.digest = stale.split('@')[1];
      },
      expected: /API reference mismatch|API digest mismatch/u,
    },
  ];
  for (const scenario of cases) {
    const mutated = structuredClone(original);
    scenario.mutate(mutated);
    writeFileSync(manifestPath, `${JSON.stringify(mutated, null, 2)}\n`);
    assert.match(
      validateProductionBundle(output, {
        cwd: fixture.repository,
        requiredMode: 'committed-release',
      }).failures.join('\n'),
      scenario.expected,
    );
  }
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

test('rejects release-tree metadata drift and a non-atomic activation policy', (t) => {
  const fixture = candidateFixture(t);
  const directoryDrift = join(fixture.root, 'directory-drift');
  buildProductionBundle({ cwd: fixture.repository, output: directoryDrift });
  const directoryManifestPath = join(directoryDrift, 'release-manifest.json');
  const directoryManifest = JSON.parse(
    readFileSync(directoryManifestPath, 'utf8'),
  );
  directoryManifest.directories.find((entry) => entry.path === '.').mode =
    '0777';
  writeFileSync(
    directoryManifestPath,
    `${JSON.stringify(directoryManifest, null, 2)}\n`,
  );
  assert.match(
    validateProductionBundle(directoryDrift, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /release directory allowlist or metadata mismatch/u,
  );

  const atomicDrift = join(fixture.root, 'atomic-drift');
  buildProductionBundle({ cwd: fixture.repository, output: atomicDrift });
  const atomicManifestPath = join(atomicDrift, 'release-manifest.json');
  const atomicManifest = JSON.parse(readFileSync(atomicManifestPath, 'utf8'));
  atomicManifest.releaseTree.activation.primitive = 'mv';
  atomicManifest.releaseTree.activation.nonAtomicFallback = 'allowed';
  writeFileSync(
    atomicManifestPath,
    `${JSON.stringify(atomicManifest, null, 2)}\n`,
  );
  assert.match(
    validateProductionBundle(atomicDrift, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /release-tree policy mismatch/u,
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

  assert.throws(
    () =>
      buildProductionBundle({
        cwd: fixture.repository,
        output: join(fixture.root, 'rollback-candidate'),
        releaseRole: 'rollback',
      }),
    /candidate bundles can describe only the current release role/u,
  );

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

  const rollbackSelected = join(fixture.root, 'rollback-selected');
  buildProductionBundle({ cwd: fixture.repository, output: rollbackSelected });
  const rollbackSelectedManifestPath = join(
    rollbackSelected,
    'release-manifest.json',
  );
  const rollbackSelectedManifest = JSON.parse(
    readFileSync(rollbackSelectedManifestPath, 'utf8'),
  );
  rollbackSelectedManifest.images.api.reference =
    rollbackSelectedManifest.rollback.api.reference;
  rollbackSelectedManifest.images.api.digest =
    rollbackSelectedManifest.rollback.api.digest;
  writeFileSync(
    rollbackSelectedManifestPath,
    `${JSON.stringify(rollbackSelectedManifest, null, 2)}\n`,
  );
  assert.match(
    validateProductionBundle(rollbackSelected, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /API reference mismatch|API digest mismatch|must remain distinct/u,
  );

  const staleCurrent = join(fixture.root, 'stale-current');
  buildProductionBundle({ cwd: fixture.repository, output: staleCurrent });
  const staleCurrentManifestPath = join(staleCurrent, 'release-manifest.json');
  const staleCurrentManifest = JSON.parse(
    readFileSync(staleCurrentManifestPath, 'utf8'),
  );
  staleCurrentManifest.images.api.reference =
    'ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a';
  staleCurrentManifest.images.api.digest =
    'sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a';
  writeFileSync(
    staleCurrentManifestPath,
    `${JSON.stringify(staleCurrentManifest, null, 2)}\n`,
  );
  assert.match(
    validateProductionBundle(staleCurrent, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /API reference mismatch|API digest mismatch/u,
  );

  const provenanceDrift = join(fixture.root, 'provenance-drift');
  buildProductionBundle({ cwd: fixture.repository, output: provenanceDrift });
  const provenanceManifestPath = join(provenanceDrift, 'release-manifest.json');
  const provenanceManifest = JSON.parse(
    readFileSync(provenanceManifestPath, 'utf8'),
  );
  provenanceManifest.images.api.applicationRevision =
    '1111111111111111111111111111111111111111';
  provenanceManifest.images.api.configDigest = `sha256:${'2'.repeat(64)}`;
  provenanceManifest.images.api.platform = 'linux/arm64';
  writeFileSync(
    provenanceManifestPath,
    `${JSON.stringify(provenanceManifest, null, 2)}\n`,
  );
  assert.match(
    validateProductionBundle(provenanceDrift, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /API config digest mismatch/u,
  );
  assert.match(
    validateProductionBundle(provenanceDrift, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /API application revision mismatch/u,
  );
  assert.match(
    validateProductionBundle(provenanceDrift, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /API platform mismatch/u,
  );

  const rollbackTag = join(fixture.root, 'rollback-tag');
  buildProductionBundle({ cwd: fixture.repository, output: rollbackTag });
  const rollbackManifestPath = join(rollbackTag, 'release-manifest.json');
  const rollbackManifest = JSON.parse(
    readFileSync(rollbackManifestPath, 'utf8'),
  );
  rollbackManifest.rollback.api.reference =
    'ghcr.io/arthurportodev/genesis-platform-api:rollback';
  writeFileSync(
    rollbackManifestPath,
    `${JSON.stringify(rollbackManifest, null, 2)}\n`,
  );
  assert.match(
    validateProductionBundle(rollbackTag, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /rollback API reference mismatch|rollback API image is not immutable/u,
  );

  const traefikTag = join(fixture.root, 'traefik-tag');
  buildProductionBundle({ cwd: fixture.repository, output: traefikTag });
  const traefikManifestPath = join(traefikTag, 'release-manifest.json');
  const traefikManifest = JSON.parse(readFileSync(traefikManifestPath, 'utf8'));
  traefikManifest.images.traefik.reference = 'traefik:v3.7.9';
  writeFileSync(
    traefikManifestPath,
    `${JSON.stringify(traefikManifest, null, 2)}\n`,
  );
  assert.match(
    validateProductionBundle(traefikTag, {
      cwd: fixture.repository,
    }).failures.join('\n'),
    /Traefik reference mismatch|Traefik image is not immutable/u,
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
