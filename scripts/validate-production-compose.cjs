const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { basename, resolve } = require('node:path');

const API_RELEASE_BINDINGS = Object.freeze({
  current: Object.freeze({
    applicationRevision: 'ac2f8cd96ae02c1cad52366871bdde8ca651631d',
    image:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:c53b283571955fa4ad2a056270bbc4b03222028e56d5177208c1a788696149f7',
    configDigest:
      'sha256:17e5b82451b78a20c6934b5dc2bb0cc00fa10252665245ed49b2f7c09a7fc629',
  }),
  rollback: Object.freeze({
    applicationRevision: '0a56a8aee7c64bda59a1981888418e1ad03950c0',
    image:
      'ghcr.io/arthurportodev/genesis-platform-api@sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb',
    configDigest:
      'sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24',
  }),
});
const POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const TRAEFIK_IMAGE =
  'traefik@sha256:652929a140a32d7cafafb13c6cdfab5376cfeff800f51397b87b524501ed02a8';
const PLATFORM = 'linux/amd64';
const EXPECTED_SERVICES = ['api', 'migrate', 'postgres', 'traefik'];
const BASE_COMPOSE = 'compose.production.yml';
const FUNCTIONAL_COMPOSE = 'compose.production.functional.yml';
const FUNCTIONAL_SECRET_FILES = {
  origin_proxy_key: '/opt/genesis/secrets/origin-proxy-key',
};
const PUBLIC_HTTP_STATIC_CONFIGS = [
  'traefik-acme-staging.yml',
  'traefik-acme-production.yml',
];
const MODE_CONTRACTS = {
  base: {
    override: null,
    staticConfig: 'traefik-internal.yml',
    ports: [],
  },
  internal: {
    override: 'compose.traefik-internal.yml',
    staticConfig: 'traefik-internal.yml',
    ports: [
      { host_ip: '127.0.0.1', target: 80, published: '18080', protocol: 'tcp' },
      {
        host_ip: '127.0.0.1',
        target: 443,
        published: '18443',
        protocol: 'tcp',
      },
    ],
  },
  'public-http': {
    override: 'compose.traefik-public-http.yml',
    staticConfig: 'traefik-acme-staging.yml',
    staticConfigs: PUBLIC_HTTP_STATIC_CONFIGS,
    ports: [
      { host_ip: '0.0.0.0', target: 80, published: '80', protocol: 'tcp' },
      {
        host_ip: '127.0.0.1',
        target: 443,
        published: '18443',
        protocol: 'tcp',
      },
    ],
  },
  'public-full': {
    override: 'compose.traefik-public-full.yml',
    staticConfig: 'traefik-acme-production.yml',
    ports: [
      { host_ip: '0.0.0.0', target: 80, published: '80', protocol: 'tcp' },
      { host_ip: '0.0.0.0', target: 443, published: '443', protocol: 'tcp' },
    ],
  },
};
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
    "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
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

function validateProductionCompose(
  config,
  rawConfig,
  {
    mode = 'base',
    cwd = process.cwd(),
    selectedStaticConfig,
    functional = false,
  } = {},
) {
  const failures = [];
  const modeContract = MODE_CONTRACTS[mode];
  check(
    Boolean(modeContract),
    `unknown Traefik binding mode: ${mode}`,
    failures,
  );
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
  const expectedSecretFiles = functional
    ? { ...SECRET_FILES, ...FUNCTIONAL_SECRET_FILES }
    : SECRET_FILES;
  checkTopLevelSecrets(config, rawConfig, failures, expectedSecretFiles);

  const postgres = services.postgres ?? {};
  const migrate = services.migrate ?? {};
  const api = services.api ?? {};
  const traefik = services.traefik ?? {};
  const rawPostgres = rawServices.postgres ?? {};
  const rawMigrate = rawServices.migrate ?? {};
  const rawApi = rawServices.api ?? {};
  const rawTraefik = rawServices.traefik ?? {};

  for (const [name, service] of Object.entries(services)) {
    if (name !== 'traefik') {
      check(
        service.ports === undefined,
        `${name} must not publish ports`,
        failures,
      );
    }
    check(!('build' in service), `${name} must not define build`, failures);
    check(
      service.platform === PLATFORM,
      `${name} platform must be ${PLATFORM}`,
      failures,
    );
  }
  check(
    api.image === API_RELEASE_BINDINGS.current.image,
    'api image must use the approved digest',
    failures,
  );
  check(
    migrate.image === API_RELEASE_BINDINGS.current.image,
    'migrate image must use the approved digest',
    failures,
  );
  check(
    postgres.image === POSTGRES_IMAGE,
    'postgres image must use the approved digest',
    failures,
  );
  check(
    traefik.image === TRAEFIK_IMAGE,
    'traefik image must use the approved official digest',
    failures,
  );
  for (const [name, image] of Object.entries({
    api: rawApi.image,
    migrate: rawMigrate.image,
    postgres: rawPostgres.image,
    traefik: rawTraefik.image,
  })) {
    checkImmutableImage(image, name, failures);
  }

  checkNetworks(postgres, ['database'], 'postgres', failures);
  checkNetworks(migrate, ['database'], 'migrate', failures);
  checkNetworks(api, ['database', 'edge'], 'api', failures);
  checkNetworks(traefik, ['edge'], 'traefik', failures);
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
  check(
    traefik.restart === 'unless-stopped',
    'traefik restart policy',
    failures,
  );
  check(api.init === true, 'api must enable init', failures);
  check(migrate.init === true, 'migrate must enable init', failures);
  check(traefik.init === true, 'traefik must enable init', failures);
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
  check(
    traefik.read_only === true,
    'traefik filesystem must be read-only',
    failures,
  );
  checkHardening(api, 'api', failures);
  checkHardening(migrate, 'migrate', failures);
  checkHardening(traefik, 'traefik', failures);
  check(
    sameStringArray(traefik.cap_add, ['NET_BIND_SERVICE']),
    'traefik must add only NET_BIND_SERVICE',
    failures,
  );

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
  for (const [source, target] of [
    [
      'docker/traefik/render-static-config.sh',
      '/etc/traefik/render-static-config.sh',
    ],
    [
      'docker/traefik/traefik-internal.yml',
      '/etc/traefik/static/traefik-internal.yml',
    ],
    [
      'docker/traefik/traefik-acme-staging.yml',
      '/etc/traefik/static/traefik-acme-staging.yml',
    ],
    [
      'docker/traefik/traefik-acme-production.yml',
      '/etc/traefik/static/traefik-acme-production.yml',
    ],
    ['docker/traefik/dynamic', '/etc/traefik/dynamic'],
  ]) {
    checkReadOnlyBind(traefik, source, target, 'traefik', failures);
  }
  check(
    sameStringArray(traefik.entrypoint, [
      '/bin/sh',
      '/etc/traefik/render-static-config.sh',
    ]),
    'traefik wrapper must be invoked by /bin/sh',
    failures,
  );
  check(
    JSON.stringify(traefik.volumes ?? []).includes('/var/lib/traefik') &&
      !JSON.stringify(traefik.volumes ?? []).includes('/var/run/docker.sock'),
    'traefik must mount only external ACME state and never the Docker socket',
    failures,
  );
  check(
    !JSON.stringify(config).includes('/var/run/docker.sock'),
    'Docker socket is forbidden anywhere in production Compose',
    failures,
  );

  check(
    postgres.environment?.POSTGRES_PASSWORD_FILE ===
      '/run/secrets/postgres_bootstrap_password',
    'postgres must use POSTGRES_PASSWORD_FILE',
    failures,
  );
  const expectedServiceSecrets = functional
    ? { ...SERVICE_SECRETS, traefik: ['origin_proxy_key'] }
    : SERVICE_SECRETS;
  checkServiceSecrets(services, failures, expectedServiceSecrets);
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
    api.environment?.FRONTEND_URL === 'https://app.agenciagenesismkt.com.br',
    'frontend origin must match the single approved production origin',
    failures,
  );
  check(
    String(api.environment?.WEB_PROXY_ATTESTATION_ENABLED) ===
      String(functional),
    `functional API attestation must be ${functional ? 'enabled' : 'disabled'}`,
    failures,
  );
  if (functional) {
    checkGroup(traefik, 'traefik', failures);
    check(
      traefik.environment?.ORIGIN_PROXY_KEY_FILE ===
        '/run/secrets/origin_proxy_key',
      'traefik origin key must use its mounted secret file',
      failures,
    );
  } else {
    check(
      !Array.isArray(traefik.group_add) || traefik.group_add.length === 0,
      'base traefik must not receive an extra host group',
      failures,
    );
    check(
      traefik.environment?.ORIGIN_PROXY_KEY_FILE === undefined,
      'base traefik must not receive the functional origin key path',
      failures,
    );
  }
  check(
    String(api.environment?.TRUST_PROXY_HOPS) === '1',
    'API must trust exactly one Traefik proxy hop',
    failures,
  );
  failures.push(...validateStaticConfigSelection(mode, selectedStaticConfig));
  const allowedStaticConfigs = modeContract?.staticConfigs ?? [
    modeContract?.staticConfig,
  ];
  check(
    allowedStaticConfigs.includes(traefik.environment?.TRAEFIK_STATIC_CONFIG),
    `traefik static configuration does not match ${mode}`,
    failures,
  );
  check(
    traefik.environment?.ACME_EMAIL === 'acme-contact-required@genesis.invalid',
    'ACME email must be a required non-secret parameter with the safe example value',
    failures,
  );
  check(
    traefik.depends_on?.api?.condition === 'service_healthy',
    'traefik must wait for the healthy API',
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
  checkResources(traefik, 0.5, 256 * 1024 ** 2, 128, 'traefik', failures);
  checkTraefikPorts(services, modeContract?.ports ?? [], failures);
  validateTraefikSources(cwd, failures);
  for (const [name, service] of Object.entries({
    api,
    migrate,
    postgres,
    traefik,
  })) {
    checkLogging(service, name, failures);
  }

  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    serviceNames: names,
    failures,
  };
}

function checkTraefikPorts(services, expected, failures) {
  const actual = Array.isArray(services.traefik?.ports)
    ? services.traefik.ports.map((entry) => ({
        host_ip: entry.host_ip,
        target: Number(entry.target),
        published: String(entry.published),
        protocol: entry.protocol,
      }))
    : [];
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    'Traefik bindings do not match the selected exclusive mode',
    failures,
  );
  for (const [serviceName, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) {
      check(
        typeof port.host_ip === 'string' && port.host_ip.length > 0,
        `${serviceName} contains an implicit wildcard binding`,
        failures,
      );
      check(
        !String(port.host_ip).includes('::'),
        `${serviceName} contains a forbidden IPv6 wildcard binding`,
        failures,
      );
      check(
        serviceName === 'traefik' && [80, 443].includes(Number(port.target)),
        `${serviceName} publishes a forbidden target port`,
        failures,
      );
      check(
        ![3000, 5432, 8080].includes(Number(port.published)),
        `${serviceName} publishes forbidden host port ${port.published}`,
        failures,
      );
    }
  }
}

function validateTraefikSources(cwd, failures) {
  const paths = {
    base: 'compose.production.yml',
    internalOverride: 'compose.traefik-internal.yml',
    publicHttpOverride: 'compose.traefik-public-http.yml',
    publicFullOverride: 'compose.traefik-public-full.yml',
    render: 'docker/traefik/render-static-config.sh',
    internal: 'docker/traefik/traefik-internal.yml',
    staging: 'docker/traefik/traefik-acme-staging.yml',
    production: 'docker/traefik/traefik-acme-production.yml',
    dynamic: 'docker/traefik/dynamic/api-health-only.yml',
  };
  const sources = {};
  for (const [name, path] of Object.entries(paths)) {
    try {
      sources[name] = readFileSync(resolve(cwd, path), 'utf8');
    } catch (error) {
      failures.push(
        `required Traefik source is unavailable: ${path}: ${error.message}`,
      );
    }
  }
  if (Object.keys(sources).length !== Object.keys(paths).length) return;

  const traefikBase =
    sources.base.match(/\n  traefik:[\s\S]*?\n  postgres:/u)?.[0] ?? '';
  check(
    !/^\s+ports:/mu.test(traefikBase),
    'base Traefik service must not define ports',
    failures,
  );
  for (const [name, source] of [
    ['internal', sources.internalOverride],
    ['public-http', sources.publicHttpOverride],
    ['public-full', sources.publicFullOverride],
  ]) {
    check(
      /ports:\s*!override/u.test(source),
      `${name} override must replace the port list integrally`,
      failures,
    );
    check(
      !/\[::\]|host_ip:\s*::/u.test(source),
      `${name} override contains IPv6 wildcard`,
      failures,
    );
  }

  for (const [name, source] of [
    ['internal', sources.internal],
    ['staging', sources.staging],
    ['production', sources.production],
  ]) {
    check(
      /dashboard:\s*false/u.test(source),
      `${name} must disable the dashboard`,
      failures,
    );
    check(
      /insecure:\s*false/u.test(source),
      `${name} must disable insecure API exposure`,
      failures,
    );
    check(
      /providers:\s*\n\s+file:/u.test(source),
      `${name} must use the file provider`,
      failures,
    );
    check(
      !/docker:/u.test(source),
      `${name} must not enable the Docker provider`,
      failures,
    );
    check(
      !/:8080\b/u.test(source),
      `${name} must not define port 8080`,
      failures,
    );
    check(
      (source.match(/forwardedHeaders:\s*\n\s+insecure:\s*false/gu) ?? [])
        .length === 2,
      `${name} must disable insecure forwarded headers on both entrypoints`,
      failures,
    );
  }
  check(
    !/certificatesResolvers:|\bacme:/u.test(sources.internal),
    'internal config must keep ACME disabled',
    failures,
  );
  check(
    /__ACME_EMAIL__/u.test(sources.staging),
    'staging config must require rendered ACME email',
    failures,
  );
  check(
    /__ACME_EMAIL__/u.test(sources.production),
    'production config must require rendered ACME email',
    failures,
  );
  check(
    /acme-staging-v02\.api\.letsencrypt\.org/u.test(sources.staging),
    "staging config must use the Let's Encrypt staging CA",
    failures,
  );
  check(
    /acme-v02\.api\.letsencrypt\.org/u.test(sources.production),
    "production config must use the Let's Encrypt production CA",
    failures,
  );
  check(
    /storage:\s*\/var\/lib\/traefik\/acme-staging\.json/u.test(sources.staging),
    'staging ACME state path is invalid',
    failures,
  );
  check(
    /storage:\s*\/var\/lib\/traefik\/acme\.json/u.test(sources.production),
    'production ACME state path is invalid',
    failures,
  );
  for (const source of [sources.staging, sources.production]) {
    check(
      /httpChallenge:\s*\n\s+entryPoint:\s*web/u.test(source),
      'ACME must use HTTP-01 on the port 80 entrypoint',
      failures,
    );
    check(
      /redirections:[\s\S]*to:\s*websecure/u.test(source),
      'ACME modes must preserve HTTP to HTTPS redirect',
      failures,
    );
    check(
      !/dnsChallenge|TLS_CHALLENGE|tlsChallenge/u.test(source),
      'only HTTP-01 is allowed',
      failures,
    );
  }

  const expectedRule =
    'Host(`api.agenciagenesismkt.com.br`) && Path(`/health`) && Method(`GET`)';
  check(
    sources.dynamic.includes(expectedRule),
    'health-only router rule is not exact',
    failures,
  );
  check(
    /url:\s*http:\/\/api:3000/u.test(sources.dynamic),
    'health-only upstream must be http://api:3000',
    failures,
  );
  check(
    (sources.dynamic.match(/^\s{4}[a-z][a-z0-9-]+:\s*$/gmu) ?? []).length === 2,
    'dynamic config must contain only one router and one service',
    failures,
  );
  for (const forbidden of ['/api/v1', '/dashboard', '/api/rawdata', 'POST']) {
    check(
      !sources.dynamic.includes(forbidden),
      `dynamic config contains forbidden route token ${forbidden}`,
      failures,
    );
  }

  check(
    /case "\$config_name"/u.test(sources.render),
    'render wrapper must allowlist static configurations',
    failures,
  );
  check(
    /ACME_EMAIL must be one safe non-secret email address/u.test(
      sources.render,
    ),
    'render wrapper must validate ACME_EMAIL',
    failures,
  );
  check(
    !/echo .*\$acme_email|printf .*\$acme_email/u.test(sources.render),
    'render wrapper must never log ACME_EMAIL',
    failures,
  );
  for (const forbiddenState of [
    'docker/traefik/acme.json',
    'docker/traefik/acme-staging.json',
  ]) {
    check(
      !existsSync(resolve(cwd, forbiddenState)),
      `${forbiddenState} must remain outside Git`,
      failures,
    );
  }
}

function validateComposeFileSelection(composePaths) {
  const failures = [];
  const names = composePaths.map((entry) => basename(entry));
  check(
    names.filter((name) => name === BASE_COMPOSE).length === 1,
    'Compose selection must contain the base exactly once',
    failures,
  );
  const selectedOverrides = names.filter((name) =>
    Object.values(MODE_CONTRACTS).some(
      (contract) => contract.override === name,
    ),
  );
  check(
    selectedOverrides.length <= 1,
    'Compose selection must not combine Traefik binding modes',
    failures,
  );
  check(
    names.filter((name) => name === FUNCTIONAL_COMPOSE).length <= 1,
    'Compose selection must not repeat the functional proxy extension',
    failures,
  );
  const functionalExtensions = names.filter(
    (name) => name === FUNCTIONAL_COMPOSE,
  );
  check(
    names.length === 1 + selectedOverrides.length + functionalExtensions.length,
    'Compose selection contains an unexpected file',
    failures,
  );
  return failures;
}

function validateStaticConfigSelection(mode, selectedStaticConfig) {
  const failures = [];
  if (mode !== 'public-http') return failures;
  const selected =
    selectedStaticConfig === undefined
      ? MODE_CONTRACTS['public-http'].staticConfig
      : selectedStaticConfig;
  check(
    typeof selected === 'string' &&
      PUBLIC_HTTP_STATIC_CONFIGS.includes(selected),
    `public-http static configuration must be one of: ${PUBLIC_HTTP_STATIC_CONFIGS.join(', ')}`,
    failures,
  );
  return failures;
}

function checkRequiredBindings(services, failures) {
  for (const [serviceName, key, variable] of REQUIRED_BINDINGS) {
    const environment = Object.fromEntries(
      environmentEntries(services[serviceName]?.environment),
    );
    check(
      environment[key] === requiredExpression(variable),
      `${serviceName}.${key} must require ${variable}`,
      failures,
    );
  }
}

function checkNoSecretEnvironment(services, failures) {
  for (const [serviceName, service] of Object.entries(services)) {
    for (const [key, value] of environmentEntries(service?.environment)) {
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

function environmentEntries(environment) {
  if (isPlainObject(environment)) return Object.entries(environment);
  if (!Array.isArray(environment)) return [];
  return environment.map((entry) => {
    const text = String(entry);
    const separator = text.indexOf('=');
    return separator === -1
      ? [text, '']
      : [text.slice(0, separator), text.slice(separator + 1)];
  });
}

function checkTopLevelSecrets(
  config,
  rawConfig,
  failures,
  expectedSecretFiles = SECRET_FILES,
) {
  const actual = Object.keys(config?.secrets ?? {}).sort();
  const expected = Object.keys(expectedSecretFiles).sort();
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    'top-level secret allowlist is invalid',
    failures,
  );
  for (const [name, path] of Object.entries(expectedSecretFiles)) {
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

function checkServiceSecrets(
  services,
  failures,
  expectedServiceSecrets = SERVICE_SECRETS,
) {
  for (const [serviceName, expected] of Object.entries(
    expectedServiceSecrets,
  )) {
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

function loadProductionCompose({
  cwd,
  composePath,
  composePaths,
  envFile,
  environment = {},
}) {
  const paths = composePaths ?? [composePath];
  const failures = validateComposeFileSelection(paths);
  if (failures.length > 0) {
    return {
      status: 'failed',
      failures,
      config: undefined,
      rawConfig: undefined,
    };
  }
  const rendered = runComposeConfig({
    cwd,
    composePaths: paths,
    envFile,
    environment,
  });
  const raw = runComposeConfig({
    cwd,
    composePaths: paths,
    envFile,
    environment,
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
  composePaths,
  envFile,
  environment,
  noInterpolate = false,
}) {
  const args = ['compose', '--env-file', envFile];
  for (const composePath of composePaths) args.push('-f', composePath);
  args.push('config');
  if (noInterpolate) args.push('--no-interpolate');
  args.push('--format', 'json');
  return spawnSync('docker', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function main() {
  const cwd = process.cwd();
  const envFile = process.env.GENESIS_PRODUCTION_ENV_FILE;
  if (!envFile) {
    console.error('FAIL: GENESIS_PRODUCTION_ENV_FILE is required.');
    process.exitCode = 1;
    return;
  }
  const validations = [];
  for (const functional of [false, true]) {
    for (const [mode, contract] of Object.entries(MODE_CONTRACTS)) {
      const composePaths = [resolve(cwd, BASE_COMPOSE)];
      if (functional) composePaths.push(resolve(cwd, FUNCTIONAL_COMPOSE));
      if (contract.override) composePaths.push(resolve(cwd, contract.override));
      const selections =
        mode === 'public-http' ? PUBLIC_HTTP_STATIC_CONFIGS : [undefined];
      for (const selectedStaticConfig of selections) {
        const validationMode = selectedStaticConfig
          ? `${functional ? 'functional+' : ''}${mode}+${selectedStaticConfig}`
          : `${functional ? 'functional+' : ''}${mode}`;
        const loaded = loadProductionCompose({
          cwd,
          composePaths,
          envFile: resolve(cwd, envFile),
          environment:
            selectedStaticConfig === undefined
              ? {}
              : { TRAEFIK_PUBLIC_HTTP_CONFIG: selectedStaticConfig },
        });
        if (loaded.status !== 'passed') {
          validations.push({
            mode: validationMode,
            status: 'failed',
            failures: loaded.failures,
          });
          continue;
        }
        validations.push({
          mode: validationMode,
          ...validateProductionCompose(loaded.config, loaded.rawConfig, {
            mode,
            cwd,
            selectedStaticConfig,
            functional,
          }),
        });
      }
    }
  }
  const failures = validations.flatMap((entry) =>
    entry.failures.map((failure) => `${entry.mode}: ${failure}`),
  );
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  console.log(
    JSON.stringify({
      command: 'npm run production:compose:validate',
      status: failures.length === 0 ? 'passed' : 'failed',
      modes: validations,
      failures,
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  API_RELEASE_BINDINGS,
  BASE_COMPOSE,
  FUNCTIONAL_COMPOSE,
  MODE_CONTRACTS,
  PLATFORM,
  POSTGRES_IMAGE,
  PUBLIC_HTTP_STATIC_CONFIGS,
  TRAEFIK_IMAGE,
  SECRET_FILES,
  SERVICE_SECRETS,
  loadProductionCompose,
  validateComposeFileSelection,
  validateProductionCompose,
  validateStaticConfigSelection,
};
