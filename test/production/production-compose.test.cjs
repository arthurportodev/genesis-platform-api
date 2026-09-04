const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const {
  API_IMAGE_EXPRESSION,
  API_RELEASE_BINDINGS,
  BASE_COMPOSE,
  MODE_CONTRACTS,
  POSTGRES_IMAGE,
  PUBLIC_HTTP_STATIC_CONFIGS,
  SECRET_FILES,
  SERVICE_SECRETS,
  TRAEFIK_IMAGE,
  loadProductionCompose,
  validateComposeFileSelection,
  validateProductionCompose,
  validateStaticConfigSelection,
} = require('../../scripts/validate-production-compose.cjs');

function loadMode(mode, selectedStaticConfig) {
  const contract = MODE_CONTRACTS[mode];
  const composePaths = [resolve(BASE_COMPOSE)];
  if (contract.override) composePaths.push(resolve(contract.override));
  return loadProductionCompose({
    cwd: process.cwd(),
    composePaths,
    envFile: resolve('.env.production.example'),
    environment: {
      API_IMAGE: API_RELEASE_BINDINGS.current.image,
      ...(selectedStaticConfig === undefined
        ? {}
        : { TRAEFIK_PUBLIC_HTTP_CONFIG: selectedStaticConfig }),
    },
  });
}

const loaded = loadMode('base');
const modes = Object.fromEntries(
  Object.keys(MODE_CONTRACTS).map((mode) => [mode, loadMode(mode)]),
);

test('renders and validates the complete production Compose contract', () => {
  assert.equal(loaded.status, 'passed', loaded.failures.join('\n'));
  assert.deepEqual(validateProductionCompose(loaded.config, loaded.rawConfig), {
    status: 'passed',
    serviceNames: ['api', 'migrate', 'postgres', 'traefik'],
    failures: [],
  });
});

test('pins every image by approved digest for linux/amd64', () => {
  assert.equal(
    loaded.config.services.api.image,
    API_RELEASE_BINDINGS.current.image,
  );
  assert.equal(
    loaded.config.services.migrate.image,
    API_RELEASE_BINDINGS.current.image,
  );
  assert.equal(loaded.rawConfig.services.api.image, API_IMAGE_EXPRESSION);
  assert.equal(loaded.rawConfig.services.migrate.image, API_IMAGE_EXPRESSION);
  assert.deepEqual(API_RELEASE_BINDINGS.current, {
    applicationRevision: 'ac2f8cd96ae02c1cad52366871bdde8ca651631d',
    image:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:c53b283571955fa4ad2a056270bbc4b03222028e56d5177208c1a788696149f7',
    configDigest:
      'sha256:17e5b82451b78a20c6934b5dc2bb0cc00fa10252665245ed49b2f7c09a7fc629',
  });
  assert.deepEqual(API_RELEASE_BINDINGS.rollback, {
    applicationRevision: '0a56a8aee7c64bda59a1981888418e1ad03950c0',
    image:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb',
    configDigest:
      'sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24',
  });
  assert.notEqual(
    API_RELEASE_BINDINGS.current.image,
    API_RELEASE_BINDINGS.rollback.image,
  );
  assert.equal(loaded.config.services.postgres.image, POSTGRES_IMAGE);
  assert.equal(loaded.config.services.traefik.image, TRAEFIK_IMAGE);
  for (const service of Object.values(loaded.config.services)) {
    assert.equal(service.platform, 'linux/amd64');
    assert.match(service.image, /@sha256:[a-f0-9]{64}$/u);
  }
});

test('requires API_IMAGE explicitly with no Compose fallback', () => {
  const missing = loadProductionCompose({
    cwd: process.cwd(),
    composePaths: [resolve(BASE_COMPOSE)],
    envFile: resolve('.env.production.example'),
    environment: { API_IMAGE: '' },
  });
  assert.equal(missing.status, 'failed');
  assert.match(missing.failures.join('\n'), /API_IMAGE is required/u);
});

test('rejects historical harness compatibility metadata from current Compose', () => {
  const rawConfig = structuredClone(loaded.rawConfig);
  rawConfig['x-genesis-historical-release-api-images'] = {
    api: API_RELEASE_BINDINGS.current.image,
    migrate: API_RELEASE_BINDINGS.current.image,
  };
  const validation = validateProductionCompose(loaded.config, rawConfig);
  assert.equal(validation.status, 'failed');
  assert.match(validation.failures.join('\n'), /compatibility adapter/u);
});

test('renders four mutually exclusive binding modes with exact host IPs', () => {
  for (const [mode, modeLoaded] of Object.entries(modes)) {
    assert.equal(modeLoaded.status, 'passed', modeLoaded.failures.join('\n'));
    assert.deepEqual(
      validateProductionCompose(modeLoaded.config, modeLoaded.rawConfig, {
        mode,
      }),
      {
        status: 'passed',
        serviceNames: ['api', 'migrate', 'postgres', 'traefik'],
        failures: [],
      },
    );
    assert.deepEqual(
      (modeLoaded.config.services.traefik.ports ?? []).map((entry) => ({
        host_ip: entry.host_ip,
        target: entry.target,
        published: entry.published,
        protocol: entry.protocol,
      })),
      MODE_CONTRACTS[mode].ports,
    );
    assert.equal(modeLoaded.config.services.api.ports, undefined);
    assert.equal(modeLoaded.config.services.postgres.ports, undefined);
  }
});

test('accepts public-http with staging and production using identical loopback-safe bindings', () => {
  for (const selectedStaticConfig of PUBLIC_HTTP_STATIC_CONFIGS) {
    const modeLoaded = loadMode('public-http', selectedStaticConfig);
    assert.equal(modeLoaded.status, 'passed', modeLoaded.failures.join('\n'));
    assert.deepEqual(
      validateProductionCompose(modeLoaded.config, modeLoaded.rawConfig, {
        mode: 'public-http',
        selectedStaticConfig,
      }),
      {
        status: 'passed',
        serviceNames: ['api', 'migrate', 'postgres', 'traefik'],
        failures: [],
      },
    );
    assert.equal(
      modeLoaded.config.services.traefik.environment.TRAEFIK_STATIC_CONFIG,
      selectedStaticConfig,
    );
    assert.deepEqual(
      modeLoaded.config.services.traefik.ports.map((entry) => ({
        host_ip: entry.host_ip,
        target: entry.target,
        published: entry.published,
        protocol: entry.protocol,
      })),
      MODE_CONTRACTS['public-http'].ports,
    );
    assert.equal(
      modeLoaded.config.services.traefik.ports.some(
        (entry) => entry.host_ip === '0.0.0.0' && entry.target === 443,
      ),
      false,
    );
  }
});

test('rejects every public-http static configuration outside the explicit allowlist', () => {
  for (const selectedStaticConfig of [
    'traefik-internal.yml',
    'arbitrary.yml',
    '/etc/traefik/static/traefik-acme-production.yml',
    '../traefik-acme-production.yml',
    '',
    'traefik-acme-preview.yml',
  ]) {
    const modeLoaded = loadMode('public-http', selectedStaticConfig);
    assert.equal(modeLoaded.status, 'passed', modeLoaded.failures.join('\n'));
    const validation = validateProductionCompose(
      modeLoaded.config,
      modeLoaded.rawConfig,
      {
        mode: 'public-http',
        selectedStaticConfig,
      },
    );
    assert.equal(validation.status, 'failed');
    assert.ok(
      validation.failures.includes(
        'public-http static configuration must be one of: traefik-acme-staging.yml, traefik-acme-production.yml',
      ),
    );
  }
  assert.deepEqual(validateStaticConfigSelection('public-http', undefined), []);
});

test('rejects cumulative modes and unexpected Compose files before rendering', () => {
  assert.deepEqual(
    validateComposeFileSelection([
      BASE_COMPOSE,
      'compose.traefik-internal.yml',
      'compose.traefik-public-http.yml',
    ]),
    ['Compose selection must not combine Traefik binding modes'],
  );
  assert.deepEqual(validateComposeFileSelection([BASE_COMPOSE, 'other.yml']), [
    'Compose selection contains an unexpected file',
  ]);
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
      config.services.api.image = API_RELEASE_BINDINGS.rollback.image;
      config.services.migrate.image = API_RELEASE_BINDINGS.rollback.image;
    },
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
    (config) => {
      config.services.api.environment.TRUST_PROXY_HOPS = '0';
    },
    (config) => {
      config.services.traefik.image = 'traefik:v3.7.9';
    },
    (config) => {
      config.services.traefik.ports = [
        { target: 8080, published: '8080', protocol: 'tcp' },
      ];
    },
    (config) => {
      config.services.traefik.volumes.push({
        type: 'bind',
        source: '/var/run/docker.sock',
        target: '/var/run/docker.sock',
      });
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

test('keeps the edge health-only and ACME states separate and outside Git', () => {
  const dynamic = readFileSync(
    'docker/traefik/dynamic/api-health-only.yml',
    'utf8',
  );
  assert.match(
    dynamic,
    /Host\(`api\.agenciagenesismkt\.com\.br`\) && Path\(`\/health`\) && Method\(`GET`\)/u,
  );
  assert.match(dynamic, /url: http:\/\/api:3000/u);
  for (const forbidden of [
    '/api/v1',
    '/api/v1/health',
    '/api/v1/auth/csrf',
    '/dashboard/',
    '/api/rawdata',
    'POST',
  ]) {
    assert.equal(dynamic.includes(forbidden), false);
  }
  const internal = readFileSync('docker/traefik/traefik-internal.yml', 'utf8');
  const staging = readFileSync(
    'docker/traefik/traefik-acme-staging.yml',
    'utf8',
  );
  const production = readFileSync(
    'docker/traefik/traefik-acme-production.yml',
    'utf8',
  );
  assert.doesNotMatch(internal, /certificatesResolvers|\bacme:/u);
  assert.match(staging, /storage: \/var\/lib\/traefik\/acme-staging\.json/u);
  assert.match(production, /storage: \/var\/lib\/traefik\/acme\.json/u);
  assert.doesNotMatch(staging, /storage: \/var\/lib\/traefik\/acme\.json/u);
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
