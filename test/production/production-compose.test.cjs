const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const {
  API_IMAGE,
  POSTGRES_IMAGE,
  SECRET_FILES,
  SERVICE_SECRETS,
  loadProductionCompose,
  validateProductionCompose,
} = require('../../scripts/validate-production-compose.cjs');

const loaded = loadProductionCompose({
  cwd: process.cwd(),
  composePath: resolve('compose.production.yml'),
  envFile: resolve('.env.production.example'),
});

test('renders and validates the complete production Compose contract', () => {
  assert.equal(loaded.status, 'passed', loaded.failures.join('\n'));
  assert.deepEqual(validateProductionCompose(loaded.config, loaded.rawConfig), {
    status: 'passed',
    serviceNames: ['api', 'migrate', 'postgres'],
    failures: [],
  });
});

test('pins both images by approved digest for linux/amd64', () => {
  assert.equal(loaded.config.services.api.image, API_IMAGE);
  assert.equal(loaded.config.services.migrate.image, API_IMAGE);
  assert.equal(loaded.config.services.postgres.image, POSTGRES_IMAGE);
  for (const service of Object.values(loaded.config.services)) {
    assert.equal(service.platform, 'linux/amd64');
    assert.match(service.image, /@sha256:[a-f0-9]{64}$/u);
  }
});

test('keeps all secret values outside environment and interpolation', () => {
  const forbidden = [
    'POSTGRES_PASSWORD',
    'DATABASE_MIGRATION_PASSWORD',
    'DATABASE_RUNTIME_PASSWORD',
    'DATABASE_PASSWORD',
    'JWT_ACCESS_SECRET',
    'REFRESH_TOKEN_PEPPER',
    'LEAD_IDEMPOTENCY_KEYS',
  ];
  for (const config of [loaded.config, loaded.rawConfig]) {
    const serialized = JSON.stringify(config.services);
    for (const variable of forbidden) {
      for (const service of Object.values(config.services)) {
        assert.equal(
          Object.hasOwn(service.environment ?? {}, variable),
          false,
          `${variable} leaked into environment`,
        );
      }
      assert.doesNotMatch(
        serialized,
        new RegExp(`\\$\\{${variable}(?::|\\})`, 'u'),
      );
    }
  }
  assert.equal(
    loaded.config.services.postgres.environment.POSTGRES_PASSWORD_FILE,
    '/run/secrets/postgres_bootstrap_password',
  );
});

test('mounts only the approved service-specific secret subsets', () => {
  assert.deepEqual(
    Object.keys(loaded.config.secrets).sort(),
    Object.keys(SECRET_FILES).sort(),
  );
  for (const [name, expected] of Object.entries(SERVICE_SECRETS)) {
    assert.deepEqual(
      loaded.config.services[name].secrets.map((entry) => entry.source).sort(),
      [...expected].sort(),
    );
  }
  assert.deepEqual(loaded.config.services.api.group_add, ['70']);
  assert.deepEqual(loaded.config.services.migrate.group_add, ['70']);
});

test('bind-mounts wrappers and init read-only and invokes wrappers through /bin/sh', () => {
  assert.deepEqual(loaded.config.services.api.entrypoint, [
    '/bin/sh',
    '/opt/genesis/bin/api-entrypoint.sh',
  ]);
  assert.deepEqual(loaded.config.services.migrate.entrypoint, [
    '/bin/sh',
    '/opt/genesis/bin/migrate-entrypoint.sh',
  ]);
  for (const [serviceName, target] of [
    ['api', '/opt/genesis/bin/api-entrypoint.sh'],
    ['migrate', '/opt/genesis/bin/migrate-entrypoint.sh'],
    ['postgres', '/docker-entrypoint-initdb.d/10-production-roles.sh'],
  ]) {
    const mount = loaded.config.services[serviceName].volumes.find(
      (entry) => entry.target === target,
    );
    assert.equal(mount.type, 'bind');
    assert.equal(mount.read_only, true);
  }
});

test('stabilizes project and protects the external data volume', () => {
  assert.equal(loaded.config.name, 'genesis');
  assert.deepEqual(loaded.config.volumes.postgres_data, {
    name: 'genesis-postgres-data',
    external: true,
  });
  assert.equal(loaded.rawConfig.services.postgres.stop_grace_period, '90s');
  assert.equal(loaded.config.services.api.stop_grace_period, '20s');
});

test('rejects security and persistence regressions', () => {
  const mutations = [
    (config) => {
      config.services.api.image =
        'ghcr.io/arthurportodev/genesis-platform-api:latest';
    },
    (config) => {
      config.services.api.environment.JWT_ACCESS_SECRET = 'literal';
    },
    (config) => {
      config.services.api.secrets.push({
        source: 'database_migration_password',
        target: '/run/secrets/database_migration_password',
      });
    },
    (config) => {
      config.services.api.group_add = ['70', '71'];
    },
    (config) => {
      config.services.api.volumes[0].read_only = false;
    },
    (config) => {
      config.volumes.postgres_data.external = false;
    },
    (config) => {
      config.services.postgres.stop_grace_period = '10s';
    },
    (config) => {
      config.services.api.environment.FRONTEND_URL = 'https://example.com';
    },
  ];

  for (const mutate of mutations) {
    const config = structuredClone(loaded.config);
    mutate(config);
    assert.equal(
      validateProductionCompose(config, loaded.rawConfig).status,
      'failed',
    );
  }
});

test('keeps the versioned environment example non-secret', () => {
  const source = readFileSync('.env.production.example', 'utf8');
  for (const name of [
    'POSTGRES_PASSWORD',
    'DATABASE_MIGRATION_PASSWORD',
    'DATABASE_RUNTIME_PASSWORD',
    'DATABASE_PASSWORD',
    'JWT_ACCESS_SECRET',
    'REFRESH_TOKEN_PEPPER',
    'LEAD_IDEMPOTENCY_KEYS',
  ]) {
    assert.doesNotMatch(source, new RegExp(`^${name}=`, 'mu'));
  }
  assert.match(source, /^DATABASE_BOOTSTRAP_USER=genesis_bootstrap$/mu);
  assert.doesNotMatch(source, /^GENESIS_API_IMAGE=/mu);
});
