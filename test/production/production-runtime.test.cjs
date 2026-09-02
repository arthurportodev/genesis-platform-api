const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');
const {
  POSTGRES_IMAGE,
  SERVICE_SECRETS,
  TRAEFIK_IMAGE,
} = require('../../scripts/validate-production-compose.cjs');

const enabled = process.env.GENESIS_MVP06A_DOCKER_RUNTIME === '1';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    env: process.env,
  });
}

function succeed(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed with ${result.status}: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function composeArgs(project, override, ...args) {
  return [
    'compose',
    '-p',
    project,
    '-f',
    resolve('compose.production.yml'),
    '-f',
    resolve('compose.traefik-internal.yml'),
    '-f',
    override,
    '--env-file',
    resolve('.env.production.example'),
    ...args,
  ];
}

function yamlString(value) {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

function writeSecrets(root, suffix = '') {
  const directory = join(root, `secrets${suffix}`);
  mkdirSync(directory);
  const marker = (name) =>
    `synthetic-mvp05a-${name}-$-space-"quote"-'single'-${'x'.repeat(40)}`;
  const values = {
    postgres_bootstrap_password: marker('bootstrap'),
    database_migration_password: marker('migration'),
    database_runtime_password: marker('runtime'),
    jwt_access_secret: marker('jwt'),
    refresh_token_pepper: marker('pepper'),
    lead_idempotency_keys: JSON.stringify({
      1: Buffer.alloc(32, 7).toString('base64'),
    }),
  };
  for (const [name, value] of Object.entries(values)) {
    writeFileSync(join(directory, name), `${value}\n`, { mode: 0o440 });
  }
  return { directory, values };
}

function writeOverride(root, name, volume, secrets, traefikVolume, extra = '') {
  const path = join(root, `${name}.override.yml`);
  const file = (secret) => yamlString(join(secrets, secret));
  writeFileSync(
    path,
    [
      'services:',
      ...(extra ? [extra] : []),
      '  traefik:',
      '    volumes:',
      '      - type: volume',
      `        source: ${traefikVolume}`,
      '        target: /var/lib/traefik',
      'secrets:',
      `  postgres_bootstrap_password:\n    file: ${file('postgres_bootstrap_password')}`,
      `  database_migration_password:\n    file: ${file('database_migration_password')}`,
      `  database_runtime_password:\n    file: ${file('database_runtime_password')}`,
      `  jwt_access_secret:\n    file: ${file('jwt_access_secret')}`,
      `  refresh_token_pepper:\n    file: ${file('refresh_token_pepper')}`,
      `  lead_idempotency_keys:\n    file: ${file('lead_idempotency_keys')}`,
      'volumes:',
      '  postgres_data:',
      '    external: true',
      `    name: ${volume}`,
      `  ${traefikVolume}:`,
      '    external: true',
      `    name: ${traefikVolume}`,
      '',
    ].join('\n'),
  );
  return path;
}

function initializeTraefikState(volume) {
  succeed('docker', ['volume', 'create', volume]);
  succeed('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    `type=volume,src=${volume},dst=/state`,
    TRAEFIK_IMAGE,
    '-ec',
    'umask 077; : > /state/acme-staging.json; : > /state/acme.json; chmod 0600 /state/acme-staging.json /state/acme.json; stat -c "%F:%a:%n" /state/acme-staging.json /state/acme.json',
  ]);
  const metadata = succeed('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    `type=volume,src=${volume},dst=/state,readonly`,
    TRAEFIK_IMAGE,
    '-ec',
    'stat -c "%F:%a:%n" /state/acme-staging.json /state/acme.json',
  ]);
  assert.match(
    metadata,
    /regular(?: empty)? file:600:\/state\/acme-staging\.json/u,
  );
  assert.match(metadata, /regular(?: empty)? file:600:\/state\/acme\.json/u);
}

function probeHealthOnlyEdge() {
  const script = String.raw`
    const http = require('node:http');
    const cases = [
      ['GET', '/health', 'api.agenciagenesismkt.com.br'],
      ['GET', '/', 'api.agenciagenesismkt.com.br'],
      ['GET', '/api/v1', 'api.agenciagenesismkt.com.br'],
      ['GET', '/api/v1/health', 'api.agenciagenesismkt.com.br'],
      ['GET', '/api/v1/auth/csrf', 'api.agenciagenesismkt.com.br'],
      ['GET', '/dashboard/', 'api.agenciagenesismkt.com.br'],
      ['GET', '/api/rawdata', 'api.agenciagenesismkt.com.br'],
      ['POST', '/health', 'api.agenciagenesismkt.com.br'],
      ['HEAD', '/health', 'api.agenciagenesismkt.com.br'],
      ['GET', '/health', 'different.example.invalid']
    ];
    const probe = ([method, path, host]) => new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1', port: 18080, method, path, headers: { Host: host }
      }, (response) => {
        response.resume();
        response.on('end', () => resolve({
          method, path, host, status: response.statusCode,
          cacheControl: response.headers['cache-control'] ?? null
        }));
      });
      request.on('error', reject);
      request.end();
    });
    Promise.all(cases.map(probe)).then((results) => {
      process.stdout.write(JSON.stringify(results));
    }).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  `;
  return JSON.parse(succeed('node', ['-e', script]));
}

function volumeExists(name) {
  return run('docker', ['volume', 'inspect', name]).status === 0;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertNoSecretValues(text, values) {
  for (const value of Object.values(values)) {
    assert.equal(text.includes(value), false, 'synthetic secret leaked');
  }
}

function inspectService(project, override, service) {
  const id = succeed(
    'docker',
    composeArgs(project, override, 'ps', '-aq', service),
  );
  assert.notEqual(id, '', `${service} container is absent`);
  return JSON.parse(succeed('docker', ['inspect', id]))[0];
}

function psql(project, override, sql) {
  return succeed(
    'docker',
    composeArgs(
      project,
      override,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'genesis_bootstrap',
      '-d',
      'genesis_platform',
      '-Atqc',
      sql,
    ),
  );
}

function runtimeQuery(project, override, sql) {
  return run(
    'docker',
    composeArgs(
      project,
      override,
      'exec',
      '-T',
      'postgres',
      '/bin/sh',
      '-c',
      'PGPASSWORD="$(cat /run/secrets/database_runtime_password)" exec psql -h 127.0.0.1 -U genesis_runtime -d genesis_platform -v ON_ERROR_STOP=1 -c "$1"',
      'runtime-query',
      sql,
    ),
  );
}

function testWrapperRuntime(root, values, suffix) {
  const wrapperRoot = join(root, 'wrapper-secrets');
  mkdirSync(wrapperRoot);
  const migrationPath = resolve('docker/production/migrate-entrypoint.sh');
  const apiPath = resolve('docker/production/api-entrypoint.sh');
  const mount = (source, target) =>
    `type=bind,src=${source.replaceAll('\\', '/')},dst=${target},readonly`;

  const missing = run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    mount(migrationPath, '/wrapper.sh'),
    '--mount',
    mount(wrapperRoot, '/run/secrets'),
    POSTGRES_IMAGE,
    '/wrapper.sh',
    '/bin/true',
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing/u);

  writeFileSync(join(wrapperRoot, 'database_migration_password'), '');
  const empty = run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    mount(migrationPath, '/wrapper.sh'),
    '--mount',
    mount(wrapperRoot, '/run/secrets'),
    POSTGRES_IMAGE,
    '/wrapper.sh',
    '/bin/true',
  ]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /empty/u);

  const special = `${values.database_runtime_password}\n`;
  writeFileSync(
    join(wrapperRoot, 'database_migration_password'),
    `${values.database_migration_password}\n`,
  );
  writeFileSync(join(wrapperRoot, 'database_runtime_password'), `${special}\n`);
  writeFileSync(
    join(wrapperRoot, 'jwt_access_secret'),
    `${values.jwt_access_secret}\n`,
  );
  writeFileSync(
    join(wrapperRoot, 'refresh_token_pepper'),
    `${values.refresh_token_pepper}\n`,
  );
  writeFileSync(
    join(wrapperRoot, 'lead_idempotency_keys'),
    `${values.lead_idempotency_keys}\n`,
  );
  const hashes = succeed('docker', [
    'run',
    '--rm',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    mount(apiPath, '/wrapper.sh'),
    '--mount',
    mount(wrapperRoot, '/run/secrets'),
    POSTGRES_IMAGE,
    '/wrapper.sh',
    '/bin/sh',
    '-c',
    'printf \'%s\' "$DATABASE_PASSWORD" | sha256sum; printf \'%s\' "$JWT_ACCESS_SECRET" | sha256sum; printf \'%s\' "$REFRESH_TOKEN_PEPPER" | sha256sum; printf \'%s\' "$LEAD_IDEMPOTENCY_KEYS" | sha256sum',
  ])
    .split(/\r?\n/u)
    .map((line) => line.split(/\s+/u)[0]);
  assert.deepEqual(hashes, [
    sha(special),
    sha(values.jwt_access_secret),
    sha(values.refresh_token_pepper),
    sha(values.lead_idempotency_keys),
  ]);

  const pid = succeed('docker', [
    'run',
    '--rm',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    mount(migrationPath, '/wrapper.sh'),
    '--mount',
    mount(wrapperRoot, '/run/secrets'),
    POSTGRES_IMAGE,
    '/wrapper.sh',
    '/bin/sh',
    '-c',
    'echo $$',
  ]);
  assert.equal(pid, '1');

  const exitCode = run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    '/bin/sh',
    '--mount',
    mount(migrationPath, '/wrapper.sh'),
    '--mount',
    mount(wrapperRoot, '/run/secrets'),
    POSTGRES_IMAGE,
    '/wrapper.sh',
    '/bin/sh',
    '-c',
    'exit 37',
  ]);
  assert.equal(exitCode.status, 37);

  const signalName = `genesis-mvp05a-signal-${suffix}`;
  try {
    succeed('docker', [
      'run',
      '-d',
      '--name',
      signalName,
      '--entrypoint',
      '/bin/sh',
      '--mount',
      mount(migrationPath, '/wrapper.sh'),
      '--mount',
      mount(wrapperRoot, '/run/secrets'),
      POSTGRES_IMAGE,
      '/wrapper.sh',
      '/bin/sh',
      '-c',
      "trap 'exit 23' TERM; while :; do sleep 1; done",
    ]);
    succeed('docker', ['kill', '--signal', 'TERM', signalName]);
    succeed('docker', ['wait', signalName]);
    assert.equal(
      succeed('docker', [
        'inspect',
        '--format',
        '{{.State.ExitCode}}',
        signalName,
      ]),
      '23',
    );
  } finally {
    run('docker', ['rm', '-f', signalName]);
  }
}

function testSourcedPostgresInit(root, directory, values, suffix) {
  const initPath = resolve('docker/postgres/init-runtime-role.sh');
  const mount = (source, target, readonly = true) =>
    `type=bind,src=${source.replaceAll('\\', '/')},dst=${target}${readonly ? ',readonly' : ''}`;

  for (const scenario of ['success', 'password-psql-failure']) {
    const workspace = join(root, `sourced-init-${scenario}-${suffix}`);
    mkdirSync(workspace);
    const marker = join(workspace, 'cleanup-marker');
    const shouldFail = scenario === 'password-psql-failure';
    const shell = [
      'set -eu',
      'counter=/workspace/psql-counter',
      'marker=/workspace/cleanup-marker',
      'printf \'0\\n\' > "$counter"',
      'unset() {',
      '  case " $* " in',
      '    *" GENESIS_MIGRATION_PASSWORD GENESIS_RUNTIME_PASSWORD "*)',
      '      printf \'cleanup\\n\' >> "$marker"',
      '      ;;',
      '  esac',
      '  command unset "$@"',
      '}',
      'psql() {',
      '  call=$(cat "$counter")',
      '  call=$((call + 1))',
      '  printf \'%s\\n\' "$call" > "$counter"',
      '  case "$call" in',
      "    1) printf '0\\n' ;;",
      `    2) ${shouldFail ? 'return 23' : ':'} ;;`,
      "    3) printf '2\\n' ;;",
      "    4) printf '0\\n' ;;",
      "    5) printf 't\\n' ;;",
      '    *) return 99 ;;',
      '  esac',
      '}',
      'POSTGRES_USER=genesis_bootstrap',
      'DATABASE_MIGRATION_USER=genesis_migration',
      'DATABASE_RUNTIME_ROLE=genesis_runtime',
      'POSTGRES_DB=genesis_platform',
      'POSTGRES_PASSWORD=$(cat /run/secrets/postgres_bootstrap_password)',
      '. /init-runtime-role.sh',
      'test "${GENESIS_MIGRATION_PASSWORD+x}" != x',
      'test "${GENESIS_RUNTIME_PASSWORD+x}" != x',
      'case "$(trap)" in *GENESIS_MIGRATION_PASSWORD*|*GENESIS_RUNTIME_PASSWORD*) exit 97 ;; esac',
    ].join('\n');
    const args = [
      'run',
      '--rm',
      '--name',
      `genesis-mvp05a-sourced-${scenario}-${suffix}`,
      '--entrypoint',
      '/bin/sh',
      '--mount',
      mount(initPath, '/init-runtime-role.sh'),
      '--mount',
      mount(directory, '/run/secrets'),
      '--mount',
      mount(workspace, '/workspace', false),
      POSTGRES_IMAGE,
      '-c',
      shell,
    ];
    assertNoSecretValues(args.join('\n'), values);
    const result = run('docker', args);
    assertNoSecretValues(`${result.stdout}\n${result.stderr}`, values);
    assert.equal(result.status, shouldFail ? 23 : 0, result.stderr);
    assert.equal(
      readFileSync(marker, 'utf8'),
      'cleanup\n',
      `${scenario} must execute credential cleanup exactly once`,
    );
  }
}

function processEnvironmentNames(project, override, service) {
  return succeed(
    'docker',
    composeArgs(
      project,
      override,
      'exec',
      '-T',
      service,
      '/bin/sh',
      '-c',
      "tr '\\000' '\\n' < /proc/1/environ | cut -d= -f1",
    ),
  ).split(/\r?\n/u);
}

function assertInitGuardMutation({
  root,
  directory,
  values,
  suffix,
  label,
  mutate,
  expected,
}) {
  const container = `genesis-mvp05a-guard-${label}-${suffix}`;
  const volume = `genesis-mvp05a-guard-${label}-${suffix}`;
  const source = readFileSync('docker/postgres/init-runtime-role.sh', 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${label} mutation was not applied`);
  const script = join(root, `init-${label}.sh`);
  writeFileSync(script, mutated);
  const mount = (sourcePath, target) =>
    `type=bind,src=${sourcePath.replaceAll('\\', '/')},dst=${target},readonly`;
  try {
    succeed('docker', ['volume', 'create', volume]);
    succeed('docker', [
      'run',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_DB=genesis_guard',
      '-e',
      'POSTGRES_USER=genesis_bootstrap',
      '-e',
      'POSTGRES_PASSWORD_FILE=/run/secrets/postgres_bootstrap_password',
      '-e',
      'DATABASE_MIGRATION_USER=genesis_migration',
      '-e',
      'DATABASE_RUNTIME_ROLE=genesis_runtime',
      '--mount',
      `type=volume,src=${volume},dst=/var/lib/postgresql/data`,
      '--mount',
      mount(script, '/docker-entrypoint-initdb.d/10-production-roles.sh'),
      '--mount',
      mount(directory, '/run/secrets'),
      POSTGRES_IMAGE,
    ]);
    const wait = run('docker', ['wait', container], { timeout: 180_000 });
    assert.equal(wait.status, 0, wait.stderr);
    assert.notEqual(wait.stdout.trim(), '0');
    const logResult = run('docker', ['logs', container]);
    assert.equal(logResult.status, 0, logResult.stderr);
    const logs = `${logResult.stdout}\n${logResult.stderr}`;
    assert.match(logs, expected);
    assertNoSecretValues(logs, values);
  } finally {
    run('docker', ['rm', '-f', container]);
    if (volumeExists(volume)) {
      const removed = run('docker', ['volume', 'rm', volume]);
      assert.equal(removed.status, 0, removed.stderr);
    }
  }
}

test(
  'validates the isolated internal Traefik runtime, health-only edge, privileges and secrets',
  { skip: !enabled, timeout: 900_000 },
  () => {
    const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
    const root = mkdtempSync(join(tmpdir(), 'genesis-mvp06a-runtime-'));
    const project = `genesis-mvp06a-runtime-${suffix}`;
    const failureProject = `genesis-mvp06a-failure-${suffix}`;
    const missingProject = `genesis-mvp06a-missing-${suffix}`;
    const volume = `genesis-mvp06a-runtime-${suffix}`;
    const failureVolume = `genesis-mvp06a-failure-${suffix}`;
    const missingVolume = `genesis-mvp06a-missing-${suffix}`;
    const traefikVolume = `genesis-mvp06a-traefik-${suffix}`;
    const failureTraefikVolume = `genesis-mvp06a-traefik-failure-${suffix}`;
    const missingTraefikVolume = `genesis-mvp06a-traefik-missing-${suffix}`;
    const { directory, values } = writeSecrets(root);
    const override = writeOverride(
      root,
      'runtime',
      volume,
      directory,
      traefikVolume,
    );
    const failureOverride = writeOverride(
      root,
      'failure',
      failureVolume,
      directory,
      failureTraefikVolume,
      "  migrate:\n    command: ['/bin/sh', '-c', 'exit 42']",
    );
    const missingOverride = writeOverride(
      root,
      'missing',
      missingVolume,
      directory,
      missingTraefikVolume,
    );

    assert.equal(
      succeed('docker', [
        'ps',
        '--filter',
        'publish=18080',
        '--format',
        '{{.ID}}',
      ]),
      '',
      'host port 18080 is already in use',
    );
    assert.equal(
      succeed('docker', [
        'ps',
        '--filter',
        'publish=18443',
        '--format',
        '{{.ID}}',
      ]),
      '',
      'host port 18443 is already in use',
    );
    assert.equal(volumeExists('genesis-postgres-data'), false);
    assert.equal(volumeExists(missingVolume), false);
    const missing = run(
      'docker',
      composeArgs(missingProject, missingOverride, 'up', '-d', 'postgres'),
    );
    assert.notEqual(missing.status, 0);
    assert.equal(volumeExists(missingVolume), false);

    try {
      testWrapperRuntime(root, values, suffix);
      testSourcedPostgresInit(root, directory, values, suffix);

      assertInitGuardMutation({
        root,
        directory,
        values,
        suffix,
        label: 'ownership',
        mutate: (source) =>
          source.replace(
            "SELECT format('ALTER DATABASE %I OWNER TO %I', :'database_name', :'migration_role') \\gexec",
            "SELECT 'ownership guard mutation';",
          ),
        expected: /Migration ownership did not converge/u,
      });
      assertInitGuardMutation({
        root,
        directory,
        values,
        suffix,
        label: 'membership',
        mutate: (source) =>
          source.replace(
            "SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migration_role') \\gexec\nSQL",
            "SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migration_role') \\gexec\nSELECT format('GRANT %I TO %I', :'migration_role', :'runtime_role') \\gexec\nSQL",
          ),
        expected: /Unexpected membership involving production roles/u,
      });

      initializeTraefikState(traefikVolume);
      initializeTraefikState(failureTraefikVolume);
      succeed('docker', ['volume', 'create', volume]);
      succeed(
        'docker',
        composeArgs(
          project,
          override,
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '240',
        ),
        { timeout: 360_000 },
      );

      const roleContract = psql(
        project,
        override,
        "SELECT string_agg(rolname || ':' || rolsuper || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolinherit || ':' || rolbypassrls, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('genesis_bootstrap','genesis_migration','genesis_runtime')",
      );
      assert.equal(
        roleContract,
        'genesis_bootstrap:true:true:true:true:true,genesis_migration:false:false:false:false:false,genesis_runtime:false:false:false:false:false',
      );
      assert.equal(
        psql(
          project,
          override,
          "SELECT pg_get_userbyid(datdba) || ':' || (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public') FROM pg_database WHERE datname='genesis_platform'",
        ),
        'genesis_migration:genesis_migration',
      );
      assert.equal(
        psql(
          project,
          override,
          "SELECT count(*) FROM pg_auth_members memberships JOIN pg_roles granted ON granted.oid=memberships.roleid JOIN pg_roles member_role ON member_role.oid=memberships.member WHERE granted.rolname IN ('genesis_bootstrap','genesis_migration','genesis_runtime') OR member_role.rolname IN ('genesis_bootstrap','genesis_migration','genesis_runtime')",
        ),
        '0',
      );
      assert.equal(
        psql(
          project,
          override,
          "SELECT has_database_privilege('public','genesis_platform','CONNECT') || ':' || has_schema_privilege('public','public','CREATE')",
        ),
        'false:false',
      );
      assert.equal(
        psql(
          project,
          override,
          "SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname='pgcrypto'",
        ),
        'genesis_migration',
      );

      const preexisting = run(
        'docker',
        composeArgs(
          project,
          override,
          'exec',
          '-T',
          'postgres',
          '/bin/sh',
          '-c',
          'POSTGRES_PASSWORD="$(cat /run/secrets/postgres_bootstrap_password)" exec /docker-entrypoint-initdb.d/10-production-roles.sh',
        ),
      );
      assert.notEqual(preexisting.status, 0);
      assert.match(
        preexisting.stderr,
        /already exists during first-volume initialization/u,
      );
      assertNoSecretValues(preexisting.stderr, values);

      for (const statement of [
        'CREATE TABLE mvp05a_forbidden(id integer)',
        'CREATE ROLE mvp05a_forbidden',
        'CREATE DATABASE mvp05a_forbidden',
        'SET ROLE genesis_migration',
        'SET ROLE genesis_bootstrap',
      ]) {
        assert.notEqual(runtimeQuery(project, override, statement).status, 0);
      }

      const beforeMigrations = psql(
        project,
        override,
        'SELECT count(*) FROM migrations',
      );
      succeed(
        'docker',
        composeArgs(project, override, 'run', '--rm', 'migrate'),
        { timeout: 240_000 },
      );
      assert.equal(
        psql(project, override, 'SELECT count(*) FROM migrations'),
        beforeMigrations,
      );

      const readiness = succeed(
        'docker',
        composeArgs(
          project,
          override,
          'exec',
          '-T',
          'api',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(async response => { process.stdout.write(response.status + ':' + await response.text()); process.exit(response.ok ? 0 : 1); })",
        ),
      );
      assert.match(readiness, /^200:/u);

      const edgeResults = probeHealthOnlyEdge();
      assert.equal(edgeResults[0].status, 200);
      assert.equal(edgeResults[0].cacheControl, 'no-store');
      for (const result of edgeResults.slice(1)) {
        assert.equal(
          result.status,
          404,
          `${result.method} ${result.host}${result.path} escaped health-only routing`,
        );
      }
      const traefikInspection = inspectService(project, override, 'traefik');
      assert.deepEqual(traefikInspection.NetworkSettings.Ports['80/tcp'], [
        { HostIp: '127.0.0.1', HostPort: '18080' },
      ]);
      assert.deepEqual(traefikInspection.NetworkSettings.Ports['443/tcp'], [
        { HostIp: '127.0.0.1', HostPort: '18443' },
      ]);
      assert.equal(
        traefikInspection.Mounts.some(
          (mount) => mount.Destination === '/var/run/docker.sock',
        ),
        false,
      );

      for (const service of ['postgres', 'migrate', 'api']) {
        const inspection = inspectService(project, override, service);
        const env = inspection.Config.Env.join('\n');
        assertNoSecretValues(env, values);
        for (const forbidden of [
          'POSTGRES_PASSWORD=',
          'DATABASE_MIGRATION_PASSWORD=',
          'DATABASE_RUNTIME_PASSWORD=',
          'DATABASE_PASSWORD=',
          'JWT_ACCESS_SECRET=',
          'REFRESH_TOKEN_PEPPER=',
          'LEAD_IDEMPOTENCY_KEYS=',
        ]) {
          assert.equal(env.includes(forbidden), false);
        }
        const secretTargets = inspection.Mounts.filter((mount) =>
          mount.Destination.startsWith('/run/secrets/'),
        )
          .map((mount) => mount.Destination.slice('/run/secrets/'.length))
          .sort();
        assert.deepEqual(
          secretTargets,
          [...SERVICE_SECRETS[service]].sort(),
          `${service} runtime secret mounts differ from the allowlist`,
        );
      }
      const postgresEnvironmentNames = processEnvironmentNames(
        project,
        override,
        'postgres',
      );
      assert.equal(
        postgresEnvironmentNames.includes('GENESIS_MIGRATION_PASSWORD'),
        false,
      );
      assert.equal(
        postgresEnvironmentNames.includes('GENESIS_RUNTIME_PASSWORD'),
        false,
      );
      const logs = succeed(
        'docker',
        composeArgs(project, override, 'logs', '--no-color'),
      );
      assertNoSecretValues(logs, values);

      succeed('docker', ['volume', 'create', failureVolume]);
      const failed = run(
        'docker',
        composeArgs(
          failureProject,
          failureOverride,
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '180',
        ),
        { timeout: 300_000 },
      );
      assert.notEqual(failed.status, 0);
      const failedApiId = succeed(
        'docker',
        composeArgs(failureProject, failureOverride, 'ps', '-aq', 'api'),
      );
      if (failedApiId) {
        assert.notEqual(
          succeed('docker', [
            'inspect',
            '--format',
            '{{.State.Status}}',
            failedApiId,
          ]),
          'running',
        );
      }

      succeed(
        'docker',
        composeArgs(project, override, 'down', '--remove-orphans'),
      );
      assert.equal(volumeExists(volume), true);
      succeed(
        'docker',
        composeArgs(
          failureProject,
          failureOverride,
          'down',
          '--remove-orphans',
        ),
      );
      assert.equal(volumeExists(failureVolume), true);
    } finally {
      for (const [cleanupProject, cleanupOverride] of [
        [project, override],
        [failureProject, failureOverride],
        [missingProject, missingOverride],
      ]) {
        run(
          'docker',
          composeArgs(
            cleanupProject,
            cleanupOverride,
            'down',
            '--remove-orphans',
          ),
        );
      }
      for (const cleanupVolume of [
        volume,
        failureVolume,
        missingVolume,
        traefikVolume,
        failureTraefikVolume,
        missingTraefikVolume,
      ]) {
        if (volumeExists(cleanupVolume)) {
          const remove = run('docker', ['volume', 'rm', cleanupVolume]);
          assert.equal(remove.status, 0, remove.stderr);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }

    assert.equal(volumeExists('genesis-postgres-data'), false);
    assert.equal(volumeExists(volume), false);
    assert.equal(volumeExists(failureVolume), false);
  },
);
