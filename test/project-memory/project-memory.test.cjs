'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  cpSync,
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
  AUTHORITY_PATH,
  PROJECTION_PATH,
  SCHEMA_PATH,
  TARGET_STATE_REVISION,
  WEB_INTEGRATED_SHA,
  WEB_RECEIPT_BASE_SHA,
  WEB_SHA,
  WEB_TRANSITION_ID,
  MemoryError,
  containingCommit,
  renderProjection,
  validateCrossRepo,
  validateOnboardingResponse,
  validateRepositoryEvidence,
  validateState,
} = require('../../scripts/validate-project-memory.cjs');

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'validate-project-memory.cjs');
const STABLE = [
  'AGENTS.md',
  'README.md',
  'docs/START_HERE.md',
  'docs/PROJECT_OVERVIEW.md',
  'docs/ROADMAP.md',
  'docs/PRODUCTION.md',
  'docs/ARCHITECTURE.md',
  'docs/SECURITY.md',
  'docs/TASK_LOG.md',
  'docs/DEVELOPMENT_WORKFLOW.md',
  'docs/decisions/README.md',
  'docs/decisions/ADR-012-development-operating-system-v2.md',
  'docs/decisions/ADR-013-mvp-production-baseline.md',
  'docs/decisions/ADR-014-versioned-production-contract.md',
];
const FIXTURES = [];
const REPOSITORY_EVIDENCE_PREFIX =
  'repo://arthurportodev/genesis-platform-api/';
const HISTORICAL_REPOSITORY_EVIDENCE_PREFIX =
  'https://github.com/arthurportodev/genesis-platform-api/blob/';
const HISTORICAL_GIT_ROOT = mkdtempSync(
  join(tmpdir(), 'genesis-memory-objects-'),
);
const ROOT_GIT_DIR = join(HISTORICAL_GIT_ROOT, 'repository.git').replaceAll(
  '\\',
  '/',
);
FIXTURES.push(HISTORICAL_GIT_ROOT);
git(ROOT, ['clone', '--quiet', '--bare', '--shared', '.', ROOT_GIT_DIR]);
const POINTER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/arthurportodev/genesis-platform-web/schemas/genesis-harness/project-state.pointer.v1.schema.json',
  title: 'Genesis Platform Web canonical-state pointer v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'instanceKind',
    'project',
    'mode',
    'authority',
    'receipt',
  ],
  properties: {
    schemaVersion: { const: '1.0.0' },
    instanceKind: { const: 'current' },
    project: { const: 'genesis-platform' },
    mode: { const: 'pointer-only' },
    authority: {
      type: 'object',
      additionalProperties: false,
      required: [
        'repository',
        'branch',
        'path',
        'acceptedSchemaMajor',
        'resolutionOrder',
      ],
      properties: {
        repository: { const: 'arthurportodev/genesis-platform-api' },
        branch: { const: 'main' },
        path: { const: AUTHORITY_PATH },
        acceptedSchemaMajor: { const: 1 },
        resolutionOrder: {
          const: ['explicit-checkout', 'sibling-checkout', 'remote-read-only'],
        },
      },
    },
    receipt: {
      type: 'object',
      additionalProperties: false,
      required: [
        'transitionId',
        'targetStateRevision',
        'baseSha',
        'revisionSource',
        'generatedAt',
      ],
      properties: {
        transitionId: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$',
        },
        targetStateRevision: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$',
        },
        baseSha: { type: 'string', pattern: '^(?!0{40}$)[a-f0-9]{40}$' },
        revisionSource: { const: 'containing-commit' },
        generatedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};

function candidatePointer() {
  return {
    schemaVersion: '1.0.0',
    instanceKind: 'current',
    project: 'genesis-platform',
    mode: 'pointer-only',
    authority: {
      repository: 'arthurportodev/genesis-platform-api',
      branch: 'main',
      path: AUTHORITY_PATH,
      acceptedSchemaMajor: 1,
      resolutionOrder: [
        'explicit-checkout',
        'sibling-checkout',
        'remote-read-only',
      ],
    },
    receipt: {
      transitionId: WEB_TRANSITION_ID,
      targetStateRevision: TARGET_STATE_REVISION,
      baseSha: WEB_RECEIPT_BASE_SHA,
      revisionSource: 'containing-commit',
      generatedAt: '2026-08-24T14:18:54.2261794Z',
    },
  };
}

function target(root, path) {
  return join(root, ...path.split('/'));
}

function copy(root, path) {
  const destination = target(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(target(ROOT, path), destination);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'genesis-api-memory-'));
  FIXTURES.push(root);
  const authority = JSON.parse(
    readFileSync(target(ROOT, AUTHORITY_PATH), 'utf8'),
  );
  const repositoryEvidence = authority.evidence
    .filter((entry) => entry.uri.startsWith(REPOSITORY_EVIDENCE_PREFIX))
    .map((entry) => entry.uri.slice(REPOSITORY_EVIDENCE_PREFIX.length));
  const historicalRepositoryEvidence = authority.evidence
    .filter((entry) =>
      entry.uri.startsWith(HISTORICAL_REPOSITORY_EVIDENCE_PREFIX),
    )
    .map((entry) => {
      const reference = entry.uri.slice(
        HISTORICAL_REPOSITORY_EVIDENCE_PREFIX.length,
      );
      return reference.slice(reference.indexOf('/') + 1);
    });
  writeFileSync(join(root, '.git'), `gitdir: ${ROOT_GIT_DIR}\n`, 'utf8');
  for (const path of new Set([
    AUTHORITY_PATH,
    SCHEMA_PATH,
    PROJECTION_PATH,
    ...STABLE,
    ...repositoryEvidence,
    ...historicalRepositoryEvidence,
  ]))
    copy(root, path);
  return root;
}

function readJson(root, path = AUTHORITY_PATH) {
  return JSON.parse(readFileSync(target(root, path), 'utf8'));
}

function writeJson(root, value, path = AUTHORITY_PATH) {
  const destination = target(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(root, args = ['--mode', 'local']) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitWebFixture() {
  const root = mkdtempSync(join(tmpdir(), 'genesis-web-provenance-'));
  FIXTURES.push(root);
  writeJson(
    root,
    candidatePointer(),
    'docs/memory/project-state.pointer.v1.json',
  );
  writeJson(
    root,
    POINTER_SCHEMA,
    'schemas/genesis-harness/project-state.pointer.v1.schema.json',
  );
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Genesis Memory Test']);
  git(root, ['config', 'user.email', 'memory-test@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Add Web pointer contract']);
  return root;
}

function expectCode(result, code, status = 1) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, code);
  assert.ok(result.stderr.length > 0);
}

function evidence(uri, sha256) {
  return {
    evidence: [
      {
        id: 'EV-TEST-REPOSITORY',
        kind: 'repository-file',
        uri,
        sha256,
      },
    ],
  };
}

function expectEvidenceCode(root, state, code) {
  assert.throws(
    () => validateRepositoryEvidence(root, state),
    (error) => error instanceof MemoryError && error.code === code,
  );
}

function historicalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'genesis-history-evidence-'));
  FIXTURES.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Genesis Memory Test']);
  git(root, ['config', 'user.email', 'memory-test@example.invalid']);
  writeFileSync(target(root, 'evidence.txt'), 'historical bytes\n', 'utf8');
  git(root, ['add', 'evidence.txt']);
  git(root, ['commit', '-m', 'Record historical evidence']);
  return {
    root,
    revision: git(root, ['rev-parse', 'HEAD']),
    hash: createHash('sha256').update('historical bytes\n').digest('hex'),
  };
}

test.after(() => {
  for (const root of FIXTURES) rmSync(root, { recursive: true, force: true });
});

test('accepts the complete API authority and generated projection', () => {
  const result = run(ROOT);
  assert.equal(result.status, 0, result.stderr);
  const state = readJson(ROOT);
  assert.deepEqual(result.json, {
    ok: true,
    code: 'MEMORY_VALID',
    stateRevision: state.stateRevision,
    schemaValidated: true,
    semanticRulesValidated: true,
    projectionCurrent: true,
    stableSourcesValidated: true,
  });
});

test('renders byte-identical output and check mode is idempotent', () => {
  const root = fixture();
  const before = readFileSync(target(root, PROJECTION_PATH), 'utf8');
  const rendered = run(root, ['--mode', 'render']);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(readFileSync(target(root, PROJECTION_PATH), 'utf8'), before);
  assert.equal(run(root, ['--mode', 'render', '--check']).status, 0);
});

test('rejects stale generated projection', () => {
  const root = fixture();
  writeFileSync(target(root, PROJECTION_PATH), '# stale\n', 'utf8');
  expectCode(run(root), 'MEMORY_PROJECTION_STALE');
});

test('rejects invalid JSON and non-UTF-8 authority input', () => {
  const root = fixture();
  writeFileSync(target(root, AUTHORITY_PATH), '{', 'utf8');
  expectCode(run(root), 'MEMORY_PARSE_ERROR');
  writeFileSync(target(root, AUTHORITY_PATH), Buffer.from([0xff, 0xfe]));
  expectCode(run(root), 'MEMORY_PARSE_ERROR');
});

test('rejects an unsupported schema version', () => {
  const root = fixture();
  const state = readJson(root);
  state.schemaVersion = '2.0.0';
  writeJson(root, state);
  expectCode(run(root), 'MEMORY_SCHEMA_UNSUPPORTED');
});

test('rejects historical fixtures as current authority', () => {
  const state = readJson(ROOT);
  state.instanceKind = 'historical-fixture';
  assert.throws(
    () => validateState(state),
    (error) => error.code === 'MEMORY_HISTORICAL_FIXTURE',
  );
});

test('rejects unknown top-level properties', () => {
  const root = fixture();
  const state = readJson(root);
  state.duplicateCurrentState = {};
  writeJson(root, state);
  expectCode(run(root), 'MEMORY_SCHEMA_INVALID');
});

test('applies the complete authority schema to nested properties and formats', () => {
  for (const mutate of [
    (state) => {
      state.phase.unexpected = true;
    },
    (state) => {
      state.evidence[0].sha256 = 'not-a-sha';
    },
    (state) => {
      state.evidence[0].uri = 'not a uri';
    },
    (state) => {
      delete state.blockers[0].summary;
    },
    (state) => {
      state.nextTask.extra = true;
    },
  ]) {
    const root = fixture();
    const state = readJson(root);
    mutate(state);
    writeJson(root, state);
    expectCode(run(root), 'MEMORY_SCHEMA_INVALID');
  }
});

test('rejects a second authority and an API future SHA', () => {
  for (const mutate of [
    (state) => {
      state.repositories.find((entry) => entry.id === 'web').role = 'authority';
    },
    (state) => {
      state.repositories.find(
        (entry) => entry.id === 'api',
      ).memoryRevision.sha = 'a'.repeat(40);
    },
  ]) {
    const state = readJson(ROOT);
    mutate(state);
    assert.throws(
      () => validateState(state),
      (error) => error.code === 'MEMORY_AUTHORITY_NOT_UNIQUE',
    );
  }
});

test('requires the exact Web pointer memoryRevision', () => {
  const root = fixture();
  const state = readJson(root);
  state.repositories.find((entry) => entry.id === 'web').memoryRevision.sha =
    'a'.repeat(40);
  writeJson(root, state);
  expectCode(run(root), 'MEMORY_WEB_REVISION_MISMATCH');
});

test('keeps the pointer receipt stable across later authority revisions', () => {
  const state = readJson(ROOT);
  state.stateRevision = 'LATER-AUTHORITY-REVISION-2026-08-26';
  assert.equal(validateState(state), state);

  state.pointerMetadata.targetStateRevision = state.stateRevision;
  assert.throws(
    () => validateState(state),
    (error) => error.code === 'MEMORY_POINTER_MISMATCH',
  );
});

test('rejects observed facts without direct observation time', () => {
  const state = readJson(ROOT);
  state.operationalState.facts[0].basis = 'observed';
  assert.throws(
    () => validateState(state),
    (error) => error.code === 'MEMORY_OBSERVATION_INCOMPLETE',
  );
});

test('rejects observedAt on documented or unknown facts', () => {
  const state = readJson(ROOT);
  state.operationalState.facts[0].observedAt = '2026-08-10T16:00:00Z';
  assert.throws(
    () => validateState(state),
    (error) => error.code === 'MEMORY_OBSERVATION_INCOMPLETE',
  );
});

test('requires the MVP08 remote tree binding to be explicitly superseded', () => {
  const state = readJson(ROOT);
  const fact = state.operationalState.facts.find(
    (entry) => entry.id === 'OPS-MVP08-VPS-INTEGRITY-AUDIT',
  );
  fact.status = 'present';
  fact.statement = 'remoteTreeBinding=REBIND_REQUIRED. Historical value.';
  assert.throws(
    () => validateState(state),
    (error) => error.code === 'MEMORY_RELEASE_TREE_BINDING_INVALID',
  );
});

test('binds application, containing release contracts, derived bundle, images and Web exactly', () => {
  const state = readJson(ROOT);
  assert.deepEqual(state.releaseBindings, {
    apiApplicationRevision: '0a56a8aee7c64bda59a1981888418e1ad03950c0',
    apiReleaseManifestRevision: { kind: 'containing-commit' },
    apiReleaseTreeContractRevision: { kind: 'containing-commit' },
    apiReleaseBundleFingerprint: {
      kind: 'derived-from-containing-commit',
      algorithm: 'sha256',
      artifact: 'release-manifest.json',
      releaseRole: 'current',
    },
    apiRollbackReleaseBundleFingerprint: {
      kind: 'derived-from-containing-commit',
      algorithm: 'sha256',
      artifact: 'release-manifest.json',
      releaseRole: 'rollback',
    },
    authorizedApiImage:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb',
    authorizedApiImageConfigDigest:
      'sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24',
    rollbackApiImage:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a',
    webIntegratedRevision: WEB_INTEGRATED_SHA,
  });

  for (const mutate of [
    (candidate) => {
      candidate.releaseBindings.apiApplicationRevision =
        '1111111111111111111111111111111111111111';
    },
    (candidate) => {
      candidate.releaseBindings.apiReleaseManifestRevision = {
        kind: 'commit',
        sha: '2222222222222222222222222222222222222222',
      };
    },
    (candidate) => {
      candidate.releaseBindings.apiReleaseTreeContractRevision = {
        kind: 'commit',
      };
    },
    (candidate) => {
      candidate.releaseBindings.apiReleaseBundleFingerprint.algorithm =
        'sha512';
    },
    (candidate) => {
      candidate.releaseBindings.apiReleaseBundleFingerprint.releaseRole =
        'rollback';
    },
    (candidate) => {
      candidate.releaseBindings.apiRollbackReleaseBundleFingerprint.releaseRole =
        'current';
    },
    (candidate) => {
      candidate.releaseBindings.authorizedApiImage =
        candidate.releaseBindings.rollbackApiImage;
    },
    (candidate) => {
      candidate.releaseBindings.authorizedApiImageConfigDigest = `sha256:${'3'.repeat(64)}`;
    },
    (candidate) => {
      candidate.releaseBindings.rollbackApiImage =
        'ghcr.io/arthurportodev/genesis-platform-api:rollback';
    },
    (candidate) => {
      candidate.releaseBindings.webIntegratedRevision =
        '4444444444444444444444444444444444444444';
    },
  ]) {
    const candidate = structuredClone(state);
    mutate(candidate);
    assert.throws(
      () => validateState(candidate),
      (error) =>
        error.code === 'MEMORY_SCHEMA_INVALID' ||
        error.code === 'MEMORY_RELEASE_BINDING_MISMATCH',
    );
  }
});

test('rejects missing or misclassified control categories', () => {
  for (const mutate of [
    (state) => {
      state.permanentInvariants = [];
    },
    (state) => {
      state.releaseGates[0].id = 'OR-WRONG';
    },
    (state) => {
      state.currentRestrictions[0].id = 'PI-WRONG';
    },
  ]) {
    const state = readJson(ROOT);
    mutate(state);
    assert.throws(
      () => validateState(state),
      (error) => error.code === 'MEMORY_CONTROL_CLASSIFICATION_INVALID',
    );
  }
});

test('rejects unresolved evidence references', () => {
  const state = readJson(ROOT);
  state.releaseGates[0].sourceEvidenceIds = ['EV-MISSING'];
  assert.throws(
    () => validateState(state),
    (error) => error.code === 'MEMORY_EVIDENCE_UNRESOLVED',
  );
});

test('rejects an incomplete supersession record', () => {
  const state = readJson(ROOT);
  state.supersededPlans = [];
  assert.throws(
    () => validateState(state),
    (error) => error.code === 'MEMORY_SUPERSESSION_INCOMPLETE',
  );
});

test('rejects secret-bearing keys and secret-like values', () => {
  for (const mutate of [
    (state) => {
      state.project.apiToken = 'not-real';
    },
    (state) => {
      state.project.name = `github_pat_${'a'.repeat(24)}`;
    },
  ]) {
    const state = readJson(ROOT);
    mutate(state);
    assert.throws(
      () => validateState(state),
      (error) => error.code === 'MEMORY_SECRET_DETECTED',
    );
  }
});

test('requires every stable source to delegate temporal authority', () => {
  const root = fixture();
  writeFileSync(target(root, 'README.md'), '# no authority\n', 'utf8');
  expectCode(run(root), 'MEMORY_STABLE_SOURCE_HAS_STATE');
});

test('requires source authority by domain and never promotes ADR or projection over temporal JSON', () => {
  const root = fixture();
  const agentsPath = target(root, 'AGENTS.md');
  const agents = readFileSync(agentsPath, 'utf8').replace(
    'temporal=docs/memory/project-state.v1.json',
    'temporal=accepted-adrs',
  );
  writeFileSync(agentsPath, agents, 'utf8');
  expectCode(run(root), 'MEMORY_SOURCE_AUTHORITY_INVALID');
});

test('marker does not suppress a pending human decision assertion', () => {
  const root = fixture();
  const path = target(root, 'README.md');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}\n\n## Decisões humanas pendentes\n\n**PENDING HUMAN DECISION**: escolher provedor.\n`,
    'utf8',
  );
  expectCode(run(root), 'MEMORY_TEMPORAL_ASSERTION_FORBIDDEN');
});

test('marker does not suppress a hardcoded next task', () => {
  const root = fixture();
  const path = target(root, 'README.md');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}\n\nPróxima tarefa: 0.8-MVP-99.\n`,
    'utf8',
  );
  expectCode(run(root), 'MEMORY_TEMPORAL_ASSERTION_FORBIDDEN');
});

test('temporal lint covers phase, blockers, rollout, operational state and current gates', () => {
  for (const assertion of [
    'Fase atual: 0.8-MVP.',
    '## Blockers abertos\n\n- BLOCK-X.',
    'Rollout pendente até nova ordem.',
    '## Estado atual\n\nServiço ativo.',
    '## Gates atuais pendentes\n\n- RG-X.',
  ]) {
    const root = fixture();
    const path = target(root, 'README.md');
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}\n\n${assertion}\n`,
      'utf8',
    );
    expectCode(run(root), 'MEMORY_TEMPORAL_ASSERTION_FORBIDDEN');
  }
});

test('explicitly bounded historical snapshot passes temporal lint', () => {
  const root = fixture();
  const path = target(root, 'README.md');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}\n\n<!-- genesis-memory-history:start -->\n\n## Snapshot histórico do estado atual\n\nPróxima tarefa: snapshot-antigo.\n\n**PENDING HUMAN DECISION**\n\n<!-- genesis-memory-history:end -->\n`,
    'utf8',
  );
  assert.equal(run(root).status, 0);
});

test('accepted ADR may state a durable decision but not current temporal state', () => {
  const passingRoot = fixture();
  const passingPath = target(
    passingRoot,
    'docs/decisions/ADR-012-development-operating-system-v2.md',
  );
  writeFileSync(
    passingPath,
    `${readFileSync(passingPath, 'utf8')}\n\nA arquitetura aprovada usa validação fail-closed.\n`,
    'utf8',
  );
  assert.equal(run(passingRoot).status, 0);

  const failingRoot = fixture();
  const failingPath = target(
    failingRoot,
    'docs/decisions/ADR-012-development-operating-system-v2.md',
  );
  writeFileSync(
    failingPath,
    `${readFileSync(failingPath, 'utf8')}\n\n## Estado atual\n\nPróxima tarefa: 0.8-MVP-99.\n`,
    'utf8',
  );
  expectCode(run(failingRoot), 'MEMORY_TEMPORAL_ASSERTION_FORBIDDEN');
});

test('rejects a whole-document history marker outside the explicit allowlist', () => {
  const root = fixture();
  const path = target(root, 'README.md');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}\n<!-- genesis-memory-history:v1 -->\n`,
    'utf8',
  );
  expectCode(run(root), 'MEMORY_HISTORY_MARKER_INVALID');
});

test('binds canonical decision evidence to the corrected ADR bytes', () => {
  const root = fixture();
  const path = target(
    root,
    'docs/decisions/ADR-013-mvp-production-baseline.md',
  );
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nchanged\n`, 'utf8');
  expectCode(run(root), 'MEMORY_EVIDENCE_HASH_MISMATCH');
});

test('keeps repo evidence bound to current regular-file bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'genesis-current-evidence-'));
  FIXTURES.push(root);
  writeFileSync(target(root, 'current.txt'), 'current bytes\n', 'utf8');
  const state = evidence(
    `${REPOSITORY_EVIDENCE_PREFIX}current.txt`,
    createHash('sha256').update('current bytes\n').digest('hex'),
  );
  assert.doesNotThrow(() => validateRepositoryEvidence(root, state));
  writeFileSync(target(root, 'current.txt'), 'mutated bytes\n', 'utf8');
  expectEvidenceCode(root, state, 'MEMORY_EVIDENCE_HASH_MISMATCH');
});

test('validates immutable historical bytes after the worktree evolves', () => {
  const { root, revision, hash } = historicalFixture();
  const state = evidence(
    `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}/evidence.txt`,
    hash,
  );
  writeFileSync(
    target(root, 'evidence.txt'),
    'current bytes changed\n',
    'utf8',
  );
  assert.doesNotThrow(() => validateRepositoryEvidence(root, state));
  expectEvidenceCode(
    root,
    evidence(state.evidence[0].uri, '0'.repeat(64)),
    'MEMORY_EVIDENCE_HASH_MISMATCH',
  );
});

test('fails closed for missing historical revisions, paths, and non-commit objects', () => {
  const { root, revision, hash } = historicalFixture();
  expectEvidenceCode(
    root,
    evidence(
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${'f'.repeat(40)}/evidence.txt`,
      hash,
    ),
    'MEMORY_EVIDENCE_REVISION_INVALID',
  );
  expectEvidenceCode(
    root,
    evidence(
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}/missing.txt`,
      hash,
    ),
    'MEMORY_EVIDENCE_OBJECT_INVALID',
  );
  const blob = git(root, ['rev-parse', `${revision}:evidence.txt`]);
  expectEvidenceCode(
    root,
    evidence(
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${blob}/evidence.txt`,
      hash,
    ),
    'MEMORY_EVIDENCE_REVISION_INVALID',
  );
});

test('rejects unsafe or unsupported historical repository references', () => {
  const { root, revision, hash } = historicalFixture();
  const invalid = [
    [
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}ABC/evidence.txt`,
      'MEMORY_EVIDENCE_REVISION_INVALID',
    ],
    [
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}/../evidence.txt`,
      'MEMORY_EVIDENCE_PATH_INVALID',
    ],
    [
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}//absolute.txt`,
      'MEMORY_EVIDENCE_PATH_INVALID',
    ],
    [
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}/dir\\file.txt`,
      'MEMORY_EVIDENCE_PATH_INVALID',
    ],
    [
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}/bad%2Fpath.txt`,
      'MEMORY_EVIDENCE_PATH_INVALID',
    ],
    [
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}/evidence;touch-pwned`,
      'MEMORY_EVIDENCE_PATH_INVALID',
    ],
    [
      `https://github.com/other/repository/blob/${revision}/evidence.txt`,
      'MEMORY_EVIDENCE_REPOSITORY_UNSUPPORTED',
    ],
  ];
  for (const [uri, code] of invalid)
    expectEvidenceCode(root, evidence(uri, hash), code);
  assert.equal(existsSync(target(root, 'touch-pwned')), false);
});

test('rejects a historical symlink entry', () => {
  const { root, hash } = historicalFixture();
  const blob = git(root, ['hash-object', '-w', 'evidence.txt']);
  git(root, [
    'update-index',
    '--add',
    '--cacheinfo',
    '120000',
    blob,
    'evidence-link',
  ]);
  git(root, ['commit', '-m', 'Record symlink entry']);
  const revision = git(root, ['rev-parse', 'HEAD']);
  expectEvidenceCode(
    root,
    evidence(
      `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}${revision}/evidence-link`,
      hash,
    ),
    'MEMORY_EVIDENCE_OBJECT_INVALID',
  );
});

test('preserves the exact MVP08 historical binding while current Compose evolves', () => {
  const canonical = readJson(ROOT).evidence.find(
    (entry) => entry.id === 'EV-MVP08-R1-RELEASE-BINDING',
  );
  assert.deepEqual(canonical, {
    id: 'EV-MVP08-R1-RELEASE-BINDING',
    kind: 'repository-file',
    uri: `${HISTORICAL_REPOSITORY_EVIDENCE_PREFIX}ca82e44aaec44bc9080c2aa627dc4dc1f0e35949/compose.production.yml`,
    sha256: '09ee24584afecef641cb075c6e0488f86bdb0e771abf5ad168357715f3b0e4f4',
    capturedAt: '2026-08-14T07:58:01.159Z',
  });
  const root = fixture();
  writeFileSync(
    target(root, 'compose.production.yml'),
    'legitimate future Compose bytes\n',
    'utf8',
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.code, 'MEMORY_VALID');
});

test('memory validation CI checkout includes immutable evidence history', () => {
  const workflow = readFileSync(
    target(ROOT, '.github/workflows/ci.yml'),
    'utf8',
  );
  const validateJob = workflow.match(
    /^  validate:\r?\n[\s\S]*?(?=^  build-and-scan:)/mu,
  )?.[0];
  assert.ok(validateJob);
  assert.match(
    validateJob,
    /uses: actions\/checkout@[a-f0-9]{40}[^\r\n]*\r?\n\s+with:\r?\n\s+fetch-depth: 0/u,
  );
});

test('records approved destinations as documented without reopening resolved choices', () => {
  const state = readJson(ROOT);
  const decisions = new Set(
    state.pendingHumanDecisions.map((entry) => entry.id),
  );
  assert.equal(decisions.has('HD-DOMAIN'), false);
  assert.equal(decisions.has('HD-BACKUP'), false);
  assert.match(
    state.pendingHumanDecisions.find((entry) => entry.id === 'HD-MONITORING')
      .question,
    /alertas, destinatários e escalonamento/u,
  );
  const facts = Object.fromEntries(
    state.operationalState.facts.map((entry) => [entry.id, entry]),
  );
  for (const id of [
    'OPS-APPROVED-EDGE',
    'OPS-APPROVED-RUNTIME',
    'OPS-APPROVED-DELIVERY',
    'OPS-APPROVED-RECOVERY',
    'OPS-APPROVED-MONITORING',
    'OPS-RECOVERY-TOOLING',
  ]) {
    assert.equal(facts[id].basis, 'documented');
    assert.equal(Object.hasOwn(facts[id], 'observedAt'), false);
  }
  assert.match(
    facts['OPS-APPROVED-RECOVERY'].statement,
    /RPO de 24 horas.*frequência de 12 horas.*RTO lógico sintético de quatro horas.*30\/90 dias.*duas cópias verificadas.*trash-only/u,
  );
  assert.match(
    facts['OPS-RECOVERY-TOOLING'].statement,
    /genesis_backup somente sob autorização explícita.*OAuth externo.*status In production.*scope drive\.file.*nenhum backup, OAuth, role, timer ou restore live foi executado/u,
  );
  assert.equal(facts['OPS-GHCR-VISIBILITY'].basis, 'observed');
  assert.equal(facts['OPS-GHCR-VISIBILITY'].status, 'present');
  assert.ok(facts['OPS-GHCR-VISIBILITY'].observedAt);
});

test('requires TASK_LOG to remain explicitly historical', () => {
  const root = fixture();
  writeFileSync(target(root, 'docs/TASK_LOG.md'), '# history\n', 'utf8');
  expectCode(run(root), 'MEMORY_HISTORY_MARKER_REQUIRED');
});

test('projection is derived only from the authority object', () => {
  const state = readJson(ROOT);
  const projection = renderProjection(state);
  assert.equal(projection, readFileSync(target(ROOT, PROJECTION_PATH), 'utf8'));
  assert.match(
    projection,
    new RegExp(state.nextTask.id.replaceAll('.', '\\.')),
  );
  assert.match(projection, /containing-commit/u);
  assert.match(projection, /0a56a8aee7c64bda59a1981888418e1ad03950c0/u);
  assert.match(projection, /sha256:b45425d7f6ea63/u);
  assert.match(projection, /sha256:a4dafefab191/u);
  assert.match(projection, new RegExp(WEB_INTEGRATED_SHA, 'u'));
});

test('cross-repo contract resolves the clean integrated Candidate A receipt', () => {
  const web = mkdtempSync(join(tmpdir(), 'genesis-web-pointer-'));
  FIXTURES.push(web);
  const pointerPath = target(web, 'docs/memory/project-state.pointer.v1.json');
  mkdirSync(dirname(pointerPath), { recursive: true });
  writeJson(
    web,
    {
      schemaVersion: '1.0.0',
      instanceKind: 'current',
      project: 'genesis-platform',
      mode: 'pointer-only',
      authority: {
        repository: 'arthurportodev/genesis-platform-api',
        branch: 'main',
        path: AUTHORITY_PATH,
        acceptedSchemaMajor: 1,
        resolutionOrder: [
          'explicit-checkout',
          'sibling-checkout',
          'remote-read-only',
        ],
      },
      receipt: {
        transitionId: WEB_TRANSITION_ID,
        targetStateRevision: TARGET_STATE_REVISION,
        baseSha: WEB_RECEIPT_BASE_SHA,
        revisionSource: 'containing-commit',
        generatedAt: '2026-08-24T14:18:54.2261794Z',
      },
    },
    'docs/memory/project-state.pointer.v1.json',
  );
  const result = validateCrossRepo(readJson(ROOT), web, {
    pointerSchema: POINTER_SCHEMA,
    resolveContainingCommit: () => WEB_SHA,
  });
  assert.equal(result.commit, WEB_SHA);
  assert.equal(result.pointer.mode, 'pointer-only');
});

test('cross-repo contract rejects previous and arbitrary Web containing commits', () => {
  for (const commit of [
    '04515f8b17545947129466faab5d8140d1463f4f',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]) {
    const web = mkdtempSync(join(tmpdir(), 'genesis-web-revision-'));
    FIXTURES.push(web);
    writeJson(
      web,
      candidatePointer(),
      'docs/memory/project-state.pointer.v1.json',
    );
    assert.throws(
      () =>
        validateCrossRepo(readJson(ROOT), web, {
          pointerSchema: POINTER_SCHEMA,
          resolveContainingCommit: () => commit,
        }),
      (error) => error.code === 'MEMORY_WEB_REVISION_MISMATCH',
    );
  }
});

test('cross-repo contract rejects unavailable containing-commit provenance', () => {
  const web = mkdtempSync(join(tmpdir(), 'genesis-web-provenance-'));
  FIXTURES.push(web);
  writeJson(
    web,
    candidatePointer(),
    'docs/memory/project-state.pointer.v1.json',
  );
  assert.throws(
    () =>
      validateCrossRepo(readJson(ROOT), web, {
        pointerSchema: POINTER_SCHEMA,
        resolveContainingCommit: () => null,
      }),
    (error) => error.code === 'MEMORY_POINTER_PROVENANCE_INVALID',
  );
});

test('containing-commit provenance binds both the pointer and its schema', () => {
  const web = gitWebFixture();
  const pointerCommit = git(web, ['rev-parse', 'HEAD']);
  assert.equal(containingCommit(web), pointerCommit);

  const schemaPath =
    'schemas/genesis-harness/project-state.pointer.v1.schema.json';
  const schema = readJson(web, schemaPath);
  schema.additionalProperties = true;
  writeJson(web, schema, schemaPath);
  assert.equal(containingCommit(web), null);

  git(web, ['add', schemaPath]);
  git(web, ['commit', '-m', 'Diverge pointer schema']);
  assert.equal(containingCommit(web), null);
});

test('cross-repo contract rejects incompatible pointer schemas', () => {
  const web = mkdtempSync(join(tmpdir(), 'genesis-web-schema-contract-'));
  FIXTURES.push(web);
  writeJson(
    web,
    candidatePointer(),
    'docs/memory/project-state.pointer.v1.json',
  );
  const schemas = [
    {},
    { ...structuredClone(POINTER_SCHEMA), additionalProperties: true },
    (() => {
      const schema = structuredClone(POINTER_SCHEMA);
      delete schema.properties.receipt.properties.revisionSource;
      return schema;
    })(),
  ];
  for (const pointerSchema of schemas)
    assert.throws(
      () =>
        validateCrossRepo(readJson(ROOT), web, {
          pointerSchema,
          resolveContainingCommit: () => WEB_SHA,
        }),
      (error) => error.code === 'MEMORY_POINTER_SCHEMA_MISMATCH',
    );
});

test('cross-repo contract rejects divergent receipt and authority identity', () => {
  for (const mutate of [
    (pointer) => {
      pointer.receipt.targetStateRevision = 'MVP-10B-LIVE-2026-08-21';
    },
    (pointer) => {
      pointer.receipt.transitionId = 'MVP-10C-CROSS-REPO';
    },
    (pointer) => {
      pointer.receipt.baseSha = WEB_SHA;
    },
    (pointer) => {
      pointer.authority.repository = 'example.invalid/wrong-authority';
    },
  ]) {
    const web = mkdtempSync(join(tmpdir(), 'genesis-web-contract-'));
    FIXTURES.push(web);
    const pointer = candidatePointer();
    mutate(pointer);
    writeJson(web, pointer, 'docs/memory/project-state.pointer.v1.json');
    assert.throws(
      () =>
        validateCrossRepo(readJson(ROOT), web, {
          pointerSchema: POINTER_SCHEMA,
          resolveContainingCommit: () => WEB_SHA,
        }),
      (error) =>
        error.code === 'MEMORY_TRANSITION_PENDING' ||
        error.code === 'MEMORY_POINTER_MISMATCH',
    );
  }
});

test('cross-repo source failure never falls back to the generated projection', () => {
  const result = run(ROOT, [
    '--mode',
    'cross-repo',
    '--web-source',
    join(tmpdir(), 'genesis-missing-web-source'),
  ]);
  expectCode(result, 'AUTHORITY_UNAVAILABLE');
  assert.equal(result.json.staleFallbackUsed, false);
  assert.doesNotMatch(result.stdout, /Web integrado na main/iu);
});

test('cross-repo schema rejects extra temporal or secret-bearing pointer data', () => {
  for (const property of ['phase', 'authorizationToken']) {
    const web = mkdtempSync(join(tmpdir(), 'genesis-web-pointer-invalid-'));
    FIXTURES.push(web);
    const pointer = {
      schemaVersion: '1.0.0',
      instanceKind: 'current',
      project: 'genesis-platform',
      mode: 'pointer-only',
      authority: {
        repository: 'arthurportodev/genesis-platform-api',
        branch: 'main',
        path: AUTHORITY_PATH,
        acceptedSchemaMajor: 1,
        resolutionOrder: ['explicit-checkout'],
      },
      receipt: {
        transitionId: WEB_TRANSITION_ID,
        targetStateRevision: TARGET_STATE_REVISION,
        baseSha: WEB_RECEIPT_BASE_SHA,
        revisionSource: 'containing-commit',
        generatedAt: '2026-08-24T14:18:54.2261794Z',
      },
      [property]: property === 'phase' ? { id: 'forbidden' } : 'forbidden',
    };
    writeJson(web, pointer, 'docs/memory/project-state.pointer.v1.json');
    assert.throws(
      () =>
        validateCrossRepo(readJson(ROOT), web, {
          pointerSchema: POINTER_SCHEMA,
        }),
      (error) =>
        error.code === 'MEMORY_POINTER_MISMATCH' ||
        error.code === 'MEMORY_SECRET_DETECTED',
    );
  }
});

test('dynamic onboarding oracle derives current values without hardcoding task ids', () => {
  const state = readJson(ROOT);
  const response = {
    stateRevision: state.stateRevision,
    phaseId: state.phase.id,
    lastCompletedId: state.phase.lastCompleted.id,
    currentWorkStatus: state.currentWork.status,
    nextTaskId: state.nextTask.id,
    webMemoryRevision: WEB_SHA,
    operationalFacts: Object.fromEntries(
      state.operationalState.facts.map((fact) => [fact.id, fact.basis]),
    ),
    blockerIds: state.blockers
      .filter((entry) => entry.status === 'open')
      .map((entry) => entry.id),
    pendingDecisionIds: state.pendingHumanDecisions.map((entry) => entry.id),
    restrictionIds: state.currentRestrictions.map((entry) => entry.id),
    supersededPlanIds: state.supersededPlans.map((entry) => entry.id),
    supersededUsedAsCurrent: false,
    mutations: 0,
    secretsExposed: 0,
    startedNextTask: false,
    humanQuestions: 0,
    humanInterventions: 0,
    sourceCount: 3,
    durationSeconds: 120,
    indeterminateAnswers: 0,
  };
  const result = validateOnboardingResponse(state, response);
  assert.equal(result.ok, true);
  assert.equal(result.humanInterventionRate, 0);
  response.nextTaskId = 'superseded-task';
  assert.equal(validateOnboardingResponse(state, response).ok, false);
});

test('invalid usage exits 2 with a machine-readable code', () => {
  expectCode(run(ROOT, ['--mode', 'cross-repo']), 'USAGE_ERROR', 2);
});
