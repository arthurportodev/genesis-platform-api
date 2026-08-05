const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');
const {
  loadProductionCompose,
  validateProductionCompose,
} = require('../../scripts/validate-production-compose.cjs');

const composeSource = readFileSync('compose.production.yml', 'utf8');

test('accepts the frozen production Compose contract', () => {
  const result = validateProductionCompose(validConfig(), validRawConfig());

  assert.deepEqual(result.failures, []);
  assert.equal(result.status, 'passed');
});

test('uses comment-insensitive Compose JSON to reject a masked fallback', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'genesis-mvp03-compose-'));
  t.after(() => {
    assert.equal(directory.startsWith(tmpdir()), true);
    rmSync(directory, { recursive: true, force: true });
  });
  const composePath = join(directory, 'compose.production.yml');
  const envFile = join(directory, '.env.validation');
  const approved =
    '      POSTGRES_PASSWORD: ${DATABASE_MIGRATION_PASSWORD:?DATABASE_MIGRATION_PASSWORD is required}';
  const unsafe = [
    `      # POSTGRES_PASSWORD: ${'${DATABASE_MIGRATION_PASSWORD:?DATABASE_MIGRATION_PASSWORD is required}'}`,
    `      POSTGRES_PASSWORD: ${'${DATABASE_MIGRATION_PASSWORD:-arbitrary-fallback}'}`,
  ].join('\n');
  writeFileSync(composePath, composeSource.replace(approved, unsafe), 'utf8');
  writeFileSync(envFile, syntheticEnvironment(), 'utf8');

  const loaded = loadProductionCompose({
    cwd: process.cwd(),
    composePath,
    envFile,
  });
  assert.deepEqual(loaded.failures, []);

  const result = validateProductionCompose(loaded.config, loaded.rawConfig);

  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /must not use a fallback/);
});

const negativeScenarios = [
  {
    name: 'rejects an arbitrary sensitive fallback',
    mutate(_config, rawConfig) {
      rawConfig.services.api.environment.JWT_ACCESS_SECRET =
        '${JWT_ACCESS_SECRET:-not-change-password}';
    },
    diagnostic: /must not use a fallback/,
  },
  {
    name: 'rejects a one-second stop grace period',
    mutate(config) {
      config.services.api.stop_grace_period = '1s';
    },
    diagnostic: /stop_grace_period must be exactly 20s/,
  },
  {
    name: 'rejects a missing readiness timeout',
    mutate(config) {
      delete config.services.api.healthcheck.timeout;
    },
    diagnostic: /healthcheck timeout must be 5s/,
  },
  {
    name: 'rejects missing readiness retries',
    mutate(config) {
      delete config.services.api.healthcheck.retries;
    },
    diagnostic: /healthcheck retries must be 6/,
  },
  {
    name: 'rejects a missing readiness start period',
    mutate(config) {
      delete config.services.api.healthcheck.start_period;
    },
    diagnostic: /healthcheck start_period must be 15s/,
  },
  {
    name: 'rejects a different health endpoint',
    mutate(config) {
      config.services.api.healthcheck.test[3] =
        config.services.api.healthcheck.test[3].replace(
          '/api/v1/health/ready',
          '/api/v1/health/other',
        );
    },
    diagnostic: /healthcheck command is invalid/,
  },
  {
    name: 'rejects liveness in place of readiness',
    mutate(config) {
      config.services.api.healthcheck.test[3] =
        config.services.api.healthcheck.test[3].replace(
          '/api/v1/health/ready',
          '/api/v1/health/live',
        );
    },
    diagnostic: /healthcheck command is invalid/,
  },
  {
    name: 'rejects a disabled API healthcheck',
    mutate(config) {
      config.services.api.healthcheck.disable = true;
    },
    diagnostic: /healthcheck must not be disabled/,
  },
  {
    name: 'rejects an unexpected healthcheck scalar',
    mutate(config) {
      config.services.api.healthcheck = 'ready';
    },
    diagnostic: /healthcheck must be an object/,
  },
  {
    name: 'rejects migration credentials reinserted into the API',
    mutate(config) {
      config.services.api.environment.DATABASE_MIGRATION_PASSWORD = 'present';
    },
    diagnostic: /api must not receive migration credentials/,
  },
  {
    name: 'rejects an echo migration command containing expected substrings',
    mutate(config) {
      config.services.migrate.command = [
        'echo',
        'dist/database/data-source.js',
        'migration:run',
      ];
    },
    diagnostic: /migrate command must exactly invoke/,
  },
  {
    name: 'rejects a scalar migration command',
    mutate(config) {
      config.services.migrate.command =
        'node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run';
    },
    diagnostic: /migrate command must exactly invoke/,
  },
  {
    name: 'rejects an extra migration command argument',
    mutate(config) {
      config.services.migrate.command.push('--transaction', 'all');
    },
    diagnostic: /migrate command must exactly invoke/,
  },
  {
    name: 'rejects reordered migration command arguments',
    mutate(config) {
      config.services.migrate.command = [
        'node',
        'node_modules/typeorm/cli.js',
        'migration:run',
        '-d',
        'dist/database/data-source.js',
      ];
    },
    diagnostic: /migrate command must exactly invoke/,
  },
  {
    name: 'rejects a shell migration command',
    mutate(config) {
      config.services.migrate.command = [
        'sh',
        '-c',
        'node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run',
      ];
    },
    diagnostic: /migrate command must exactly invoke/,
  },
  {
    name: 'rejects a published API port',
    mutate(config) {
      config.services.api.ports = [{ target: 3000, published: '3000' }];
    },
    diagnostic: /api must not publish ports/,
  },
  {
    name: 'rejects a published migrate port',
    mutate(config) {
      config.services.migrate.ports = [{ target: 3000, published: '3001' }];
    },
    diagnostic: /migrate must not publish ports/,
  },
  {
    name: 'rejects a published PostgreSQL port',
    mutate(config) {
      config.services.postgres.ports = [{ target: 5432, published: '5432' }];
    },
    diagnostic: /postgres must not publish ports/,
  },
  {
    name: 'rejects a bind mount for PostgreSQL data',
    mutate(config) {
      config.services.postgres.volumes = [
        {
          type: 'bind',
          source: './postgres-data',
          target: '/var/lib/postgresql/data',
        },
      ];
    },
    diagnostic: /data mount must be exactly the named volume/,
  },
  {
    name: 'rejects an anonymous volume for PostgreSQL data',
    mutate(config) {
      config.services.postgres.volumes = [
        { type: 'volume', target: '/var/lib/postgresql/data' },
      ];
    },
    diagnostic: /data mount must be exactly the named volume/,
  },
  {
    name: 'rejects the wrong PostgreSQL data volume source',
    mutate(config) {
      config.services.postgres.volumes[0].source = 'other_data';
    },
    diagnostic: /data mount must be exactly the named volume/,
  },
  {
    name: 'rejects a conflicting PostgreSQL data mount',
    mutate(config) {
      config.services.postgres.volumes.push({
        type: 'volume',
        source: 'other_data',
        target: '/var/lib/postgresql/data',
      });
    },
    diagnostic: /data mount must be exactly the named volume/,
  },
  {
    name: 'rejects an undeclared PostgreSQL data volume',
    mutate(config) {
      delete config.volumes.postgres_data;
    },
    diagnostic: /top-level postgres_data volume must be declared/,
  },
  {
    name: 'rejects postgres 1700 prefix bypass',
    mutate(config) {
      config.services.postgres.image = 'postgres:1700-alpine';
    },
    diagnostic: /postgres image must be exactly postgres:17-alpine/,
  },
  {
    name: 'rejects a different PostgreSQL major version',
    mutate(config) {
      config.services.postgres.image = 'postgres:16-alpine';
    },
    diagnostic: /postgres image must be exactly postgres:17-alpine/,
  },
  {
    name: 'rejects PostgreSQL on the edge network',
    mutate(config) {
      config.services.postgres.networks.edge = {};
    },
    diagnostic: /postgres networks must be database/,
  },
];

for (const scenario of negativeScenarios) {
  test(scenario.name, () => {
    const config = validConfig();
    const rawConfig = validRawConfig();
    scenario.mutate(config, rawConfig);

    const result = validateProductionCompose(config, rawConfig);

    assert.equal(result.status, 'failed');
    assert.match(result.failures.join('\n'), scenario.diagnostic);
  });
}

test('rejects service expansion and weakened startup or hardening', () => {
  const config = validConfig();
  config.services['invitation-worker'] = {};
  config.services.api.read_only = false;
  config.services.api.depends_on.migrate.condition = 'service_started';

  const result = validateProductionCompose(config, validRawConfig());

  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /expected only/);
  assert.match(result.failures.join('\n'), /filesystem must be read-only/);
  assert.match(result.failures.join('\n'), /successful migration/);
});

function validConfig() {
  const apiHealthcheck = {
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
  const postgresHealthcheck = {
    test: [
      'CMD-SHELL',
      'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"',
    ],
    interval: '5s',
    timeout: '5s',
    retries: 12,
    start_period: '10s',
  };
  return {
    services: {
      api: {
        image: 'genesis-platform-api:candidate',
        restart: 'unless-stopped',
        init: true,
        stop_grace_period: '20s',
        read_only: true,
        expose: ['3000'],
        environment: {
          DATABASE_USER: 'runtime',
          DATABASE_PASSWORD: 'present',
          DATABASE_RUNTIME_ROLE: 'runtime',
        },
        depends_on: {
          migrate: { condition: 'service_completed_successfully' },
        },
        healthcheck: apiHealthcheck,
        networks: { database: {}, edge: {} },
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        cpus: 0.75,
        mem_limit: 1024 ** 3,
        pids_limit: 128,
        logging: logging(),
      },
      migrate: {
        image: 'genesis-platform-api:candidate',
        restart: 'no',
        init: true,
        read_only: true,
        command: [
          'node',
          'node_modules/typeorm/cli.js',
          '-d',
          'dist/database/data-source.js',
          'migration:run',
        ],
        environment: {
          DATABASE_MIGRATION_USER: 'owner',
          DATABASE_MIGRATION_PASSWORD: 'present',
          DATABASE_RUNTIME_ROLE: 'runtime',
        },
        depends_on: { postgres: { condition: 'service_healthy' } },
        networks: { database: {} },
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        cpus: 0.75,
        mem_limit: 1024 ** 3,
        pids_limit: 128,
        logging: logging(),
      },
      postgres: {
        image: 'postgres:17-alpine',
        restart: 'unless-stopped',
        environment: {
          POSTGRES_DB: 'genesis',
          POSTGRES_USER: 'owner',
          POSTGRES_PASSWORD: 'present',
          DATABASE_RUNTIME_ROLE: 'runtime',
          DATABASE_RUNTIME_PASSWORD: 'present',
        },
        volumes: [
          {
            type: 'volume',
            source: 'postgres_data',
            target: '/var/lib/postgresql/data',
          },
        ],
        healthcheck: postgresHealthcheck,
        networks: { database: {} },
        cpus: 1,
        mem_limit: 2 * 1024 ** 3,
        pids_limit: 256,
        logging: logging(),
      },
    },
    networks: { database: { internal: true }, edge: {} },
    volumes: { postgres_data: {} },
  };
}

function validRawConfig() {
  const config = validConfig();
  config.services.postgres.environment = {
    POSTGRES_DB: required('DATABASE_NAME'),
    POSTGRES_USER: required('DATABASE_MIGRATION_USER'),
    POSTGRES_PASSWORD: required('DATABASE_MIGRATION_PASSWORD'),
    DATABASE_RUNTIME_ROLE: required('DATABASE_RUNTIME_ROLE'),
    DATABASE_RUNTIME_PASSWORD: required('DATABASE_RUNTIME_PASSWORD'),
  };
  config.services.migrate.image = required('GENESIS_API_IMAGE');
  config.services.migrate.environment = {
    DATABASE_NAME: required('DATABASE_NAME'),
    DATABASE_MIGRATION_USER: required('DATABASE_MIGRATION_USER'),
    DATABASE_MIGRATION_PASSWORD: required('DATABASE_MIGRATION_PASSWORD'),
    DATABASE_RUNTIME_ROLE: required('DATABASE_RUNTIME_ROLE'),
  };
  config.services.api.image = required('GENESIS_API_IMAGE');
  config.services.api.environment = {
    DATABASE_NAME: required('DATABASE_NAME'),
    DATABASE_USER: required('DATABASE_RUNTIME_ROLE'),
    DATABASE_PASSWORD: required('DATABASE_RUNTIME_PASSWORD'),
    DATABASE_RUNTIME_ROLE: required('DATABASE_RUNTIME_ROLE'),
    FRONTEND_URL: required('FRONTEND_URL'),
    JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),
    REFRESH_TOKEN_PEPPER: required('REFRESH_TOKEN_PEPPER'),
  };
  return config;
}

function logging() {
  return {
    driver: 'json-file',
    options: { 'max-size': '10m', 'max-file': '5' },
  };
}

function required(variable) {
  return `${'${'}${variable}:?${variable} is required}`;
}

function syntheticEnvironment() {
  const generated = Buffer.alloc(32, 7).toString('hex');
  return [
    'GENESIS_API_IMAGE=genesis-platform-api:structural-test',
    'DATABASE_NAME=genesis_structural_test',
    'DATABASE_MIGRATION_USER=structural_owner',
    `DATABASE_MIGRATION_PASSWORD=${generated}`,
    'DATABASE_RUNTIME_ROLE=structural_runtime',
    `DATABASE_RUNTIME_PASSWORD=${generated}`,
    'FRONTEND_URL=https://example.invalid',
    `JWT_ACCESS_SECRET=${generated}`,
    `REFRESH_TOKEN_PEPPER=${generated}`,
    '',
  ].join('\n');
}
