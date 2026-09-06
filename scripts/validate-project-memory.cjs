#!/usr/bin/env node
'use strict';

const {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { TextDecoder } = require('node:util');

const AUTHORITY_PATH = 'docs/memory/project-state.v2.json';
const SCHEMA_PATH = 'schemas/genesis-harness/project-state.v2.schema.json';
const PROJECTION_PATH = 'docs/CURRENT_STATE.md';
const MAX_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/u;
const FULL_SHA = /^(?!0{40}$)[a-f0-9]{40}$/u;
const IMAGE = /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{20,80}$/u;
const SECRET_KEY =
  /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|credential)/iu;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|https?:\/\/[^/\s]+@)/u;
const TOP_LEVEL_KEYS = [
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

function readJson(path) {
  try {
    return JSON.parse(safeRead(path));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    fail('MEMORY_PARSE_ERROR', 'Input is not valid JSON.', path, 'Fix JSON.');
  }
}

function text(value, path, maxLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      `${path} must be a trimmed non-empty string up to ${maxLength} characters.`,
      path,
      'Provide concise durable text.',
    );
  }
}

function identifier(value, path) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      `${path} must be a canonical identifier.`,
      path,
      'Use 2-80 letters, digits, dot, underscore, or hyphen.',
    );
  }
}

function scanSecrets(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) {
    if (typeof value === 'string' && SECRET_VALUE.test(value)) {
      fail(
        'MEMORY_SECRET_FORBIDDEN',
        'Secret-like value is forbidden in canonical memory.',
        path,
        'Remove credential material.',
      );
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      fail(
        'MEMORY_SECRET_FORBIDDEN',
        `Secret-bearing key is forbidden: ${key}.`,
        `${path}.${key}`,
        'Remove credential fields.',
      );
    }
    scanSecrets(entry, `${path}.${key}`);
  }
}

function validateNamed(value, path) {
  exactKeys(value, ['id', 'title'], path);
  identifier(value.id, `${path}.id`);
  text(value.title, `${path}.title`, 160);
}

function validateCurrentWork(value) {
  if (!isObject(value)) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      '$.currentWork must be an object.',
      '$.currentWork',
      'Use the none or active shape.',
    );
  }
  if (value.status === 'none') {
    exactKeys(value, ['status'], '$.currentWork');
    return;
  }
  if (value.status === 'active') {
    exactKeys(value, ['status', 'id', 'title'], '$.currentWork');
    identifier(value.id, '$.currentWork.id');
    text(value.title, '$.currentWork.title', 160);
    return;
  }
  fail(
    'MEMORY_SCHEMA_INVALID',
    '$.currentWork.status must be none or active.',
    '$.currentWork.status',
    'Use a supported state.',
  );
}

function validateNextTask(value) {
  if (!isObject(value)) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      '$.nextTask must be an object.',
      '$.nextTask',
      'Use the undecided or decided shape.',
    );
  }
  if (value.status === 'undecided') {
    exactKeys(value, ['status', 'planningState'], '$.nextTask');
    identifier(value.planningState, '$.nextTask.planningState');
    return;
  }
  if (value.status === 'decided') {
    exactKeys(value, ['status', 'id', 'title'], '$.nextTask');
    identifier(value.id, '$.nextTask.id');
    text(value.title, '$.nextTask.title', 160);
    return;
  }
  fail(
    'MEMORY_SCHEMA_INVALID',
    '$.nextTask.status must be undecided or decided.',
    '$.nextTask.status',
    'Use a supported state.',
  );
}

function validateLive(value) {
  exactKeys(value, ['api', 'web'], '$.live');
  exactKeys(value.api, ['sourceSha', 'image'], '$.live.api');
  if (!FULL_SHA.test(value.api.sourceSha ?? '')) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      '$.live.api.sourceSha must be a full non-zero SHA.',
      '$.live.api.sourceSha',
      'Use the functional source SHA.',
    );
  }
  if (!IMAGE.test(value.api.image ?? '')) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      '$.live.api.image must be an immutable GHCR digest reference.',
      '$.live.api.image',
      'Use ghcr.io/...@sha256:<64 lowercase hex>.',
    );
  }

  exactKeys(value.web, ['sourceSha', 'deploymentId', 'domain'], '$.live.web');
  if (!FULL_SHA.test(value.web.sourceSha ?? '')) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      '$.live.web.sourceSha must be a full non-zero SHA.',
      '$.live.web.sourceSha',
      'Use the functional source SHA.',
    );
  }
  if (!DEPLOYMENT_ID.test(value.web.deploymentId ?? '')) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      '$.live.web.deploymentId must be a Vercel deployment id.',
      '$.live.web.deploymentId',
      'Use dpl_ followed by 20-80 letters or digits.',
    );
  }
  let domain;
  try {
    domain = new URL(value.web.domain);
  } catch {
    domain = null;
  }
  if (
    !domain ||
    domain.protocol !== 'https:' ||
    domain.username ||
    domain.password ||
    domain.pathname !== '/' ||
    domain.search ||
    domain.hash
  ) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      '$.live.web.domain must be a credential-free HTTPS origin.',
      '$.live.web.domain',
      'Use an HTTPS origin without path, query, fragment, or credentials.',
    );
  }
}

function validateNotes(items, path, allIds) {
  if (!Array.isArray(items) || items.length > 20) {
    fail(
      'MEMORY_SCHEMA_INVALID',
      `${path} must be an array with at most 20 items.`,
      path,
      'Keep only current concise items.',
    );
  }
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    exactKeys(item, ['id', 'summary'], itemPath);
    identifier(item.id, `${itemPath}.id`);
    text(item.summary, `${itemPath}.summary`, 500);
    if (allIds.has(item.id)) {
      fail(
        'MEMORY_DUPLICATE_ID',
        `Duplicate current-state id: ${item.id}.`,
        `${itemPath}.id`,
        'Use unique ids across blockers, restrictions, and follow-ups.',
      );
    }
    allIds.add(item.id);
  }
}

function validateState(state) {
  scanSecrets(state);
  exactKeys(state, TOP_LEVEL_KEYS, '$');
  if (state.schemaVersion !== '2.0.0') {
    fail(
      'MEMORY_SCHEMA_UNSUPPORTED',
      '$.schemaVersion must be 2.0.0.',
      '$.schemaVersion',
      'Use Canonical Memory v2.',
    );
  }
  identifier(state.stateRevision, '$.stateRevision');
  validateNamed(state.phase, '$.phase');

  exactKeys(state.lastCompleted, ['id', 'title', 'outcome'], '$.lastCompleted');
  identifier(state.lastCompleted.id, '$.lastCompleted.id');
  text(state.lastCompleted.title, '$.lastCompleted.title', 160);
  text(state.lastCompleted.outcome, '$.lastCompleted.outcome', 500);

  validateCurrentWork(state.currentWork);
  validateNextTask(state.nextTask);
  if (
    state.currentWork.status === 'active' &&
    state.currentWork.id === state.lastCompleted.id
  ) {
    fail(
      'MEMORY_STATE_CONTRADICTION',
      'Current work cannot equal the last completed work.',
      '$.currentWork.id',
      'Correct the active or completed task.',
    );
  }
  if (
    state.nextTask.status === 'decided' &&
    (state.nextTask.id === state.lastCompleted.id ||
      (state.currentWork.status === 'active' &&
        state.nextTask.id === state.currentWork.id))
  ) {
    fail(
      'MEMORY_STATE_CONTRADICTION',
      'The decided next task must differ from current and completed work.',
      '$.nextTask.id',
      'Correct the task lifecycle.',
    );
  }

  validateLive(state.live);
  const ids = new Set();
  validateNotes(state.openBlockers, '$.openBlockers', ids);
  validateNotes(state.activeRestrictions, '$.activeRestrictions', ids);
  validateNotes(state.followUps, '$.followUps', ids);
  return state;
}

function validateClosedSchemas(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateClosedSchemas(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isObject(value)) return;
  if (value.type === 'object' && value.additionalProperties !== false) {
    fail(
      'MEMORY_SCHEMA_CONTRACT_INVALID',
      `${path} must set additionalProperties=false.`,
      path,
      'Keep every object schema closed.',
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    validateClosedSchemas(entry, `${path}.${key}`);
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
    schema.$id !==
      'https://schemas.agenciagenesis.invalid/genesis-harness/project-state.v2.schema.json' ||
    schema.type !== 'object' ||
    schema.additionalProperties !== false ||
    schema.properties?.schemaVersion?.const !== '2.0.0'
  ) {
    fail(
      'MEMORY_SCHEMA_CONTRACT_INVALID',
      'The v2 schema identity or root contract is invalid.',
      '$schema',
      'Restore the canonical v2 schema identity.',
    );
  }
  const required = [...(schema.required ?? [])].sort();
  const expected = [...TOP_LEVEL_KEYS].sort();
  if (
    JSON.stringify(required) !== JSON.stringify(expected) ||
    JSON.stringify(Object.keys(schema.properties ?? {}).sort()) !==
      JSON.stringify(expected)
  ) {
    fail(
      'MEMORY_SCHEMA_CONTRACT_INVALID',
      'The v2 schema root fields do not match the authority contract.',
      '$schema.required',
      'Keep the schema and validator root fields aligned.',
    );
  }
  validateClosedSchemas(schema);
  return schema;
}

function renderItems(items) {
  if (items.length === 0) return '- None.';
  return items.map((item) => `- **${item.id}:** ${item.summary}`).join('\n');
}

function renderProjection(state) {
  const current =
    state.currentWork.status === 'none'
      ? 'none'
      : `${state.currentWork.id} — ${state.currentWork.title}`;
  const next =
    state.nextTask.status === 'undecided'
      ? `undecided — ${state.nextTask.planningState}`
      : `${state.nextTask.id} — ${state.nextTask.title}`;
  return `<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v2.json -->

# Current project state

This is a deterministic projection. Edit [project-state.v2.json](memory/project-state.v2.json), then regenerate this file.

- **State revision:** ${state.stateRevision}
- **Phase:** ${state.phase.id} — ${state.phase.title}
- **Last completed product work:** ${state.lastCompleted.id} — ${state.lastCompleted.title}
- **Outcome:** ${state.lastCompleted.outcome}
- **Current work:** ${current}
- **Next task:** ${next}

## Live bindings

- **API source:** ${state.live.api.sourceSha}
- **API image:** ${state.live.api.image}
- **Web source:** ${state.live.web.sourceSha}
- **Web deployment:** ${state.live.web.deploymentId}
- **Web domain:** ${state.live.web.domain}

## Open blockers

${renderItems(state.openBlockers)}

## Active restrictions

${renderItems(state.activeRestrictions)}

## Follow-ups

${renderItems(state.followUps)}
`;
}

function validateLocal(
  root = process.cwd(),
  {
    authorityPath = AUTHORITY_PATH,
    schemaPath = SCHEMA_PATH,
    projectionPath = PROJECTION_PATH,
    checkProjection = true,
  } = {},
) {
  const authority = resolve(root, ...authorityPath.split('/'));
  const schema = resolve(root, ...schemaPath.split('/'));
  const projection = resolve(root, ...projectionPath.split('/'));
  validateSchemaContract(readJson(schema));
  const state = validateState(readJson(authority));
  const rendered = renderProjection(state);
  if (checkProjection) {
    if (!existsSync(projection) || safeRead(projection) !== rendered) {
      fail(
        'MEMORY_PROJECTION_DRIFT',
        'docs/CURRENT_STATE.md is not the deterministic v2 projection.',
        projectionPath,
        'Run node scripts/validate-project-memory.cjs --write-projection.',
      );
    }
  }
  return {
    status: 'READY',
    authorityPath,
    schemaPath,
    projectionPath,
    schemaVersion: state.schemaVersion,
    stateRevision: state.stateRevision,
    authorityBytes: Buffer.byteLength(JSON.stringify(state)),
  };
}

function parseArguments(argv) {
  const options = {
    mode: 'local',
    writeProjection: false,
    json: false,
    authorityPath: AUTHORITY_PATH,
    schemaPath: SCHEMA_PATH,
    projectionPath: PROJECTION_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write-projection') options.writeProjection = true;
    else if (argument === '--json') options.json = true;
    else if (argument.startsWith('--')) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        fail(
          'MEMORY_USAGE_INVALID',
          `Missing value for ${argument}.`,
          argument,
          'Provide the documented CLI value.',
        );
      }
      if (argument === '--mode') options.mode = value;
      else if (argument === '--authority') options.authorityPath = value;
      else if (argument === '--schema') options.schemaPath = value;
      else if (argument === '--projection') options.projectionPath = value;
      else {
        fail(
          'MEMORY_USAGE_INVALID',
          `Unknown argument: ${argument}.`,
          argument,
          'Use --mode local, --write-projection, --json, or path overrides.',
        );
      }
      index += 1;
    } else {
      fail(
        'MEMORY_USAGE_INVALID',
        `Unexpected argument: ${argument}.`,
        argument,
        'Use named options.',
      );
    }
  }
  if (options.mode !== 'local') {
    fail(
      'MEMORY_USAGE_INVALID',
      `Unsupported mode: ${options.mode}.`,
      '--mode',
      'Use local.',
    );
  }
  return options;
}

function main() {
  const startedAt = Date.now();
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = validateLocal(process.cwd(), {
      authorityPath: options.authorityPath,
      schemaPath: options.schemaPath,
      projectionPath: options.projectionPath,
      checkProjection: !options.writeProjection,
    });
    if (options.writeProjection) {
      const state = validateState(
        readJson(join(process.cwd(), ...options.authorityPath.split('/'))),
      );
      writeFileSync(
        join(process.cwd(), ...options.projectionPath.split('/')),
        renderProjection(state),
        'utf8',
      );
    }
    const output = {
      command: 'validate-project-memory',
      durationMs: Date.now() - startedAt,
      ...result,
    };
    console.log(options.json ? JSON.stringify(output) : 'READY');
  } catch (error) {
    const result =
      error instanceof MemoryError
        ? {
            status: 'NOT_READY',
            code: error.code,
            message: error.message,
            path: error.path,
            nextAction: error.nextAction,
          }
        : {
            status: 'NOT_READY',
            code: 'MEMORY_VALIDATION_FAILED',
            message: error.message,
          };
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  AUTHORITY_PATH,
  MemoryError,
  PROJECTION_PATH,
  SCHEMA_PATH,
  parseArguments,
  readJson,
  renderProjection,
  scanSecrets,
  validateLocal,
  validateSchemaContract,
  validateState,
};
