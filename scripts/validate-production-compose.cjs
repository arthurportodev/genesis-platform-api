const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_SERVICES = ['api', 'migrate', 'postgres'];
const MIGRATION_COMMAND = [
  'node',
  'node_modules/typeorm/cli.js',
  '-d',
  'dist/database/data-source.js',
  'migration:run',
];
const POSTGRES_DATA_MOUNT = {
  type: 'volume',
  source: 'postgres_data',
  target: '/var/lib/postgresql/data',
};
const REQUIRED_BINDINGS = [
  ['postgres', 'environment', 'POSTGRES_DB', 'DATABASE_NAME'],
  ['postgres', 'environment', 'POSTGRES_USER', 'DATABASE_MIGRATION_USER'],
  [
    'postgres',
    'environment',
    'POSTGRES_PASSWORD',
    'DATABASE_MIGRATION_PASSWORD',
  ],
  ['postgres', 'environment', 'DATABASE_RUNTIME_ROLE', 'DATABASE_RUNTIME_ROLE'],
  [
    'postgres',
    'environment',
    'DATABASE_RUNTIME_PASSWORD',
    'DATABASE_RUNTIME_PASSWORD',
  ],
  ['migrate', 'image', null, 'GENESIS_API_IMAGE'],
  ['migrate', 'environment', 'DATABASE_NAME', 'DATABASE_NAME'],
  [
    'migrate',
    'environment',
    'DATABASE_MIGRATION_USER',
    'DATABASE_MIGRATION_USER',
  ],
  [
    'migrate',
    'environment',
    'DATABASE_MIGRATION_PASSWORD',
    'DATABASE_MIGRATION_PASSWORD',
  ],
  ['migrate', 'environment', 'DATABASE_RUNTIME_ROLE', 'DATABASE_RUNTIME_ROLE'],
  ['api', 'image', null, 'GENESIS_API_IMAGE'],
  ['api', 'environment', 'DATABASE_NAME', 'DATABASE_NAME'],
  ['api', 'environment', 'DATABASE_USER', 'DATABASE_RUNTIME_ROLE'],
  ['api', 'environment', 'DATABASE_PASSWORD', 'DATABASE_RUNTIME_PASSWORD'],
  ['api', 'environment', 'DATABASE_RUNTIME_ROLE', 'DATABASE_RUNTIME_ROLE'],
  ['api', 'environment', 'FRONTEND_URL', 'FRONTEND_URL'],
  ['api', 'environment', 'JWT_ACCESS_SECRET', 'JWT_ACCESS_SECRET'],
  ['api', 'environment', 'REFRESH_TOKEN_PEPPER', 'REFRESH_TOKEN_PEPPER'],
];
const SENSITIVE_NAME =
  /(?:PASSWORD|SECRET|PEPPER|(?:^|_)TOKEN(?:_|$).*KEY|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/iu;
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
  check(
    isPlainObject(config?.services),
    'rendered services must be an object',
    failures,
  );
  check(
    isPlainObject(rawConfig?.services),
    'non-interpolated services must be an object',
    failures,
  );
  const serviceNames = Object.keys(services).sort();
  check(
    JSON.stringify(serviceNames) === JSON.stringify(EXPECTED_SERVICES),
    `expected only ${EXPECTED_SERVICES.join(', ')} services`,
    failures,
  );

  checkRequiredBindings(rawServices, failures);
  checkSensitiveEnvironments(rawServices, failures);

  const postgres = services.postgres ?? {};
  const migrate = services.migrate ?? {};
  const api = services.api ?? {};
  const rawPostgres = rawServices.postgres ?? {};
  const rawMigrate = rawServices.migrate ?? {};
  const rawApi = rawServices.api ?? {};

  for (const [name, service] of Object.entries(services)) {
    checkNoPublishedPorts(service, name, failures);
  }
  check(!('build' in postgres), 'postgres must not define build', failures);
  check(!('build' in migrate), 'migrate must not define build', failures);
  check(!('build' in api), 'api must not define build', failures);
  check(
    api.image && api.image === migrate.image,
    'api and migrate must use the same image identity',
    failures,
  );
  check(
    postgres.image === 'postgres:17-alpine',
    'postgres image must be exactly postgres:17-alpine',
    failures,
  );

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
    'edge network must remain attachable from the future ingress',
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
    'api stop_grace_period must be exactly 20s',
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
    sameStringArray(migrate.command, MIGRATION_COMMAND),
    'migrate command must exactly invoke compiled TypeORM migration:run',
    failures,
  );

  checkEnvironmentObject(api, 'api rendered', failures);
  checkEnvironmentObject(migrate, 'migrate rendered', failures);
  checkEnvironmentObject(postgres, 'postgres rendered', failures);
  checkEnvironmentObject(rawApi, 'api non-interpolated', failures);
  checkEnvironmentObject(rawMigrate, 'migrate non-interpolated', failures);
  checkEnvironmentObject(rawPostgres, 'postgres non-interpolated', failures);
  const apiEnvironment = environmentOf(api);
  const migrateEnvironment = environmentOf(migrate);
  check(
    !apiEnvironment.has('DATABASE_MIGRATION_USER') &&
      !apiEnvironment.has('DATABASE_MIGRATION_PASSWORD'),
    'api must not receive migration credentials',
    failures,
  );
  check(
    !migrateEnvironment.has('DATABASE_PASSWORD') &&
      !migrateEnvironment.has('DATABASE_RUNTIME_PASSWORD') &&
      !migrateEnvironment.has('JWT_ACCESS_SECRET') &&
      !migrateEnvironment.has('REFRESH_TOKEN_PEPPER'),
    'migrate must not receive runtime or application secrets',
    failures,
  );

  checkHealthcheck(api, API_HEALTHCHECK, 'api', failures);
  checkHealthcheck(postgres, POSTGRES_HEALTHCHECK, 'postgres', failures);
  checkPostgresDataVolume(config, postgres, failures);
  check(
    exposeValues(api).some((value) => value.startsWith('3000')),
    'api must expose port 3000 internally',
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
    serviceNames,
    failures,
  };
}

function checkRequiredBindings(services, failures) {
  for (const [serviceName, field, key, variable] of REQUIRED_BINDINGS) {
    const service = services[serviceName];
    let actual;
    if (field === 'image') actual = service?.image;
    else if (isPlainObject(service?.environment)) {
      actual = service.environment[key];
    }
    check(
      actual === requiredExpression(variable),
      `${serviceName}.${key ?? field} must use required interpolation for ${variable}`,
      failures,
    );
  }
}

function checkSensitiveEnvironments(services, failures) {
  for (const [serviceName, service] of Object.entries(services)) {
    if (!isPlainObject(service?.environment)) continue;
    for (const [key, value] of Object.entries(service.environment)) {
      const stringValue = typeof value === 'string' ? value : '';
      const expressions = [...stringValue.matchAll(interpolationPattern())];
      const sensitiveExpression = expressions.some((match) =>
        SENSITIVE_NAME.test(match[1]),
      );
      if (!SENSITIVE_NAME.test(key) && !sensitiveExpression) continue;
      check(
        expressions.length === 1 && expressions[0][0] === stringValue,
        `${serviceName}.${key} sensitive value must be a single variable interpolation`,
        failures,
      );
      for (const match of expressions) {
        check(
          match[2] !== ':-' && match[2] !== '-',
          `${serviceName}.${key} sensitive interpolation must not use a fallback`,
          failures,
        );
      }
    }
  }
}

function checkHealthcheck(service, expected, name, failures) {
  const healthcheck = service?.healthcheck;
  check(
    isPlainObject(healthcheck),
    `${name} healthcheck must be an object`,
    failures,
  );
  if (!isPlainObject(healthcheck)) return;
  check(
    healthcheck.disable !== true,
    `${name} healthcheck must not be disabled`,
    failures,
  );
  check(
    Array.isArray(healthcheck.test) &&
      JSON.stringify(healthcheck.test) === JSON.stringify(expected.test),
    `${name} healthcheck command is invalid`,
    failures,
  );
  for (const field of ['interval', 'timeout', 'retries', 'start_period']) {
    check(
      healthcheck[field] === expected[field],
      `${name} healthcheck ${field} must be ${expected[field]}`,
      failures,
    );
  }
}

function checkNoPublishedPorts(service, name, failures) {
  check(
    service.ports === undefined,
    `${name} must not publish ports`,
    failures,
  );
}

function checkPostgresDataVolume(config, postgres, failures) {
  const volumes = Array.isArray(postgres.volumes) ? postgres.volumes : [];
  const targetMounts = volumes.filter(
    (volume) =>
      isPlainObject(volume) && volume.target === POSTGRES_DATA_MOUNT.target,
  );
  const sourceMounts = volumes.filter(
    (volume) =>
      isPlainObject(volume) && volume.source === POSTGRES_DATA_MOUNT.source,
  );
  const exactMounts = volumes.filter(
    (volume) =>
      isPlainObject(volume) &&
      volume.type === POSTGRES_DATA_MOUNT.type &&
      volume.source === POSTGRES_DATA_MOUNT.source &&
      volume.target === POSTGRES_DATA_MOUNT.target,
  );

  check(
    targetMounts.length === 1 &&
      sourceMounts.length === 1 &&
      exactMounts.length === 1,
    'postgres data mount must be exactly the named volume postgres_data at /var/lib/postgresql/data',
    failures,
  );
  check(
    isPlainObject(config.volumes) &&
      Object.prototype.hasOwnProperty.call(config.volumes, 'postgres_data') &&
      isPlainObject(config.volumes.postgres_data),
    'top-level postgres_data volume must be declared',
    failures,
  );
}

function checkNetworks(service, expected, name, failures) {
  const actual = networkNames(service).sort();
  check(
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `${name} networks must be ${expected.join(', ')}`,
    failures,
  );
}

function checkHardening(service, name, failures) {
  check(
    Array.isArray(service.security_opt) &&
      service.security_opt.includes('no-new-privileges:true'),
    `${name} must enable no-new-privileges`,
    failures,
  );
  check(
    Array.isArray(service.cap_drop) && service.cap_drop.includes('ALL'),
    `${name} must drop all capabilities`,
    failures,
  );
}

function checkResources(service, maxCpu, maxMemory, maxPids, name, failures) {
  const cpu = Number(service.cpus);
  const memory = memoryBytes(service.mem_limit);
  const pids = Number(service.pids_limit);
  check(cpu > 0 && cpu <= maxCpu, `${name} CPU limit is invalid`, failures);
  check(
    memory > 0 && memory <= maxMemory,
    `${name} memory limit is invalid`,
    failures,
  );
  check(pids > 0 && pids <= maxPids, `${name} pids limit is invalid`, failures);
}

function checkLogging(service, name, failures) {
  check(
    service.logging?.driver === 'json-file',
    `${name} logging driver`,
    failures,
  );
  check(
    service.logging?.options?.['max-size'] === '10m',
    `${name} log max-size`,
    failures,
  );
  check(
    String(service.logging?.options?.['max-file']) === '5',
    `${name} log max-file`,
    failures,
  );
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function networkNames(service) {
  if (Array.isArray(service.networks)) return service.networks;
  return isPlainObject(service.networks) ? Object.keys(service.networks) : [];
}

function environmentOf(service) {
  return new Map(
    isPlainObject(service.environment)
      ? Object.entries(service.environment)
      : [],
  );
}

function checkEnvironmentObject(service, name, failures) {
  check(
    isPlainObject(service?.environment),
    `${name} environment must be an object`,
    failures,
  );
}

function exposeValues(service) {
  return Array.isArray(service.expose) ? service.expose.map(String) : [];
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (value, index) => typeof value === 'string' && value === expected[index],
    )
  );
}

function requiredExpression(variable) {
  return `\${${variable}:?${variable} is required}`;
}

function interpolationPattern() {
  return /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:\?|\?|:-|-)([^}]*))?\}/gu;
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
  const powers = { k: 1, m: 2, g: 3, t: 4 };
  const exponent = match[2] ? powers[match[2].toLowerCase()] : 0;
  return Number(match[1]) * 1024 ** exponent;
}

function main() {
  const cwd = process.cwd();
  const composePath = resolve(cwd, 'compose.production.yml');
  const envFile = process.env.GENESIS_PRODUCTION_ENV_FILE;
  if (!envFile) {
    console.error('FAIL: GENESIS_PRODUCTION_ENV_FILE is required.');
    process.exitCode = 1;
    return;
  }

  const loaded = loadProductionCompose({
    cwd,
    composePath,
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

function loadProductionCompose({ cwd, composePath, envFile }) {
  const failures = [];
  const rendered = runComposeConfig({ cwd, composePath, envFile });
  const raw = runComposeConfig({
    cwd,
    composePath,
    envFile,
    noInterpolate: true,
  });
  if (rendered.status !== 0) {
    failures.push(
      `interpolated docker compose config exited with ${rendered.status ?? 1}`,
    );
  }
  if (raw.status !== 0) {
    failures.push(
      `non-interpolated docker compose config exited with ${raw.status ?? 1}`,
    );
  }
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
  return spawnSync('docker', args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

if (require.main === module) main();

module.exports = { loadProductionCompose, validateProductionCompose };
