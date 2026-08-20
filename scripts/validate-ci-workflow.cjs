const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const RELEASE_WORKFLOW_PATH = '.github/workflows/release-image.yml';
const FULL_SHA = /^[a-f0-9]{40}$/u;
const MANUAL_RELEASE_IMAGE_REF =
  /^ghcr\.io\/(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*):(?<tag>sha-[a-f0-9]{40})$/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isDefinitiveManifestAbsence({
  status,
  stdout,
  stderr,
  expectedImageRef,
} = {}) {
  if (
    status !== 1 ||
    stdout !== '' ||
    typeof stderr !== 'string' ||
    typeof expectedImageRef !== 'string'
  ) {
    return false;
  }
  const identity = MANUAL_RELEASE_IMAGE_REF.exec(expectedImageRef);
  if (!identity?.groups) return false;
  if (stderr.length === 0 || /[\r\n\u0085\u2028\u2029]/u.test(stderr)) {
    return false;
  }
  const imageRef = escapeRegExp(expectedImageRef);
  const manifestUrl = escapeRegExp(
    `https://ghcr.io/v2/${identity.groups.repository}/manifests/${identity.groups.tag}`,
  );
  const absence = '(?:manifest unknown|name unknown|no such manifest)';
  return [
    new RegExp(`^(?:ERROR: )?${absence}: ${imageRef}$`, 'u'),
    new RegExp(`^(?:ERROR: )?${imageRef}: ${absence}$`, 'u'),
    new RegExp(
      `^(?:ERROR: )?unexpected status from (?:HEAD|GET) request to ${manifestUrl}: 404 Not Found$`,
      'u',
    ),
  ].some((pattern) => pattern.test(stderr));
}

const ACTIONS = new Map([
  [
    'actions/checkout',
    {
      sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
      version: 'v7.0.1',
    },
  ],
  [
    'actions/setup-node',
    {
      sha: '820762786026740c76f36085b0efc47a31fe5020',
      version: 'v7.0.0',
    },
  ],
  [
    'actions/upload-artifact',
    {
      sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      version: 'v7.0.1',
    },
  ],
  [
    'docker/setup-buildx-action',
    {
      sha: 'bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
      version: 'v4.2.0',
    },
  ],
  [
    'docker/build-push-action',
    {
      sha: '53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
      version: 'v7.3.0',
    },
  ],
  [
    'docker/login-action',
    {
      sha: 'dbcb813823bdd20940b903addbd779551569679f',
      version: 'v4.6.0',
    },
  ],
  [
    'docker/metadata-action',
    {
      sha: 'dc802804100637a589fabce1cb79ff13a1411302',
      version: 'v6.2.0',
    },
  ],
  [
    'aquasecurity/trivy-action',
    {
      sha: 'ed142fd0673e97e23eac54620cfb913e5ce36c25',
      version: 'v0.36.0',
    },
  ],
]);
const OCI_LABELS = [
  'org.opencontainers.image.source',
  'org.opencontainers.image.revision',
  'org.opencontainers.image.version',
  'org.opencontainers.image.created',
  'org.opencontainers.image.title',
  'org.opencontainers.image.description',
];
const SYNTHETIC_ENV_MATRIX = Object.freeze({
  DATABASE_NAME: 'genesis_platform',
  DATABASE_BOOTSTRAP_USER: 'genesis_bootstrap',
  DATABASE_MIGRATION_USER: 'genesis_migration',
  DATABASE_RUNTIME_ROLE: 'genesis_runtime',
  APP_NAME: 'Genesis Platform API',
  APP_VERSION: '0.1.0',
  ACME_EMAIL: 'acme-contact-required@genesis.invalid',
  TRUST_PROXY_HOPS: '1',
  JWT_ACCESS_EXPIRES_IN: '15m',
  REFRESH_TOKEN_EXPIRES_IN_DAYS: '30',
  LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION: '1',
  API_CPUS: '0.75',
  API_MEMORY_LIMIT: '1g',
  API_PIDS_LIMIT: '128',
  API_NODE_MAX_OLD_SPACE_MB: '640',
  MIGRATE_CPUS: '0.75',
  MIGRATE_MEMORY_LIMIT: '1g',
  MIGRATE_PIDS_LIMIT: '128',
  MIGRATE_NODE_MAX_OLD_SPACE_MB: '640',
  POSTGRES_CPUS: '1.0',
  POSTGRES_MEMORY_LIMIT: '2g',
  POSTGRES_PIDS_LIMIT: '256',
});
const SYNTHETIC_SECRET_FILES = Object.freeze({
  postgres_bootstrap_password: 'postgres-bootstrap-password',
  database_migration_password: 'database-migration-password',
  database_runtime_password: 'database-runtime-password',
  jwt_access_secret: 'jwt-access-secret',
  refresh_token_pepper: 'refresh-token-pepper',
  lead_idempotency_keys: 'lead-idempotency-keys',
});
const SYNTHETIC_PATH_ENV = Object.freeze({
  PRODUCTION_CI_ROOT: '$RUNNER_TEMP/genesis-production-ci',
  PRODUCTION_CI_ENV_FILE: '$RUNNER_TEMP/genesis-production-ci/production.env',
  PRODUCTION_CI_SECRET_DIR: '$RUNNER_TEMP/genesis-production-ci/secrets',
  PRODUCTION_CI_OVERRIDE_FILE:
    '$RUNNER_TEMP/genesis-production-ci/secret-files.override.yml',
  PRODUCTION_CI_RENDER_FILE: '$RUNNER_TEMP/genesis-production-ci/rendered.json',
});
const SYNTHETIC_PATH_INITIALIZATION = [
  'set -euo pipefail',
  '{',
  ...Object.entries(SYNTHETIC_PATH_ENV).map(
    ([name, path]) => `  printf '${name}=%s\\n' "${path}"`,
  ),
  '} >> "$GITHUB_ENV"',
].join('\n');
const SYNTHETIC_API_IMAGE =
  'ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a';
const SYNTHETIC_POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';

class WorkflowContractError extends Error {
  constructor(failures) {
    super(
      `CI workflow contract failed:\n${failures.map((entry) => `- ${entry}`).join('\n')}`,
    );
    this.name = 'WorkflowContractError';
    this.failures = failures;
  }
}

function stripComment(value) {
  let single = false;
  let double = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) {
      if (single && value[index + 1] === "'") {
        index += 1;
      } else {
        single = !single;
      }
    } else if (character === '"' && !single) {
      let escaped = false;
      for (
        let cursor = index - 1;
        cursor >= 0 && value[cursor] === '\\';
        cursor -= 1
      ) {
        escaped = !escaped;
      }
      if (!escaped) double = !double;
    } else if (
      character === '#' &&
      !single &&
      !double &&
      (index === 0 || /\s/u.test(value[index - 1]))
    ) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function splitMappingEntry(value, lineNumber) {
  let single = false;
  let double = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === ':' && !single && !double) {
      const key = value.slice(0, index).trim();
      if (!key) throw new Error(`empty YAML key at line ${lineNumber}.`);
      return [unquote(key), value.slice(index + 1).trim()];
    }
  }
  throw new Error(`expected YAML mapping entry at line ${lineNumber}.`);
}

function unquote(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

function scalar(value) {
  if (value === '{}') return {};
  if (value === '[]') return [];
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  return unquote(value);
}

function parseYamlSubset(source) {
  const physicalLines = source.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const lines = [];
  for (let index = 0; index < physicalLines.length; index += 1) {
    const raw = physicalLines[index];
    if (/^\s*$/u.test(raw) || /^\s*#/u.test(raw)) continue;
    if (/^\s*\t/u.test(raw)) {
      throw new Error(
        `tabs are not allowed for YAML indentation at line ${index + 1}.`,
      );
    }
    const indent = raw.match(/^ */u)[0].length;
    const content = stripComment(raw.slice(indent));
    if (!content) continue;
    lines.push({
      content,
      indent,
      lineNumber: index + 1,
      physicalIndex: index,
    });
  }
  if (lines.length === 0) throw new Error('workflow YAML is empty.');

  function blockScalar(line, marker, nextIndex) {
    const contentLines = [];
    let cursor = line.physicalIndex + 1;
    let minimumIndent = null;
    while (cursor < physicalLines.length) {
      const raw = physicalLines[cursor];
      if (/^\s*$/u.test(raw)) {
        contentLines.push('');
        cursor += 1;
        continue;
      }
      const indent = raw.match(/^ */u)[0].length;
      if (indent <= line.indent) break;
      minimumIndent =
        minimumIndent === null ? indent : Math.min(minimumIndent, indent);
      contentLines.push(raw);
      cursor += 1;
    }
    const normalized = contentLines.map((entry) =>
      entry === '' ? '' : entry.slice(minimumIndent ?? 0),
    );
    const value = marker.startsWith('>')
      ? normalized.join(' ').replace(/\s+/gu, ' ').trim()
      : normalized.join('\n');
    while (
      nextIndex < lines.length &&
      lines[nextIndex].physicalIndex < cursor
    ) {
      nextIndex += 1;
    }
    return { nextIndex, value };
  }

  function parseBlock(startIndex, indent) {
    const sequence =
      lines[startIndex].content === '-' ||
      lines[startIndex].content.startsWith('- ');
    const container = sequence ? [] : {};
    let index = startIndex;
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(
          `unexpected YAML indentation at line ${line.lineNumber}.`,
        );
      }
      const item = line.content === '-' || line.content.startsWith('- ');
      if (item !== sequence) {
        throw new Error(
          `mixed YAML mapping and sequence at line ${line.lineNumber}.`,
        );
      }
      if (sequence) {
        const remainder = line.content.slice(1).trim();
        if (!remainder) {
          if (index + 1 >= lines.length || lines[index + 1].indent <= indent) {
            container.push(null);
            index += 1;
          } else {
            const child = parseBlock(index + 1, lines[index + 1].indent);
            container.push(child.value);
            index = child.nextIndex;
          }
          continue;
        }
        if (!remainder.includes(':')) {
          container.push(scalar(remainder));
          index += 1;
          continue;
        }
        const [key, rawValue] = splitMappingEntry(remainder, line.lineNumber);
        const object = {};
        index += 1;
        if (rawValue === '|' || rawValue.startsWith('>')) {
          const parsed = blockScalar(line, rawValue, index);
          object[key] = parsed.value;
          index = parsed.nextIndex;
        } else if (rawValue !== '') {
          object[key] = scalar(rawValue);
        } else if (index < lines.length && lines[index].indent > indent) {
          const child = parseBlock(index, lines[index].indent);
          object[key] = child.value;
          index = child.nextIndex;
        } else {
          object[key] = {};
        }
        if (index < lines.length && lines[index].indent > indent) {
          const sibling = parseBlock(index, lines[index].indent);
          if (
            sibling.value === null ||
            typeof sibling.value !== 'object' ||
            Array.isArray(sibling.value)
          ) {
            throw new Error(
              `sequence mapping continuation is invalid at line ${lines[index].lineNumber}.`,
            );
          }
          Object.assign(object, sibling.value);
          index = sibling.nextIndex;
        }
        container.push(object);
        continue;
      }

      const [key, rawValue] = splitMappingEntry(line.content, line.lineNumber);
      if (Object.hasOwn(container, key)) {
        throw new Error(
          `duplicate YAML key '${key}' at line ${line.lineNumber}.`,
        );
      }
      index += 1;
      if (rawValue === '|' || rawValue.startsWith('>')) {
        const parsed = blockScalar(line, rawValue, index);
        container[key] = parsed.value;
        index = parsed.nextIndex;
      } else if (rawValue !== '') {
        container[key] = scalar(rawValue);
      } else if (index < lines.length && lines[index].indent > indent) {
        const child = parseBlock(index, lines[index].indent);
        container[key] = child.value;
        index = child.nextIndex;
      } else {
        container[key] = {};
      }
    }
    return { nextIndex: index, value: container };
  }

  return parseBlock(0, lines[0].indent).value;
}

function normalizeExpression(value) {
  return String(value ?? '')
    .replace(/^\$\{\{\s*/u, '')
    .replace(/\s*\}\}$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function actionReference(step) {
  if (typeof step?.uses !== 'string') return null;
  const separator = step.uses.lastIndexOf('@');
  if (separator <= 0) return { action: step.uses, sha: '' };
  return {
    action: step.uses.slice(0, separator),
    sha: step.uses.slice(separator + 1),
  };
}

function stepsFor(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function findStep(job, predicate) {
  return stepsFor(job).find(predicate);
}

function stepIndex(job, predicate) {
  return stepsFor(job).findIndex(predicate);
}

function permissionFailures(value, expected, location) {
  const failures = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${location} permissions must be a mapping.`];
  }
  const actual = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, String(entry)]),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${location} permissions must equal ${JSON.stringify(expected)}.`,
    );
  }
  return failures;
}

function jobEnvironmentContextFailures(jobs) {
  const failures = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const [name, value] of Object.entries(job?.env ?? {})) {
      if (/\$\{\{\s*runner\./u.test(String(value))) {
        failures.push(
          `jobs.${jobName}.env.${name} must not reference the unavailable runner context.`,
        );
      }
    }
  }
  return failures;
}

function parseSyntheticEnvironment(run, failures) {
  const block =
    /cat > "\$PRODUCTION_CI_ENV_FILE" <<'ENV'\n([\s\S]*?)\nENV/gu.exec(
      run,
    )?.[1];
  if (block === undefined) {
    failures.push('synthetic production environment heredoc is missing.');
    return {};
  }
  const parsed = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      failures.push('synthetic production environment has an invalid line.');
      continue;
    }
    if (Object.hasOwn(parsed, match[1])) {
      failures.push(`synthetic production environment duplicates ${match[1]}.`);
    }
    parsed[match[1]] = match[2];
  }
  return parsed;
}

function syntheticProductionFailures(validate) {
  const failures = [];
  const steps = stepsFor(validate);
  const initialize = steps.find(
    (step) => step.name === 'Initialize synthetic production paths',
  );
  const create = steps.find(
    (step) => step.name === 'Create synthetic production Compose inputs',
  );
  const render = steps.find(
    (step) =>
      step.name === 'Validate synthetic secret-backed production render',
  );
  const compose = steps.find(
    (step) =>
      String(step.run ?? '').trim() === 'npm run production:compose:validate',
  );
  const cleanup = steps.find(
    (step) => step.name === 'Remove synthetic production Compose inputs',
  );
  if (
    steps.some(
      (step) => actionReference(step)?.action === 'actions/upload-artifact',
    )
  ) {
    failures.push(
      'validate must not upload synthetic production inputs or rendered metadata.',
    );
  }
  if (!initialize || !create || !render || !compose || !cleanup) {
    failures.push(
      'synthetic production path initialization, create, render, canonical validation and cleanup steps are required.',
    );
    return failures;
  }
  const initializeRun = String(initialize.run ?? '').trim();
  const createRun = String(create.run ?? '');
  const renderRun = String(render.run ?? '');
  const cleanupRun = String(cleanup.run ?? '');
  if (
    initialize.shell !== 'bash' ||
    initializeRun !== SYNTHETIC_PATH_INITIALIZATION ||
    Object.keys(SYNTHETIC_PATH_ENV).some((name) =>
      Object.hasOwn(validate.env ?? {}, name),
    )
  ) {
    failures.push(
      'synthetic production paths must be initialized exactly from RUNNER_TEMP through GITHUB_ENV during the first step.',
    );
  }
  if (
    create.shell !== 'bash' ||
    !createRun.includes('set -euo pipefail') ||
    !createRun.includes('umask 077') ||
    !createRun.includes(
      'install -d -m 0700 "$PRODUCTION_CI_ROOT" "$PRODUCTION_CI_SECRET_DIR"',
    )
  ) {
    failures.push(
      'synthetic production inputs must use fail-closed bash and private directories.',
    );
  }
  const environment = parseSyntheticEnvironment(createRun, failures);
  if (JSON.stringify(environment) !== JSON.stringify(SYNTHETIC_ENV_MATRIX)) {
    failures.push(
      'synthetic production environment must match the complete approved matrix.',
    );
  }
  const roles = [
    environment.DATABASE_BOOTSTRAP_USER,
    environment.DATABASE_MIGRATION_USER,
    environment.DATABASE_RUNTIME_ROLE,
  ];
  if (
    roles.some((role) => !/^[a-z_][a-z0-9_]*$/u.test(role ?? '')) ||
    new Set(roles).size !== 3
  ) {
    failures.push('synthetic database roles must be valid and distinct.');
  }
  for (const forbidden of [
    'GENESIS_API_IMAGE',
    'FRONTEND_URL',
    'POSTGRES_PASSWORD',
    'DATABASE_MIGRATION_PASSWORD',
    'DATABASE_RUNTIME_PASSWORD',
    'DATABASE_PASSWORD',
    'JWT_ACCESS_SECRET',
    'REFRESH_TOKEN_PEPPER',
    'LEAD_IDEMPOTENCY_KEYS',
  ]) {
    if (Object.hasOwn(environment, forbidden)) {
      failures.push(
        `synthetic production environment must not contain ${forbidden}.`,
      );
    }
  }
  for (const [name, filename] of Object.entries(SYNTHETIC_SECRET_FILES)) {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const writePattern = new RegExp(
      `printf '%s\\\\n' 'synthetic-ci-[^'\\n]+' > "\\$PRODUCTION_CI_SECRET_DIR/${escaped}"`,
      'u',
    );
    if (!writePattern.test(createRun)) {
      failures.push(`synthetic secret file is not safely created: ${name}.`);
    }
    if (
      !createRun.includes(`"$PRODUCTION_CI_SECRET_DIR/${filename}"`) ||
      !createRun.includes(
        `${name}:\n    file: $PRODUCTION_CI_SECRET_DIR/${filename}`,
      )
    ) {
      failures.push(`synthetic secret override is incomplete: ${name}.`);
    }
    if (!cleanupRun.includes(`"$PRODUCTION_CI_SECRET_DIR/${filename}"`)) {
      failures.push(`synthetic secret cleanup is incomplete: ${name}.`);
    }
  }
  if (
    !createRun.includes('chmod 0600') ||
    !createRun.includes('cat > "$PRODUCTION_CI_OVERRIDE_FILE" <<OVERRIDE')
  ) {
    failures.push(
      'synthetic secret files require mode 0600 and a RUNNER_TEMP override.',
    );
  }
  for (const fragment of [
    'docker compose',
    '--env-file "$PRODUCTION_CI_ENV_FILE"',
    '-f compose.production.yml',
    '-f "$PRODUCTION_CI_OVERRIDE_FILE"',
    'config --format json > "$PRODUCTION_CI_RENDER_FILE"',
    SYNTHETIC_API_IMAGE,
    SYNTHETIC_POSTGRES_IMAGE,
    "FRONTEND_URL !== 'https://app.agenciagenesismkt.com.br'",
    "LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION) !== '1'",
    'new Set(roles).size !== 3',
    '(statSync(expected).mode & 0o777) !== 0o600',
    "value.startsWith('synthetic-ci-')",
  ]) {
    if (!renderRun.includes(fragment)) {
      failures.push(
        'synthetic secret-backed render validation is incomplete or mutable.',
      );
      break;
    }
  }
  if (
    render.shell !== 'bash' ||
    !renderRun.includes('set -euo pipefail') ||
    /\b(?:console\.log|process\.stdout|set -x)\b/u.test(renderRun) ||
    /\b(?:cat|head|tail|sed|awk|grep|tee)\b[^\n]*PRODUCTION_CI_SECRET_DIR/u.test(
      renderRun,
    )
  ) {
    failures.push(
      'synthetic secret values must never be printed or copied to logs.',
    );
  }
  if (
    compose.env?.GENESIS_PRODUCTION_ENV_FILE !==
    '${{ env.PRODUCTION_CI_ENV_FILE }}'
  ) {
    failures.push(
      'Compose validation must use the synthetic RUNNER_TEMP environment file.',
    );
  }
  if (
    normalizeExpression(cleanup.if) !== 'always()' ||
    cleanup.shell !== 'bash' ||
    !cleanupRun.includes('rm -f --') ||
    !cleanupRun.includes('"$PRODUCTION_CI_RENDER_FILE"') ||
    !cleanupRun.includes('"$PRODUCTION_CI_OVERRIDE_FILE"') ||
    !cleanupRun.includes('"$PRODUCTION_CI_ENV_FILE"') ||
    !cleanupRun.includes('if [ -d "$PRODUCTION_CI_SECRET_DIR" ]; then') ||
    !cleanupRun.includes('rmdir -- "$PRODUCTION_CI_SECRET_DIR"') ||
    !cleanupRun.includes('if [ -d "$PRODUCTION_CI_ROOT" ]; then') ||
    !cleanupRun.includes('rmdir -- "$PRODUCTION_CI_ROOT"') ||
    /\*|rm\s+-(?:[^\s]*r|[^\s]*R)|\|\|\s*true|print|echo|cat\s+[^>]/iu.test(
      cleanupRun,
    )
  ) {
    failures.push(
      'synthetic production cleanup must be exact, unconditional and silent.',
    );
  }
  const initializeIndex = steps.indexOf(initialize);
  const createIndex = steps.indexOf(create);
  const renderIndex = steps.indexOf(render);
  const composeIndex = steps.indexOf(compose);
  const cleanupIndex = steps.indexOf(cleanup);
  if (!(
    initializeIndex === 0 &&
    initializeIndex < createIndex &&
    createIndex < renderIndex &&
    renderIndex < composeIndex &&
    composeIndex < cleanupIndex &&
    cleanupIndex === composeIndex + 1
  )) {
    failures.push(
      'synthetic production inputs must be created, rendered, validated and immediately cleaned in order.',
    );
  }
  if (
    /github\.(?:event|sha|ref|actor)|secrets\./u.test(
      `${initializeRun}\n${createRun}\n${renderRun}\n${cleanupRun}`,
    )
  ) {
    failures.push(
      'synthetic production inputs must not depend on untrusted event data or credentials.',
    );
  }
  return failures;
}

function buildFailures(job, location) {
  const failures = [];
  const buildSteps = stepsFor(job).filter(
    (step) => actionReference(step)?.action === 'docker/build-push-action',
  );
  if (buildSteps.length !== 1)
    failures.push(`${location} must contain exactly one image build step.`);
  for (const step of buildSteps) {
    const inputs = step.with ?? {};
    if (inputs.target !== 'production')
      failures.push(`${location} build target must be production.`);
    if (inputs.platforms !== 'linux/amd64')
      failures.push(`${location} build platform must be linux/amd64.`);
    if (inputs.load !== true)
      failures.push(`${location} build must load the local image.`);
    if (inputs.push !== false)
      failures.push(`${location} build action must not push.`);
    if (inputs.provenance !== false)
      failures.push(`${location} must disable provenance.`);
    if (inputs.sbom !== false) failures.push(`${location} must disable SBOM.`);
    for (const forbidden of [
      'build-args',
      'cache-from',
      'cache-to',
      'secrets',
    ]) {
      if (Object.hasOwn(inputs, forbidden))
        failures.push(`${location} build must not set ${forbidden}.`);
    }
  }
  return failures;
}

function trivyFailures(step, location) {
  const failures = [];
  if (!step) return [`${location} is missing Trivy.`];
  const reference = actionReference(step);
  if (reference?.action !== 'aquasecurity/trivy-action') {
    failures.push(`${location} must use aquasecurity/trivy-action.`);
  }
  const inputs = step.with ?? {};
  const expected = {
    'scan-type': 'image',
    format: 'table',
    'exit-code': '1',
    'ignore-unfixed': false,
    scanners: 'vuln',
    severity: 'CRITICAL',
    version: 'v0.70.0',
    cache: false,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(inputs[key]) !== String(value))
      failures.push(`${location} Trivy ${key} must be ${value}.`);
  }
  if (
    Object.hasOwn(inputs, 'skip-db-update') ||
    Object.hasOwn(inputs, 'skip-java-db-update')
  ) {
    failures.push(`${location} must not skip vulnerability database updates.`);
  }
  if (!inputs['image-ref'])
    failures.push(`${location} must identify the scanned image.`);
  return failures;
}

function metadataFailures(job, location, shaExpression = '${{ github.sha }}') {
  const failures = [];
  const metadata = findStep(
    job,
    (step) => actionReference(step)?.action === 'docker/metadata-action',
  );
  if (!metadata) return [`${location} is missing OCI metadata generation.`];
  const inputs = metadata.with ?? {};
  if (inputs.images !== 'ghcr.io/arthurportodev/genesis-platform-api') {
    failures.push(
      `${location} metadata must use the canonical GHCR repository.`,
    );
  }
  if (String(inputs.flavor).trim() !== 'latest=false') {
    failures.push(`${location} must disable the implicit latest tag.`);
  }
  if (String(inputs.tags).trim() !== `type=raw,value=sha-${shaExpression}`) {
    failures.push(`${location} must define only the full-SHA tag.`);
  }
  const labels = String(inputs.labels ?? '');
  const requiredValues = new Map([
    [
      'org.opencontainers.image.source',
      '${{ github.server_url }}/${{ github.repository }}',
    ],
    ['org.opencontainers.image.revision', shaExpression],
    ['org.opencontainers.image.version', `sha-${shaExpression}`],
    [
      'org.opencontainers.image.created',
      '${{ steps.identity.outputs.created }}',
    ],
    ['org.opencontainers.image.title', '${{ steps.identity.outputs.title }}'],
    [
      'org.opencontainers.image.description',
      '${{ steps.identity.outputs.description }}',
    ],
  ]);
  for (const [label, expected] of requiredValues) {
    const entry = labels
      .split('\n')
      .find((line) => line.startsWith(`${label}=`));
    if (entry !== `${label}=${expected}`)
      failures.push(`${location} label ${label} must equal ${expected}.`);
  }
  for (const label of OCI_LABELS) {
    if (
      labels.split('\n').filter((line) => line.startsWith(`${label}=`))
        .length !== 1
    ) {
      failures.push(`${location} must define ${label} exactly once.`);
    }
  }
  return failures;
}

function validatePinnedActions(jobs) {
  const failures = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of stepsFor(job)) {
      const reference = actionReference(step);
      if (!reference) continue;
      const approved = ACTIONS.get(reference.action);
      if (!approved) {
        failures.push(`${jobName} uses unapproved Action ${reference.action}.`);
      } else if (
        !FULL_SHA.test(reference.sha) ||
        reference.sha !== approved.sha
      ) {
        failures.push(
          `${reference.action} must use ${approved.sha} (${approved.version}).`,
        );
      }
    }
  }
  return failures;
}

function configuredEvents(workflow) {
  if (
    !workflow?.on ||
    typeof workflow.on !== 'object' ||
    Array.isArray(workflow.on)
  ) {
    return null;
  }
  return Object.keys(workflow.on).sort();
}

function containsRegistryCapability(job) {
  return stepsFor(job).some((step) => {
    const action = actionReference(step)?.action ?? '';
    const run = String(step.run ?? '');
    return (
      action === 'docker/login-action' ||
      /\bdocker\s+(?:login|push)\b/iu.test(run) ||
      /\b(?:buildx\s+imagetools\s+create|docker\s+manifest\s+(?:create|push)|oras\s+push)\b/iu.test(
        run,
      ) ||
      (action === 'docker/build-push-action' && step.with?.push === true)
    );
  });
}

function containsDeploymentCapability(job) {
  return stepsFor(job).some((step) => {
    const action = actionReference(step)?.action ?? '';
    const run = String(step.run ?? '');
    return (
      /(?:deploy|ssh-action|scp-action|vercel-action)/iu.test(action) ||
      /\b(?:ssh|scp|rsync|vercel|kubectl|helm)\b|deploy(?:ment)?|webhook|docker\s+(?:compose|service)\s+(?:up|restart|update)/iu.test(
        run,
      )
    );
  });
}

function validateAutomaticWorkflowDocument(workflow) {
  const failures = [];
  const events = configuredEvents(workflow);
  if (
    JSON.stringify(events) !==
    JSON.stringify(['pull_request', 'push', 'workflow_dispatch'])
  ) {
    failures.push(
      'automatic CI must define only pull_request, push, and workflow_dispatch events.',
    );
  }
  for (const event of ['pull_request', 'push']) {
    const branches = workflow?.on?.[event]?.branches;
    if (
      !Array.isArray(branches) ||
      branches.length !== 1 ||
      branches[0] !== 'main'
    ) {
      failures.push(`${event} must target only main.`);
    }
  }
  failures.push(
    ...permissionFailures(
      workflow?.permissions,
      { contents: 'read' },
      'global',
    ),
  );
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    failures.push('automatic CI jobs must be a mapping.');
    return failures;
  }
  if (
    JSON.stringify(Object.keys(jobs).sort()) !==
    JSON.stringify(['build-and-scan', 'validate'])
  ) {
    failures.push(
      'automatic CI must contain exactly validate and build-and-scan jobs.',
    );
  }
  const validate = jobs.validate ?? {};
  const build = jobs['build-and-scan'] ?? {};
  failures.push(...jobEnvironmentContextFailures(jobs));
  for (const [name, job] of Object.entries({
    validate,
    'build-and-scan': build,
  })) {
    if (job['runs-on'] !== 'ubuntu-24.04')
      failures.push(`${name} must use ubuntu-24.04.`);
    failures.push(
      ...permissionFailures(job.permissions, { contents: 'read' }, name),
    );
    if (Object.hasOwn(job, 'uses')) {
      failures.push(`${name} must not call a reusable workflow.`);
    }
    if (containsRegistryCapability(job)) {
      failures.push(
        `${name} must have no registry login or publication capability.`,
      );
    }
    if (containsDeploymentCapability(job)) {
      failures.push(`${name} must have no deployment capability.`);
    }
  }
  if (build.needs !== 'validate')
    failures.push('build-and-scan must need validate.');
  if (normalizeExpression(validate.if) !== '') {
    failures.push('validate must run for every configured automatic CI event.');
  }
  if (normalizeExpression(build.if) !== '') {
    failures.push(
      'build-and-scan must run after validation for every configured CI event.',
    );
  }

  const validateSteps = stepsFor(validate);
  failures.push(...syntheticProductionFailures(validate));
  const requiredValidationCommands = [
    'npm run task:contracts',
    'npm run format:check:task-tools',
    'npm run test:task-tools',
    'node scripts/validate-project-memory.cjs --mode local',
    'node --test test/project-memory/project-memory.test.cjs',
    'npm run ci:contract:validate',
    'npm run format:check:ci',
    'npm run test:ci',
    'npm run format:check:production',
    'npm run production:compose:validate',
    'npm run test:production',
    'npm run recovery:validate',
    'npm run format:check:recovery',
    'sudo env "PATH=$PATH" npm run test:recovery',
    'npm run test:recovery:integration',
    'npm run format:check',
    'npm run lint',
    'npm run build',
    'npm run test -- --runInBand',
    'npm run test:e2e -- --runInBand',
    'npm run test:integration',
  ];
  const validateRuns = validateSteps.map((step) =>
    String(step.run ?? '').trim(),
  );
  for (const command of requiredValidationCommands) {
    if (!validateRuns.includes(command)) {
      failures.push(`validate is missing exact command: ${command}.`);
    }
  }

  failures.push(...buildFailures(build, 'build-and-scan'));
  failures.push(...metadataFailures(build, 'build-and-scan'));
  const buildSteps = stepsFor(build);
  const scans = buildSteps.filter(
    (step) => actionReference(step)?.action === 'aquasecurity/trivy-action',
  );
  if (scans.length !== 1) {
    failures.push(
      'build-and-scan must contain exactly one blocking Trivy scan.',
    );
  } else {
    failures.push(...trivyFailures(scans[0], 'build-and-scan'));
  }
  const buildIndex = stepIndex(
    build,
    (step) => actionReference(step)?.action === 'docker/build-push-action',
  );
  const runtimeIndex = stepIndex(
    build,
    (step) =>
      String(step.run ?? '').trim() ===
      'node --test test/production/production-image.test.cjs',
  );
  const scanIndex = buildSteps.indexOf(scans[0]);
  if (!(
    buildIndex >= 0 &&
    buildIndex < runtimeIndex &&
    runtimeIndex < scanIndex
  )) {
    failures.push(
      'automatic image build, runtime validation, and scan order is invalid.',
    );
  }
  const buildAction = buildSteps.find(
    (step) => actionReference(step)?.action === 'docker/build-push-action',
  );
  if (buildAction?.with?.push !== false || buildAction?.with?.load !== true) {
    failures.push('automatic build must load locally with push false.');
  }
  if (!String(build?.env?.IMAGE_REF ?? '').endsWith(':sha-${{ github.sha }}')) {
    failures.push(
      'automatic image reference must use the full github.sha tag.',
    );
  }
  failures.push(...validatePinnedActions(jobs));
  return [...new Set(failures)].sort();
}

function validateManualReleaseDocument(workflow) {
  const failures = [];
  const events = configuredEvents(workflow);
  if (JSON.stringify(events) !== JSON.stringify(['workflow_dispatch'])) {
    failures.push(
      'manual release must be triggered only by workflow_dispatch.',
    );
  }
  const inputs = workflow?.on?.workflow_dispatch?.inputs;
  if (
    !inputs ||
    inputs.full_sha?.required !== true ||
    inputs.full_sha?.type !== 'string'
  ) {
    failures.push('manual release must require a full_sha string input.');
  }
  if (
    inputs?.confirm_release?.required !== true ||
    inputs?.confirm_release?.type !== 'boolean'
  ) {
    failures.push('manual release must require explicit boolean confirmation.');
  }
  failures.push(
    ...permissionFailures(
      workflow?.permissions,
      { contents: 'read' },
      'global',
    ),
  );
  if (
    workflow?.concurrency?.group !==
      'manual-image-release-${{ inputs.full_sha }}' ||
    workflow?.concurrency?.['cancel-in-progress'] !== false
  ) {
    failures.push(
      'manual release must serialize runs for the same full SHA without cancellation.',
    );
  }
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    failures.push('manual release jobs must be a mapping.');
    return failures;
  }
  if (JSON.stringify(Object.keys(jobs)) !== JSON.stringify(['publish-image'])) {
    failures.push('manual release must contain exactly one publish-image job.');
  }
  const publish = jobs['publish-image'] ?? {};
  failures.push(
    ...permissionFailures(
      publish.permissions,
      { contents: 'read', packages: 'write' },
      'publish-image',
    ),
  );
  for (const [jobName, job] of Object.entries(jobs)) {
    if (jobName !== 'publish-image' && job?.permissions?.packages === 'write') {
      failures.push('packages write must be isolated to publish-image.');
    }
  }
  if (publish.environment !== 'ghcr-production-release') {
    failures.push(
      'publish-image must reference ghcr-production-release Environment.',
    );
  }
  if (publish['runs-on'] !== 'ubuntu-24.04') {
    failures.push('publish-image must use ubuntu-24.04.');
  }
  if (Object.hasOwn(publish, 'uses')) {
    failures.push('manual release must not delegate to another workflow.');
  }
  if (
    publish.env?.RELEASE_ENABLED !== '${{ vars.MANUAL_IMAGE_RELEASE_ENABLED }}'
  ) {
    failures.push(
      'manual release must read MANUAL_IMAGE_RELEASE_ENABLED from Environment vars.',
    );
  }
  if (publish.env?.REQUESTED_SHA !== '${{ inputs.full_sha }}') {
    failures.push('manual release must bind REQUESTED_SHA to full_sha.');
  }
  if (
    publish.env?.IMAGE_TAG !== 'sha-${{ inputs.full_sha }}' ||
    !String(publish.env?.IMAGE_REF ?? '').endsWith(
      ':sha-${{ inputs.full_sha }}',
    )
  ) {
    failures.push('manual release must use only the immutable full SHA tag.');
  }

  const steps = stepsFor(publish);
  const authorize = steps.find((step) => step.id === 'authorize');
  const authorizeRun = String(authorize?.run ?? '');
  if (
    !authorize ||
    authorize['working-directory'] !== 'image-source' ||
    authorize.env?.CONFIRM_RELEASE !== '${{ inputs.confirm_release }}' ||
    !/"\$CONFIRM_RELEASE" != 'true'/u.test(authorizeRun) ||
    !/"\$RELEASE_ENABLED" != 'true'/u.test(authorizeRun) ||
    !/\^\[a-f0-9\]\{40\}\$/u.test(authorizeRun) ||
    !/git cat-file -e "\$REQUESTED_SHA\^\{commit\}"/u.test(authorizeRun) ||
    !/git merge-base --is-ancestor "\$REQUESTED_SHA" refs\/remotes\/origin\/main/u.test(
      authorizeRun,
    ) ||
    !/resolved_sha=.*git rev-parse/u.test(authorizeRun) ||
    !/"\$resolved_sha" != "\$REQUESTED_SHA"/u.test(authorizeRun)
  ) {
    failures.push(
      'authorization must fail closed on confirmation, enablement, full SHA, commit, and main ancestry.',
    );
  }
  const checkouts = steps.filter(
    (step) => actionReference(step)?.action === 'actions/checkout',
  );
  if (
    checkouts.length !== 2 ||
    checkouts[0]?.with?.ref !== '${{ github.workflow_sha }}' ||
    checkouts[0]?.with?.path !== 'release-control' ||
    checkouts[0]?.with?.['fetch-depth'] !== 1 ||
    checkouts[0]?.with?.['persist-credentials'] !== false ||
    checkouts[1]?.with?.ref !== 'main' ||
    checkouts[1]?.with?.path !== 'image-source' ||
    checkouts[1]?.with?.['fetch-depth'] !== 0 ||
    checkouts[1]?.with?.['persist-credentials'] !== false
  ) {
    failures.push(
      'manual release must isolate workflow-revision tooling from main image source history in two credential-free checkout paths.',
    );
  }
  const toolingIdentity = steps.find(
    (step) =>
      String(step.name ?? '') === 'Verify release control tooling identity',
  );
  const toolingIdentityRun = String(toolingIdentity?.run ?? '');
  if (
    toolingIdentity?.['working-directory'] !== 'release-control' ||
    toolingIdentity?.env?.EXPECTED_WORKFLOW_SHA !==
      '${{ github.workflow_sha }}' ||
    !/git rev-parse HEAD/u.test(toolingIdentityRun) ||
    !/"\$tooling_sha" != "\$EXPECTED_WORKFLOW_SHA"/u.test(toolingIdentityRun) ||
    !/\[ ! -f scripts\/inspect-release-tag\.cjs \]/u.test(toolingIdentityRun)
  ) {
    failures.push(
      'manual release must bind available release inspection tooling to the exact workflow revision.',
    );
  }
  const sourceSelection = steps.find(
    (step) =>
      String(step.name ?? '') === 'Select the exact authorized image source',
  );
  const sourceSelectionRun = String(sourceSelection?.run ?? '');
  if (
    sourceSelection?.['working-directory'] !== 'image-source' ||
    sourceSelection?.env?.AUTHORIZED_SHA !==
      '${{ steps.authorize.outputs.sha }}' ||
    !/git checkout --detach "\$AUTHORIZED_SHA"/u.test(sourceSelectionRun)
  ) {
    failures.push(
      'manual release must select the authorized full SHA only inside the isolated image source checkout.',
    );
  }
  const exactCheckout = steps.find(
    (step) => String(step.name ?? '') === 'Verify exact checkout identity',
  );
  if (
    exactCheckout?.['working-directory'] !== 'image-source' ||
    !/git rev-parse HEAD/u.test(String(exactCheckout?.run ?? '')) ||
    !/"\$checked_out_sha" != "\$REQUESTED_SHA"/u.test(
      String(exactCheckout?.run ?? ''),
    )
  ) {
    failures.push(
      'manual release must verify HEAD remains the requested SHA after checkout.',
    );
  }
  const identity = steps.find((step) => step.id === 'identity');
  if (
    identity?.['working-directory'] !== 'image-source' ||
    !/git show -s --format=%cI "\$REQUESTED_SHA"/u.test(
      String(identity?.run ?? ''),
    ) ||
    /new Date/u.test(String(identity?.run ?? ''))
  ) {
    failures.push(
      'manual release metadata time must derive from the requested commit, not the workflow clock.',
    );
  }

  failures.push(...buildFailures(publish, 'publish-image'));
  failures.push(
    ...metadataFailures(publish, 'publish-image', '${{ inputs.full_sha }}'),
  );
  const buildIndex = stepIndex(
    publish,
    (step) => actionReference(step)?.action === 'docker/build-push-action',
  );
  const runtimeIndex = stepIndex(
    publish,
    (step) =>
      String(step.run ?? '').trim() ===
      'node --test test/production/production-image.test.cjs',
  );
  const scanIndex = stepIndex(
    publish,
    (step) => actionReference(step)?.action === 'aquasecurity/trivy-action',
  );
  const loginIndex = stepIndex(
    publish,
    (step) => actionReference(step)?.action === 'docker/login-action',
  );
  const pushIndex = stepIndex(publish, (step) =>
    /\bdocker\s+push\b/u.test(String(step.run ?? '')),
  );
  const existence = steps.find((step) => step.id === 'existence');
  const existenceIndex = steps.indexOf(existence);
  const selected = steps.find((step) => step.id === 'selected');
  const selectedIndex = steps.indexOf(selected);
  const verifyIndex = steps.findIndex((step) => step.id === 'verify');
  if (!(
    buildIndex >= 0 &&
    buildIndex < runtimeIndex &&
    runtimeIndex < scanIndex &&
    scanIndex < loginIndex &&
    loginIndex < existenceIndex &&
    existenceIndex < pushIndex &&
    pushIndex < selectedIndex &&
    selectedIndex < verifyIndex
  )) {
    failures.push(
      'build, runtime validation, scan, login, immutable lookup, conditional push, selection, and digest verification order is invalid.',
    );
  }
  if (!(
    steps.indexOf(authorize) >= 0 && steps.indexOf(authorize) < loginIndex
  )) {
    failures.push(
      'all fail-closed authorization checks must precede registry login.',
    );
  }
  const scan = steps[scanIndex];
  if (scan) failures.push(...trivyFailures(scan, 'publish-image'));
  const build = steps[buildIndex];
  if (
    build?.with?.context !== './image-source' ||
    build?.with?.push !== false ||
    build?.with?.load !== true
  ) {
    failures.push(
      'manual release must build only the isolated image source and load locally with push false before login.',
    );
  }
  const runtime = steps[runtimeIndex];
  if (runtime?.['working-directory'] !== 'image-source') {
    failures.push(
      'manual release runtime validation must execute only from the isolated image source.',
    );
  }
  const login = steps[loginIndex];
  if (
    login?.with?.registry !== 'ghcr.io' ||
    login?.with?.username !== '${{ github.actor }}' ||
    login?.with?.password !== '${{ secrets.GITHUB_TOKEN }}'
  ) {
    failures.push(
      'manual release login must use only github.actor and GITHUB_TOKEN for GHCR.',
    );
  }
  const existenceRun = String(existence?.run ?? '');
  if (
    existence?.env?.EXPECTED_LOCAL_CONFIG_DIGEST !==
      '${{ steps.local.outputs.config_digest }}' ||
    !/imagetools inspect "\$IMAGE_REF" --format '\{\{json \.Manifest\}\}'/u.test(
      existenceRun,
    ) ||
    !/imagetools inspect "\$IMAGE_REF" --raw/u.test(existenceRun) ||
    !/--format '\{\{json \.Image\}\}'/u.test(existenceRun) ||
    !existenceRun.includes(
      '> "${{ runner.temp }}/existing-descriptor.json" 2> "${{ runner.temp }}/existing-error.txt"',
    ) ||
    !existenceRun.includes(
      'node release-control/scripts/inspect-release-tag.cjs inspect "$lookup_status"',
    ) ||
    !/TAG_AVAILABLE/u.test(existenceRun) ||
    !/state=TAG_AVAILABLE/u.test(existenceRun) ||
    !/if \[ "\$inspection_status" -ne 0 \]; then\s+exit "\$inspection_status"/u.test(
      existenceRun,
    ) ||
    /<<-?\s*['"]?[A-Za-z_]/u.test(existenceRun) ||
    /grep\s+-[^\n]*[iE][^\n]*manifest unknown/iu.test(existenceRun) ||
    /\bdocker\s+push\b/u.test(existenceRun)
  ) {
    failures.push(
      'existing full-SHA tag must be classified by the versioned inspection script without inline heredoc or registry mutation.',
    );
  }
  const push = steps[pushIndex];
  const pushRun = String(push?.run ?? '');
  if (
    push?.id !== 'push' ||
    normalizeExpression(push?.if) !==
      "steps.existence.outputs.state == 'TAG_AVAILABLE'" ||
    !/imagetools inspect "\$IMAGE_REF"/u.test(pushRun) ||
    !pushRun.includes(
      '> "${{ runner.temp }}/prepush-output.txt" 2> "${{ runner.temp }}/prepush-error.txt"',
    ) ||
    pushRun.includes('/dev/null') ||
    !pushRun.includes(
      'node release-control/scripts/inspect-release-tag.cjs availability "$prepush_status"',
    ) ||
    !/TAG_AVAILABLE/u.test(pushRun) ||
    !/if \[ "\$availability_status" -ne 0 \]; then\s+exit "\$availability_status"/u.test(
      pushRun,
    ) ||
    /grep\s+-[^\n]*[iE][^\n]*manifest unknown/iu.test(pushRun) ||
    !/docker push "\$IMAGE_REF"/u.test(pushRun) ||
    !/pushed_digests/u.test(pushRun) ||
    !/digest=\$digest/u.test(pushRun) ||
    !/immutable_ref=\$IMAGE_REPOSITORY@\$digest/u.test(pushRun)
  ) {
    failures.push(
      'manual release must perform exactly one guarded push only after definitive tag absence and capture its digest.',
    );
  }
  const pushSteps = steps.filter((step) =>
    /\bdocker\s+push\b/u.test(String(step.run ?? '')),
  );
  if (pushSteps.length !== 1) {
    failures.push(
      'manual release must contain exactly one conditional image push.',
    );
  }
  const tagInspectionCalls = steps.reduce(
    (count, step) =>
      count +
      (String(step.run ?? '').match(
        /node release-control\/scripts\/inspect-release-tag\.cjs (?:inspect|availability)/gu,
      )?.length ?? 0),
    0,
  );
  if (tagInspectionCalls !== 2) {
    failures.push(
      'manual release must apply the versioned fail-closed tag classifier exactly once in each registry lookup.',
    );
  }
  const selectedRun = String(selected?.run ?? '');
  if (
    selected?.env?.TAG_STATE !== '${{ steps.existence.outputs.state }}' ||
    selected?.env?.PUSHED_DIGEST !== '${{ steps.push.outputs.digest }}' ||
    selected?.env?.PUSHED_IMMUTABLE_REF !==
      '${{ steps.push.outputs.immutable_ref }}' ||
    !/"\$TAG_STATE" != 'TAG_AVAILABLE'/u.test(selectedRun) ||
    !/digest="\$PUSHED_DIGEST"/u.test(selectedRun) ||
    !/immutable_ref/u.test(selectedRun)
  ) {
    failures.push(
      'manual release must select only the single digest pushed after TAG_AVAILABLE.',
    );
  }
  const verify = steps[verifyIndex];
  const verifyRun = String(verify?.run ?? '');
  if (
    verify?.env?.EXPECTED_DIGEST !== '${{ steps.selected.outputs.digest }}' ||
    verify?.env?.IMMUTABLE_REF !==
      '${{ steps.selected.outputs.immutable_ref }}' ||
    !/imagetools inspect "\$IMMUTABLE_REF"/u.test(verifyRun) ||
    !/manifestDigest !== process\.env\.EXPECTED_DIGEST/u.test(verifyRun) ||
    !/configDigest !== process\.env\.EXPECTED_CONFIG_DIGEST/u.test(verifyRun) ||
    !/immutable registry reference mismatch/u.test(verifyRun)
  ) {
    failures.push(
      'manual release must reinspect and verify the selected manifest and config digests.',
    );
  }
  const evidence = steps.find((step) => step.id === 'evidence');
  const evidenceRun = String(evidence?.run ?? '');
  for (const field of [
    'IMAGE_PUBLISHED_AND_DIGEST_VERIFIED',
    'repository:',
    'commitSha:',
    'tag:',
    'manifestDigest:',
    'actor:',
    'workflowRun:',
    'recordedAt:',
    'scan:',
  ]) {
    if (!evidenceRun.includes(field))
      failures.push(`release evidence is missing ${field}.`);
  }
  const artifact = steps.find(
    (step) => actionReference(step)?.action === 'actions/upload-artifact',
  );
  if (
    artifact?.with?.path !== 'image-release-identity.json' ||
    artifact?.with?.['if-no-files-found'] !== 'error' ||
    artifact?.with?.['retention-days'] !== 14
  ) {
    failures.push(
      'manual release evidence artifact must fail closed and retain for 14 days.',
    );
  }
  if (containsDeploymentCapability(publish)) {
    failures.push(
      'manual image release must contain no deployment capability.',
    );
  }
  if (
    steps.some((step) =>
      /\b(?:migration|fixture|traefik)\b/iu.test(String(step.run ?? '')),
    )
  ) {
    failures.push(
      'manual image release must contain no deployment capability.',
    );
  }
  if (/\b(?:latest|main)\b/u.test(String(publish.env?.IMAGE_TAG ?? ''))) {
    failures.push(
      'manual release must not use latest or another mutable operational tag.',
    );
  }
  failures.push(...validatePinnedActions(jobs));
  return [...new Set(failures)].sort();
}

function validateWorkflowDocument(workflow) {
  return validateAutomaticWorkflowDocument(workflow);
}
function validateWorkflowSource(source) {
  let workflow;
  try {
    workflow = parseYamlSubset(source);
  } catch (error) {
    throw new WorkflowContractError([
      `workflow YAML could not be parsed: ${error.message}`,
    ]);
  }
  const failures = validateWorkflowDocument(workflow);
  if (failures.length > 0) throw new WorkflowContractError(failures);
  return workflow;
}

function resolveBashExecutable({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env.GENESIS_BASH_PATH) return env.GENESIS_BASH_PATH;
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    const candidates = [
      join(programFiles, 'Git', 'bin', 'bash.exe'),
      join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    ];
    const available = candidates.find((candidate) => existsSync(candidate));
    if (available) return available;
  }
  return 'bash';
}

function shellSourceForSyntaxCheck(source) {
  return source.replace(/\$\{\{[\s\S]*?\}\}/gu, '__GITHUB_EXPRESSION__');
}

function validateReleaseRunShellSyntax(workflow, options = {}) {
  const failures = [];
  const bash = options.bash ?? resolveBashExecutable(options);
  for (const step of stepsFor(workflow?.jobs?.['publish-image'])) {
    if (typeof step.run !== 'string') continue;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-n'], {
      input: shellSourceForSyntaxCheck(step.run),
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) {
      failures.push(
        `release shell syntax could not be checked for ${step.name ?? step.id ?? 'unnamed step'}: ${result.error.code ?? 'spawn failed'}.`,
      );
      continue;
    }
    if (result.status !== 0) {
      const diagnostic = String(result.stderr ?? '')
        .split(/\r?\n/u)
        .find((line) => line.trim().length > 0);
      failures.push(
        `release shell syntax is invalid for ${step.name ?? step.id ?? 'unnamed step'}${diagnostic ? `: ${diagnostic.trim()}` : ''}.`,
      );
    }
  }
  return failures;
}

function validateReleaseWorkflowSource(source) {
  let workflow;
  try {
    workflow = parseYamlSubset(source);
  } catch (error) {
    throw new WorkflowContractError([
      `release workflow YAML could not be parsed: ${error.message}`,
    ]);
  }
  const failures = [
    ...validateManualReleaseDocument(workflow),
    ...validateReleaseRunShellSyntax(workflow),
  ];
  if (failures.length > 0) throw new WorkflowContractError(failures);
  return workflow;
}

function validateWorkflowFile({
  cwd = process.cwd(),
  path = WORKFLOW_PATH,
} = {}) {
  return validateWorkflowSource(
    readFileSync(join(cwd, ...path.split('/')), 'utf8'),
  );
}

function validateReleaseWorkflowFile({
  cwd = process.cwd(),
  path = RELEASE_WORKFLOW_PATH,
} = {}) {
  return validateReleaseWorkflowSource(
    readFileSync(join(cwd, ...path.split('/')), 'utf8'),
  );
}

function main() {
  try {
    validateWorkflowFile();
    validateReleaseWorkflowFile();
    console.log(`CI workflow contract passed: ${WORKFLOW_PATH}`);
    console.log(`Manual release contract passed: ${RELEASE_WORKFLOW_PATH}`);
  } catch (error) {
    for (const failure of error.failures ?? [error.message])
      console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  }
}

function classifyManifestAbsenceCli(args) {
  if (args.length !== 4 || args[0] !== '1') {
    process.exitCode = 2;
    return;
  }
  let stdout;
  let stderr;
  try {
    stdout = readFileSync(args[1], 'utf8');
    stderr = readFileSync(args[2], 'utf8');
  } catch {
    process.exitCode = 2;
    return;
  }
  process.exitCode = isDefinitiveManifestAbsence({
    status: 1,
    stdout,
    stderr,
    expectedImageRef: args[3],
  })
    ? 0
    : 1;
}

if (require.main === module) {
  if (process.argv[2] === '--classify-manifest-absence') {
    classifyManifestAbsenceCli(process.argv.slice(3));
  } else {
    main();
  }
}

module.exports = {
  ACTIONS,
  OCI_LABELS,
  SYNTHETIC_ENV_MATRIX,
  SYNTHETIC_PATH_ENV,
  SYNTHETIC_SECRET_FILES,
  RELEASE_WORKFLOW_PATH,
  WORKFLOW_PATH,
  WorkflowContractError,
  isDefinitiveManifestAbsence,
  parseYamlSubset,
  validateAutomaticWorkflowDocument,
  validateManualReleaseDocument,
  validateReleaseRunShellSyntax,
  validateReleaseWorkflowFile,
  validateReleaseWorkflowSource,
  validateWorkflowDocument,
  validateWorkflowFile,
  validateWorkflowSource,
};
