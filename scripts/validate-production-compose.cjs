const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const API_IMAGE =
  'ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659';
const POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const PLATFORM = 'linux/amd64';
const EXPECTED_SERVICES = ['api', 'migrate', 'postgres'];
const MIGRATION_COMMAND = [
  'node',
  'node_modules/typeorm/cli.js',
  '-d',
  'dist/database/data-source.js',
  'migration:run',
];
const API_COMMAND = ['node', 'dist/main.js'];
const SECRET_FILES = {
  postgres_bootstrap_password:
    '/opt/genesis/secrets/postgres-bootstrap-password',
  database_migration_password:
    '/opt/genesis/secrets/database-migration-password',
  database_runtime_password: '/opt/genesis/secrets/database-runtime-password',
  jwt_access_secret: '/opt/genesis/secrets/jwt-access-secret',
  refresh_token_pepper: '/opt/genesis/secrets/refresh-token-pepper',
  lead_idempotency_keys: '/opt/genesis/secrets/lead-idempotency-keys',
};
const SERVICE_SECRETS = {
  postgres: [
    'postgres_bootstrap_password',
    'database_migration_password',
    'database_runtime_password',
  ],
  migrate: ['database_migration_password'],
  api: [
    'database_runtime_password',
    'jwt_access_secret',
    'refresh_token_pepper',
    'lead_idempotency_keys',
  ],
};
const FORBIDDEN_SECRET_ENV = new Set([
  'POSTGRES_PASSWORD',
  'DATABASE_MIGRATION_PASSWORD',
  'DATABASE_RUNTIME_PASSWORD',
  'DATABASE_PASSWORD',
  'JWT_ACCESS_SECRET',
  'REFRESH_TOKEN_PEPPER',
  'LEAD_IDEMPOTENCY_KEYS',
]);
const REQUIRED_BINDINGS = [
  ['postgres', 'POSTGRES_DB', 'DATABASE_NAME'],
  ['postgres', 'POSTGRES_USER', 'DATABASE_BOOTSTRAP_USER'],
  ['postgres', 'DATABASE_MIGRATION_USER', 'DATABASE_MIGRATION_USER'],
  ['postgres', 'DATABASE_RUNTIME_ROLE', 'DATABASE_RUNTIME_ROLE'],
  ['migrate', 'DATABASE_NAME', 'DATABASE_NAME'],
  ['migrate', 'DATABASE_MIGRATION_USER', 'DATABASE_MIGRATION_USER'],
  ['migrate', 'DATABASE_RUNTIME_ROLE', 'DATABASE_RUNTIME_ROLE'],
  ['api', 'DATABASE_NAME', 'DATABASE_NAME'],
  ['api', 'DATABASE_USER', 'DATABASE_RUNTIME_ROLE'],
  ['api', 'DATABASE_RUNTIME_ROLE', 'DATABASE_RUNTIME_ROLE'],
];
const API_HEALTHCHECK = {
  test: [
    'CMD',
    'node',
    '-e',
    "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
  ],
  interval: '10s',
  timeout: '5s',
  retries: 6,
  start_period: '15s',
};
const POSTGRES_HEALTHCHECK = {
  test: ['CMD-SHELL', 'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"'],
  interval: '5s',
  timeout: '5s',
  retries: 12,
  start_period: '10s',
};

function validateProductionCompose(config, rawConfig) {
  const failures = [];
  const services = isPlainObject(config?.services) ? config.services : {};
  const rawServices = isPlainObject(rawConfig?.services)
    ? rawConfig.services
    : {};
  const names = Object.keys(services).sort();

  check(config?.name === 'genesis', 'project name must be genesis', failures);
  check(
    rawConfig?.name === 'genesis',
    'raw project name must be genesis',
    failures,
  );
  check(
    JSON.stringify(names) === JSON.stringify(EXPECTED_SERVICES),
    `expected only ${EXPECTED_SERVICES.join(', ')} services`,
    failures,
  );
  check(
    Object.keys(rawServices).sort().join(',') === EXPECTED_SERVICES.join(','),
    'raw services differ from the production contract',
    failures,
  );

  checkRequiredBindings(rawServices, failures);
  checkNoSecretEnvironment(rawServices, failures);
  checkNoSecretEnvironment(services, failures);
  checkTopLevelSecrets(config, rawConfig, failures);

  const postgres = services.postgres ?? {};
  const migrate = services.migrate ?? {};
  const api = services.api ?? {};
  const rawPostgres = rawServices.postgres ?? {};
  const rawMigrate = rawServices.migrate ?? {};
  const rawApi = rawServices.api ?? {};

  for (const [name, service] of Object.entries(services)) {
    check(
      service.ports === undefined,
      `${name} must not publish ports`,
      failures,
    );
    check(!('build' in service), `${name} must not define build`, failures);
    check(
      service.platform === PLATFORM,
      `${name} platform must be ${PLATFORM}`,
      failures,
    );
  }
  check(
    api.image === API_IMAGE,
    'api image must use the approved digest',
    failures,
  );
  check(
    migrate.image === API_IMAGE,
    'migrate image must use the approved digest',
    failures,
  );
  check(
    postgres.image === POSTGRES_IMAGE,
    'postgres image must use the approved digest',
    failures,
  );
  for (const [name, image] of Object.entries({
    api: rawApi.image,
    migrate: rawMigrate.image,
    postgres: rawPostgres.image,
  })) {
    checkImmutableImage(image, name, failures);
  }

  checkNetworks(postgres, ['database'], 'postgres', failures);
  checkNetworks(migrate, ['database'], 'migrate', failures);
  checkNetworks(api, ['database', 'edge'], 'api', failures);
  check(
    config.networks?.database?.internal === true,
    'database network must be internal',
    failures,
  );
  check(
    config.networks?.edge?.internal !== true,
    'edge network must not be internal',
    failures,
  );

  check(
    postgres.restart === 'unless-stopped',
    'postgres restart policy',
    failures,
  );
  check(migrate.restart === 'no', 'migrate must be one-shot', failures);
  check(api.restart === 'unless-stopped', 'api restart policy', failures);
  check(api.init === true, 'api must enable init', failures);
  check(migrate.init === true, 'migrate must enable init', failures);
  check(
    api.stop_grace_period === '20s',
    'api grace period must be 20s',
    failures,
  );
  check(
    postgres.stop_grace_period === '1m30s' &&
      rawPostgres.stop_grace_period === '90s',
    'postgres grace period must be exactly 90s',
    failures,
  );
  check(api.read_only === true, 'api filesystem must be read-only', failures);
  check(
    migrate.read_only === true,
    'migrate filesystem must be read-only',
    failures,
  );
  checkHardening(api, 'api', failures);
  checkHardening(migrate, 'migrate', failures);

  check(
    sameStringArray(api.entrypoint, [
      '/bin/sh',
      '/opt/genesis/bin/api-entrypoint.sh',
    ]),
    'api wrapper must be invoked by /bin/sh',
    failures,
  );
  check(
    sameStringArray(migrate.entrypoint, [
      '/bin/sh',
      '/opt/genesis/bin/migrate-entrypoint.sh',
    ]),
    'migrate wrapper must be invoked by /bin/sh',
    failures,
  );
  check(
    sameStringArray(api.command, API_COMMAND),
    'api command is invalid',
    failures,
  );
  check(
    sameStringArray(migrate.command, MIGRATION_COMMAND),
    'migration command is invalid',
    failures,
  );
  checkReadOnlyBind(
    api,
    'docker/production/api-entrypoint.sh',
    '/opt/genesis/bin/api-entrypoint.sh',
    'api',
    failures,
  );
  checkReadOnlyBind(
    migrate,
    'docker/production/migrate-entrypoint.sh',
    '/opt/genesis/bin/migrate-entrypoint.sh',
    'migrate',
    failures,
  );
  checkReadOnlyBind(
    postgres,
    'docker/postgres/init-runtime-role.sh',
    '/docker-entrypoint-initdb.d/10-production-roles.sh',
    'postgres',
    failures,
  );

  check(
    postgres.environment?.POSTGRES_PASSWORD_FILE ===
      '/run/secrets/postgres_bootstrap_password',
    'postgres must use POSTGRES_PASSWORD_FILE',
    failures,
  );
  checkServiceSecrets(services, failures);
  checkGroup(api, 'api', failures);
  checkGroup(migrate, 'migrate', failures);
  check(
    !Array.isArray(postgres.group_add) || !postgres.group_add.includes('70'),
    'postgres must not receive an extra host group',
    failures,
  );

  check(
    migrate.depends_on?.postgres?.condition === 'service_healthy',
    'migrate must wait for healthy postgres',
    failures,
  );
  check(
    api.depends_on?.migrate?.condition === 'service_completed_successfully',
    'api must wait for successful migration',
    failures,
  );
  check(
    api.environment?.FRONTEND_URL === 'https://genesis.invalid',
    'frontend origin must remain fail-closed',
    failures,
  );
  for (const key of [
    'INVITATION_ISSUANCE_READINESS',
    'INVITATION_ACCEPTANCE_READINESS',
    'INVITATION_ACTIVATION_READINESS',
    'INVITATION_WORKER_ENABLED',
    'LEAD_FORM_READINESS',
  ]) {
    check(
      String(api.environment?.[key]) === 'false',
      `${key} must remain false`,
      failures,
    );
  }
  check(
    String(api.environment?.LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION) === '1',
    'Lead idempotency key version must be 1',
    failures,
  );

  checkHealthcheck(api, API_HEALTHCHECK, 'api', failures);
  checkHealthcheck(postgres, POSTGRES_HEALTHCHECK, 'postgres', failures);
  checkPostgresDataVolume(config, postgres, failures);
  check(
    Array.isArray(api.expose) && api.expose.map(String).includes('3000'),
    'api must expose 3000 internally',
    failures,
  );
  checkResources(api, 0.75, 1024 ** 3, 128, 'api', failures);
  checkResources(migrate, 0.75, 1024 ** 3, 128, 'migrate', failures);
  checkResources(postgres, 1, 2 * 1024 ** 3, 256, 'postgres', failures);
  for (const [name, service] of Object.entries({ api, migrate, postgres })) {
    checkLogging(service, name, failures);
  }

  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    serviceNames: names,
    failures,
  };
}

function checkRequiredBindings(services, failures) {
  for (const [serviceName, key, variable] of REQUIRED_BINDINGS) {
    check(
      services[serviceName]?.environment?.[key] ===
        requiredExpression(variable),
      `${serviceName}.${key} must require ${variable}`,
      failures,
    );
  }
}

function checkNoSecretEnvironment(services, failures) {
  for (const [serviceName, service] of Object.entries(services)) {
    if (!isPlainObject(service?.environment)) continue;
    for (const [key, value] of Object.entries(service.environment)) {
      check(
        !FORBIDDEN_SECRET_ENV.has(key),
        `${serviceName}.${key} must be file-backed, not environment metadata`,
        failures,
      );
      const text = String(value ?? '');
      for (const forbidden of FORBIDDEN_SECRET_ENV) {
        check(
          !text.includes(`\${${forbidden}}`) &&
            !text.includes(`\${${forbidden}:`),
          `${serviceName}.${key} must not interpolate ${forbidden}`,
          failures,
        );
      }
    }
  }
}

function checkTopLevelSecrets(config, rawConfig, failures) {
  const actual = Object.keys(config?.secrets ?? {}).sort();
  const expected = Object.keys(SECRET_FILES).sort();
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    'top-level secret allowlist is invalid',
    failures,
  );
  for (const [name, path] of Object.entries(SECRET_FILES)) {
    check(
      config?.secrets?.[name]?.file === path,
      `${name} must use fixed host path ${path}`,
      failures,
    );
    check(
      rawConfig?.secrets?.[name]?.file === path,
      `${name} raw host path is invalid`,
      failures,
    );
  }
}

function checkServiceSecrets(services, failures) {
  for (const [serviceName, expected] of Object.entries(SERVICE_SECRETS)) {
    const actual = (services[serviceName]?.secrets ?? [])
      .map((entry) => entry.source)
      .sort();
    check(
      JSON.stringify(actual) === JSON.stringify([...expected].sort()),
      `${serviceName} secret subset is invalid`,
      failures,
    );
    for (const entry of services[serviceName]?.secrets ?? []) {
      check(
        entry.target === `/run/secrets/${entry.source}`,
        `${serviceName}.${entry.source} target is invalid`,
        failures,
      );
    }
  }
}

function checkReadOnlyBind(service, sourceSuffix, target, name, failures) {
  const normalizedSuffix = sourceSuffix.replaceAll('/', '\\').toLowerCase();
  const matches = (service.volumes ?? []).filter(
    (mount) =>
      mount.type === 'bind' &&
      mount.target === target &&
      mount.read_only === true &&
      String(mount.source)
        .replaceAll('/', '\\')
        .toLowerCase()
        .endsWith(normalizedSuffix),
  );
  check(
    matches.length === 1,
    `${name} wrapper/init bind must be exact and read-only`,
    failures,
  );
}

function checkImmutableImage(image, name, failures) {
  check(
    typeof image === 'string' && /@sha256:[a-f0-9]{64}$/u.test(image),
    `${name} image must be immutable by sha256 digest`,
    failures,
  );
  check(
    !String(image).includes('${'),
    `${name} image must not be interpolated`,
    failures,
  );
}

function checkPostgresDataVolume(config, postgres, failures) {
  const mounts = (postgres.volumes ?? []).filter(
    (entry) =>
      entry.type === 'volume' && entry.target === '/var/lib/postgresql/data',
  );
  check(
    mounts.length === 1 && mounts[0].source === 'postgres_data',
    'postgres data mount must use postgres_data',
    failures,
  );
  check(
    config.volumes?.postgres_data?.external === true,
    'postgres_data must be external',
    failures,
  );
  check(
    config.volumes?.postgres_data?.name === 'genesis-postgres-data',
    'physical volume name must be genesis-postgres-data',
    failures,
  );
}

function checkHealthcheck(service, expected, name, failures) {
  const health = service.healthcheck;
  check(isPlainObject(health), `${name} healthcheck must exist`, failures);
  if (!isPlainObject(health)) return;
  check(
    JSON.stringify(health.test) === JSON.stringify(expected.test),
    `${name} healthcheck command is invalid`,
    failures,
  );
  for (const field of ['interval', 'timeout', 'retries', 'start_period']) {
    check(
      health[field] === expected[field],
      `${name} healthcheck ${field} is invalid`,
      failures,
    );
  }
}

function checkNetworks(service, expected, name, failures) {
  const actual = (
    Array.isArray(service.networks)
      ? service.networks
      : Object.keys(service.networks ?? {})
  ).sort();
  check(
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `${name} networks are invalid`,
    failures,
  );
}

function checkHardening(service, name, failures) {
  check(
    service.security_opt?.includes('no-new-privileges:true'),
    `${name} must use no-new-privileges`,
    failures,
  );
  check(
    service.cap_drop?.includes('ALL'),
    `${name} must drop all capabilities`,
    failures,
  );
}

function checkGroup(service, name, failures) {
  check(
    Array.isArray(service.group_add) &&
      service.group_add.length === 1 &&
      service.group_add[0] === '70',
    `${name} must receive only GID 70`,
    failures,
  );
}

function checkResources(service, maxCpu, maxMemory, maxPids, name, failures) {
  check(
    Number(service.cpus) > 0 && Number(service.cpus) <= maxCpu,
    `${name} CPU limit is invalid`,
    failures,
  );
  check(
    memoryBytes(service.mem_limit) > 0 &&
      memoryBytes(service.mem_limit) <= maxMemory,
    `${name} memory limit is invalid`,
    failures,
  );
  check(
    Number(service.pids_limit) > 0 && Number(service.pids_limit) <= maxPids,
    `${name} pids limit is invalid`,
    failures,
  );
}

function checkLogging(service, name, failures) {
  check(
    service.logging?.driver === 'json-file',
    `${name} logging driver is invalid`,
    failures,
  );
  check(
    service.logging?.options?.['max-size'] === '10m',
    `${name} log max-size is invalid`,
    failures,
  );
  check(
    String(service.logging?.options?.['max-file']) === '5',
    `${name} log max-file is invalid`,
    failures,
  );
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function requiredExpression(variable) {
  return `\${${variable}:?${variable} is required}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function memoryBytes(value) {
  if (typeof value === 'number') return value;
  const match = String(value ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/iu);
  if (!match) return Number.NaN;
  const exponent = match[2]
    ? { k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()]
    : 0;
  return Number(match[1]) * 1024 ** exponent;
}

function loadProductionCompose({ cwd, composePath, envFile }) {
  const failures = [];
  const rendered = runComposeConfig({ cwd, composePath, envFile });
  const raw = runComposeConfig({
    cwd,
    composePath,
    envFile,
    noInterpolate: true,
  });
  if (rendered.status !== 0)
    failures.push(
      `interpolated docker compose config exited with ${rendered.status ?? 1}: ${rendered.stderr.trim()}`,
    );
  if (raw.status !== 0)
    failures.push(
      `non-interpolated docker compose config exited with ${raw.status ?? 1}: ${raw.stderr.trim()}`,
    );
  let config;
  let rawConfig;
  if (failures.length === 0) {
    try {
      config = JSON.parse(rendered.stdout);
      rawConfig = JSON.parse(raw.stdout);
    } catch {
      failures.push('docker compose config did not return valid JSON');
    }
  }
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    config,
    rawConfig,
  };
}

function runComposeConfig({
  cwd,
  composePath,
  envFile,
  noInterpolate = false,
}) {
  const args = ['compose', '--env-file', envFile, '-f', composePath, 'config'];
  if (noInterpolate) args.push('--no-interpolate');
  args.push('--format', 'json');
  return spawnSync('docker', args, { cwd, encoding: 'utf8', env: process.env });
}

function main() {
  const cwd = process.cwd();
  const envFile = process.env.GENESIS_PRODUCTION_ENV_FILE;
  if (!envFile) {
    console.error('FAIL: GENESIS_PRODUCTION_ENV_FILE is required.');
    process.exitCode = 1;
    return;
  }
  const loaded = loadProductionCompose({
    cwd,
    composePath: resolve(cwd, 'compose.production.yml'),
    envFile: resolve(cwd, envFile),
  });
  if (loaded.status !== 'passed') {
    for (const failure of loaded.failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  const validation = validateProductionCompose(loaded.config, loaded.rawConfig);
  for (const failure of validation.failures) console.error(`FAIL: ${failure}`);
  console.log(
    JSON.stringify({
      command: 'npm run production:compose:validate',
      ...validation,
    }),
  );
  if (validation.status !== 'passed') process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  API_IMAGE,
  PLATFORM,
  POSTGRES_IMAGE,
  SECRET_FILES,
  SERVICE_SECRETS,
  loadProductionCompose,
  validateProductionCompose,
};
