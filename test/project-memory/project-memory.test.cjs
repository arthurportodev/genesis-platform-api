'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  cpSync,
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
  WEB_SHA,
  renderProjection,
  validateCrossRepo,
  validateOnboardingResponse,
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
const POINTER_SCHEMA = {
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
          type: 'array',
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: {
            enum: ['explicit-checkout', 'sibling-checkout', 'remote-read-only'],
          },
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
        transitionId: { type: 'string' },
        targetStateRevision: { type: 'string' },
        baseSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        revisionSource: { const: 'containing-commit' },
        generatedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};

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
  for (const path of [AUTHORITY_PATH, SCHEMA_PATH, PROJECTION_PATH, ...STABLE])
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

function expectCode(result, code, status = 1) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, code);
  assert.ok(result.stderr.length > 0);
}

test.after(() => {
  for (const root of FIXTURES) rmSync(root, { recursive: true, force: true });
});

test('accepts the complete API authority and generated projection', () => {
  const result = run(ROOT);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, {
    ok: true,
    code: 'MEMORY_VALID',
    stateRevision: 'GH-01-COMPLETE',
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

test('requires the exact integrated Web memoryRevision', () => {
  const root = fixture();
  const state = readJson(root);
  state.repositories.find((entry) => entry.id === 'web').memoryRevision.sha =
    'a'.repeat(40);
  writeJson(root, state);
  expectCode(run(root), 'MEMORY_WEB_REVISION_MISMATCH');
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

test('records approved destinations as documented without reopening resolved choices', () => {
  const state = readJson(ROOT);
  const decisions = new Set(
    state.pendingHumanDecisions.map((entry) => entry.id),
  );
  assert.equal(decisions.has('HD-DOMAIN'), false);
  assert.match(
    state.pendingHumanDecisions.find((entry) => entry.id === 'HD-BACKUP')
      .question,
    /RPO, RTO e retenção/u,
  );
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
  ]) {
    assert.equal(facts[id].basis, 'documented');
    assert.equal(Object.hasOwn(facts[id], 'observedAt'), false);
  }
  assert.equal(facts['OPS-GHCR-VISIBILITY'].basis, 'unknown');
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
});

test('cross-repo contract accepts the integrated pointer containing commit', () => {
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
        transitionId: 'GH-01-CROSS-REPO',
        targetStateRevision: 'GH-01-COMPLETE',
        baseSha: '1c2ba2af9306f13b9995b48619f4aafb682385cf',
        revisionSource: 'containing-commit',
        generatedAt: '2026-08-10T12:28:06.317Z',
      },
    },
    'docs/memory/project-state.pointer.v1.json',
  );
  const result = validateCrossRepo(readJson(ROOT), web, {
    resolveCommit: () => WEB_SHA,
    pointerSchema: POINTER_SCHEMA,
  });
  assert.equal(result.commit, WEB_SHA);
  assert.equal(result.pointer.mode, 'pointer-only');
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
        transitionId: 'GH-01-CROSS-REPO',
        targetStateRevision: 'GH-01-COMPLETE',
        baseSha: '1c2ba2af9306f13b9995b48619f4aafb682385cf',
        revisionSource: 'containing-commit',
        generatedAt: '2026-08-10T12:28:06.317Z',
      },
      [property]: property === 'phase' ? { id: 'forbidden' } : 'forbidden',
    };
    writeJson(web, pointer, 'docs/memory/project-state.pointer.v1.json');
    assert.throws(
      () =>
        validateCrossRepo(readJson(ROOT), web, {
          resolveCommit: () => WEB_SHA,
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
