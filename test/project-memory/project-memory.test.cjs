const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const {
  MemoryError,
  renderProjection,
  validateLocal,
  validateSchemaContract,
  validateState,
} = require('../../scripts/validate-project-memory.cjs');

const CURRENT_AUTHORITY = 'docs/memory/project-state.v2.json';
const V1_AUTHORITY = 'docs/memory/project-state.v1.json';
const SCHEMA = 'schemas/genesis-harness/project-state.v2.schema.json';

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function fictionalState(overrides = {}) {
  return {
    schemaVersion: '2.0.0',
    stateRevision: 'PRODUCT-STATE-42',
    phase: {
      id: 'PRODUCT-V3',
      title: 'Fictional product phase',
    },
    lastCompleted: {
      id: 'PRODUCT-V3-04',
      title: 'Fictional completed work',
      outcome: 'Released successfully',
    },
    currentWork: {
      status: 'none',
    },
    nextTask: {
      status: 'undecided',
      planningState: 'PENDING-PRODUCT-PRIORITIZATION',
    },
    live: {
      api: {
        sourceSha: 'a'.repeat(40),
        image: `ghcr.io/example/project-api@sha256:${'b'.repeat(64)}`,
      },
      web: {
        sourceSha: 'c'.repeat(40),
        deploymentId: `dpl_${'D'.repeat(24)}`,
        domain: 'https://example.invalid',
      },
    },
    openBlockers: [],
    activeRestrictions: [],
    followUps: [],
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof MemoryError);
    assert.equal(error.code, code);
    return true;
  });
}

test('accepts a minimal valid current state', () => {
  assert.equal(validateState(fictionalState()).schemaVersion, '2.0.0');
});

test('rejects an unknown property', () => {
  const state = fictionalState();
  state.evidence = [];
  expectCode(() => validateState(state), 'MEMORY_SCHEMA_INVALID');
});

test('rejects a missing required property', () => {
  const state = fictionalState();
  delete state.phase;
  expectCode(() => validateState(state), 'MEMORY_SCHEMA_INVALID');
});

test('rejects malformed state revisions', () => {
  const state = fictionalState({ stateRevision: 'bad revision' });
  expectCode(() => validateState(state), 'MEMORY_SCHEMA_INVALID');
});

test('rejects malformed API and Web source SHAs', () => {
  for (const target of ['api', 'web']) {
    const state = fictionalState();
    state.live[target].sourceSha = 'abc';
    expectCode(() => validateState(state), 'MEMORY_SCHEMA_INVALID');
  }
});

test('rejects malformed image digests', () => {
  const state = fictionalState();
  state.live.api.image = 'ghcr.io/example/project-api:latest';
  expectCode(() => validateState(state), 'MEMORY_SCHEMA_INVALID');
});

test('rejects malformed Web deployment ids', () => {
  const state = fictionalState();
  state.live.web.deploymentId = 'deployment-current';
  expectCode(() => validateState(state), 'MEMORY_SCHEMA_INVALID');
});

test('rejects secret-bearing keys and values', () => {
  const key = fictionalState();
  key.apiToken = 'redacted';
  expectCode(() => validateState(key), 'MEMORY_SECRET_FORBIDDEN');

  const value = fictionalState();
  value.followUps.push({
    id: 'FOLLOW-UP-ONE',
    summary: 'Bearer credential-material',
  });
  expectCode(() => validateState(value), 'MEMORY_SECRET_FORBIDDEN');
});

test('accepts the exact currentWork none shape', () => {
  const state = fictionalState({ currentWork: { status: 'none' } });
  assert.equal(validateState(state).currentWork.status, 'none');
});

test('accepts a valid active currentWork shape', () => {
  const state = fictionalState({
    currentWork: {
      status: 'active',
      id: 'PRODUCT-V3-05',
      title: 'Active fictional work',
    },
  });
  assert.equal(validateState(state).currentWork.status, 'active');
});

test('rejects contradictory and mixed currentWork shapes', () => {
  const completed = fictionalState();
  completed.currentWork = {
    status: 'active',
    id: completed.lastCompleted.id,
    title: 'Still active',
  };
  expectCode(() => validateState(completed), 'MEMORY_STATE_CONTRADICTION');

  const mixed = fictionalState();
  mixed.currentWork = {
    status: 'none',
    id: 'PRODUCT-V3-05',
    title: 'Should not exist',
  };
  expectCode(() => validateState(mixed), 'MEMORY_SCHEMA_INVALID');
});

test('accepts a decided next task', () => {
  const state = fictionalState({
    nextTask: {
      status: 'decided',
      id: 'PRODUCT-V3-05',
      title: 'Next fictional work',
    },
  });
  assert.equal(validateState(state).nextTask.status, 'decided');
});

test('accepts an undecided next task', () => {
  const state = fictionalState();
  assert.equal(validateState(state).nextTask.status, 'undecided');
});

test('rejects duplicate blocker, restriction, and follow-up ids', () => {
  const state = fictionalState({
    openBlockers: [{ id: 'CURRENT-ITEM', summary: 'A blocker.' }],
    activeRestrictions: [{ id: 'CURRENT-ITEM', summary: 'A restriction.' }],
  });
  expectCode(() => validateState(state), 'MEMORY_DUPLICATE_ID');
});

test('accepts complete API and Web live bindings', () => {
  assert.deepEqual(Object.keys(validateState(fictionalState()).live), [
    'api',
    'web',
  ]);
});

test('rejects a missing live binding', () => {
  const state = fictionalState();
  delete state.live.api.image;
  expectCode(() => validateState(state), 'MEMORY_SCHEMA_INVALID');
});

test('accepts alternate fictional task and state identifiers', () => {
  const first = fictionalState();
  const second = fictionalState({
    stateRevision: 'ANOTHER-STATE-900',
    phase: { id: 'ANOTHER-PHASE', title: 'Another phase' },
    lastCompleted: {
      id: 'ANOTHER-TASK-08',
      title: 'Another completed task',
      outcome: 'Accepted',
    },
  });
  assert.doesNotThrow(() => validateState(first));
  assert.doesNotThrow(() => validateState(second));
});

test('accepts alternate valid SHAs, image digests, and deployment ids', () => {
  const state = fictionalState();
  state.live.api.sourceSha = 'd'.repeat(40);
  state.live.api.image = `ghcr.io/another/project@sha256:${'e'.repeat(64)}`;
  state.live.web.sourceSha = 'f'.repeat(40);
  state.live.web.deploymentId = `dpl_${'9'.repeat(32)}`;
  assert.doesNotThrow(() => validateState(state));
});

test('validator source contains no current task or release instance constants', () => {
  const source = readFileSync('scripts/validate-project-memory.cjs', 'utf8');
  assert.doesNotMatch(
    source,
    /PIPE-V2-03A|a169369f|e0d3613f|90dc36a3|DhUzyz|transitionId|memoryRevision/u,
  );
});

test('rejects an unsupported schema major', () => {
  const state = fictionalState({ schemaVersion: '3.0.0' });
  expectCode(() => validateState(state), 'MEMORY_SCHEMA_UNSUPPORTED');
});

test('schema contract is strict and closes every object', () => {
  const schema = json(SCHEMA);
  assert.equal(validateSchemaContract(schema).additionalProperties, false);
  const invalid = clone(schema);
  invalid.temporary = true;
  expectCode(() => validateSchemaContract(invalid), 'MEMORY_SCHEMA_INVALID');
});

test('projection rendering is deterministic, concise, and history-free', () => {
  const rendered = renderProjection(fictionalState());
  assert.equal(rendered, renderProjection(fictionalState()));
  assert.match(rendered, /deterministic projection/u);
  assert.doesNotMatch(
    rendered,
    /evidence catalog|release-tree|deployment history|resolved blocker/iu,
  );
  assert.ok(Buffer.byteLength(rendered) < 3000);
});

test('projection drift is detected and regenerated content passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'genesis-memory-v2-'));
  const authorityPath = 'docs/memory/project-state.v2.json';
  const schemaPath = 'schemas/project-state.v2.schema.json';
  const projectionPath = 'docs/CURRENT_STATE.md';
  for (const path of [authorityPath, schemaPath, projectionPath]) {
    mkdirSync(dirname(join(root, ...path.split('/'))), { recursive: true });
  }
  const state = fictionalState();
  writeFileSync(join(root, ...authorityPath.split('/')), JSON.stringify(state));
  writeFileSync(join(root, ...schemaPath.split('/')), readFileSync(SCHEMA));
  writeFileSync(join(root, ...projectionPath.split('/')), 'hand-edited\n');
  expectCode(
    () => validateLocal(root, { authorityPath, schemaPath, projectionPath }),
    'MEMORY_PROJECTION_DRIFT',
  );
  writeFileSync(
    join(root, ...projectionPath.split('/')),
    renderProjection(state),
  );
  assert.equal(
    validateLocal(root, { authorityPath, schemaPath, projectionPath }).status,
    'READY',
  );
});

test('current authority and projection validate locally', () => {
  const result = validateLocal();
  assert.equal(result.status, 'READY');
  assert.equal(result.schemaVersion, '2.0.0');
});

test('one-time migration preserves useful current v1 semantics', () => {
  const v1 = json(V1_AUTHORITY);
  const v2 = json(CURRENT_AUTHORITY);
  assert.equal(v2.stateRevision, v1.stateRevision);
  assert.deepEqual(v2.phase, {
    id: v1.phase.id,
    title: v1.phase.title,
  });
  assert.deepEqual(v2.lastCompleted, {
    id: v1.phase.lastCompleted.id,
    title: v1.phase.lastCompleted.title,
    outcome: 'PRODUCTION_KEEP / 03A_LIVE',
  });
  assert.equal(v2.currentWork.status, v1.currentWork.status);
  assert.equal(v2.nextTask.status, 'undecided');
  assert.equal(v2.nextTask.planningState, v1.nextTask.id);
  assert.equal(
    v2.live.api.sourceSha,
    v1.releaseBindings.apiApplicationRevision,
  );
  assert.equal(v2.live.api.image, v1.releaseBindings.authorizedApiImage);
  assert.equal(v2.live.web.sourceSha, v1.releaseBindings.webIntegratedRevision);

  const webFact = v1.operationalState.facts.find(
    (fact) => fact.id === 'OPS-PIPE-V2-WEB-PRODUCTION',
  );
  assert.match(webFact.statement, new RegExp(v2.live.web.deploymentId, 'u'));
  assert.match(webFact.statement, /app\.agenciagenesismkt\.com\.br/u);
  assert.equal(
    v2.openBlockers.length,
    v1.blockers.filter((blocker) => blocker.status !== 'resolved').length,
  );
  for (const id of [
    'OR-SINGLE-VPS',
    'OR-SINGLE-REPLICA',
    'OR-VERCEL-HOBBY-TECHNICAL-MVP',
  ]) {
    assert.ok(v1.currentRestrictions.some((item) => item.id === id));
    assert.ok(v2.activeRestrictions.some((item) => item.id === id));
  }
  assert.deepEqual(Object.keys(v2), [
    'schemaVersion',
    'stateRevision',
    'phase',
    'lastCompleted',
    'currentWork',
    'nextTask',
    'live',
    'openBlockers',
    'activeRestrictions',
    'followUps',
  ]);
  assert.doesNotMatch(
    JSON.stringify(v2),
    /evidenceIds|releaseTree|rollback|pendingHumanDecisions|supersededPlans/iu,
  );
});
