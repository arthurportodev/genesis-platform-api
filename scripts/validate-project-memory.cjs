#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { TextDecoder } = require('node:util');

const AUTHORITY_PATH = 'docs/memory/project-state.v1.json';
const SCHEMA_PATH = 'schemas/genesis-harness/project-state.v1.schema.json';
const PROJECTION_PATH = 'docs/CURRENT_STATE.md';
const WEB_POINTER_PATH = 'docs/memory/project-state.pointer.v1.json';
const WEB_POINTER_SCHEMA_PATH =
  'schemas/genesis-harness/project-state.pointer.v1.schema.json';
const WEB_SHA = 'fa4193fc28751d64923be824d293367499d4fba0';
const API_REPOSITORY = 'arthurportodev/genesis-platform-api';
const WEB_REPOSITORY = 'arthurportodev/genesis-platform-web';
const MAX_BYTES = 512 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/u;
const FULL_SHA = /^(?!0{40}$)[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET_KEY =
  /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key)/iu;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u;
const BASIS = new Set(['documented', 'observed', 'unknown']);
const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'instanceKind',
  'stateRevision',
  'project',
  'updatedAt',
  'authority',
  'repositories',
  'phase',
  'currentWork',
  'nextTask',
  'operationalState',
  'evidence',
  'blockers',
  'pendingHumanDecisions',
  'supersededPlans',
  'permanentInvariants',
  'releaseGates',
  'currentRestrictions',
  'pointerMetadata',
];
const STABLE_SOURCES = [
  'AGENTS.md',
  'README.md',
  'docs/START_HERE.md',
  'docs/PROJECT_OVERVIEW.md',
  'docs/ROADMAP.md',
  'docs/PRODUCTION.md',
  'docs/ARCHITECTURE.md',
  'docs/SECURITY.md',
  'docs/DEVELOPMENT_WORKFLOW.md',
  'docs/decisions/README.md',
  'docs/decisions/ADR-012-development-operating-system-v2.md',
  'docs/decisions/ADR-013-mvp-production-baseline.md',
  'docs/decisions/ADR-014-versioned-production-contract.md',
];
const SOURCE_AUTHORITY_MARKER =
  '<!-- genesis-source-authorities:v1 implementation=main-code temporal=docs/memory/project-state.v1.json projection=derived architecture=accepted-adrs history=explicit -->';
const SOURCE_AUTHORITY_PATHS = ['AGENTS.md', 'docs/START_HERE.md'];
const WHOLE_DOCUMENT_HISTORY_MARKER = '<!-- genesis-memory-history:v1 -->';
const WHOLE_DOCUMENT_HISTORY_PATHS = new Set([
  'docs/ROADMAP.md',
  'docs/TASK_LOG.md',
]);
const HISTORY_START = '<!-- genesis-memory-history:start -->';
const HISTORY_END = '<!-- genesis-memory-history:end -->';
const REPOSITORY_EVIDENCE_PREFIX =
  'repo://arthurportodev/genesis-platform-api/';
const TEMPORAL_ASSERTION_RULES = [
  {
    label: 'PENDING HUMAN DECISION expression',
    pattern: /PENDING HUMAN DECISION/iu,
  },
  {
    label: 'current phase assertion',
    pattern:
      /(?:fase (?:atual|vigente)|current phase)\s*(?::|=|é\b|continua\b|permanece\b)/iu,
  },
  {
    label: 'current or next task assertion',
    pattern:
      /(?:próxima tarefa|tarefa (?:atual|vigente)|trabalho vigente|next task|current task|current work)\s*(?::|=|é\b|continua\b|permanece\b)/iu,
  },
  {
    label: 'open blocker list',
    pattern:
      /^#{1,6}\s+.*(?:blockers?\s+(?:abertos?|atuais?|vigentes?)|open blockers?)/imu,
  },
  {
    label: 'pending decision list',
    pattern:
      /^#{1,6}\s+.*decis(?:ão|ões|oes).*(?:pendentes?|abertas?|vigentes?)/imu,
  },
  {
    label: 'pending rollout assertion',
    pattern:
      /(?:rollout|implanta(?:ção|cao)|abertura)\s+(?:ainda\s+)?(?:pendente|não executad[ao]|não concluíd[ao])/iu,
  },
  {
    label: 'current operational state section',
    pattern:
      /^#{1,6}\s+(?:estado atual|estado operacional (?:atual|vigente)|current state)\s*$/imu,
  },
  {
    label: 'current gates or restrictions list',
    pattern:
      /^#{1,6}\s+.*(?:gates?|restri(?:ção|ções|cao|coes)).*(?:atuais?|vigentes?|abertos?|pendentes?)/imu,
  },
];

class MemoryError extends Error {
  constructor(code, message, path, nextAction) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.path = path;
    this.nextAction = nextAction;
  }
}

function fail(code, message, path, nextAction) {
  throw new MemoryError(code, message, path, nextAction);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, path) {
  if (!isObject(value)) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      `${path} must be an object.`,
      path,
      'Restore the documented object shape.',
    );
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      `${path} has missing or unexpected properties.`,
      path,
      `Use exactly: ${wanted.join(', ')}.`,
    );
  }
}

function safeRead(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(
      'MEMORY_UNSAFE_INPUT',
      'Input is unavailable.',
      path,
      'Provide an existing regular file.',
    );
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) {
    fail(
      'MEMORY_UNSAFE_INPUT',
      'Input must be a bounded regular file.',
      path,
      `Use a regular file no larger than ${MAX_BYTES} bytes.`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch {
    fail(
      'MEMORY_PARSE_ERROR',
      'Input is not strict UTF-8.',
      path,
      'Encode the file as strict UTF-8.',
    );
  }
}

function parseJson(path) {
  try {
    return JSON.parse(safeRead(path));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    fail(
      'MEMORY_PARSE_ERROR',
      'Input is not valid JSON.',
      path,
      'Fix JSON syntax.',
    );
  }
}

function validateTimestamp(value, path) {
  if (
    typeof value !== 'string' ||
    !value.endsWith('Z') ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      `${path} must be an RFC 3339 UTC timestamp.`,
      path,
      'Use a real UTC timestamp ending in Z.',
    );
  }
}

function uniqueIds(items, path) {
  if (!Array.isArray(items))
    fail(
      'MEMORY_SCHEMA_INVALID',
      `${path} must be an array.`,
      path,
      'Restore the documented array.',
    );
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (
      !isObject(item) ||
      !IDENTIFIER.test(item.id ?? '') ||
      ids.has(item.id)
    ) {
      fail(
        'MEMORY_SCHEMA_INVALID',
        `${path} contains an invalid or duplicate id.`,
        `${path}[${index}].id`,
        'Use unique canonical identifiers.',
      );
    }
    ids.add(item.id);
  }
  return ids;
}

function scanSecrets(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key))
        fail(
          'MEMORY_SECRET_DETECTED',
          `Secret-bearing key is forbidden: ${key}.`,
          `${path}.${key}`,
          'Remove credentials and secret material.',
        );
      scanSecrets(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) {
    fail(
      'MEMORY_SECRET_DETECTED',
      'Secret-like value is forbidden.',
      path,
      'Remove credentials and secret material.',
    );
  }
}

function validateSchemaContract(schema) {
  exactKeys(
    schema,
    [
      '$schema',
      '$id',
      'title',
      'type',
      'additionalProperties',
      'required',
      'properties',
      '$defs',
    ],
    '$schema',
  );
  if (
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    schema.type !== 'object' ||
    schema.additionalProperties !== false
  ) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      'Schema root contract is invalid.',
      SCHEMA_PATH,
      'Restore draft 2020-12 and a closed object root.',
    );
  }
  if (JSON.stringify(schema.required) !== JSON.stringify(TOP_LEVEL_KEYS)) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      'Schema required properties drifted.',
      '$schema.required',
      'Keep the canonical top-level property order.',
    );
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!Object.hasOwn(schema.properties, key))
      fail(
        'MEMORY_SCHEMA_INVALID',
        `Schema does not define ${key}.`,
        '$schema.properties',
        'Define every required authority property.',
      );
  }
}

function schemaEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveSchemaRef(rootSchema, reference, path, code) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    fail(
      code,
      `Unsupported schema reference: ${reference}.`,
      path,
      'Use only local JSON Pointer references.',
    );
  }
  let current = rootSchema;
  for (const encoded of reference.slice(2).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(current) || !Object.hasOwn(current, segment)) {
      fail(
        code,
        `Schema reference does not resolve: ${reference}.`,
        path,
        'Restore a resolvable local schema reference.',
      );
    }
    current = current[segment];
  }
  return current;
}

function validateJsonSchema(
  value,
  schema,
  { rootSchema = schema, path = '$', code = 'MEMORY_SCHEMA_INVALID' } = {},
) {
  if (!isObject(schema))
    fail(
      code,
      'Schema node must be an object.',
      path,
      'Restore a valid JSON Schema node.',
    );
  if (schema.$ref) {
    validateJsonSchema(
      value,
      resolveSchemaRef(rootSchema, schema.$ref, path, code),
      { rootSchema, path, code },
    );
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const option of schema.oneOf) {
      try {
        validateJsonSchema(value, option, { rootSchema, path, code });
        matches += 1;
      } catch (error) {
        if (!(error instanceof MemoryError) || error.code !== code) throw error;
      }
    }
    if (matches !== 1)
      fail(
        code,
        `${path} must match exactly one schema branch.`,
        path,
        'Restore the documented union variant.',
      );
    return;
  }
  if (Object.hasOwn(schema, 'const') && !schemaEqual(value, schema.const))
    fail(
      code,
      `${path} violates const.`,
      path,
      'Use the canonical constant value.',
    );
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => schemaEqual(value, entry))
  )
    fail(
      code,
      `${path} is not an allowed enum value.`,
      path,
      'Use one of the schema enum values.',
    );
  if (schema.type === 'object') {
    if (!isObject(value))
      fail(
        code,
        `${path} must be an object.`,
        path,
        'Restore the documented object.',
      );
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required))
        fail(
          code,
          `${path}.${required} is required.`,
          `${path}.${required}`,
          'Add the required property.',
        );
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find(
        (key) => !Object.hasOwn(properties, key),
      );
      if (extra)
        fail(
          code,
          `${path}.${extra} is not allowed.`,
          `${path}.${extra}`,
          'Remove the additional property.',
        );
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key))
        validateJsonSchema(value[key], child, {
          rootSchema,
          path: `${path}.${key}`,
          code,
        });
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value))
      fail(
        code,
        `${path} must be an array.`,
        path,
        'Restore the documented array.',
      );
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems)
      fail(
        code,
        `${path} has too few items.`,
        path,
        `Use at least ${schema.minItems} items.`,
      );
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems)
      fail(
        code,
        `${path} has too many items.`,
        path,
        `Use at most ${schema.maxItems} items.`,
      );
    if (schema.uniqueItems === true) {
      const canonical = value.map((entry) => JSON.stringify(entry));
      if (new Set(canonical).size !== canonical.length)
        fail(
          code,
          `${path} must contain unique items.`,
          path,
          'Remove duplicate items.',
        );
    }
    if (schema.items)
      value.forEach((entry, index) =>
        validateJsonSchema(entry, schema.items, {
          rootSchema,
          path: `${path}[${index}]`,
          code,
        }),
      );
  } else if (schema.type === 'string') {
    if (typeof value !== 'string')
      fail(code, `${path} must be a string.`, path, 'Use a string value.');
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength)
      fail(
        code,
        `${path} is too short.`,
        path,
        `Use at least ${schema.minLength} characters.`,
      );
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength)
      fail(
        code,
        `${path} is too long.`,
        path,
        `Use at most ${schema.maxLength} characters.`,
      );
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      fail(
        code,
        `${path} does not match its pattern.`,
        path,
        'Use the documented value format.',
      );
    if (schema.format === 'date-time') validateTimestamp(value, path);
    if (schema.format === 'uri') {
      try {
        const url = new URL(value);
        if (!url.protocol || !url.hostname)
          throw new Error('absolute URI required');
      } catch {
        fail(
          code,
          `${path} must be an absolute URI.`,
          path,
          'Use a valid absolute URI.',
        );
      }
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value))
      fail(code, `${path} must be an integer.`, path, 'Use an integer value.');
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      fail(
        code,
        `${path} must be a finite number.`,
        path,
        'Use a finite number.',
      );
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    fail(code, `${path} must be boolean.`, path, 'Use true or false.');
  }
}

function validateReferenceIds(state) {
  const evidenceIds = uniqueIds(state.evidence, '$.evidence');
  const lists = [
    [
      '$.phase.lastCompleted.evidenceIds',
      state.phase.lastCompleted.evidenceIds,
    ],
    ...state.operationalState.facts.map((entry, index) => [
      `$.operationalState.facts[${index}].evidenceIds`,
      entry.evidenceIds,
    ]),
    ...state.supersededPlans.map((entry, index) => [
      `$.supersededPlans[${index}].sourceEvidenceIds`,
      entry.sourceEvidenceIds,
    ]),
    ...state.permanentInvariants.map((entry, index) => [
      `$.permanentInvariants[${index}].sourceEvidenceIds`,
      entry.sourceEvidenceIds,
    ]),
    ...state.releaseGates.map((entry, index) => [
      `$.releaseGates[${index}].sourceEvidenceIds`,
      entry.sourceEvidenceIds,
    ]),
    ...state.currentRestrictions.map((entry, index) => [
      `$.currentRestrictions[${index}].sourceEvidenceIds`,
      entry.sourceEvidenceIds,
    ]),
  ];
  for (const [path, ids] of lists) {
    if (!Array.isArray(ids) || ids.some((id) => !evidenceIds.has(id))) {
      fail(
        'MEMORY_EVIDENCE_UNRESOLVED',
        'An evidence reference does not resolve.',
        path,
        'Reference an evidence id declared by this authority.',
      );
    }
  }
}

function validateState(state, { allowFixture = false } = {}) {
  exactKeys(state, TOP_LEVEL_KEYS, '$');
  scanSecrets(state);
  if (state.schemaVersion !== '1.0.0')
    fail(
      'MEMORY_SCHEMA_UNSUPPORTED',
      'Only schema 1.0.0 is supported.',
      '$.schemaVersion',
      'Use schemaVersion 1.0.0.',
    );
  if (state.instanceKind === 'historical-fixture' && !allowFixture)
    fail(
      'MEMORY_HISTORICAL_FIXTURE',
      'Historical fixtures cannot be current authority.',
      '$.instanceKind',
      'Use the current authority instance.',
    );
  if (state.instanceKind !== 'current' && !allowFixture)
    fail(
      'MEMORY_SCHEMA_INVALID',
      'Authority instanceKind must be current.',
      '$.instanceKind',
      'Use instanceKind current.',
    );
  if (
    !IDENTIFIER.test(state.stateRevision ?? '') ||
    state.project?.id !== 'genesis-platform' ||
    state.project?.name !== 'Genesis Platform'
  ) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      'Project identity or state revision is invalid.',
      '$',
      'Restore the canonical Genesis project identity.',
    );
  }
  validateTimestamp(state.updatedAt, '$.updatedAt');
  if (
    JSON.stringify(state.authority) !==
    JSON.stringify({
      repository: API_REPOSITORY,
      branch: 'main',
      path: AUTHORITY_PATH,
      revisionSource: 'containing-commit',
    })
  ) {
    fail(
      'MEMORY_AUTHORITY_NOT_UNIQUE',
      'The API main authority contract is invalid.',
      '$.authority',
      'Use the single API containing-commit authority.',
    );
  }
  if (!Array.isArray(state.repositories) || state.repositories.length !== 2)
    fail(
      'MEMORY_SCHEMA_INVALID',
      'Exactly two repository records are required.',
      '$.repositories',
      'Declare API authority and Web satellite exactly once.',
    );
  const api = state.repositories.find((entry) => entry.id === 'api');
  const web = state.repositories.find((entry) => entry.id === 'web');
  if (
    !api ||
    !web ||
    api.repository !== API_REPOSITORY ||
    api.role !== 'authority' ||
    api.memoryRevision?.kind !== 'containing-commit' ||
    Object.hasOwn(api.memoryRevision ?? {}, 'sha')
  ) {
    fail(
      'MEMORY_AUTHORITY_NOT_UNIQUE',
      'API repository authority metadata is invalid.',
      '$.repositories',
      'Use one API authority with containing-commit provenance and no future SHA.',
    );
  }
  if (web.role !== 'satellite') {
    fail(
      'MEMORY_AUTHORITY_NOT_UNIQUE',
      'Web must remain a pointer-only satellite.',
      '$.repositories[web].role',
      'Keep exactly one authority in the API repository.',
    );
  }
  if (
    web.repository !== WEB_REPOSITORY ||
    web.memoryRevision?.kind !== 'commit' ||
    web.memoryRevision?.sha !== WEB_SHA ||
    !FULL_SHA.test(web.memoryRevision.sha)
  ) {
    fail(
      'MEMORY_WEB_REVISION_MISMATCH',
      'Web memoryRevision is not the integrated pointer commit.',
      '$.repositories[web].memoryRevision',
      `Use ${WEB_SHA}.`,
    );
  }
  if (
    state.currentWork?.status === 'none' &&
    Object.hasOwn(state.currentWork, 'task')
  )
    fail(
      'MEMORY_SCHEMA_INVALID',
      'currentWork none cannot include a task.',
      '$.currentWork',
      'Remove the task or select a non-none status.',
    );
  if (
    state.currentWork?.status !== 'none' &&
    !isObject(state.currentWork?.task)
  )
    fail(
      'MEMORY_SCHEMA_INVALID',
      'Active currentWork requires task identity.',
      '$.currentWork.task',
      'Declare the active task.',
    );
  validateTimestamp(
    state.phase?.lastCompleted?.completedAt,
    '$.phase.lastCompleted.completedAt',
  );
  validateTimestamp(
    state.operationalState?.documentedAt,
    '$.operationalState.documentedAt',
  );
  uniqueIds(state.operationalState?.facts, '$.operationalState.facts');
  for (const [index, fact] of state.operationalState.facts.entries()) {
    if (!BASIS.has(fact.basis))
      fail(
        'MEMORY_OBSERVATION_INCOMPLETE',
        'Operational fact basis is invalid.',
        `$.operationalState.facts[${index}].basis`,
        'Use documented, observed, or unknown.',
      );
    validateTimestamp(
      fact.documentedAt,
      `$.operationalState.facts[${index}].documentedAt`,
    );
    if (fact.basis === 'observed' && !fact.observedAt)
      fail(
        'MEMORY_OBSERVATION_INCOMPLETE',
        'Observed facts require observedAt.',
        `$.operationalState.facts[${index}]`,
        'Record direct observation time or use documented/unknown.',
      );
    if (fact.basis !== 'observed' && Object.hasOwn(fact, 'observedAt'))
      fail(
        'MEMORY_OBSERVATION_INCOMPLETE',
        'Only observed facts may include observedAt.',
        `$.operationalState.facts[${index}].observedAt`,
        'Remove observedAt or set basis observed with direct evidence.',
      );
  }
  for (const [path, list, prefix] of [
    ['$.permanentInvariants', state.permanentInvariants, 'PI-'],
    ['$.releaseGates', state.releaseGates, 'RG-'],
    ['$.currentRestrictions', state.currentRestrictions, 'OR-'],
  ]) {
    const ids = uniqueIds(list, path);
    if (ids.size === 0 || [...ids].some((id) => !id.startsWith(prefix)))
      fail(
        'MEMORY_CONTROL_CLASSIFICATION_INVALID',
        `${path} is empty or misclassified.`,
        path,
        `Use non-empty ${prefix} controls only in this category.`,
      );
  }
  uniqueIds(state.blockers, '$.blockers');
  uniqueIds(state.pendingHumanDecisions, '$.pendingHumanDecisions');
  uniqueIds(state.supersededPlans, '$.supersededPlans');
  if (
    !state.supersededPlans.some(
      (plan) =>
        plan.id === 'PLAN-0.8.2-0.8.11' && plan.replacedBy === '0.8-MVP',
    )
  ) {
    fail(
      'MEMORY_SUPERSESSION_INCOMPLETE',
      'The previous production sequence is not explicitly superseded.',
      '$.supersededPlans',
      'Record PLAN-0.8.2-0.8.11 as replaced by 0.8-MVP.',
    );
  }
  if (
    state.pointerMetadata?.repository !== WEB_REPOSITORY ||
    state.pointerMetadata?.path !== WEB_POINTER_PATH ||
    state.pointerMetadata?.mode !== 'pointer-only' ||
    state.pointerMetadata?.targetStateRevision !== state.stateRevision
  ) {
    fail(
      'MEMORY_POINTER_MISMATCH',
      'Pointer metadata does not match this authority.',
      '$.pointerMetadata',
      'Restore the Web pointer-only receipt metadata.',
    );
  }
  validateReferenceIds(state);
  return state;
}

function renderList(items, line) {
  return items.length === 0 ? '- Nenhum.' : items.map(line).join('\n');
}

function renderProjection(state) {
  const facts = renderList(
    state.operationalState.facts,
    (fact) =>
      `- **${fact.id}** [${fact.basis}/${fact.status}] — ${fact.statement}`,
  );
  const blockers = renderList(
    state.blockers.filter((entry) => entry.status === 'open'),
    (entry) => `- **${entry.id}** — ${entry.summary}`,
  );
  const decisions = renderList(
    state.pendingHumanDecisions,
    (entry) => `- **${entry.id}** — ${entry.question}`,
  );
  const restrictions = renderList(
    state.currentRestrictions,
    (entry) => `- **${entry.id}** — ${entry.statement}`,
  );
  const gates = renderList(
    state.releaseGates,
    (entry) => `- **${entry.id}** [${entry.status}] — ${entry.statement}`,
  );
  return `<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->\n\n# Estado atual\n\nEsta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).\n\n- **Revisão de estado:** ${state.stateRevision}\n- **Atualização documentada:** ${state.updatedAt}\n- **Fase:** ${state.phase.id} — ${state.phase.title}\n- **Último trabalho concluído:** ${state.phase.lastCompleted.id} — ${state.phase.lastCompleted.title}\n- **Trabalho vigente:** ${state.currentWork.status} — ${state.currentWork.summary}\n- **Próxima tarefa:** ${state.nextTask.id} — ${state.nextTask.title}\n- **Web integrado:** ${WEB_SHA}\n- **Proveniência da API:** containing-commit\n\n## Estado operacional\n\n${state.operationalState.summary}\n\n${facts}\n\n## Blockers abertos\n\n${blockers}\n\n## Decisões humanas pendentes\n\n${decisions}\n\n## Release gates\n\n${gates}\n\n## Restrições atuais\n\n${restrictions}\n`;
}

function stripHistoricalRegions(text, path) {
  if (text.includes(WHOLE_DOCUMENT_HISTORY_MARKER)) {
    if (!WHOLE_DOCUMENT_HISTORY_PATHS.has(path))
      fail(
        'MEMORY_HISTORY_MARKER_INVALID',
        `${path} cannot disable temporal lint for the whole document.`,
        path,
        `Use bounded ${HISTORY_START} and ${HISTORY_END} regions instead.`,
      );
    return '';
  }

  const marker = /<!-- genesis-memory-history:(start|end) -->/gu;
  let historical = false;
  let cursor = 0;
  let visible = '';
  for (const match of text.matchAll(marker)) {
    if (match[1] === 'start') {
      if (historical)
        fail(
          'MEMORY_HISTORY_MARKER_INVALID',
          `${path} has nested historical regions.`,
          path,
          'Use non-overlapping, explicitly bounded historical regions.',
        );
      const following = text.slice(match.index + match[0].length);
      if (!/^\s*#{2,6}\s+.*(?:snapshot|históric)/iu.test(following))
        fail(
          'MEMORY_HISTORY_MARKER_INVALID',
          `${path} opens a historical region without an explicit historical heading.`,
          path,
          'Place the start marker immediately before a Snapshot histórico heading.',
        );
      visible += text.slice(cursor, match.index);
      historical = true;
    } else {
      if (!historical)
        fail(
          'MEMORY_HISTORY_MARKER_INVALID',
          `${path} closes a historical region that was not opened.`,
          path,
          `Add ${HISTORY_START} before this marker.`,
        );
      historical = false;
    }
    cursor = match.index + match[0].length;
  }
  if (historical)
    fail(
      'MEMORY_HISTORY_MARKER_INVALID',
      `${path} has an unclosed historical region.`,
      path,
      `Close it with ${HISTORY_END}.`,
    );
  visible += text.slice(cursor);
  return visible;
}

function delegatesTemporalAuthority(block) {
  return (
    block.includes(AUTHORITY_PATH) &&
    /(?:autoridade|resolve|pertence|exclusiv|não define|não substitu)/iu.test(
      block,
    )
  );
}

function lintTemporalAssertions(text, path) {
  const visible = stripHistoricalRegions(text, path);
  for (const block of visible.split(/\r?\n\s*\r?\n/gu)) {
    if (delegatesTemporalAuthority(block)) continue;
    for (const rule of TEMPORAL_ASSERTION_RULES) {
      if (rule.pattern.test(block))
        fail(
          'MEMORY_TEMPORAL_ASSERTION_FORBIDDEN',
          `${path} contains a forbidden ${rule.label}.`,
          path,
          `Move temporal state to ${AUTHORITY_PATH} or bound an actual snapshot with ${HISTORY_START} and ${HISTORY_END}.`,
        );
    }
  }
}

function validateRepositoryEvidence(root, state) {
  for (const evidence of state.evidence) {
    if (!evidence.uri.startsWith(REPOSITORY_EVIDENCE_PREFIX)) continue;
    const relative = evidence.uri.slice(REPOSITORY_EVIDENCE_PREFIX.length);
    if (
      relative.length === 0 ||
      relative.includes('\\') ||
      relative.startsWith('/') ||
      relative.split('/').includes('..')
    )
      fail(
        'MEMORY_EVIDENCE_PATH_INVALID',
        `${evidence.id} has an unsafe repository evidence path.`,
        `$.evidence.${evidence.id}.uri`,
        'Use a normalized repository-relative path.',
      );
    if (!evidence.sha256)
      fail(
        'MEMORY_EVIDENCE_HASH_REQUIRED',
        `${evidence.id} must include sha256.`,
        `$.evidence.${evidence.id}.sha256`,
        'Record the SHA-256 of the referenced repository file.',
      );
    const content = safeRead(join(root, ...relative.split('/')));
    const actual = createHash('sha256').update(content, 'utf8').digest('hex');
    if (actual !== evidence.sha256)
      fail(
        'MEMORY_EVIDENCE_HASH_MISMATCH',
        `${evidence.id} does not match ${relative}.`,
        `$.evidence.${evidence.id}.sha256`,
        'Regenerate the evidence hash from the final referenced document.',
      );
  }
}

function validateStableSources(root) {
  for (const path of STABLE_SOURCES) {
    const text = safeRead(join(root, ...path.split('/')));
    if (
      !text.includes('genesis-memory-authority:v1') ||
      !text.includes(AUTHORITY_PATH)
    ) {
      fail(
        'MEMORY_STABLE_SOURCE_HAS_STATE',
        `${path} does not delegate temporal authority.`,
        path,
        `Add the genesis-memory-authority:v1 marker and resolve current facts from ${AUTHORITY_PATH}.`,
      );
    }
    if (
      SOURCE_AUTHORITY_PATHS.includes(path) &&
      !text.includes(SOURCE_AUTHORITY_MARKER)
    )
      fail(
        'MEMORY_SOURCE_AUTHORITY_INVALID',
        `${path} does not declare authorities by domain.`,
        path,
        'Restore the canonical source-authorities marker and domain contract.',
      );
    lintTemporalAssertions(text, path);
  }
  const taskLog = safeRead(join(root, 'docs', 'TASK_LOG.md'));
  if (!taskLog.includes(WHOLE_DOCUMENT_HISTORY_MARKER))
    fail(
      'MEMORY_HISTORY_MARKER_REQUIRED',
      'TASK_LOG must be explicitly historical.',
      'docs/TASK_LOG.md',
      'Add the whole-document history marker.',
    );
}

function validateLocal(root = process.cwd(), { checkProjection = true } = {}) {
  const schema = parseJson(join(root, ...SCHEMA_PATH.split('/')));
  validateSchemaContract(schema);
  const instance = parseJson(join(root, ...AUTHORITY_PATH.split('/')));
  if (instance.schemaVersion !== '1.0.0') {
    fail(
      'MEMORY_SCHEMA_UNSUPPORTED',
      'Only schema 1.0.0 is supported.',
      '$.schemaVersion',
      'Use schemaVersion 1.0.0.',
    );
  }
  validateJsonSchema(instance, schema);
  const state = validateState(instance);
  validateRepositoryEvidence(root, state);
  validateStableSources(root);
  const expected = renderProjection(state);
  if (
    checkProjection &&
    safeRead(join(root, ...PROJECTION_PATH.split('/'))) !== expected
  ) {
    fail(
      'MEMORY_PROJECTION_STALE',
      'CURRENT_STATE.md differs from the deterministic projection.',
      PROJECTION_PATH,
      'Run --mode render and review the generated projection.',
    );
  }
  return { state, expected };
}

function loadWebPointer(source) {
  const absolute = resolve(source);
  let root = absolute;
  try {
    if (!statSync(absolute).isDirectory())
      root = resolve(absolute, '..', '..', '..');
  } catch {
    fail(
      'AUTHORITY_UNAVAILABLE',
      'Web source is unavailable.',
      '--web-source',
      'Provide the integrated Web checkout or pointer file.',
    );
  }
  const pointerPath = statSync(absolute).isDirectory()
    ? join(absolute, ...WEB_POINTER_PATH.split('/'))
    : absolute;
  return { pointer: parseJson(pointerPath), root };
}

function validateCrossRepo(
  state,
  source,
  { resolveCommit, pointerSchema } = {},
) {
  const { pointer, root } = loadWebPointer(source);
  const schema =
    pointerSchema ??
    parseJson(join(root, ...WEB_POINTER_SCHEMA_PATH.split('/')));
  scanSecrets(pointer, '$web');
  validateJsonSchema(pointer, schema, {
    rootSchema: schema,
    path: '$web',
    code: 'MEMORY_POINTER_MISMATCH',
  });
  if (
    pointer.schemaVersion !== '1.0.0' ||
    pointer.instanceKind !== 'current' ||
    pointer.mode !== 'pointer-only' ||
    pointer.authority?.repository !== API_REPOSITORY ||
    pointer.authority?.path !== AUTHORITY_PATH ||
    pointer.authority?.acceptedSchemaMajor !== 1
  ) {
    fail(
      'MEMORY_POINTER_MISMATCH',
      'Web pointer identity or authority is incompatible.',
      '--web-source',
      'Use the integrated v1 pointer-only Web checkout.',
    );
  }
  if (
    pointer.receipt?.targetStateRevision !== state.stateRevision ||
    pointer.receipt?.transitionId !== state.pointerMetadata.transitionId
  ) {
    fail(
      'MEMORY_TRANSITION_PENDING',
      'Web receipt target does not match the API state revision.',
      '$web.receipt',
      'Complete the approved cross-repository transition contract.',
    );
  }
  let commit;
  try {
    commit = resolveCommit
      ? resolveCommit(root)
      : execFileSync(
          'git',
          [
            '-c',
            `safe.directory=${root.replaceAll('\\', '/')}`,
            'log',
            '-1',
            '--format=%H',
            'origin/main',
            '--',
            WEB_POINTER_PATH,
          ],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
  } catch {
    fail(
      'AUTHORITY_UNAVAILABLE',
      'The Web pointer containing commit could not be resolved.',
      '--web-source',
      'Fetch and provide the integrated Web origin/main checkout.',
    );
  }
  if (
    commit !== WEB_SHA ||
    state.repositories.find((entry) => entry.id === 'web')?.memoryRevision
      ?.sha !== commit
  ) {
    fail(
      'MEMORY_WEB_REVISION_MISMATCH',
      'Web pointer containing commit differs from the API authority.',
      '--web-source',
      `Use the exact integrated commit ${WEB_SHA}.`,
    );
  }
  return { commit, pointer };
}

function validateOnboardingResponse(state, response) {
  const expectedFacts = Object.fromEntries(
    state.operationalState.facts.map((fact) => [fact.id, fact.basis]),
  );
  const expected = {
    stateRevision: state.stateRevision,
    phaseId: state.phase.id,
    lastCompletedId: state.phase.lastCompleted.id,
    currentWorkStatus: state.currentWork.status,
    nextTaskId: state.nextTask.id,
    webMemoryRevision: WEB_SHA,
    operationalFacts: expectedFacts,
    blockerIds: state.blockers
      .filter((entry) => entry.status === 'open')
      .map((entry) => entry.id)
      .sort(),
    pendingDecisionIds: state.pendingHumanDecisions
      .map((entry) => entry.id)
      .sort(),
    restrictionIds: state.currentRestrictions.map((entry) => entry.id).sort(),
    supersededPlanIds: state.supersededPlans.map((entry) => entry.id).sort(),
  };
  const normalized = {
    ...response,
    blockerIds: [...(response.blockerIds ?? [])].sort(),
    pendingDecisionIds: [...(response.pendingDecisionIds ?? [])].sort(),
    restrictionIds: [...(response.restrictionIds ?? [])].sort(),
    supersededPlanIds: [...(response.supersededPlanIds ?? [])].sort(),
  };
  const fields = Object.keys(expected);
  const mismatches = fields.filter(
    (field) =>
      JSON.stringify(normalized[field]) !== JSON.stringify(expected[field]),
  );
  const hardFailure =
    mismatches.length > 0 ||
    response.supersededUsedAsCurrent === true ||
    response.mutations !== 0 ||
    response.secretsExposed !== 0 ||
    response.startedNextTask === true ||
    response.humanQuestions > 0;
  const verifiedOutcomes = hardFailure ? 0 : 1;
  const interventions = Number(response.humanInterventions ?? 0);
  return {
    ok: !hardFailure,
    code: hardFailure ? 'ONBOARDING_ORACLE_FAILED' : 'ONBOARDING_ORACLE_PASSED',
    mismatches,
    raw: {
      sourceCount: Number(response.sourceCount ?? 0),
      durationSeconds: Number(response.durationSeconds ?? 0),
      humanQuestions: Number(response.humanQuestions ?? 0),
      humanInterventions: interventions,
      correctAnswers: fields.length - mismatches.length,
      incorrectAnswers: mismatches.length,
      indeterminateAnswers: Number(response.indeterminateAnswers ?? 0),
      verifiedOutcomes,
    },
    humanInterventionRate:
      verifiedOutcomes === 0 ? null : interventions / verifiedOutcomes,
  };
}

function parseArguments(argv) {
  const args = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--check') {
      args.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !name?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    )
      fail(
        'USAGE_ERROR',
        'Arguments must be named options.',
        'argv',
        'Use --mode local|render|cross-repo|onboarding-oracle.',
      );
    args[
      name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    ] = value;
    index += 1;
  }
  if (
    !['local', 'render', 'cross-repo', 'onboarding-oracle'].includes(args.mode)
  )
    fail(
      'USAGE_ERROR',
      'Unsupported mode.',
      'argv',
      'Use --mode local|render|cross-repo|onboarding-oracle.',
    );
  return args;
}

function output(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.mode === 'render') {
      const { expected } = validateLocal(process.cwd(), {
        checkProjection: false,
      });
      if (args.check) {
        if (safeRead(PROJECTION_PATH) !== expected)
          fail(
            'MEMORY_PROJECTION_STALE',
            'Projection is stale.',
            PROJECTION_PATH,
            'Run --mode render without --check.',
          );
      } else {
        writeFileSync(PROJECTION_PATH, expected, 'utf8');
      }
      output({
        ok: true,
        code: args.check
          ? 'MEMORY_PROJECTION_CURRENT'
          : 'MEMORY_PROJECTION_RENDERED',
        path: PROJECTION_PATH,
      });
      return;
    }
    const { state } = validateLocal();
    if (args.mode === 'cross-repo') {
      if (!args.webSource)
        fail(
          'USAGE_ERROR',
          '--web-source is required.',
          'argv',
          'Provide the integrated Web checkout.',
        );
      const cross = validateCrossRepo(state, args.webSource);
      output({
        ok: true,
        code: 'MEMORY_CROSS_REPO_VALID',
        stateRevision: state.stateRevision,
        webMemoryRevision: cross.commit,
        pointerOnly: true,
      });
      return;
    }
    if (args.mode === 'onboarding-oracle') {
      if (!args.response)
        fail(
          'USAGE_ERROR',
          '--response is required.',
          'argv',
          'Provide the structured onboarding response JSON.',
        );
      const result = validateOnboardingResponse(
        state,
        parseJson(resolve(args.response)),
      );
      output(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    output({
      ok: true,
      code: 'MEMORY_VALID',
      stateRevision: state.stateRevision,
      schemaValidated: true,
      semanticRulesValidated: true,
      projectionCurrent: true,
      stableSourcesValidated: true,
    });
  } catch (error) {
    const failure =
      error instanceof MemoryError
        ? error
        : new MemoryError(
            'MEMORY_VALIDATION_FAILED',
            error.message,
            'runtime',
            'Inspect the validator inputs.',
          );
    output({
      ok: false,
      code: failure.code,
      codes: [failure.code],
      path: failure.path,
      nextAction: failure.nextAction,
    });
    process.stderr.write(`${failure.message}\n`);
    process.exitCode = failure.code === 'USAGE_ERROR' ? 2 : 1;
  }
}

if (require.main === module) main();

module.exports = {
  AUTHORITY_PATH,
  PROJECTION_PATH,
  SCHEMA_PATH,
  WEB_SHA,
  MemoryError,
  parseArguments,
  renderProjection,
  lintTemporalAssertions,
  validateCrossRepo,
  validateLocal,
  validateOnboardingResponse,
  validateRepositoryEvidence,
  validateSchemaContract,
  validateStableSources,
  validateJsonSchema,
  validateState,
};
