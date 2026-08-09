const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const migrate = readFileSync('docker/production/migrate-entrypoint.sh', 'utf8');
const api = readFileSync('docker/production/api-entrypoint.sh', 'utf8');
const init = readFileSync('docker/postgres/init-runtime-role.sh', 'utf8');

function assertWrapper(source, paths, exports) {
  assert.match(source, /^#!\/bin\/sh\nset -eu\n/u);
  assert.doesNotMatch(source, /set -x|printenv|env\s*$/mu);
  assert.match(
    source,
    /secret_with_sentinel=\$\(cat "\$secret_path"; printf x\)/u,
  );
  assert.match(source, /secret_value=\$\{secret_with_sentinel%x\}/u);
  assert.match(source, /secret_value=\$\{secret_value%"\n"\}/u);
  assert.match(source, /exec "\$@"\s*$/u);
  for (const path of paths)
    assert.match(source, new RegExp(path.replaceAll('/', '\\/'), 'u'));
  for (const name of exports) {
    assert.match(source, new RegExp(`export ${name}=\\$secret_value`, 'u'));
  }
}

test('migration wrapper has a fixed path, exact newline handling and terminal exec', () => {
  assertWrapper(
    migrate,
    ['/run/secrets/database_migration_password'],
    ['DATABASE_MIGRATION_PASSWORD'],
  );
});

test('API wrapper exports only its four service secrets from fixed paths', () => {
  assertWrapper(
    api,
    [
      '/run/secrets/database_runtime_password',
      '/run/secrets/jwt_access_secret',
      '/run/secrets/refresh_token_pepper',
      '/run/secrets/lead_idempotency_keys',
    ],
    [
      'DATABASE_PASSWORD',
      'JWT_ACCESS_SECRET',
      'REFRESH_TOKEN_PEPPER',
      'LEAD_IDEMPOTENCY_KEYS',
    ],
  );
  assert.doesNotMatch(api, /DATABASE_MIGRATION_PASSWORD|POSTGRES_PASSWORD/u);
});

test('PostgreSQL init fails closed around role identity and unexpected state', () => {
  assert.match(init, /^#!\/bin\/sh\nset -eu\n/u);
  for (const path of [
    '/run/secrets/postgres_bootstrap_password',
    '/run/secrets/database_migration_password',
    '/run/secrets/database_runtime_password',
  ]) {
    assert.match(init, new RegExp(path.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(
    init,
    /Bootstrap, migration and runtime roles must be distinct/u,
  );
  assert.match(init, /already exists during first-volume initialization/u);
  assert.match(init, /Unexpected membership involving production roles/u);
  assert.match(init, /Migration ownership did not converge/u);
  assert.match(
    init,
    /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/gmu,
  );
  assert.match(init, /REVOKE CONNECT, TEMPORARY ON DATABASE/u);
  assert.match(init, /REVOKE ALL ON SCHEMA public FROM PUBLIC/u);
  assert.match(
    init,
    /trap 'unset GENESIS_MIGRATION_PASSWORD GENESIS_RUNTIME_PASSWORD' EXIT/u,
  );
  const passwordPsqlEnd = init.indexOf('\nSQL\n');
  const explicitCleanup = init.indexOf(
    'unset GENESIS_MIGRATION_PASSWORD GENESIS_RUNTIME_PASSWORD',
    passwordPsqlEnd,
  );
  const trapDisarm = init.indexOf('trap - EXIT', explicitCleanup);
  const contractChecks = init.indexOf('role_contract=', trapDisarm);
  assert.ok(passwordPsqlEnd > 0, 'password-consuming psql must be present');
  assert.ok(
    explicitCleanup > passwordPsqlEnd,
    'credentials must be removed after the password-consuming psql',
  );
  assert.ok(
    trapDisarm > explicitCleanup,
    'the EXIT trap must be disarmed only after explicit cleanup',
  );
  assert.ok(
    contractChecks > trapDisarm,
    'cleanup and trap disarm must precede later contract queries',
  );
  assert.doesNotMatch(init, /set -x|printenv/u);
});
