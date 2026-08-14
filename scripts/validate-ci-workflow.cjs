const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const FULL_SHA = /^[a-f0-9]{40}$/u;
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
  'ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659';
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

function metadataFailures(job, location) {
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
  if (String(inputs.tags).trim() !== 'type=raw,value=sha-${{ github.sha }}') {
    failures.push(`${location} must define only the full-SHA tag.`);
  }
  const labels = String(inputs.labels ?? '');
  const requiredValues = new Map([
    [
      'org.opencontainers.image.source',
      '${{ github.server_url }}/${{ github.repository }}',
    ],
    ['org.opencontainers.image.revision', '${{ github.sha }}'],
    ['org.opencontainers.image.version', 'sha-${{ github.sha }}'],
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

function validateWorkflowDocument(workflow) {
  const failures = [];
  const triggers = workflow?.on;
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) {
    failures.push('workflow triggers must be a mapping.');
  } else {
    const eventNames = Object.keys(triggers).sort();
    if (
      JSON.stringify(eventNames) !==
      JSON.stringify(['pull_request', 'push', 'workflow_dispatch'])
    ) {
      failures.push(
        'workflow must define only pull_request, push, and workflow_dispatch events.',
      );
    }
    for (const event of ['pull_request', 'push']) {
      const branches = triggers[event]?.branches;
      if (
        !Array.isArray(branches) ||
        branches.length !== 1 ||
        branches[0] !== 'main'
      ) {
        failures.push(`${event} must target only main.`);
      }
    }
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
    "ci-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}"
  ) {
    failures.push(
      'concurrency must group PRs by number and push/manual runs by unique run ID.',
    );
  }
  if (
    normalizeExpression(workflow?.concurrency?.['cancel-in-progress']) !==
    "github.event_name == 'pull_request'"
  ) {
    failures.push('only pull request runs may be cancelled in progress.');
  }

  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    failures.push('jobs must be a mapping.');
    return failures;
  }
  if (
    JSON.stringify(Object.keys(jobs).sort()) !==
    JSON.stringify([
      'build-and-scan',
      'image-impact',
      'publish-image',
      'validate',
    ])
  ) {
    failures.push(
      'workflow must contain exactly validate, image-impact, build-and-scan, and publish-image jobs.',
    );
  }
  const validate = jobs.validate ?? {};
  const imageImpact = jobs['image-impact'] ?? {};
  const build = jobs['build-and-scan'] ?? {};
  const publish = jobs['publish-image'] ?? {};
  failures.push(...jobEnvironmentContextFailures(jobs));
  for (const [name, job] of Object.entries({
    validate,
    'image-impact': imageImpact,
    'build-and-scan': build,
    'publish-image': publish,
  })) {
    if (job['runs-on'] !== 'ubuntu-24.04')
      failures.push(`${name} must use ubuntu-24.04.`);
  }
  failures.push(
    ...permissionFailures(
      validate.permissions,
      { contents: 'read' },
      'validate',
    ),
  );
  failures.push(
    ...permissionFailures(
      imageImpact.permissions,
      { contents: 'read' },
      'image-impact',
    ),
  );
  failures.push(
    ...permissionFailures(
      build.permissions,
      { contents: 'read' },
      'build-and-scan',
    ),
  );
  failures.push(
    ...permissionFailures(
      publish.permissions,
      { contents: 'read', packages: 'write' },
      'publish-image',
    ),
  );
  if (build.needs !== 'validate')
    failures.push('build-and-scan must need validate.');
  if (normalizeExpression(validate.if) !== '') {
    failures.push('validate must run for every configured workflow event.');
  }
  if (
    !Array.isArray(publish.needs) ||
    JSON.stringify([...publish.needs].sort()) !==
      JSON.stringify(['image-impact', 'validate'])
  ) {
    failures.push('publish-image must need validate and image-impact.');
  }
  const imageImpactCondition = normalizeExpression(imageImpact.if);
  if (
    imageImpactCondition !==
    "github.event_name == 'push' && github.ref == 'refs/heads/main'"
  ) {
    failures.push('image-impact must run only for push of refs/heads/main.');
  }
  const buildCondition = normalizeExpression(build.if);
  if (
    buildCondition !==
    "github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'"
  ) {
    failures.push(
      'build-and-scan must run only for pull_request or workflow_dispatch.',
    );
  }
  const publishCondition = normalizeExpression(publish.if);
  if (
    publishCondition !==
    "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.validate.result == 'success' && needs.image-impact.result == 'success' && needs.image-impact.outputs.should_publish == 'true'"
  ) {
    failures.push(
      'publish-image must require push of main, successful validation and detection, and canonical true image impact.',
    );
  }

  const imageImpactSteps = stepsFor(imageImpact);
  const imageImpactCheckouts = imageImpactSteps.filter(
    (step) => actionReference(step)?.action === 'actions/checkout',
  );
  if (
    imageImpactCheckouts.length !== 1 ||
    Number(imageImpactCheckouts[0]?.with?.['fetch-depth']) !== 0 ||
    imageImpactCheckouts[0]?.with?.['persist-credentials'] !== false
  ) {
    failures.push(
      'image-impact must use one pinned checkout with complete history and no persisted credential.',
    );
  }
  const imageImpactSetups = imageImpactSteps.filter(
    (step) => actionReference(step)?.action === 'actions/setup-node',
  );
  if (
    imageImpactSetups.length !== 1 ||
    imageImpactSetups[0]?.with?.['node-version-file'] !== '.nvmrc'
  ) {
    failures.push('image-impact must use the pinned project Node.js runtime.');
  }
  const detector = imageImpactSteps.find((step) => step.id === 'detect');
  if (
    imageImpactSteps.length !== 3 ||
    imageImpactSteps[0] !== imageImpactCheckouts[0] ||
    imageImpactSteps[1] !== imageImpactSetups[0] ||
    imageImpactSteps[2] !== detector ||
    !detector ||
    String(detector.run ?? '').trim() !==
      'node scripts/detect-image-impact.cjs --base "$IMAGE_IMPACT_BASE_SHA" --head "$IMAGE_IMPACT_HEAD_SHA"' ||
    detector.env?.IMAGE_IMPACT_BASE_SHA !== '${{ github.event.before }}' ||
    detector.env?.IMAGE_IMPACT_HEAD_SHA !== '${{ github.sha }}' ||
    Object.hasOwn(detector, 'continue-on-error')
  ) {
    failures.push(
      'image-impact must invoke the fail-closed detector with the exact push endpoints.',
    );
  }
  if (
    !imageImpact.outputs ||
    typeof imageImpact.outputs !== 'object' ||
    Array.isArray(imageImpact.outputs) ||
    JSON.stringify(imageImpact.outputs) !==
      JSON.stringify({
        should_publish: '${{ steps.detect.outputs.should_publish }}',
      })
  ) {
    failures.push(
      'image-impact must expose only the canonical detector boolean.',
    );
  }
  if (
    Object.hasOwn(imageImpact, 'continue-on-error') ||
    imageImpactSteps.some(
      (step) =>
        actionReference(step)?.action.startsWith('docker/') ||
        /\bdocker\s+(?:build|login|push)\b/u.test(String(step.run ?? '')) ||
        /secrets\.|GITHUB_TOKEN|ghcr\.io/iu.test(JSON.stringify(step)),
    )
  ) {
    failures.push(
      'image-impact must not continue on error, use registry credentials, build, login, or publish.',
    );
  }

  const validateSteps = stepsFor(validate);
  failures.push(...syntheticProductionFailures(validate));
  if (
    validateSteps.some((step) =>
      actionReference(step)?.action.startsWith('docker/'),
    )
  ) {
    failures.push('validate must not use Docker actions.');
  }
  if (
    validateSteps.some((step) =>
      /\bdocker\s+(?:build|login|push)\b/u.test(String(step.run ?? '')),
    )
  ) {
    failures.push(
      'validate must not build, authenticate, or publish an image.',
    );
  }
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
    if (!validateRuns.includes(command))
      failures.push(`validate is missing exact command: ${command}.`);
  }
  const memoryValidationIndex = validateRuns.indexOf(
    'node scripts/validate-project-memory.cjs --mode local',
  );
  const memoryTestsIndex = validateRuns.indexOf(
    'node --test test/project-memory/project-memory.test.cjs',
  );
  const ciContractIndex = validateRuns.indexOf('npm run ci:contract:validate');
  if (
    memoryValidationIndex < 0 ||
    memoryTestsIndex !== memoryValidationIndex + 1 ||
    ciContractIndex <= memoryTestsIndex
  ) {
    failures.push(
      'canonical memory validation and tests must run consecutively before the CI contract.',
    );
  }
  const composeStep = validateSteps.find(
    (step) =>
      String(step.run ?? '').trim() === 'npm run production:compose:validate',
  );
  if (!composeStep) {
    failures.push('Compose validation step is missing.');
  }

  failures.push(...buildFailures(build, 'build-and-scan'));
  failures.push(...buildFailures(publish, 'publish-image'));
  failures.push(...metadataFailures(build, 'build-and-scan'));
  failures.push(...metadataFailures(publish, 'publish-image'));

  const buildScans = stepsFor(build).filter(
    (step) => actionReference(step)?.action === 'aquasecurity/trivy-action',
  );
  if (buildScans.length !== 1)
    failures.push('build-and-scan must contain exactly one Trivy step.');
  failures.push(...trivyFailures(buildScans[0], 'build-and-scan'));
  const buildRuntimeSteps = stepsFor(build).filter(
    (step) =>
      String(step.run ?? '').trim() ===
      'node --test test/production/production-image.test.cjs',
  );
  if (
    buildRuntimeSteps.length !== 1 ||
    buildRuntimeSteps[0]?.env?.PRODUCTION_IMAGE_UNDER_TEST !==
      '${{ env.IMAGE_REF }}'
  ) {
    failures.push(
      'build-and-scan must validate the loaded production runtime exactly once.',
    );
  } else {
    const imageBuildIndex = stepIndex(
      build,
      (step) => actionReference(step)?.action === 'docker/build-push-action',
    );
    const runtimeIndex = stepsFor(build).indexOf(buildRuntimeSteps[0]);
    const scanIndex = stepsFor(build).indexOf(buildScans[0]);
    if (!(imageBuildIndex < runtimeIndex && runtimeIndex < scanIndex)) {
      failures.push(
        'build-and-scan runtime validation must run after build and before Trivy.',
      );
    }
  }
  if (
    stepsFor(build).some(
      (step) => actionReference(step)?.action === 'docker/login-action',
    )
  ) {
    failures.push('build-and-scan must not authenticate to a registry.');
  }
  if (
    stepsFor(build).some((step) =>
      /\bdocker\s+push\b/u.test(String(step.run ?? '')),
    )
  ) {
    failures.push('build-and-scan must not publish an image.');
  }

  const publishSteps = stepsFor(publish);
  const logins = publishSteps.filter(
    (step) => actionReference(step)?.action === 'docker/login-action',
  );
  if (logins.length !== 1)
    failures.push('publish-image must contain exactly one registry login.');
  else {
    const withInputs = logins[0].with ?? {};
    if (
      withInputs.registry !== 'ghcr.io' ||
      withInputs.username !== '${{ github.actor }}' ||
      withInputs.password !== '${{ secrets.GITHUB_TOKEN }}'
    ) {
      failures.push(
        'publish-image login must use only the GitHub actor and GITHUB_TOKEN for ghcr.io.',
      );
    }
  }
  const publishScans = publishSteps.filter(
    (step) => actionReference(step)?.action === 'aquasecurity/trivy-action',
  );
  if (publishScans.length !== 2)
    failures.push(
      'publish-image needs one pre-push local scan and one post-identity remote rescan.',
    );
  for (const [index, step] of publishScans.entries())
    failures.push(...trivyFailures(step, `publish-image scan ${index + 1}`));
  const pushIndexes = publishSteps
    .map((step, index) =>
      /\bdocker\s+push\b/u.test(String(step.run ?? '')) ? index : -1,
    )
    .filter((index) => index >= 0);
  if (pushIndexes.length !== 1)
    failures.push(
      'publish-image must contain exactly one docker push command.',
    );
  const firstPush = pushIndexes[0] ?? -1;
  const buildStep = findStep(
    publish,
    (step) => actionReference(step)?.action === 'docker/build-push-action',
  );
  if (
    normalizeExpression(buildStep?.if) !==
    "steps.existence.outputs.exists == 'false'"
  ) {
    failures.push(
      'publish-image may build only when the immutable tag is absent.',
    );
  }
  const pushStep = publishSteps[firstPush];
  const pushRun = String(pushStep?.run ?? '');
  if (
    pushStep?.id !== 'push' ||
    normalizeExpression(pushStep?.if) !==
      "steps.existence.outputs.exists == 'false'" ||
    !/docker push "\$IMAGE_REF" 2>&1 \| tee/u.test(pushRun) ||
    pushStep?.env?.EXPECTED_LOCAL_CONFIG_DIGEST !==
      '${{ steps.local.outputs.config_digest }}' ||
    !/current_config_digest="\$\(docker image inspect --format '\{\{\.Id\}\}' "\$IMAGE_REF"\)"/u.test(
      pushRun,
    ) ||
    !/"\$current_config_digest" != "\$EXPECTED_LOCAL_CONFIG_DIGEST"/u.test(
      pushRun,
    ) ||
    !/mapfile -t pushed_digests/u.test(pushRun) ||
    !/digest: \(sha256:\[a-f0-9\]\{64\}\)/u.test(pushRun) ||
    !/"\$\{#pushed_digests\[@\]\}" -ne 1/u.test(pushRun) ||
    !/pushed_digest="\$\{pushed_digests\[0\]\}"/u.test(pushRun) ||
    !/immutable_ref="\$IMAGE_REPOSITORY@\$pushed_digest"/u.test(pushRun) ||
    !/echo "digest=\$pushed_digest" >> "\$GITHUB_OUTPUT"/u.test(pushRun) ||
    !/echo "immutable_ref=\$immutable_ref" >> "\$GITHUB_OUTPUT"/u.test(
      pushRun,
    ) ||
    !/echo "config_digest=\$current_config_digest" >> "\$GITHUB_OUTPUT"/u.test(
      pushRun,
    ) ||
    /sha256:[a-f0-9]{64}/u.test(pushRun)
  ) {
    failures.push(
      'publish-image must push only an absent tag and capture exactly one reported digest.',
    );
  }
  const newScan = publishScans.find(
    (step) =>
      normalizeExpression(step.if) ===
      "steps.existence.outputs.exists == 'false'",
  );
  if (
    !newScan ||
    String(newScan.with?.['image-ref']) !== '${{ env.IMAGE_REF }}'
  ) {
    failures.push('new local image must be scanned before publication.');
  }
  const publishRuntimeSteps = publishSteps.filter(
    (step) =>
      String(step.run ?? '').trim() ===
      'node --test test/production/production-image.test.cjs',
  );
  const existingRuntime = publishRuntimeSteps.find(
    (step) =>
      normalizeExpression(step.if) ===
      "steps.existence.outputs.exists == 'true'",
  );
  const newRuntime = publishRuntimeSteps.find(
    (step) =>
      normalizeExpression(step.if) ===
      "steps.existence.outputs.exists == 'false'",
  );
  const pullExisting = publishSteps.find(
    (step) =>
      normalizeExpression(step.if) ===
        "steps.existence.outputs.exists == 'true'" &&
      String(step.run ?? '').trim() ===
        'docker pull "${{ steps.existing.outputs.immutable_ref }}"',
  );
  if (
    publishRuntimeSteps.length !== 2 ||
    existingRuntime?.env?.PRODUCTION_IMAGE_UNDER_TEST !==
      '${{ steps.existing.outputs.immutable_ref }}' ||
    newRuntime?.env?.PRODUCTION_IMAGE_UNDER_TEST !== '${{ env.IMAGE_REF }}' ||
    !pullExisting
  ) {
    failures.push(
      'publish-image must validate both existing and new production runtimes.',
    );
  } else {
    const existingRuntimeIndex = publishSteps.indexOf(existingRuntime);
    const newRuntimeIndex = publishSteps.indexOf(newRuntime);
    const newScanIndex = publishSteps.indexOf(newScan);
    const pullExistingIndex = publishSteps.indexOf(pullExisting);
    if (
      !(pullExistingIndex < existingRuntimeIndex) ||
      !(newRuntimeIndex < newScanIndex) ||
      !(newScanIndex < firstPush) ||
      !(newRuntimeIndex < firstPush)
    ) {
      failures.push(
        'runtime validation and the local Trivy scan must precede image push.',
      );
    }
  }
  const existence = publishSteps.find((step) => step.id === 'existence');
  const existing = publishSteps.find((step) => step.id === 'existing');
  const local = publishSteps.find((step) => step.id === 'local');
  const selected = publishSteps.find((step) => step.id === 'selected');
  const verify = publishSteps.find((step) => step.id === 'verify');
  const packageStep = publishSteps.find((step) => step.id === 'package');
  const remoteScan = publishSteps.find((step) => step.id === 'remote-scan');
  const evidence = publishSteps.find((step) => step.id === 'evidence');
  if (
    !existence ||
    !/imagetools inspect/u.test(String(existence.run ?? '')) ||
    !/manifest unknown|not found|name unknown/u.test(
      String(existence.run ?? ''),
    )
  ) {
    failures.push(
      'publish-image must distinguish an absent tag from ambiguous registry failure.',
    );
  }
  const existingRun = String(existing?.run ?? '');
  if (
    !existing ||
    normalizeExpression(existing.if) !==
      "steps.existence.outputs.exists == 'true'" ||
    !/immutable_ref/u.test(existingRun) ||
    !/--format '\{\{json \.Manifest\}\}'/u.test(existingRun) ||
    !/imagetools inspect "\$IMAGE_REF" --raw/u.test(existingRun) ||
    !/--format '\{\{json \.Image\}\}'/u.test(existingRun) ||
    !/descriptor\?\.digest/u.test(existingRun) ||
    !/manifest\?\.config\?\.digest/u.test(existingRun) ||
    /descriptor\?\.config|descriptor\.config/u.test(existingRun) ||
    /manifest\?\.digest|manifest\.digest/u.test(existingRun) ||
    !/image\?\.os !== 'linux' \|\| image\?\.architecture !== 'amd64'/u.test(
      existingRun,
    ) ||
    !/labels\[key\] !== value/u.test(existingRun) ||
    !/echo "config_digest=\$config_digest" >> "\$GITHUB_OUTPUT"/u.test(
      existingRun,
    ) ||
    /\{\{\.Name\}\}/u.test(existingRun)
  ) {
    failures.push(
      'existing-tag path must separate descriptor, raw manifest, and image inspection without rebuilding.',
    );
  }
  if (
    !local ||
    normalizeExpression(local.if) !==
      "steps.existence.outputs.exists == 'false'" ||
    !/docker image inspect --format '\{\{\.Id\}\}' "\$IMAGE_REF"/u.test(
      String(local.run ?? ''),
    ) ||
    !/echo "config_digest=\$config_digest" >> "\$GITHUB_OUTPUT"/u.test(
      String(local.run ?? ''),
    )
  ) {
    failures.push(
      'new-image path must expose the validated local config digest before scanning.',
    );
  }
  const selectedRun = String(selected?.run ?? '');
  if (
    !selected ||
    selected?.env?.TAG_EXISTS !== '${{ steps.existence.outputs.exists }}' ||
    selected?.env?.EXISTING_IMMUTABLE_REF !==
      '${{ steps.existing.outputs.immutable_ref }}' ||
    selected?.env?.EXISTING_CONFIG_DIGEST !==
      '${{ steps.existing.outputs.config_digest }}' ||
    selected?.env?.PUSHED_IMMUTABLE_REF !==
      '${{ steps.push.outputs.immutable_ref }}' ||
    selected?.env?.PUSHED_CONFIG_DIGEST !==
      '${{ steps.push.outputs.config_digest }}' ||
    !/immutable_ref="\$EXISTING_IMMUTABLE_REF"/u.test(selectedRun) ||
    !/config_digest="\$EXISTING_CONFIG_DIGEST"/u.test(selectedRun) ||
    !/immutable_ref="\$PUSHED_IMMUTABLE_REF"/u.test(selectedRun) ||
    !/config_digest="\$PUSHED_CONFIG_DIGEST"/u.test(selectedRun) ||
    !/\^\$\{IMAGE_REPOSITORY\}@sha256:\[a-f0-9\]\{64\}\$/u.test(selectedRun) ||
    !/digest="\$\{immutable_ref##\*@\}"/u.test(selectedRun) ||
    !/echo "digest=\$digest" >> "\$GITHUB_OUTPUT"/u.test(selectedRun) ||
    !/echo "immutable_ref=\$immutable_ref" >> "\$GITHUB_OUTPUT"/u.test(
      selectedRun,
    ) ||
    !/echo "config_digest=\$config_digest" >> "\$GITHUB_OUTPUT"/u.test(
      selectedRun,
    ) ||
    /sha256:[a-f0-9]{64}/u.test(selectedRun)
  ) {
    failures.push(
      'publish-image must select only the scanned existing or pushed immutable reference.',
    );
  }
  const verifyRun = String(verify?.run ?? '');
  if (
    !verify ||
    verify?.env?.EXPECTED_CONFIG_DIGEST !==
      '${{ steps.selected.outputs.config_digest }}' ||
    verify?.env?.EXPECTED_DIGEST !== '${{ steps.selected.outputs.digest }}' ||
    verify?.env?.IMMUTABLE_REF !==
      '${{ steps.selected.outputs.immutable_ref }}' ||
    (verifyRun.match(/imagetools inspect "\$IMMUTABLE_REF"/gu) ?? []).length !==
      3 ||
    /imagetools inspect "\$IMAGE_REF"/u.test(verifyRun) ||
    !/--format '\{\{json \.Manifest\}\}'/u.test(verifyRun) ||
    !/imagetools inspect "\$IMMUTABLE_REF" --raw/u.test(verifyRun) ||
    !/--format '\{\{json \.Image\}\}'/u.test(verifyRun) ||
    !/descriptor\?\.digest/u.test(verifyRun) ||
    !/manifest\?\.config\?\.digest/u.test(verifyRun) ||
    /descriptor\?\.config|descriptor\.config/u.test(verifyRun) ||
    /manifest\?\.digest|manifest\.digest/u.test(verifyRun) ||
    !/manifestDigest !== process\.env\.EXPECTED_DIGEST/u.test(verifyRun) ||
    !/configDigest !== process\.env\.EXPECTED_CONFIG_DIGEST/u.test(verifyRun) ||
    !/immutableReference = process\.env\.IMMUTABLE_REF/u.test(verifyRun) ||
    !/immutableReference !== `\$\{process\.env\.IMAGE_REPOSITORY\}@\$\{manifestDigest\}`/u.test(
      verifyRun,
    ) ||
    !/image\?\.os !== 'linux' \|\| image\?\.architecture !== 'amd64'/u.test(
      verifyRun,
    ) ||
    !/labels\[key\] !== value/u.test(verifyRun) ||
    !/Date\.parse\(labels\['org\.opencontainers\.image\.created'\]\)/u.test(
      verifyRun,
    ) ||
    /sha256:[a-f0-9]{64}/u.test(verifyRun) ||
    /\{\{\.Name\}\}/u.test(verifyRun)
  ) {
    failures.push(
      'publish-image must verify descriptor digest, raw config digest, platform, and labels for the selected immutable image.',
    );
  }
  const packageRun = String(packageStep?.run ?? '');
  if (
    !packageStep ||
    packageStep?.env?.GH_TOKEN !== '${{ secrets.GITHUB_TOKEN }}' ||
    packageStep?.env?.EXPECTED_DIGEST !==
      '${{ steps.selected.outputs.digest }}' ||
    !/GITHUB_API_URL/u.test(packageRun) ||
    !/pkg = await request\(`\/users\/\$\{owner\}\/packages\/container\/\$\{encoded\}`\)/u.test(
      packageRun,
    ) ||
    !/pkg\?\.visibility !== 'public'/u.test(packageRun) ||
    !/linkage !== process\.env\.GITHUB_REPOSITORY/u.test(packageRun) ||
    !/tags\.length !== 1 \|\| tags\[0\] !== expectedTag/u.test(packageRun) ||
    !/tag === 'latest' \|\| tag === 'main'/u.test(packageRun) ||
    !/matching\.length !== 1/u.test(packageRun) ||
    /secrets\.(?!GITHUB_TOKEN)/u.test(packageRun)
  ) {
    failures.push(
      'publish-image must fail closed through the official API on package existence, public visibility, repository linkage, selected tag, and mutable tags.',
    );
  }
  if (
    !remoteScan ||
    normalizeExpression(remoteScan.if) !== '' ||
    String(remoteScan.with?.['image-ref']) !==
      '${{ steps.selected.outputs.immutable_ref }}'
  ) {
    failures.push(
      'publish-image must rescan the verified remote immutable digest for both publication paths.',
    );
  }
  const evidenceRun = String(evidence?.run ?? '');
  if (
    !evidence ||
    evidence?.env?.MANIFEST_DIGEST !== '${{ steps.selected.outputs.digest }}' ||
    evidence?.env?.CONFIG_DIGEST !==
      '${{ steps.selected.outputs.config_digest }}' ||
    evidence?.env?.IMMUTABLE_REF !==
      '${{ steps.selected.outputs.immutable_ref }}' ||
    !/writeFileSync\('image-identity\.json'/u.test(evidenceRun) ||
    !/chmodSync\('image-identity\.json', 0o600\)/u.test(evidenceRun) ||
    !/name: 'Trivy'/u.test(evidenceRun) ||
    !/version: '0\.70\.0'/u.test(evidenceRun) ||
    !/scanners: \['vuln'\]/u.test(evidenceRun) ||
    !/severity: \['CRITICAL'\]/u.test(evidenceRun) ||
    !/ignoreUnfixed: false/u.test(evidenceRun) ||
    !/result: 'passed'/u.test(evidenceRun)
  ) {
    failures.push(
      'image-identity.json must be generated in mode 0600 from verified immutable outputs.',
    );
  } else {
    for (const field of [
      'repository:',
      'visibility:',
      'tag:',
      'manifestDigest:',
      'configDigest:',
      'immutableReference:',
      'commit:',
      'workflowRunId:',
      'workflowRunUrl:',
      'platform:',
      'labels,',
      'scanner:',
      'remoteRescan:',
      'package:',
    ]) {
      if (!evidenceRun.includes(field)) {
        failures.push(
          `image-identity.json must include ${field.replace(/[:,]$/u, '')}.`,
        );
      }
    }
  }
  const artifact = findStep(
    publish,
    (step) => actionReference(step)?.action === 'actions/upload-artifact',
  );
  if (
    !artifact ||
    artifact.with?.path !== 'image-identity.json' ||
    artifact.with?.['if-no-files-found'] !== 'error' ||
    Number(artifact.with?.['retention-days']) !== 14
  ) {
    failures.push(
      'publish-image must retain image-identity.json for 14 days and fail if it is absent.',
    );
  }
  const verifyIndex = publishSteps.indexOf(verify);
  const packageIndex = publishSteps.indexOf(packageStep);
  const remoteScanIndex = publishSteps.indexOf(remoteScan);
  const evidenceIndex = publishSteps.indexOf(evidence);
  const artifactIndex = publishSteps.indexOf(artifact);
  if (!(
    firstPush < verifyIndex &&
    verifyIndex < packageIndex &&
    packageIndex < remoteScanIndex &&
    remoteScanIndex < evidenceIndex &&
    evidenceIndex < artifactIndex
  )) {
    failures.push(
      'remote identity and package verification must precede remote rescan, evidence generation, and artifact upload.',
    );
  }

  const allSteps = Object.values(jobs).flatMap(stepsFor);
  for (const step of allSteps) {
    const reference = actionReference(step);
    if (!reference) continue;
    const approved = ACTIONS.get(reference.action);
    if (!approved) {
      failures.push(`unapproved Action used: ${reference.action}.`);
    } else if (
      !FULL_SHA.test(reference.sha) ||
      reference.sha !== approved.sha
    ) {
      failures.push(
        `${reference.action} must use ${approved.sha} (${approved.version}).`,
      );
    }
  }
  const serialized = JSON.stringify(workflow);
  if (/pull_request_target/u.test(serialized))
    failures.push('pull_request_target is forbidden.');
  if (/\b(?:latest|main)\b/u.test(String(build?.env?.IMAGE_REF ?? '')))
    failures.push('build-and-scan image reference must not use a mutable tag.');
  if (/\b(?:latest|main)\b/u.test(String(publish?.env?.IMAGE_REF ?? '')))
    failures.push('publish-image reference must not use a mutable tag.');
  if (
    /secrets\.(?!GITHUB_TOKEN)/u.test(serialized) ||
    /\bPAT\b|personal.access.token/iu.test(serialized)
  ) {
    failures.push('new secrets and PATs are forbidden.');
  }
  if (
    !String(build?.env?.IMAGE_REF ?? '').endsWith(':sha-${{ github.sha }}') ||
    !String(publish?.env?.IMAGE_REF ?? '').endsWith(':sha-${{ github.sha }}')
  ) {
    failures.push('image references must use sha-${{ github.sha }}.');
  }
  return [...new Set(failures)].sort();
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

function validateWorkflowFile({
  cwd = process.cwd(),
  path = WORKFLOW_PATH,
} = {}) {
  return validateWorkflowSource(
    readFileSync(join(cwd, ...path.split('/')), 'utf8'),
  );
}

function main() {
  try {
    validateWorkflowFile();
    console.log(`CI workflow contract passed: ${WORKFLOW_PATH}`);
  } catch (error) {
    for (const failure of error.failures ?? [error.message])
      console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ACTIONS,
  OCI_LABELS,
  SYNTHETIC_ENV_MATRIX,
  SYNTHETIC_PATH_ENV,
  SYNTHETIC_SECRET_FILES,
  WORKFLOW_PATH,
  WorkflowContractError,
  parseYamlSubset,
  validateWorkflowDocument,
  validateWorkflowFile,
  validateWorkflowSource,
};
