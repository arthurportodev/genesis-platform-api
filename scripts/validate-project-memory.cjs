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
const WEB_SHA = '33e99bfcfb87375a801ac49343c28a9fe76e2bb2';
const API_REPOSITORY = 'arthurportodev/genesis-platform-api';
const WEB_REPOSITORY = 'arthurportodev/genesis-platform-web';
const API_APPLICATION_REVISION = '9402d067897ab727fb369d7e696a11ba3b9cf68f';
const AUTHORIZED_API_IMAGE =
  'ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a';
const AUTHORIZED_API_IMAGE_CONFIG_DIGEST =
  'sha256:ba67e2ab1bb92d3486e9f37c602fd4c374330d54b2697b5b1bca79d925a96bd9';
const ROLLBACK_API_IMAGE =
  'ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659';
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
  'releaseBindings',
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
      /(?:fase (?:atual|vigente)|current phase)\s*(?::|=|Ã©\b|continua\b|permanece\b)/iu,
  },
  {
    label: 'current or next task assertion',
    pattern:
      /(?:prÃ³xima tarefa|tarefa (?:atual|vigente)|trabalho vigente|next task|current task|current work)\s*(?::|=|Ã©\b|continua\b|permanece\b)/iu,
  },
  {
    label: 'open blocker list',
    pattern:
      /^#{1,6}\s+.*(?:blockers?\s+(?:abertos?|atuais?|vigentes?)|open blockers?)/imu,
  },
  {
    label: 'pending decision list',
    pattern:
      /^#{1,6}\s+.*decis(?:Ã£o|Ãµes|oes).*(?:pendentes?|abertas?|vigentes?)/imu,
  },
  {
    label: 'pending rollout assertion',
    pattern:
      /(?:rollout|implanta(?:Ã§Ã£o|cao)|abertura)\s+(?:ainda\s+)?(?:pendente|nÃ£o executad[ao]|nÃ£o concluÃ­d[ao])/iu,
  },
  {
    label: 'current operational state section',
    pattern:
      /^#{1,6}\s+(?:estado atual|estado operacional (?:atual|vigente)|current state)\s*$/imu,
  },
  {
    label: 'current gates or restrictions list',
    pattern:
      /^#{1,6}\s+.*(?:gates?|restri(?:Ã§Ã£o|Ã§Ãµes|cao|coes)).*(?:atuais?|vigentes?|abertos?|pendentes?)/imu,
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
          'Use a valid absolute Uãmù¶‰žËkºwµçEQ!L¹¡…Ì¡Á…Ñ ¤¤(€€€€€™…¥° (€€€€€€€€55=Ie}!%MQ=Ie}5I-I}%9Y1%œ°(€€€€€€€€‘íÁ…Ñ¡ô…¹¹½Ð‘¥Í…‰±”Ñ•µÁ½É…°±¥¹Ð™½ÈÑ¡”Ý¡½±”‘½Õµ•¹Ð¹€°(€€€€€€€Á…Ñ °(€€€€€€€UÍ”‰½Õ¹‘•€‘í!%MQ=Ie}MQIQô…¹€‘í!%MQ=Ie}9ôÉ•¥½¹Ì¥¹ÍÑ•…¹€°(€€€€€€¤ì(€€€É•ÑÕÉ¸€œœì(€ô((€½¹ÍÐµ…É­•È€ô€¼ð„´´•¹•Í¥Ìµµ•µ½Éäµ¡¥ÍÑ½Éäè¡ÍÑ…ÉÑñ•¹¤€´´ø½Ôì(€±•Ð¡¥ÍÑ½É¥…°€ô™…±Í”ì(€±•ÐÕÉÍ½È€ô€Àì(€±•ÐÙ¥Í¥‰±”€ô€œœì(€™½È€¡½¹ÍÐµ…Ñ ½˜Ñ•áÐ¹µ…Ñ¡±°¡µ…É­•È¤¤ì(€€€¥˜€¡µ…Ñ¡lÅt€ôôô€ÍÑ…ÉÐœ¤ì(€€€€€¥˜€¡¡¥ÍÑ½É¥…°¤(€€€€€€€™…¥° (€€€€€€€€€€55=Ie}!%MQ=Ie}5I-I}%9Y1%œ°(€€€€€€€€€€‘íÁ…Ñ¡ô¡…Ì¹•ÍÑ•¡¥ÍÑ½É¥…°É•¥½¹Ì¹€°(€€€€€€€€€Á…Ñ °(€€€€€€€€€€UÍ”¹½¸µ½Ù•É±…ÁÁ¥¹œ°•áÁ±¥¥Ñ±ä‰½Õ¹‘•¡¥ÍÑ½É¥…°É•¥½¹Ì¸œ°(€€€€€€€€¤ì(€€€€€½¹ÍÐ™½±±½Ý¥¹œ€ôÑ•áÐ¹Í±¥”¡µ…Ñ ¹¥¹‘•à€¬µ…Ñ¡lÁt¹±•¹Ñ ¤ì(€€€€€¥˜€ „½yqÌ¨ìÈ°ÙõqÌ¬¸¨ üéÍ¹…ÁÍ¡½Ññ¡¥ÍÓÍÉ¥Œ¤½¥Ô¹Ñ•ÍÐ¡™½±±½Ý¥¹œ¤¤(€€€€€€€™…¥° (€€€€€€€€€€55=Ie}!%MQ=Ie}5I-I}%9Y1%œ°(€€€€€€€€€€‘íÁ…Ñ¡ô½Á•¹Ì„¡¥ÍÑ½É¥…°É•¥½¸Ý¥Ñ¡½ÕÐ…¸•áÁ±¥¥Ð¡¥ÍÑ½É¥…°¡•…‘¥¹œ¹€°(€€€€€€€€€Á…Ñ °(€€€€€€€€€€A±…”Ñ¡”ÍÑ…ÉÐµ…É­•È¥µµ•‘¥…Ñ•±ä‰•™½É”„M¹…ÁÍ¡½Ð¡¥ÍÓÍÉ¥¼¡•…‘¥¹œ¸œ°(€€€€€€€€¤ì(€€€€€Ù¥Í¥‰±”€¬ôÑ•áÐ¹Í±¥”¡ÕÉÍ½È°µ…Ñ ¹¥¹‘•à¤ì(€€€€€¡¥ÍÑ½É¥…°€ôÑÉÕ”ì(€€€ô•±Í”ì(€€€€€¥˜€ …¡¥ÍÑ½É¥…°¤(€€€€€€€™…¥° (€€€€€€€€€€55=Ie}!%MQ=Ie}5I-I}%9Y1%œ°(€€€€€€€€€€‘íÁ…Ñ¡ô±½Í•Ì„¡¥ÍÑ½É¥…°É•¥½¸Ñ¡…ÐÝ…Ì¹½Ð½Á•¹•¹€°(€€€€€€€€€Á…Ñ °(€€€€€€€€€‘€‘í!%MQ=Ie}MQIQô‰•™½É”Ñ¡¥Ìµ…É­•È¹€°(€€€€€€€€¤ì(€€€€€¡¥ÍÑ½É¥…°€ô™…±Í”ì(€€€ô(€€€ÕÉÍ½È€ôµ…Ñ ¹¥¹‘•à€¬µ…Ñ¡lÁt¹±•¹Ñ ì(€ô(€¥˜€¡¡¥ÍÑ½É¥…°¤(€€€™…¥° (€€€€€€55=Ie}!%MQ=Ie}5I-I}%9Y1%œ°(€€€€€€‘íÁ…Ñ¡ô¡…Ì…¸Õ¹±½Í•¡¥ÍÑ½É¥…°É•¥½¸¹€°(€€€€€Á…Ñ °(€€€€€±½Í”¥ÐÝ¥Ñ €‘í!%MQ=Ie}9ô¹€°(€€€€¤ì(€Ù¥Í¥‰±”€¬ôÑ•áÐ¹Í±¥”¡ÕÉÍ½È¤ì(€É•ÑÕÉ¸Ù¥Í¥‰±”ì)ô()™Õ¹Ñ¥½¸‘•±•…Ñ•ÍQ•µÁ½É…±ÕÑ¡½É¥Ñä¡‰±½¬¤ì(€É•ÑÕÉ¸€ (€€€‰±½¬¹¥¹±Õ‘•Ì¡UQ!=I%Qe}AQ ¤€˜˜(€€€€¼ üé…ÕÑ½É¥‘…‘•ñÉ•Í½±Ù•ñÁ•ÉÑ•¹•ñ•á±ÕÍ¥Ùñ»¼‘•™¥¹•ñ»¼ÍÕ‰ÍÑ¥ÑÔ¤½¥Ô¹Ñ•ÍÐ (€€€€€‰±½¬°(€€€€¤(€€¤ì)ô()™Õ¹Ñ¥½¸±¥¹ÑQ•µÁ½É…±ÍÍ•ÉÑ¥½¹Ì¡Ñ•áÐ°Á…Ñ ¤ì(€½¹ÍÐÙ¥Í¥‰±”€ôÍÑÉ¥Á!¥ÍÑ½É¥…±I•¥½¹Ì¡Ñ•áÐ°Á…Ñ ¤ì(€™½È€¡½¹ÍÐ‰±½¬½˜Ù¥Í¥‰±”¹ÍÁ±¥Ð ½qÈýq¹qÌ©qÈýq¸½Ô¤¤ì(€€€¥˜€¡‘•±•…Ñ•ÍQ•µÁ½É…±ÕÑ¡½É¥Ñä¡‰±½¬¤¤½¹Ñ¥¹Õ”ì(€€€™½È€¡½¹ÍÐÉÕ±”½˜Q5A=I1}MMIQ%=9}IU1L¤ì(€€€€€¥˜€¡ÉÕ±”¹Á…ÑÑ•É¸¹Ñ•ÍÐ¡‰±½¬¤¤(€€€€€€€™…¥° (€€€€€€€€€€55=Ie}Q5A=I1}MMIQ%=9}=I	%8œ°(€€€€€€€€€€‘íÁ…Ñ¡ô½¹Ñ…¥¹Ì„™½É‰¥‘‘•¸€‘íÉÕ±”¹±…‰•±ô¹€°(€€€€€€€€€Á…Ñ °(€€€€€€€€€5½Ù”Ñ•µÁ½É…°ÍÑ…Ñ”Ñ¼€‘íUQ!=I%Qe}AQ!ô½È‰½Õ¹…¸…ÑÕ…°Í¹…ÁÍ¡½ÐÝ¥Ñ €‘í!%MQ=Ie}MQIQô…¹€‘í!%MQ=Ie}9ô¹€°(€€€€€€€€¤ì(€€€ô(€ô)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•I•Á½Í¥Ñ½ÉåÙ¥‘•¹”¡É½½Ð°ÍÑ…Ñ”¤ì(€™½È€¡½¹ÍÐ•Ù¥‘•¹”½˜ÍÑ…Ñ”¹•Ù¥‘•¹”¤ì(€€€¥˜€ …•Ù¥‘•¹”¹ÕÉ¤¹ÍÑ…ÉÑÍ]¥Ñ ¡IA=M%Q=Ie}Y%9}AI%`¤¤½¹Ñ¥¹Õ”ì(€€€½¹ÍÐÉ•±…Ñ¥Ù”€ô•Ù¥‘•¹”¹ÕÉ¤¹Í±¥”¡IA=M%Q=Ie}Y%9}AI%`¹±•¹Ñ ¤ì(€€€¥˜€ (€€€€€É•±…Ñ¥Ù”¹±•¹Ñ €ôôô€Àñð(€€€€€É•±…Ñ¥Ù”¹¥¹±Õ‘•Ì qpœ¤ñð(€€€€€É•±…Ñ¥Ù”¹ÍÑ…ÉÑÍ]¥Ñ  œ¼œ¤ñð(€€€€€É•±…Ñ¥Ù”¹ÍÁ±¥Ð œ¼œ¤¹¥¹±Õ‘•Ì œ¸¸œ¤(€€€€¤(€€€€€™…¥° (€€€€€€€€55=Ie}Y%9}AQ!}%9Y1%œ°(€€€€€€€€‘í•Ù¥‘•¹”¹¥‘ô¡…Ì…¸Õ¹Í…™”É•Á½Í¥Ñ½Éä•Ù¥‘•¹”Á…Ñ ¹€°(€€€€€€€€¹•Ù¥‘•¹”¸‘í•Ù¥‘•¹”¹¥‘ô¹ÕÉ¥€°(€€€€€€€€UÍ”„¹½Éµ…±¥é•É•Á½Í¥Ñ½ÉäµÉ•±…Ñ¥Ù”Á…Ñ ¸œ°(€€€€€€¤ì(€€€¥˜€ …•Ù¥‘•¹”¹Í¡„ÈÔØ¤(€€€€€™…¥° (€€€€€€€€55=Ie}Y%9}!M!}IEU%Iœ°(€€€€€€€€‘í•Ù¥‘•¹”¹¥‘ôµÕÍÐ¥¹±Õ‘”Í¡„ÈÔØ¹€°(€€€€€€€€¹•Ù¥‘•¹”¸‘í•Ù¥‘•¹”¹¥‘ô¹Í¡„ÈÔÙ€°(€€€€€€€€I•½ÉÑ¡”M!´ÈÔØ½˜Ñ¡”É•™•É•¹•É•Á½Í¥Ñ½Éä™¥±”¸œ°(€€€€€€¤ì(€€€½¹ÍÐ½¹Ñ•¹Ð€ôÍ…™•I•…¡©½¥¸¡É½½Ð°€¸¸¹É•±…Ñ¥Ù”¹ÍÁ±¥Ð œ¼œ¤¤¤ì(€€€½¹ÍÐ…ÑÕ…°€ôÉ•…Ñ•!…Í  Í¡„ÈÔØœ¤¹ÕÁ‘…Ñ”¡½¹Ñ•¹Ð°€ÕÑ˜àœ¤¹‘¥•ÍÐ ¡•àœ¤ì(€€€¥˜€¡…ÑÕ…°€„ôô•Ù¥‘•¹”¹Í¡„ÈÔØ¤(€€€€€™…¥° (€€€€€€€€55=Ie}Y%9}!M!}5%M5Q œ°(€€€€€€€€‘í•Ù¥‘•¹”¹¥‘ô‘½•Ì¹½Ðµ…Ñ €‘íÉ•±…Ñ¥Ù•ô¹€°(€€€€€€€€¹•Ù¥‘•¹”¸‘í•Ù¥‘•¹”¹¥‘ô¹Í¡„ÈÔÙ€°(€€€€€€€€I••¹•É…Ñ”Ñ¡”•Ù¥‘•¹”¡…Í ™É½´Ñ¡”™¥¹…°É•™•É•¹•‘½Õµ•¹Ð¸œ°(€€€€€€¤ì(€ô)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•MÑ…‰±•M½ÕÉ•Ì¡É½½Ð¤ì(€™½È€¡½¹ÍÐÁ…Ñ ½˜MQ	1}M=UIL¤ì(€€€½¹ÍÐÑ•áÐ€ôÍ…™•I•…¡©½¥¸¡É½½Ð°€¸¸¹Á…Ñ ¹ÍÁ±¥Ð œ¼œ¤¤¤ì(€€€¥˜€ (€€€€€€…Ñ•áÐ¹¥¹±Õ‘•Ì •¹•Í¥Ìµµ•µ½Éäµ…ÕÑ¡½É¥ÑäéØÄœ¤ñð(€€€€€€…Ñ•áÐ¹¥¹±Õ‘•Ì¡UQ!=I%Qe}AQ ¤(€€€€¤ì(€€€€€™…¥° (€€€€€€€€55=Ie}MQ	1}M=UI}!M}MQQœ°(€€€€€€€€‘íÁ…Ñ¡ô‘½•Ì¹½Ð‘•±•…Ñ”Ñ•µÁ½É…°…ÕÑ¡½É¥Ñä¹€°(€€€€€€€Á…Ñ °(€€€€€€€‘Ñ¡”•¹•Í¥Ìµµ•µ½Éäµ…ÕÑ¡½É¥ÑäéØÄµ…É­•È…¹É•Í½±Ù”ÕÉÉ•¹Ð™…ÑÌ™É½´€‘íUQ!=I%Qe}AQ!ô¹€°(€€€€€€¤ì(€€€ô(€€€¥˜€ (€€€€€M=UI}UQ!=I%Qe}AQ!L¹¥¹±Õ‘•Ì¡Á…Ñ ¤€˜˜(€€€€€€…Ñ•áÐ¹¥¹±Õ‘•Ì¡M=UI}UQ!=I%Qe}5I-H¤(€€€€¤(€€€€€™…¥° (€€€€€€€€55=Ie}M=UI}UQ!=I%Qe}%9Y1%œ°(€€€€€€€€‘íÁ…Ñ¡ô‘½•Ì¹½Ð‘•±…É”…ÕÑ¡½É¥Ñ¥•Ì‰ä‘½µ…¥¸¹€°(€€€€€€€Á…Ñ °(€€€€€€€€I•ÍÑ½É”Ñ¡”…¹½¹¥…°Í½ÕÉ”µ…ÕÑ¡½É¥Ñ¥•Ìµ…É­•È…¹‘½µ…¥¸½¹ÑÉ…Ð¸œ°(€€€€€€¤ì(€€€±¥¹ÑQ•µÁ½É…±ÍÍ•ÉÑ¥½¹Ì¡Ñ•áÐ°Á…Ñ ¤ì(€ô(€½¹ÍÐÑ…Í­1½œ€ôÍ…™•I•…¡©½¥¸¡É½½Ð°€‘½Ìœ°€QM-}1=¹µœ¤¤ì(€¥˜€ …Ñ…Í­1½œ¹¥¹±Õ‘•Ì¡]!=1}=U59Q}!%MQ=Ie}5I-H¤¤(€€€™…¥° (€€€€€€55=Ie}!%MQ=Ie}5I-I}IEU%Iœ°(€€€€€€QM-}1=µÕÍÐ‰”•áÁ±¥¥Ñ±ä¡¥ÍÑ½É¥…°¸œ°(€€€€€€‘½Ì½QM-}1=¹µœ°(€€€€€€‘Ñ¡”Ý¡½±”µ‘½Õµ•¹Ð¡¥ÍÑ½Éäµ…É­•È¸œ°(€€€€¤ì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•1½…°¡É½½Ð€ôÁÉ½•ÍÌ¹Ý ¤°ì¡•­AÉ½©•Ñ¥½¸€ôÑÉÕ”ô€ôíô¤ì(€½¹ÍÐÍ¡•µ„€ôÁ…ÉÍ•)Í½¸¡©½¥¸¡É½½Ð°€¸¸¹M!5}AQ ¹ÍÁ±¥Ð œ¼œ¤¤¤ì(€Ù…±¥‘…Ñ•M¡•µ…½¹ÑÉ…Ð¡Í¡•µ„¤ì(€½¹ÍÐ¥¹ÍÑ…¹”€ôÁ…ÉÍ•)Í½¸¡©½¥¸¡É½½Ð°€¸¸¹UQ!=I%Qe}AQ ¹ÍÁ±¥Ð œ¼œ¤¤¤ì(€¥˜€¡¥¹ÍÑ…¹”¹Í¡•µ…Y•ÉÍ¥½¸€„ôô€œÄ¸À¸Àœ¤ì(€€€™…¥° (€€€€€€55=Ie}M!5}U9MUAA=IQœ°(€€€€€€=¹±äÍ¡•µ„€Ä¸À¸À¥ÌÍÕÁÁ½ÉÑ•¸œ°(€€€€€€œ¹Í¡•µ…Y•ÉÍ¥½¸œ°(€€€€€€UÍ”Í¡•µ…Y•ÉÍ¥½¸€Ä¸À¸À¸œ°(€€€€¤ì(€ô(€Ù…±¥‘…Ñ•)Í½¹M¡•µ„¡¥¹ÍÑ…¹”°Í¡•µ„¤ì(€½¹ÍÐÍÑ…Ñ”€ôÙ…±¥‘…Ñ•MÑ…Ñ”¡¥¹ÍÑ…¹”¤ì(€Ù…±¥‘…Ñ•I•Á½Í¥Ñ½ÉåÙ¥‘•¹”¡É½½Ð°ÍÑ…Ñ”¤ì(€Ù…±¥‘…Ñ•MÑ…‰±•M½ÕÉ•Ì¡É½½Ð¤ì(€½¹ÍÐ•áÁ•Ñ•€ôÉ•¹‘•ÉAÉ½©•Ñ¥½¸¡ÍÑ…Ñ”¤ì(€¥˜€ (€€€¡•­AÉ½©•Ñ¥½¸€˜˜(€€€Í…™•I•…¡©½¥¸¡É½½Ð°€¸¸¹AI=)Q%=9}AQ ¹ÍÁ±¥Ð œ¼œ¤¤¤€„ôô•áÁ•Ñ•(€€¤ì(€€€™…¥° (€€€€€€55=Ie}AI=)Q%=9}MQ1œ°(€€€€€€UII9Q}MQQ¹µ‘¥™™•ÉÌ™É½´Ñ¡”‘•Ñ•Éµ¥¹¥ÍÑ¥ŒÁÉ½©•Ñ¥½¸¸œ°(€€€€€AI=)Q%=9}AQ °(€€€€€€IÕ¸€´µµ½‘”É•¹‘•È…¹É•Ù¥•ÜÑ¡”•¹•É…Ñ•ÁÉ½©•Ñ¥½¸¸œ°(€€€€¤ì(€ô(€É•ÑÕÉ¸ìÍÑ…Ñ”°•áÁ•Ñ•ôì)ô()™Õ¹Ñ¥½¸±½…‘]•‰A½¥¹Ñ•È¡Í½ÕÉ”¤ì(€½¹ÍÐ…‰Í½±ÕÑ”€ôÉ•Í½±Ù”¡Í½ÕÉ”¤ì(€±•ÐÉ½½Ð€ô…‰Í½±ÕÑ”ì(€ÑÉäì(€€€¥˜€ …ÍÑ…ÑMå¹Œ¡…‰Í½±ÕÑ”¤¹¥Í¥É•Ñ½Éä ¤¤(€€€€€É½½Ð€ôÉ•Í½±Ù”¡…‰Í½±ÕÑ”°€œ¸¸œ°€œ¸¸œ°€œ¸¸œ¤ì(€ô…Ñ ì(€€€™…¥° (€€€€€€UQ!=I%Qe}U9Y%1	1œ°(€€€€€€]•ˆÍ½ÕÉ”¥ÌÕ¹…Ù…¥±…‰±”¸œ°(€€€€€€œ´µÝ•ˆµÍ½ÕÉ”œ°(€€€€€€AÉ½Ù¥‘”Ñ¡”¥¹Ñ•É…Ñ•]•ˆ¡•­½ÕÐ½ÈÁ½¥¹Ñ•È™¥±”¸œ°(€€€€¤ì(€ô(€½¹ÍÐÁ½¥¹Ñ•ÉA…Ñ €ôÍÑ…ÑMå¹Œ¡…‰Í½±ÕÑ”¤¹¥Í¥É•Ñ½Éä ¤(€€€€ü©½¥¸¡…‰Í½±ÕÑ”°€¸¸¹]	}A=%9QI}AQ ¹ÍÁ±¥Ð œ¼œ¤¤(€€€€è…‰Í½±ÕÑ”ì(€É•ÑÕÉ¸ìÁ½¥¹Ñ•ÈèÁ…ÉÍ•)Í½¸¡Á½¥¹Ñ•ÉA…Ñ ¤°É½½Ðôì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•É½ÍÍI•Á¼ (€ÍÑ…Ñ”°(€Í½ÕÉ”°(€ìÉ•Í½±Ù•½µµ¥Ð°Á½¥¹Ñ•ÉM¡•µ„ô€ôíô°(¤ì(€½¹ÍÐìÁ½¥¹Ñ•È°É½½Ðô€ô±½…‘]•‰A½¥¹Ñ•È¡Í½ÕÉ”¤ì(€½¹ÍÐÍ¡•µ„€ô(€€€Á½¥¹Ñ•ÉM¡•µ„€üü(€€€Á…ÉÍ•)Í½¸¡©½¥¸¡É½½Ð°€¸¸¹]	}A=%9QI}M!5}AQ ¹ÍÁ±¥Ð œ¼œ¤¤¤ì(€Í…¹M•É•ÑÌ¡Á½¥¹Ñ•È°€œ‘Ý•ˆœ¤ì(€Ù…±¥‘…Ñ•)Í½¹M¡•µ„¡Á½¥¹Ñ•È°Í¡•µ„°ì(€€€É½½ÑM¡•µ„èÍ¡•µ„°(€€€Á…Ñ è€œ‘Ý•ˆœ°(€€€½‘”è€55=Ie}A=%9QI}5%M5Q œ°(€ô¤ì(€¥˜€ (€€€Á½¥¹Ñ•È¹Í¡•µ…Y•ÉÍ¥½¸€„ôô€œÄ¸À¸Àœñð(€€€Á½¥¹Ñ•È¹¥¹ÍÑ…¹•-¥¹€„ôô€ÕÉÉ•¹Ðœñð(€€€Á½¥¹Ñ•È¹µ½‘”€„ôô€Á½¥¹Ñ•Èµ½¹±äœñð(€€€Á½¥¹Ñ•È¹…ÕÑ¡½É¥Ñäü¹É•Á½Í¥Ñ½Éä€„ôôA%}IA=M%Q=Idñð(€€€Á½¥¹Ñ•È¹…ÕÑ¡½É¥Ñäü¹Á…Ñ €„ôôUQ!=I%Qe}AQ ñð(€€€Á½¥¹Ñ•È¹…ÕÑ¡½É¥Ñäü¹…•ÁÑ•‘M¡•µ…5…©½È€„ôô€Ä(€€¤ì(€€€™…¥° (€€€€€€55=Ie}A=%9QI}5%M5Q œ°(€€€€€€]•ˆÁ½¥¹Ñ•È¥‘•¹Ñ¥Ñä½È…ÕÑ¡½É¥Ñä¥Ì¥¹½µÁ…Ñ¥‰±”¸œ°(€€€€€€œ´µÝ•ˆµÍ½ÕÉ”œ°(€€€€€€UÍ”Ñ¡”¥¹Ñ•É…Ñ•ØÄÁ½¥¹Ñ•Èµ½¹±ä]•ˆ¡•­½ÕÐ¸œ°(€€€€¤ì(€ô(€¥˜€ (€€€Á½¥¹Ñ•È¹É••¥ÁÐü¹Ñ…É•ÑMÑ…Ñ•I•Ù¥Í¥½¸€„ôôÍÑ…Ñ”¹ÍÑ…Ñ•I•Ù¥Í¥½¸ñð(€€€Á½¥¹Ñ•È¹É••¥ÁÐü¹ÑÉ…¹Í¥Ñ¥½¹%€„ôôÍÑ…Ñ”¹Á½¥¹Ñ•É5•Ñ…‘…Ñ„¹ÑÉ…¹Í¥Ñ¥½¹%(€€¤ì(€€€™…¥° (€€€€€€55=Ie}QI9M%Q%=9}A9%9œ°(€€€€€€]•ˆÉ••¥ÁÐÑ…É•Ð‘½•Ì¹½Ðµ…Ñ Ñ¡”A$ÍÑ…Ñ”É•Ù¥Í¥½¸¸œ°(€€€€€€œ‘Ý•ˆ¹É••¥ÁÐœ°(€€€€€€½µÁ±•Ñ”Ñ¡”…ÁÁÉ½Ù•É½ÍÌµÉ•Á½Í¥Ñ½ÉäÑÉ…¹Í¥Ñ¥½¸½¹ÑÉ…Ð¸œ°(€€€€¤ì(€ô(€±•Ð½µµ¥Ðì(€ÑÉäì(€€€½µµ¥Ð€ôÉ•Í½±Ù•½µµ¥Ð(€€€€€€üÉ•Í½±Ù•½µµ¥Ð¡É½½Ð¤(€€€€€€è•á•¥±•Må¹Œ (€€€€€€€€€€¥Ðœ°(€€€€€€€€€l(€€€€€€€€€€€€œµŒœ°(€€€€€€€€€€€Í…™”¹‘¥É•Ñ½Éäô‘íÉ½½Ð¹É•Á±…•±° qpœ°€œ¼œ¥õ€°(€€€€€€€€€€€€É•ØµÁ…ÉÍ”œ°(€€€€€€€€€€€€½É¥¥¸½µ…¥¸œ°(€€€€€€€€€t°(€€€€€€€€€ìÝèÉ½½Ð°•¹½‘¥¹œè€ÕÑ˜àœ°ÍÑ‘¥¼èl¥¹½É”œ°€Á¥Á”œ°€¥¹½É”tô°(€€€€€€€€¤¹ÑÉ¥´ ¤ì(€ô…Ñ ì(€€€™…¥° (€€€€€€UQ!=I%Qe}U9Y%1	1œ°(€€€€€€Q¡”¥¹Ñ•É…Ñ•]•ˆ½É¥¥¸½µ…¥¸½µµ¥Ð½Õ±¹½Ð‰”É•Í½±Ù•¸œ°(€€€€€€œ´µÝ•ˆµÍ½ÕÉ”œ°(€€€€€€•Ñ …¹ÁÉ½Ù¥‘”Ñ¡”¥¹Ñ•É…Ñ•]•ˆ½É¥¥¸½µ…¥¸¡•­½ÕÐ¸œ°(€€€€¤ì(€ô(€¥˜€ (€€€½µµ¥Ð€„ôô]	}M!ñð(€€€ÍÑ…Ñ”¹É•Á½Í¥Ñ½É¥•Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôô€Ý•ˆœ¤ü¹µ•µ½ÉåI•Ù¥Í¥½¸(€€€€€€ü¹Í¡„€„ôô½µµ¥Ð(€€¤ì(€€€™…¥° (€€€€€€55=Ie}]	}IY%M%=9}5%M5Q œ°(€€€€€€%¹Ñ•É…Ñ•]•ˆµ…¥¸‘¥™™•ÉÌ™É½´Ñ¡”A$…ÕÑ¡½É¥Ñä¸œ°(€€€€€€œ´µÝ•ˆµÍ½ÕÉ”œ°(€€€€€UÍ”Ñ¡”•á…Ð¥¹Ñ•É…Ñ•½µµ¥Ð€‘í]	}M!ô¹€°(€€€€¤ì(€ô(€É•ÑÕÉ¸ì½µµ¥Ð°Á½¥¹Ñ•Èôì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•=¹‰½…É‘¥¹I•ÍÁ½¹Í”¡ÍÑ…Ñ”°É•ÍÁ½¹Í”¤ì(€½¹ÍÐ•áÁ•Ñ•‘…ÑÌ€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì (€€€ÍÑ…Ñ”¹½Á•É…Ñ¥½¹…±MÑ…Ñ”¹™…ÑÌ¹µ…À ¡™…Ð¤€ôøm™…Ð¹¥°™…Ð¹‰…Í¥Ít¤°(€€¤ì(€½¹ÍÐ•áÁ•Ñ•€ôì(€€€ÍÑ…Ñ•I•Ù¥Í¥½¸èÍÑ…Ñ”¹ÍÑ…Ñ•I•Ù¥Í¥½¸°(€€€Á¡…Í•%èÍÑ…Ñ”¹Á¡…Í”¹¥°(€€€±…ÍÑ½µÁ±•Ñ•‘%èÍÑ…Ñ”¹Á¡…Í”¹±…ÍÑ½µÁ±•Ñ•¹¥°(€€€ÕÉÉ•¹Ñ]½É­MÑ…ÑÕÌèÍÑ…Ñ”¹ÕÉÉ•¹Ñ]½É¬¹ÍÑ…ÑÕÌ°(€€€¹•áÑQ…Í­%èÍÑ…Ñ”¹¹•áÑQ…Í¬¹¥°(€€€Ý•‰5•µ½ÉåI•Ù¥Í¥½¸è]	}M!°(€€€½Á•É…Ñ¥½¹…±…ÑÌè•áÁ•Ñ•‘…ÑÌ°(€€€‰±½­•É%‘ÌèÍÑ…Ñ”¹‰±½­•ÉÌ(€€€€€€¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹ÍÑ…ÑÕÌ€ôôô€½Á•¸œ¤(€€€€€€¹µ…À ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥¤(€€€€€€¹Í½ÉÐ ¤°(€€€Á•¹‘¥¹•¥Í¥½¹%‘ÌèÍÑ…Ñ”¹Á•¹‘¥¹!Õµ…¹•¥Í¥½¹Ì(€€€€€€¹µ…À ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥¤(€€€€€€¹Í½ÉÐ ¤°(€€€É•ÍÑÉ¥Ñ¥½¹%‘ÌèÍÑ…Ñ”¹ÕÉÉ•¹ÑI•ÍÑÉ¥Ñ¥½¹Ì¹µ…À ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥¤¹Í½ÉÐ ¤°(€€€ÍÕÁ•ÉÍ•‘•‘A±…¹%‘ÌèÍÑ…Ñ”¹ÍÕÁ•ÉÍ•‘•‘A±…¹Ì¹µ…À ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥¤¹Í½ÉÐ ¤°(€ôì(€½¹ÍÐ¹½Éµ…±¥é•€ôì(€€€€¸¸¹É•ÍÁ½¹Í”°(€€€‰±½­•É%‘Ìèl¸¸¸¡É•ÍÁ½¹Í”¹‰±½­•É%‘Ì€üümt¥t¹Í½ÉÐ ¤°(€€€Á•¹‘¥¹•¥Í¥½¹%‘Ìèl¸¸¸¡É•ÍÁ½¹Í”¹Á•¹‘¥¹•¥Í¥½¹%‘Ì€üümt¥t¹Í½ÉÐ ¤°(€€€É•ÍÑÉ¥Ñ¥½¹%‘Ìèl¸¸¸¡É•ÍÁ½¹Í”¹É•ÍÑÉ¥Ñ¥½¹%‘Ì€üümt¥t¹Í½ÉÐ ¤°(€€€ÍÕÁ•ÉÍ•‘•‘A±…¹%‘Ìèl¸¸¸¡É•ÍÁ½¹Í”¹ÍÕÁ•ÉÍ•‘•‘A±…¹%‘Ì€üümt¥t¹Í½ÉÐ ¤°(€ôì(€½¹ÍÐ™¥•±‘Ì€ô=‰©•Ð¹­•åÌ¡•áÁ•Ñ•¤ì(€½¹ÍÐµ¥Íµ…Ñ¡•Ì€ô™¥•±‘Ì¹™¥±Ñ•È (€€€€¡™¥•±¤€ôø(€€€€€)M=8¹ÍÑÉ¥¹¥™ä¡¹½Éµ…±¥é•‘m™¥•±‘t¤€„ôô)M=8¹ÍÑÉ¥¹¥™ä¡•áÁ•Ñ•‘m™¥•±‘t¤°(€€¤ì(€½¹ÍÐ¡…É‘…¥±ÕÉ”€ô(€€€µ¥Íµ…Ñ¡•Ì¹±•¹Ñ €ø€Àñð(€€€É•ÍÁ½¹Í”¹ÍÕÁ•ÉÍ•‘•‘UÍ•‘ÍÕÉÉ•¹Ð€ôôôÑÉÕ”ñð(€€€É•ÍÁ½¹Í”¹µÕÑ…Ñ¥½¹Ì€„ôô€Àñð(€€€É•ÍÁ½¹Í”¹Í•É•ÑÍáÁ½Í•€„ôô€Àñð(€€€É•ÍÁ½¹Í”¹ÍÑ…ÉÑ•‘9•áÑQ…Í¬€ôôôÑÉÕ”ñð(€€€É•ÍÁ½¹Í”¹¡Õµ…¹EÕ•ÍÑ¥½¹Ì€ø€Àì(€½¹ÍÐÙ•É¥™¥•‘=ÕÑ½µ•Ì€ô¡…É‘…¥±ÕÉ”€ü€À€è€Äì(€½¹ÍÐ¥¹Ñ•ÉÙ•¹Ñ¥½¹Ì€ô9Õµ‰•È¡É•ÍÁ½¹Í”¹¡Õµ…¹%¹Ñ•ÉÙ•¹Ñ¥½¹Ì€üü€À¤ì(€É•ÑÕÉ¸ì(€€€½¬è€…¡…É‘…¥±ÕÉ”°(€€€½‘”è¡…É‘…¥±ÕÉ”€ü€=9	=I%9}=I1}%1œ€è€=9	=I%9}=I1}AMMœ°(€€€µ¥Íµ…Ñ¡•Ì°(€€€É…Üèì(€€€€€Í½ÕÉ•½Õ¹Ðè9Õµ‰•È¡É•ÍÁ½¹Í”¹Í½ÕÉ•½Õ¹Ð€üü€À¤°(€€€€€‘ÕÉ…Ñ¥½¹M•½¹‘Ìè9Õµ‰•È¡É•ÍÁ½¹Í”¹‘ÕÉ…Ñ¥½¹M•½¹‘Ì€üü€À¤°(€€€€€¡Õµ…¹EÕ•ÍÑ¥½¹Ìè9Õµ‰•È¡É•ÍÁ½¹Í”¹¡Õµ…¹EÕ•ÍÑ¥½¹Ì€üü€À¤°(€€€€€¡Õµ…¹%¹Ñ•ÉÙ•¹Ñ¥½¹Ìè¥¹Ñ•ÉÙ•¹Ñ¥½¹Ì°(€€€€€½ÉÉ•Ñ¹ÍÝ•ÉÌè™¥•±‘Ì¹±•¹Ñ €´µ¥Íµ…Ñ¡•Ì¹±•¹Ñ °(€€€€€¥¹½ÉÉ•Ñ¹ÍÝ•ÉÌèµ¥Íµ…Ñ¡•Ì¹±•¹Ñ °(€€€€€¥¹‘•Ñ•Éµ¥¹…Ñ•¹ÍÝ•ÉÌè9Õµ‰•È¡É•ÍÁ½¹Í”¹¥¹‘•Ñ•Éµ¥¹…Ñ•¹ÍÝ•ÉÌ€üü€À¤°(€€€€€Ù•É¥™¥•‘=ÕÑ½µ•Ì°(€€€ô°(€€€¡Õµ…¹%¹Ñ•ÉÙ•¹Ñ¥½¹I…Ñ”è(€€€€€Ù•É¥™¥•‘=ÕÑ½µ•Ì€ôôô€À€ü¹Õ±°€è¥¹Ñ•ÉÙ•¹Ñ¥½¹Ì€¼Ù•É¥™¥•‘=ÕÑ½µ•Ì°(€ôì)ô()™Õ¹Ñ¥½¸Á…ÉÍ•ÉÕµ•¹ÑÌ¡…ÉØ¤ì(€½¹ÍÐ…ÉÌ€ôì¡•¬è™…±Í”ôì(€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ð…ÉØ¹±•¹Ñ ì¥¹‘•à€¬ô€Ä¤ì(€€€½¹ÍÐ¹…µ”€ô…ÉÙm¥¹‘•átì(€€€¥˜€¡¹…µ”€ôôô€œ´µ¡•¬œ¤ì(€€€€€…ÉÌ¹¡•¬€ôÑÉÕ”ì(€€€€€½¹Ñ¥¹Õ”ì(€€€ô(€€€½¹ÍÐÙ…±Õ”€ô…ÉÙm¥¹‘•à€¬€Åtì(€€€¥˜€ (€€€€€€…¹…µ”ü¹ÍÑ…ÉÑÍ]¥Ñ  œ´´œ¤ñð(€€€€€Ù…±Õ”€ôôôÕ¹‘•™¥¹•ñð(€€€€€Ù…±Õ”¹ÍÑ…ÉÑÍ]¥Ñ  œ´´œ¤(€€€€¤(€€€€€™…¥° (€€€€€€€€UM}II=Hœ°(€€€€€€€€ÉÕµ•¹ÑÌµÕÍÐ‰”¹…µ•½ÁÑ¥½¹Ì¸œ°(€€€€€€€€…ÉØœ°(€€€€€€€€UÍ”€´µµ½‘”±½…±ñÉ•¹‘•ÉñÉ½ÍÌµÉ•Á½ñ½¹‰½…É‘¥¹œµ½É…±”¸œ°(€€€€€€¤ì(€€€…ÉÍl(€€€€€¹…µ”¹Í±¥” È¤¹É•Á±…” ¼´¡m„µét¤½Ô°€¡|°±•ÑÑ•È¤€ôø±•ÑÑ•È¹Ñ½UÁÁ•É…Í” ¤¤(€€€t€ôÙ…±Õ”ì(€€€¥¹‘•à€¬ô€Äì(€ô(€¥˜€ (€€€€…l±½…°œ°€É•¹‘•Èœ°€É½ÍÌµÉ•Á¼œ°€½¹‰½…É‘¥¹œµ½É…±”t¹¥¹±Õ‘•Ì¡…ÉÌ¹µ½‘”¤(€€¤(€€€™…¥° (€€€€€€UM}II=Hœ°(€€€€€€U¹ÍÕÁÁ½ÉÑ•µ½‘”¸œ°(€€€€€€…ÉØœ°(€€€€€€UÍ”€´µµ½‘”±½…±ñÉ•¹‘•ÉñÉ½ÍÌµÉ•Á½ñ½¹‰½…É‘¥¹œµ½É…±”¸œ°(€€€€¤ì(€É•ÑÕÉ¸…ÉÌì)ô()™Õ¹Ñ¥½¸½ÕÑÁÕÐ¡É•ÍÕ±Ð¤ì(€ÁÉ½•ÍÌ¹ÍÑ‘½ÕÐ¹ÝÉ¥Ñ”¡€‘í)M=8¹ÍÑÉ¥¹¥™ä¡É•ÍÕ±Ð¥õq¹€¤ì)ô()™Õ¹Ñ¥½¸µ…¥¸ ¤ì(€ÑÉäì(€€€½¹ÍÐ…ÉÌ€ôÁ…ÉÍ•ÉÕµ•¹ÑÌ¡ÁÉ½•ÍÌ¹…ÉØ¹Í±¥” È¤¤ì(€€€¥˜€¡…ÉÌ¹µ½‘”€ôôô€É•¹‘•Èœ¤ì(€€€€€½¹ÍÐì•áÁ•Ñ•ô€ôÙ…±¥‘…Ñ•1½…°¡ÁÉ½•ÍÌ¹Ý ¤°ì(€€€€€€€¡•­AÉ½©•Ñ¥½¸è™…±Í”°(€€€€€ô¤ì(€€€€€¥˜€¡…ÉÌ¹¡•¬¤ì(€€€€€€€¥˜€¡Í…™•I•…¡AI=)Q%=9}AQ ¤€„ôô•áÁ•Ñ•¤(€€€€€€€€€™…¥° (€€€€€€€€€€€€55=Ie}AI=)Q%=9}MQ1œ°(€€€€€€€€€€€€AÉ½©•Ñ¥½¸¥ÌÍÑ…±”¸œ°(€€€€€€€€€€€AI=)Q%=9}AQ °(€€€€€€€€€€€€IÕ¸€´µµ½‘”É•¹‘•ÈÝ¥Ñ¡½ÕÐ€´µ¡•¬¸œ°(€€€€€€€€€€¤ì(€€€€€ô•±Í”ì(€€€€€€€ÝÉ¥Ñ•¥±•Må¹Œ¡AI=)Q%=9}AQ °•áÁ•Ñ•°€ÕÑ˜àœ¤ì(€€€€€ô(€€€€€½ÕÑÁÕÐ¡ì(€€€€€€€½¬èÑÉÕ”°(€€€€€€€½‘”è…ÉÌ¹¡•¬(€€€€€€€€€€ü€55=Ie}AI=)Q%=9}UII9Pœ(€€€€€€€€€€è€55=Ie}AI=)Q%=9}I9Iœ°(€€€€€€€Á…Ñ èAI=)Q%=9}AQ °(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€½¹ÍÐìÍÑ…Ñ”ô€ôÙ…±¥‘…Ñ•1½…° ¤ì(€€€¥˜€¡…ÉÌ¹µ½‘”€ôôô€É½ÍÌµÉ•Á¼œ¤ì(€€€€€¥˜€ ……ÉÌ¹Ý•‰M½ÕÉ”¤(€€€€€€€™…¥° (€€€€€€€€€€UM}II=Hœ°(€€€€€€€€€€œ´µÝ•ˆµÍ½ÕÉ”¥ÌÉ•ÅÕ¥É•¸œ°(€€€€€€€€€€…ÉØœ°(€€€€€€€€€€AÉ½Ù¥‘”Ñ¡”¥¹Ñ•É…Ñ•]•ˆ¡•­½ÕÐ¸œ°(€€€€€€€€¤ì(€€€€€½¹ÍÐÉ½ÍÌ€ôÙ…±¥‘…Ñ•É½ÍÍI•Á¼¡ÍÑ…Ñ”°…ÉÌ¹Ý•‰M½ÕÉ”¤ì(€€€€€½ÕÑÁÕÐ¡ì(€€€€€€€½¬èÑÉÕ”°(€€€€€€€½‘”è€55=Ie}I=MM}IA=}Y1%œ°(€€€€€€€ÍÑ…Ñ•I•Ù¥Í¥½¸èÍÑ…Ñ”¹ÍÑ…Ñ•I•Ù¥Í¥½¸°(€€€€€€€Ý•‰5•µ½ÉåI•Ù¥Í¥½¸èÉ½ÍÌ¹½µµ¥Ð°(€€€€€€€Á½¥¹Ñ•É=¹±äèÑÉÕ”°(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€¥˜€¡…ÉÌ¹µ½‘”€ôôô€½¹‰½…É‘¥¹œµ½É…±”œ¤ì(€€€€€¥˜€ ……ÉÌ¹É•ÍÁ½¹Í”¤(€€€€€€€™…¥° (€€€€€€€€€€UM}II=Hœ°(€€€€€€€€€€œ´µÉ•ÍÁ½¹Í”¥ÌÉ•ÅÕ¥É•¸œ°(€€€€€€€€€€…ÉØœ°(€€€€€€€€€€AÉ½Ù¥‘”Ñ¡”ÍÑÉÕÑÕÉ•½¹‰½…É‘¥¹œÉ•ÍÁ½¹Í”)M=8¸œ°(€€€€€€€€¤ì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ôÙ…±¥‘…Ñ•=¹‰½…É‘¥¹I•ÍÁ½¹Í” (€€€€€€€ÍÑ…Ñ”°(€€€€€€€Á…ÉÍ•)Í½¸¡É•Í½±Ù”¡…ÉÌ¹É•ÍÁ½¹Í”¤¤°(€€€€€€¤ì(€€€€€½ÕÑÁÕÐ¡É•ÍÕ±Ð¤ì(€€€€€¥˜€ …É•ÍÕ±Ð¹½¬¤ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Äì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€½ÕÑÁÕÐ¡ì(€€€€€½¬èÑÉÕ”°(€€€€€½‘”è€55=Ie}Y1%œ°(€€€€€ÍÑ…Ñ•I•Ù¥Í¥½¸èÍÑ…Ñ”¹ÍÑ…Ñ•I•Ù¥Í¥½¸°(€€€€€Í¡•µ…Y…±¥‘…Ñ•èÑÉÕ”°(€€€€€Í•µ…¹Ñ¥IÕ±•ÍY…±¥‘…Ñ•èÑÉÕ”°(€€€€€ÁÉ½©•Ñ¥½¹ÕÉÉ•¹ÐèÑÉÕ”°(€€€€€ÍÑ…‰±•M½ÕÉ•ÍY…±¥‘…Ñ•èÑÉÕ”°(€€€ô¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹ÍÐ™…¥±ÕÉ”€ô(€€€€€•ÉÉ½È¥¹ÍÑ…¹•½˜5•µ½ÉåÉÉ½È(€€€€€€€€ü•ÉÉ½È(€€€€€€€€è¹•Ü5•µ½ÉåÉÉ½È (€€€€€€€€€€€€55=Ie}Y1%Q%=9}%1œ°(€€€€€€€€€€€•ÉÉ½È¹µ•ÍÍ…”°(€€€€€€€€€€€€ÉÕ¹Ñ¥µ”œ°(€€€€€€€€€€€€%¹ÍÁ•ÐÑ¡”Ù…±¥‘…Ñ½È¥¹ÁÕÑÌ¸œ°(€€€€€€€€€€¤ì(€€€½ÕÑÁÕÐ¡ì(€€€€€½¬è™…±Í”°(€€€€€½‘”è™…¥±ÕÉ”¹½‘”°(€€€€€½‘•Ìèm™…¥±ÕÉ”¹½‘•t°(€€€€€Á…Ñ è™…¥±ÕÉ”¹Á…Ñ °(€€€€€¹•áÑÑ¥½¸è™…¥±ÕÉ”¹¹•áÑÑ¥½¸°(€€€ô¤ì(€€€ÁÉ½•ÍÌ¹ÍÑ‘•ÉÈ¹ÝÉ¥Ñ”¡€‘í™…¥±ÕÉ”¹µ•ÍÍ…•õq¹€¤ì(€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô™…¥±ÕÉ”¹½‘”€ôôô€UM}II=Hœ€ü€È€è€Äì(€ô)ô()¥˜€¡É•ÅÕ¥É”¹µ…¥¸€ôôôµ½‘Õ±”¤µ…¥¸ ¤ì()µ½‘Õ±”¹•áÁ½ÉÑÌ€ôì(€UQ!=I%Qe}AQ °(€AI=)Q%=9}AQ °(€M!5}AQ °(€]	}M!°(€5•µ½ÉåÉÉ½È°(€Á…ÉÍ•ÉÕµ•¹ÑÌ°(€É•¹‘•ÉAÉ½©•Ñ¥½¸°(€±¥¹ÑQ•µÁ½É…±ÍÍ•ÉÑ¥½¹Ì°(€Ù…±¥‘…Ñ•É½ÍÍI•Á¼°(€Ù…±¥‘…Ñ•1½…°°(€Ù…±¥‘…Ñ•=¹‰½…É‘¥¹I•ÍÁ½¹Í”°(€Ù…±¥‘…Ñ•I•Á½Í¥Ñ½ÉåÙ¥‘•¹”°(€Ù…±¥‘…Ñ•M¡•µ…½¹ÑÉ…Ð°(€Ù…±¥‘…Ñ•MÑ…‰±•M½ÕÉ•Ì°(€Ù…±¥‘…Ñ•)Í½¹M¡•µ„°(€Ù…±¥‘…Ñ•MÑ…Ñ”°)ôì