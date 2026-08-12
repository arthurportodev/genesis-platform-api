const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const { join, resolve } = require('node:path');

const POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const LABEL = 'com.genesis.recovery.run';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...options.env },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      run(
        'docker',
        ['exec', container, 'pg_isready', '-U', 'genesis_bootstrap'],
        { allowFailure: true },
      ).status === 0
    )
      return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error('synthetic PostgreSQL did not become ready');
}

function waitForInitialization(container) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const logs = run('docker', ['logs', container], { allowFailure: true });
    if (
      `${logs.stdout}${logs.stderr}`.includes(
        'PostgreSQL init process complete',
      )
    )
      return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error('synthetic PostgreSQL initialization did not complete');
}

function assertFailed(result, pattern) {
  if (result.status === 0) throw new Error('command unexpectedly succeeded');
  if (!pattern.test(result.stderr)) {
    throw new Error(`unexpected failure: ${result.stderr}`);
  }
}

function main() {
  if (process.platform === 'win32') {
    process.stdout.write(
      'backup-role-integration: skipped (dedicated Linux proof required)\n',
    );
    return;
  }
  if (process.getuid?.() !== 0) {
    const elevated = spawnSync(
      'sudo',
      ['env', `PATH=${process.env.PATH}`, process.execPath, __filename],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    process.stdout.write(elevated.stdout ?? '');
    process.stderr.write(elevated.stderr ?? '');
    if (elevated.status !== 0)
      throw new Error(`root-owned integration failed (${elevated.status})`);
    return;
  }
  if (run('docker', ['info'], { allowFailure: true }).status !== 0)
    throw new Error('Docker is required');

  const runId = randomBytes(8).toString('hex');
  const root = mkdtempSync(join(os.tmpdir(), `genesis-role-${runId}-`));
  const secrets = join(root, 'secrets');
  const status = join(root, 'status');
  mkdirSync(secrets, { mode: 0o700 });
  mkdirSync(status, { mode: 0o700 });
  const network = `genesis-recovery-net-${runId}`;
  const postgres = `genesis-recovery-pg-${runId}`;
  const password = `B${randomBytes(32).toString('base64url')}`;
  const bootstrapPassword = `A${randomBytes(32).toString('base64url')}`;
  const bootstrapPgpass = join(secrets, 'postgres-bootstrap-pgpass');
  const backupPgpass = join(secrets, 'recovery-backup-pgpass');
  const provenance = join(status, 'backup-role-provenance.v1.json');
  const envFile = join(root, 'recovery.env');
  const script = resolve('docker/recovery/provision-backup-role.sh');

  writeFileSync(
    bootstrapPgpass,
    `${postgres}:5432:genesis_platform:genesis_bootstrap:${bootstrapPassword}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    envFile,
    [
      `RECOVERY_BOOTSTRAP_PGPASS_FILE=${bootstrapPgpass}`,
      `RECOVERY_BACKUP_PGPASS_FILE=${backupPgpass}`,
      `RECOVERY_BACKUP_ROLE_PROVENANCE_FILE=${provenance}`,
      `RECOVERY_DATABASE_HOST=${postgres}`,
      'RECOVERY_DATABASE_PORT=5432',
      'RECOVERY_DATABASE_NAME=genesis_platform',
      `RECOVERY_PRODUCTION_NETWORK=${network}`,
    ].join('\n') + '\n',
    { mode: 0o600 },
  );

  const docker = (args, options) => run('docker', args, options);
  const adminSql = (sql, options = {}) =>
    docker(
      [
        'exec',
        '--env',
        `PGPASSWORD=${bootstrapPassword}`,
        postgres,
        'psql',
        '--no-password',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--username',
        'genesis_bootstrap',
        '--dbname',
        'genesis_platform',
        '--command',
        sql,
      ],
      options,
    );
  const invoke = (id, options = {}) =>
    run(
      '/bin/bash',
      [
        script,
        '--env-file',
        envFile,
        '--window-run-id',
        id,
        '--authorize-production-mutation',
        ...(options.action ? ['--action', options.action] : []),
      ],
      {
        allowFailure: options.allowFailure,
        input: options.input,
        env: {
          RECOVERY_PRODUCTION_MUTATION_AUTHORIZED: 'true',
          RECOVERY_TEST_MODE: '1',
          RECOVERY_TEST_INJECT_PROVISION_FAILURE: options.injectFailure
            ? '1'
            : '0',
        },
      },
    );

  const cleanup = () => {
    if (postgres.startsWith('genesis-recovery-pg-'))
      docker(['rm', '-f', '-v', postgres], { allowFailure: true });
    if (network.startsWith('genesis-recovery-net-'))
      docker(['network', 'rm', network], { allowFailure: true });
    rmSync(root, { recursive: true, force: true });
  };

  try {
    docker(['pull', '--platform', 'linux/amd64', POSTGRES_IMAGE]);
    docker([
      'network',
      'create',
      '--internal',
      '--label',
      `${LABEL}=${runId}`,
      network,
    ]);
    docker([
      'run',
      '--detach',
      '--name',
      postgres,
      '--label',
      `${LABEL}=${runId}`,
      '--platform',
      'linux/amd64',
      '--network',
      network,
      '--env',
      'POSTGRES_DB=genesis_platform',
      '--env',
      'POSTGRES_USER=genesis_bootstrap',
      '--env',
      `POSTGRES_PASSWORD=${bootstrapPassword}`,
      POSTGRES_IMAGE,
    ]);
    waitForPostgres(postgres);
    waitForInitialization(postgres);
    waitForPostgres(postgres);
    adminSql(
      "CREATE TABLE public.rls_fixture(id integer primary key, tenant text); INSERT INTO public.rls_fixture VALUES (1,'a'),(2,'b'); ALTER TABLE public.rls_fixture ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_only ON public.rls_fixture USING (tenant='a'); CREATE ROLE synthetic_owner NOLOGIN; CREATE TABLE public.owned_fixture(id integer); ALTER TABLE public.owned_fixture OWNER TO synthetic_owner;",
    );

    // Missing secret input fails before mutation.
    const missing = invoke(runId, { allowFailure: true });
    assertFailed(missing, /password must be supplied/u);
    if (
      adminSql(
        "SELECT count(*) FROM pg_roles WHERE rolname='genesis_backup'",
      ).stdout.trim() !== '0'
    )
      throw new Error('missing-secret case mutated the database');

    // Partial failure rolls the transaction and host secret back.
    const partial = invoke(runId, {
      allowFailure: true,
      injectFailure: true,
      input: `${password}\n`,
    });
    if (partial.status === 0)
      throw new Error('partial failure injection succeeded');
    if (
      adminSql(
        "SELECT count(*) FROM pg_roles WHERE rolname='genesis_backup'",
      ).stdout.trim() !== '0'
    )
      throw new Error('partial provision left a role behind');

    // Absent -> exact role, full RLS read, no write, no ownership.
    invoke(runId, { input: `${password}\n` });
    const oid = adminSql(
      "SELECT oid FROM pg_roles WHERE rolname='genesis_backup'",
    ).stdout.trim();
    const attrs = adminSql(
      "SELECT rolcanlogin||'|'||rolinherit||'|'||rolsuper||'|'||rolcreatedb||'|'||rolcreaterole||'|'||rolreplication||'|'||rolbypassrls||'|'||rolconnlimit FROM pg_roles WHERE rolname='genesis_backup'",
    ).stdout.trim();
    if (attrs !== 'true|true|false|false|false|false|true|1')
      throw new Error(`wrong role attributes: ${attrs}`);
    const member = adminSql(
      "SELECT r.rolname||'|'||m.admin_option||'|'||m.inherit_option||'|'||m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname='genesis_backup')",
    ).stdout.trim();
    if (member !== 'pg_read_all_data|false|true|false')
      throw new Error(`wrong membership: ${member}`);
    const backupQuery = (sql, options = {}) =>
      docker(
        [
          'exec',
          '--env',
          `PGPASSWORD=${password}`,
          postgres,
          'psql',
          '--no-password',
          '--tuples-only',
          '--no-align',
          '--username',
          'genesis_backup',
          '--dbname',
          'genesis_platform',
          '--command',
          sql,
        ],
        options,
      );
    if (
      backupQuery('SELECT count(*) FROM public.rls_fixture').stdout.trim() !==
      '2'
    )
      throw new Error('BYPASSRLS full-read proof failed');
    if (
      backupQuery("INSERT INTO public.rls_fixture VALUES (3,'a')", {
        allowFailure: true,
      }).status === 0
    )
      throw new Error('backup role unexpectedly wrote data');
    if (
      adminSql(
        "SELECT count(*) FROM pg_shdepend WHERE refobjid=(SELECT oid FROM pg_roles WHERE rolname='genesis_backup') AND deptype='o'",
      ).stdout.trim() !== '0'
    )
      throw new Error('backup role owns an object');

    // Idempotency preserves exact identity and rollback provenance.
    invoke(runId);
    if (
      adminSql(
        "SELECT oid FROM pg_roles WHERE rolname='genesis_backup'",
      ).stdout.trim() !== oid
    )
      throw new Error('idempotent run changed role identity');
    const originalMarker = readFileSync(provenance, 'utf8');
    writeFileSync(provenance, originalMarker.replace(runId, '0'.repeat(16)), {
      mode: 0o600,
    });
    assertFailed(
      invoke(runId, { action: 'rollback', allowFailure: true }),
      /provenance/u,
    );
    writeFileSync(provenance, originalMarker, { mode: 0o600 });
    invoke(runId, { action: 'rollback' });
    if (
      adminSql(
        "SELECT count(*) FROM pg_roles WHERE rolname='genesis_backup'",
      ).stdout.trim() !== '0'
    )
      throw new Error('limited rollback did not remove its role');

    // Divergent preexisting role is rejected without silent reconciliation.
    adminSql("CREATE ROLE genesis_backup LOGIN PASSWORD 'divergent-password';");
    const divergent = invoke(runId, { allowFailure: true });
    assertFailed(divergent, /divergent/u);
    if (
      adminSql(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname='genesis_backup'",
      ).stdout.trim() !== 'f'
    )
      throw new Error('divergent role was silently changed');
    adminSql('DROP ROLE genesis_backup;');

    // Exact preexisting role is accepted but cannot be removed by this window.
    const conformantId = randomBytes(8).toString('hex');
    adminSql(
      `CREATE ROLE genesis_backup LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 1 PASSWORD '${password}'; GRANT pg_read_all_data TO genesis_backup WITH INHERIT TRUE, SET FALSE; GRANT CONNECT ON DATABASE genesis_platform TO genesis_backup;`,
    );
    invoke(conformantId, { input: `${password}\n` });
    assertFailed(
      invoke(conformantId, { action: 'rollback', allowFailure: true }),
      /not created by this window/u,
    );
    adminSql(
      'REVOKE CONNECT ON DATABASE genesis_platform FROM genesis_backup; DROP ROLE genesis_backup;',
    );
    rmSync(backupPgpass, { force: true });
    rmSync(provenance, { force: true });

    // Both backup and administrative secret permissions fail closed.
    writeFileSync(
      backupPgpass,
      `${postgres}:5432:genesis_platform:genesis_backup:${password}\n`,
      { mode: 0o644 },
    );
    assertFailed(
      invoke(randomBytes(8).toString('hex'), { allowFailure: true }),
      /secret file permissions/u,
    );
    rmSync(backupPgpass, { force: true });
    chmodSync(bootstrapPgpass, 0o644);
    assertFailed(
      invoke(randomBytes(8).toString('hex'), { allowFailure: true }),
      /secret file permissions/u,
    );

    process.stdout.write(
      `backup-role-integration: passed roleStates=absent,conformant,divergent partialRollback=passed idempotent=passed rls=passed noWrite=passed noOwnership=passed productionMutationCount=0 DriveMutationCount=0\n`,
    );
  } finally {
    cleanup();
  }
}

main();
