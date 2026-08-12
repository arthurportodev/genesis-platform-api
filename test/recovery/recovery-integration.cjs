const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
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
const API_IMAGE =
  'ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659';
const AGE_URL =
  'https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-linux-amd64.tar.gz';
const AGE_SHA256 =
  'bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377';
const LABEL = 'com.genesis.recovery.run';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args, { encoding = 'utf8', allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr;
    throw new Error(
      `${command} ${args[0] ?? ''} failed: ${stderr || `exit ${result.status}`}`,
    );
  }
  return result;
}

function docker(args, options) {
  return run('docker', args, options);
}

function mount(source, target, readonly = false) {
  return `type=bind,src=${resolve(source)},dst=${target}${readonly ? ',readonly' : ''}`;
}

function waitFor(check, label, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error(`${label} did not become ready`);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function writeSecret(path, value) {
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

async function main() {
  const startedAt = Date.now();
  const dockerInfo = docker(
    ['info', '--format', '{{.OSType}}/{{.Architecture}}'],
    {
      allowFailure: true,
    },
  );
  if (dockerInfo.status !== 0)
    throw new Error('Docker is required for recovery integration');

  const runId = randomBytes(8).toString('hex');
  const root = mkdtempSync(
    join(os.tmpdir(), `genesis-recovery-integration-${runId}-`),
  );
  const fakeDrive = join(root, 'fake-drive');
  const secrets = join(root, 'secrets');
  mkdirSync(fakeDrive, { recursive: true });
  mkdirSync(secrets, { recursive: true });

  const network = `genesis-recovery-net-${runId}`;
  const sourceVolume = `genesis-recovery-data-${runId}-source`;
  const restoreVolume = `genesis-recovery-data-${runId}-restore`;
  const sourcePg = `genesis-recovery-pg-${runId}-source`;
  const restorePg = `genesis-recovery-pg-${runId}-restore`;
  const api = `genesis-recovery-api-${runId}`;
  const containers = [api, restorePg, sourcePg];
  const volumes = [restoreVolume, sourceVolume];

  const bootstrapPassword = `synthetic-bootstrap-${runId}`;
  const runtimePassword = `synthetic-runtime-${runId}`;
  const bootstrapSecret = join(secrets, 'postgres-bootstrap-password');
  writeSecret(bootstrapSecret, bootstrapPassword);
  writeSecret(join(secrets, 'database-runtime-password'), runtimePassword);
  writeSecret(
    join(secrets, 'jwt-access-secret'),
    `synthetic-jwt-${runId}-${'x'.repeat(32)}`,
  );
  writeSecret(
    join(secrets, 'refresh-token-pepper'),
    `synthetic-pepper-${runId}-${'y'.repeat(32)}`,
  );
  writeSecret(
    join(secrets, 'lead-idempotency-keys'),
    JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64') }),
  );

  const cleanup = () => {
    for (const name of containers) {
      if (!name.startsWith('genesis-recovery-')) continue;
      docker(['rm', '-f', '-v', name], { allowFailure: true });
    }
    for (const name of volumes) {
      if (
        name === 'genesis-postgres-data' ||
        !name.startsWith('genesis-recovery-data-')
      )
        continue;
      docker(['volume', 'rm', name], { allowFailure: true });
    }
    if (network.startsWith('genesis-recovery-net-')) {
      docker(['network', 'rm', network], { allowFailure: true });
    }
    rmSync(root, { recursive: true, force: true });
  };

  try {
    docker(['pull', '--platform', 'linux/amd64', POSTGRES_IMAGE]);
    docker(['pull', '--platform', 'linux/amd64', API_IMAGE]);
    if (process.platform !== 'win32') {
      docker([
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        '--mount',
        mount(secrets, '/secrets'),
        '--entrypoint',
        '/bin/sh',
        POSTGRES_IMAGE,
        '-c',
        'chown 0:70 /secrets/* && chmod 0440 /secrets/*',
      ]);
    }
    docker([
      'network',
      'create',
      '--internal',
      '--label',
      `${LABEL}=${runId}`,
      network,
    ]);
    for (const volume of volumes) {
      docker(['volume', 'create', '--label', `${LABEL}=${runId}`, volume]);
    }

    const startPostgres = (name, volume) => {
      docker([
        'run',
        '--detach',
        '--name',
        name,
        '--label',
        `${LABEL}=${runId}`,
        '--platform',
        'linux/amd64',
        '--network',
        network,
        '--group-add',
        '70',
        '--mount',
        `type=volume,src=${volume},dst=/var/lib/postgresql/data`,
        '--mount',
        mount(
          bootstrapSecret,
          '/run/secrets/postgres-bootstrap-password',
          true,
        ),
        '--env',
        'POSTGRES_DB=genesis_platform',
        '--env',
        'POSTGRES_USER=genesis_bootstrap',
        '--env',
        'POSTGRES_PASSWORD_FILE=/run/secrets/postgres-bootstrap-password',
        POSTGRES_IMAGE,
      ]);
      waitFor(
        () =>
          docker(
            [
              'exec',
              name,
              'pg_isready',
              '-U',
              'genesis_bootstrap',
              '-d',
              'genesis_platform',
            ],
            { allowFailure: true },
          ).status === 0,
        name,
      );
      waitFor(() => {
        const logs = docker(['logs', name], { allowFailure: true });
        return `${logs.stdout}${logs.stderr}`.includes(
          'PostgreSQL init process complete; ready for start up.',
        );
      }, `${name} initialization`);
      waitFor(
        () =>
          docker(
            [
              'exec',
              name,
              'pg_isready',
              '-U',
              'genesis_bootstrap',
              '-d',
              'genesis_platform',
            ],
            { allowFailure: true },
          ).status === 0,
        `${name} final server`,
      );
      const ports = docker([
        'inspect',
        '--format',
        '{{json .HostConfig.PortBindings}}',
        name,
      ]).stdout.trim();
      if (ports !== 'null' && ports !== '{}')
        throw new Error(`${name} published a port`);
    };

    startPostgres(sourcePg, sourceVolume);
    const psql = (container, sql, { allowFailure = false } = {}) =>
      docker(
        [
          'exec',
          '--env',
          `PGPASSWORD=${bootstrapPassword}`,
          container,
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
        { allowFailure },
      );

    psql(
      sourcePg,
      [
        `CREATE ROLE genesis_migration LOGIN PASSWORD 'synthetic-migration-${runId}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
        `CREATE ROLE genesis_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS`,
        `CREATE ROLE rls_reader LOGIN PASSWORD 'synthetic-rls-${runId}' NOSUPERUSER NOBYPASSRLS`,
        'ALTER DATABASE genesis_platform OWNER TO genesis_migration',
        'ALTER SCHEMA public OWNER TO genesis_migration',
        'SET ROLE genesis_migration',
        'CREATE TABLE migrations (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)',
        "INSERT INTO migrations (timestamp, name) VALUES (1, 'SyntheticRecoveryFixture')",
        'CREATE TABLE tenant_records (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, tenant_id text NOT NULL, value text NOT NULL)',
        "INSERT INTO tenant_records (tenant_id, value) VALUES ('tenant-a', 'alpha'), ('tenant-b', 'beta')",
        'ALTER TABLE tenant_records ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE tenant_records FORCE ROW LEVEL SECURITY',
        "CREATE POLICY tenant_isolation ON tenant_records USING (tenant_id = current_setting('app.tenant_id', true))",
        'RESET ROLE',
        'GRANT CONNECT ON DATABASE genesis_platform TO genesis_runtime, rls_reader',
        'GRANT USAGE ON SCHEMA public TO genesis_runtime, rls_reader',
        'GRANT SELECT ON ALL TABLES IN SCHEMA public TO genesis_runtime, rls_reader',
      ].join('; '),
    );

    const restricted = psql(
      sourcePg,
      "SET ROLE rls_reader; SET app.tenant_id='tenant-a'; SELECT count(*) FROM tenant_records; SELECT CASE WHEN (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN 'complete' ELSE 'incomplete' END",
    )
      .stdout.trim()
      .split(/\r?\n/u);
    if (!restricted.includes('1') || !restricted.includes('incomplete')) {
      throw new Error(
        'RLS adversarial fixture did not prove restricted backup failure',
      );
    }
    psql(
      sourcePg,
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM rls_reader; REVOKE USAGE ON SCHEMA public FROM rls_reader; REVOKE CONNECT ON DATABASE genesis_platform FROM rls_reader',
    );
    const complete = psql(
      sourcePg,
      "SELECT CASE WHEN (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND NOT has_table_privilege(current_user,c.oid,'SELECT')) THEN 'complete' ELSE 'incomplete' END",
    ).stdout.trim();
    if (complete !== 'complete')
      throw new Error('complete backup credential proof failed');

    const dump = docker(
      [
        'exec',
        '--env',
        `PGPASSWORD=${bootstrapPassword}`,
        sourcePg,
        'pg_dump',
        '--no-password',
        '--username',
        'genesis_bootstrap',
        '--dbname',
        'genesis_platform',
        '--format=custom',
        '--compress=zstd:6',
        '--lock-wait-timeout=60s',
      ],
      { encoding: null },
    );
    if (dump.stderr.length !== 0 || dump.stdout.length === 0) {
      throw new Error(
        `pg_dump emitted diagnostics or an empty archive: ${dump.stderr.toString('utf8').trim() || 'empty archive'}`,
      );
    }
    const dumpPath = join(root, 'source.dump');
    writeFileSync(dumpPath, dump.stdout, { mode: 0o600 });

    const ageArchive = await download(AGE_URL);
    if (sha256(ageArchive) !== AGE_SHA256)
      throw new Error('age archive checksum mismatch');
    writeFileSync(join(root, 'age.tar.gz'), ageArchive, { mode: 0o600 });
    docker([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--mount',
      mount(root, '/work'),
      '--workdir',
      '/work',
      '--entrypoint',
      'tar',
      POSTGRES_IMAGE,
      '-xzf',
      '/work/age.tar.gz',
    ]);
    docker([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--mount',
      mount(root, '/work'),
      '--workdir',
      '/work',
      '--entrypoint',
      '/work/age/age-keygen',
      POSTGRES_IMAGE,
      '--output',
      '/work/identity',
    ]);
    const recipient = docker([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--mount',
      mount(root, '/work'),
      '--workdir',
      '/work',
      '--entrypoint',
      '/work/age/age-keygen',
      POSTGRES_IMAGE,
      '-y',
      '/work/identity',
    ]).stdout.trim();
    const cipherPath = join(root, 'backup.dump.age');
    docker([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--mount',
      mount(root, '/work'),
      '--workdir',
      '/work',
      '--entrypoint',
      '/work/age/age',
      POSTGRES_IMAGE,
      '--encrypt',
      '--recipient',
      recipient,
      '--output',
      '/work/backup.dump.age.partial',
      '/work/source.dump',
    ]);
    const partial = join(root, 'backup.dump.age.partial');
    const cipherSha = sha256(readFileSync(partial));
    copyFileSync(partial, cipherPath);
    rmSync(partial);
    rmSync(dumpPath);

    const remotePath = join(fakeDrive, 'backup.dump.age');
    copyFileSync(cipherPath, remotePath);
    const downloadedPath = join(root, 'downloaded.dump.age');
    copyFileSync(remotePath, downloadedPath);
    if (sha256(readFileSync(downloadedPath)) !== cipherSha) {
      throw new Error('fake Drive recovery-route SHA-256 mismatch');
    }
    const restoredDump = join(root, 'restored.dump');
    docker([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--mount',
      mount(root, '/work'),
      '--workdir',
      '/work',
      '--entrypoint',
      '/work/age/age',
      POSTGRES_IMAGE,
      '--decrypt',
      '--identity',
      '/work/identity',
      '--output',
      '/work/restored.dump',
      '/work/downloaded.dump.age',
    ]);

    startPostgres(restorePg, restoreVolume);
    psql(
      restorePg,
      [
        `CREATE ROLE genesis_migration LOGIN PASSWORD 'synthetic-migration-${runId}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
        `CREATE ROLE genesis_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS`,
        `CREATE ROLE rls_reader LOGIN PASSWORD 'synthetic-rls-${runId}' NOSUPERUSER NOBYPASSRLS`,
        'ALTER DATABASE genesis_platform OWNER TO genesis_migration',
        'ALTER SCHEMA public OWNER TO genesis_migration',
      ].join('; '),
    );
    docker([
      'run',
      '--rm',
      '--name',
      `genesis-recovery-restore-${runId}`,
      '--label',
      `${LABEL}=${runId}`,
      '--platform',
      'linux/amd64',
      '--network',
      network,
      '--group-add',
      '70',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--mount',
      mount(restoredDump, '/recovery/backup.dump', true),
      '--env',
      `PGPASSWORD=${bootstrapPassword}`,
      POSTGRES_IMAGE,
      'pg_restore',
      '--no-password',
      '--exit-on-error',
      '--no-owner',
      '--role',
      'genesis_migration',
      '--host',
      restorePg,
      '--username',
      'genesis_bootstrap',
      '--dbname',
      'genesis_platform',
      '/recovery/backup.dump',
    ]);
    const verification = psql(
      restorePg,
      "SELECT CASE WHEN (SELECT count(*) FROM migrations)=1 AND (SELECT count(*) FROM tenant_records)=2 AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='tenant_records'::regclass) AND has_table_privilege('genesis_runtime','tenant_records','SELECT') AND pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database()))='genesis_migration' AND pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='public'))='genesis_migration' AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') AND pg_get_userbyid(c.relowner)<>'genesis_migration') THEN 'verified' ELSE 'invalid' END",
    ).stdout.trim();
    if (verification !== 'verified')
      throw new Error(
        'restored ownership, schema, migrations, RLS, or ACL verification failed',
      );

    const apiEntrypoint = join(
      process.cwd(),
      'docker/production/api-entrypoint.sh',
    );
    docker([
      'run',
      '--detach',
      '--name',
      api,
      '--label',
      `${LABEL}=${runId}`,
      '--platform',
      'linux/amd64',
      '--network',
      network,
      '--group-add',
      '70',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--entrypoint',
      '/bin/sh',
      '--mount',
      mount(apiEntrypoint, '/opt/genesis/bin/api-entrypoint.sh', true),
      '--mount',
      mount(
        join(secrets, 'database-runtime-password'),
        '/run/secrets/database_runtime_password',
        true,
      ),
      '--mount',
      mount(
        join(secrets, 'jwt-access-secret'),
        '/run/secrets/jwt_access_secret',
        true,
      ),
      '--mount',
      mount(
        join(secrets, 'refresh-token-pepper'),
        '/run/secrets/refresh_token_pepper',
        true,
      ),
      '--mount',
      mount(
        join(secrets, 'lead-idempotency-keys'),
        '/run/secrets/lead_idempotency_keys',
        true,
      ),
      '--env',
      'NODE_ENV=production',
      '--env',
      'PORT=3000',
      '--env',
      'APP_NAME=Genesis recovery integration',
      '--env',
      'APP_VERSION=0.1.0',
      '--env',
      `DATABASE_HOST=${restorePg}`,
      '--env',
      'DATABASE_PORT=5432',
      '--env',
      'DATABASE_NAME=genesis_platform',
      '--env',
      'DATABASE_USER=genesis_runtime',
      '--env',
      'DATABASE_RUNTIME_ROLE=genesis_runtime',
      '--env',
      'FRONTEND_URL=https://genesis.invalid',
      '--env',
      'TRUST_PROXY_HOPS=1',
      '--env',
      'JWT_ACCESS_EXPIRES_IN=15m',
      '--env',
      'REFRESH_TOKEN_EXPIRES_IN_DAYS=30',
      '--env',
      'API_PUBLIC_REPLICA_COUNT=1',
      '--env',
      'INVITATION_ISSUANCE_READINESS=false',
      '--env',
      'INVITATION_ACCEPTANCE_READINESS=false',
      '--env',
      'INVITATION_ACTIVATION_READINESS=false',
      '--env',
      'INVITATION_WORKER_ENABLED=false',
      '--env',
      'LEAD_FORM_READINESS=false',
      '--env',
      'LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION=1',
      API_IMAGE,
      '/opt/genesis/bin/api-entrypoint.sh',
      'node',
      'dist/main.js',
    ]);
    waitFor(
      () =>
        docker(
          [
            'exec',
            api,
            'node',
            '-e',
            "Promise.all(['/api/v1/health/live','/api/v1/health/ready'].map(p=>fetch('http://127.0.0.1:3000'+p).then(r=>{if(!r.ok)throw Error();return r.json()}))).then(v=>process.exit(v.every(x=>x.status==='ok')?0:1)).catch(()=>process.exit(1))",
          ],
          { allowFailure: true },
        ).status === 0,
      'ephemeral API health/readiness',
    );
    const apiPorts = docker([
      'inspect',
      '--format',
      '{{json .HostConfig.PortBindings}}',
      api,
    ]).stdout.trim();
    if (apiPorts !== 'null' && apiPorts !== '{}')
      throw new Error('ephemeral API published a port');

    let committedRunnerExecuted = false;
    if (process.platform === 'linux') {
      const release = join(root, 'release');
      const runnerStatus = join(root, 'runner-status');
      const runnerStaging = join(root, 'runner-staging');
      const runnerEnv = join(root, 'recovery.env');
      const sourceCommit = 'b'.repeat(40);
      mkdirSync(runnerStatus, { recursive: true });
      mkdirSync(runnerStaging, { recursive: true });
      mkdirSync(join(release, 'docker/postgres'), { recursive: true });
      mkdirSync(join(release, 'docker/production'), { recursive: true });
      copyFileSync(
        join(process.cwd(), 'docker/postgres/init-runtime-role.sh'),
        join(release, 'docker/postgres/init-runtime-role.sh'),
      );
      copyFileSync(
        join(process.cwd(), 'docker/production/api-entrypoint.sh'),
        join(release, 'docker/production/api-entrypoint.sh'),
      );
      writeFileSync(
        join(release, 'release-manifest.json'),
        `${JSON.stringify({
          contractVersion: '0.8-MVP-07A.v2',
          bundleMode: 'committed-release',
          operational: true,
          sourceCommit,
        })}\n`,
      );
      writeSecret(
        join(secrets, 'database-migration-password'),
        `synthetic-migration-${runId}`,
      );
      writeSecret(
        join(secrets, 'restore-bootstrap-pgpass'),
        `*:*:genesis_platform:genesis_bootstrap:${bootstrapPassword}`,
      );
      writeFileSync(
        runnerEnv,
        [
          `RECOVERY_RELEASE_DIR=${release}`,
          `RECOVERY_BIN_DIR=${join(root, 'age')}`,
          `RECOVERY_STAGING_DIR=${runnerStaging}`,
          `RECOVERY_STATUS_DIR=${runnerStatus}`,
          `RECOVERY_AGE_IDENTITY_FILE=${join(secrets, 'recovery-age-identity')}`,
          `RECOVERY_RCLONE_CONFIG=${join(secrets, 'unused-rclone.conf')}`,
          'RECOVERY_RCLONE_REMOTE=fake',
          'RECOVERY_REMOTE_ROOT=genesis-recovery',
          `RECOVERY_RESTORE_LOCK=${join(root, 'runner-restore.lock')}`,
          `RECOVERY_RESTORE_SECRETS_DIR=${secrets}`,
          'RECOVERY_CONTAINER_SECRET_GID=70',
          '',
        ].join('\n'),
      );
      docker([
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        '--mount',
        mount(root, '/work'),
        '--entrypoint',
        '/bin/sh',
        POSTGRES_IMAGE,
        '-c',
        'install -m 0440 -o 0 -g 70 /work/identity /work/secrets/recovery-age-identity && chown 0:0 /work/recovery.env /work/age/age /work/downloaded.dump.age /work/release/release-manifest.json /work/release/docker/postgres/init-runtime-role.sh /work/release/docker/production/api-entrypoint.sh && chmod 0644 /work/recovery.env /work/release/release-manifest.json /work/release/docker/postgres/init-runtime-role.sh /work/release/docker/production/api-entrypoint.sh && chmod 0755 /work/age/age && chmod 0440 /work/downloaded.dump.age && chown 0:70 /work/secrets/* && chmod 0440 /work/secrets/*',
      ]);
      const committedRunner = run(
        'sudo',
        [
          'env',
          ...(process.env.DOCKER_HOST
            ? [`DOCKER_HOST=${process.env.DOCKER_HOST}`]
            : []),
          ...(process.env.DOCKER_TLS_CERTDIR !== undefined
            ? [`DOCKER_TLS_CERTDIR=${process.env.DOCKER_TLS_CERTDIR}`]
            : []),
          'RECOVERY_TEST_MODE=1',
          `RECOVERY_AGE_BIN=${join(root, 'age/age')}`,
          'bash',
          join(process.cwd(), 'docker/recovery/restore-proof-runner.sh'),
          '--env-file',
          runnerEnv,
          '--ciphertext',
          downloadedPath,
          '--expected-sha256',
          cipherSha,
          '--release-dir',
          release,
          '--run-id',
          'c'.repeat(16),
          '--expected-source-commit',
          sourceCommit,
        ],
        { allowFailure: true },
      );
      if (committedRunner.status !== 0) {
        throw new Error(
          `committed restore runner failed: ${committedRunner.stderr}`,
        );
      }
      const status = run('sudo', [
        'cat',
        join(runnerStatus, 'restore-status.v1.json'),
      ]).stdout;
      if (!status.includes('"outcome":"passed"'))
        throw new Error('committed restore runner status did not pass');
      committedRunnerExecuted = true;
    }

    const durationMs = Date.now() - startedAt;
    if (durationMs >= 4 * 60 * 60 * 1000)
      throw new Error('synthetic logical recovery exceeded four hours');
    process.stdout.write(
      `${JSON.stringify({
        command: 'recovery-integration',
        status: 'passed',
        postgresMajor: 17,
        ageVersion: '1.3.1',
        dumpFormat: 'custom',
        compression: 'zstd:6',
        rlsAdversarialFixture: 'passed',
        fakeDriveRoundTrip: 'passed',
        ciphertextSha256Compared: true,
        restoreExitOnError: true,
        ownershipModel: 'genesis_migration-verified',
        schemaMigrationsRlsAcls: 'passed',
        apiHealthReadinessSmoke: 'passed',
        committedRestoreRunner: committedRunnerExecuted
          ? 'passed'
          : 'deferred-to-linux-ci',
        publishedPorts: 0,
        productionMutationCount: 0,
        driveMutationCount: 0,
        durationMs,
      })}\n`,
    );
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
