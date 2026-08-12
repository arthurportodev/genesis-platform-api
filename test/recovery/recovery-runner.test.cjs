const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const isWindows = process.platform === 'win32';
const isRoot = !isWindows && process.getuid?.() === 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return result;
}

test(
  'Linux recovery runner tests execute with root-owned fixture semantics',
  { skip: isWindows && 'Linux-only ownership contract' },
  () => {
    assert.equal(
      isRoot,
      true,
      'run the recovery runner suite as root (CI uses sudo)',
    );
  },
);

test(
  'production control files reject a non-root owner',
  { skip: isWindows && 'Linux-only ownership contract' },
  () => {
    assert.equal(isRoot, true, 'fixture ownership setup requires root');
    const root = mkdtempSync(join(os.tmpdir(), 'genesis-recovery-owner-'));
    try {
      const control = join(root, 'recovery.env');
      writeFileSync(control, 'RECOVERY_TEST_MODE=0\n', { mode: 0o644 });
      chownSync(control, 65534, 65534);
      const common = join(process.cwd(), 'docker/recovery/common.sh');
      const result = run('bash', [
        '-c',
        `. '${common}'; require_root_control_file '${control}'`,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /control file must be owned by root/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'fake Drive exercises upload, immutable duplicate rejection, recovery download, and retention',
  { skip: isWindows && 'executed in Linux CI and Docker integration locally' },
  () => {
    const root = mkdtempSync(join(os.tmpdir(), 'genesis-recovery-fake-'));
    try {
      const bin = join(root, 'bin');
      const staging = join(root, 'staging');
      const status = join(root, 'status');
      const secrets = join(root, 'secrets');
      const drive = join(root, 'drive');
      const trash = join(root, 'trash');
      for (const path of [bin, staging, status, secrets, drive, trash])
        mkdirSync(path, { recursive: true });
      const fixtures = join(process.cwd(), 'test/recovery/fixtures');
      for (const [source, target] of [
        ['fake-age.sh', 'age'],
        ['fake-docker.sh', 'docker'],
        ['fake-rclone.sh', 'rclone'],
      ]) {
        cpSync(join(fixtures, source), join(bin, target));
        chmodSync(join(bin, target), 0o755);
      }
      const bundledRecovery = join(root, 'bundle/docker/recovery');
      mkdirSync(bundledRecovery, { recursive: true });
      for (const script of [
        'backup-runner.sh',
        'common.sh',
        'retention-runner.sh',
      ]) {
        cpSync(
          join(process.cwd(), 'docker/recovery', script),
          join(bundledRecovery, script),
        );
        chmodSync(join(bundledRecovery, script), 0o644);
      }
      const recipient = join(root, 'recipient');
      const pgpass = join(secrets, 'pgpass');
      const rcloneConfig = join(secrets, 'rclone.conf');
      writeFileSync(recipient, `age1${'q'.repeat(58)}\n`, { mode: 0o600 });
      writeFileSync(
        pgpass,
        'postgres:5432:genesis_platform:genesis_backup:synthetic\n',
        { mode: 0o600 },
      );
      writeFileSync(rcloneConfig, '[fake]\ntype = local\n', { mode: 0o600 });
      const envFile = join(root, 'recovery.env');
      writeFileSync(
        envFile,
        [
          `RECOVERY_RELEASE_DIR=${process.cwd()}`,
          `RECOVERY_BIN_DIR=${bin}`,
          `RECOVERY_STAGING_DIR=${staging}`,
          `RECOVERY_STATUS_DIR=${status}`,
          `RECOVERY_AGE_RECIPIENT_FILE=${recipient}`,
          `RECOVERY_RCLONE_CONFIG=${rcloneConfig}`,
          'RECOVERY_RCLONE_REMOTE=fake',
          'RECOVERY_REMOTE_ROOT=genesis-recovery',
          `RECOVERY_BACKUP_PGPASS_FILE=${pgpass}`,
          'RECOVERY_BACKUP_DATABASE_USER=genesis_backup',
          'RECOVERY_DATABASE_HOST=postgres',
          'RECOVERY_DATABASE_PORT=5432',
          'RECOVERY_DATABASE_NAME=genesis_platform',
          'RECOVERY_PRODUCTION_NETWORK=genesis_database',
          `RECOVERY_BACKUP_LOCK=${root}/backup.lock`,
          `RECOVERY_RESTORE_LOCK=${root}/restore.lock`,
          `RECOVERY_RESTORE_SECRETS_DIR=${secrets}`,
          '',
        ].join('\n'),
      );
      const environment = {
        ...process.env,
        RECOVERY_TEST_MODE: '1',
        RECOVERY_DOCKER_BIN: join(bin, 'docker'),
        RECOVERY_AGE_BIN: join(bin, 'age'),
        RECOVERY_RCLONE_BIN: join(bin, 'rclone'),
        FAKE_DRIVE_ROOT: drive,
        FAKE_DRIVE_TRASH: trash,
        FAKE_DOCKER_LOG: join(root, 'docker.log'),
        FAKE_RCLONE_LOG: join(root, 'rclone.log'),
        FAKE_RCLONE_STATE: join(root, 'rclone-state'),
        FAKE_RCLONE_SIMULATE_RETRY: '1',
      };
      const runner = join(bundledRecovery, 'backup-runner.sh');
      const first = run(
        'bash',
        [
          runner,
          '--env-file',
          envFile,
          '--mode',
          'regular',
          '--run-id',
          '0123456789abcdef',
        ],
        { env: environment },
      );
      assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
      const remoteDir = join(drive, 'genesis-recovery/regular');
      const remoteFiles = readdirSync(remoteDir).sort();
      assert.equal(
        remoteFiles.filter((name) => name.endsWith('.dump.age')).length,
        1,
      );
      assert.equal(
        remoteFiles.filter((name) => name.endsWith('.verified.json')).length,
        1,
      );
      assert.match(
        readFileSync(join(status, 'backup-status.v1.json'), 'utf8'),
        /"outcome":"passed"/u,
      );
      assert.equal(
        readdirSync(staging).some((name) => name.endsWith('.dump')),
        false,
      );
      const rcloneLog = readFileSync(join(root, 'rclone.log'), 'utf8');
      assert.match(rcloneLog, /--retries 3/u);
      assert.match(rcloneLog, /transient failure retried internally/u);
      assert.match(rcloneLog, /--immutable copyto/u);
      assert.match(rcloneLog, /lsf --files-only --hash MD5 --format hspi/u);

      const ciphertext = remoteFiles.find((name) => name.endsWith('.dump.age'));
      const duplicate = run(
        join(bin, 'rclone'),
        [
          '--immutable',
          'copyto',
          join(remoteDir, ciphertext),
          `fake:genesis-recovery/regular/${ciphertext}`,
        ],
        { env: environment },
      );
      assert.notEqual(duplicate.status, 0);

      const beforeRestricted = readFileSync(join(root, 'rclone.log'), 'utf8');
      const restricted = run(
        'bash',
        [
          runner,
          '--env-file',
          envFile,
          '--mode',
          'regular',
          '--run-id',
          'fedcba9876543210',
        ],
        { env: { ...environment, FAKE_DOCKER_RLS_RESULT: 'incomplete' } },
      );
      assert.notEqual(restricted.status, 0);
      assert.equal(
        readFileSync(join(root, 'rclone.log'), 'utf8'),
        beforeRestricted,
      );
      assert.match(
        readFileSync(join(status, 'backup-status.v1.json'), 'utf8'),
        /"outcome":"failed"/u,
      );

      for (let index = 0; index < 4; index += 1) {
        const stamp = `2025010${index + 1}T000000Z`;
        const name = `genesis-regular-${stamp}-${String(index).repeat(16)}.dump.age`;
        writeFileSync(join(remoteDir, name), `cipher-${index}`);
        const objectId = createHash('sha256')
          .update(`${join(remoteDir, name)}\n`)
          .digest('hex')
          .slice(0, 24);
        writeFileSync(
          join(remoteDir, `${name}.verified.json`),
          JSON.stringify({
            objectPath: `genesis-recovery/regular/${name}`,
            objectId,
          }),
        );
        const old = new Date(Date.now() - (100 - index) * 86400000);
        utimesSync(join(remoteDir, name), old, old);
        utimesSync(join(remoteDir, `${name}.verified.json`), old, old);
      }
      const driftedRetention = run(
        'bash',
        [
          join(process.cwd(), 'docker/recovery/retention-runner.sh'),
          '--env-file',
          envFile,
          '--category',
          'regular',
        ],
        { env: { ...environment, FAKE_RCLONE_ID_DRIFT: '1' } },
      );
      assert.notEqual(driftedRetention.status, 0);
      assert.equal(readdirSync(trash).length, 0);
      rmSync(join(root, 'rclone-state/directory-listed'), { force: true });

      const retention = run(
        'bash',
        [
          join(process.cwd(), 'docker/recovery/retention-runner.sh'),
          '--env-file',
          envFile,
          '--category',
          'regular',
        ],
        { env: environment },
      );
      assert.equal(retention.status, 0, retention.stderr);
      const remainingMarkers = readdirSync(remoteDir).filter(
        (name) => name.includes('202501') && name.endsWith('.verified.json'),
      );
      assert.equal(remainingMarkers.length, 1);
      assert.equal(
        readdirSync(remoteDir).filter((name) => name.endsWith('.verified.json'))
          .length,
        2,
      );
      assert.equal(
        readdirSync(trash).filter((name) => name.includes('202501')).length,
        6,
      );
      assert.ok(
        existsSync(
          join(remoteDir, remainingMarkers[0].replace('.verified.json', '')),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'status thresholds and exact cleanup fail closed',
  { skip: isWindows && 'executed in Linux CI and a local Linux container' },
  () => {
    const root = mkdtempSync(join(os.tmpdir(), 'genesis-recovery-status-'));
    try {
      const statusFile = join(root, 'status.json');
      const checker = join(process.cwd(), 'docker/recovery/check-status.sh');
      const writeStatus = (hoursAgo) => {
        writeFileSync(
          statusFile,
          `${JSON.stringify({ outcome: 'passed', observedAt: new Date(Date.now() - hoursAgo * 3600000).toISOString() })}\n`,
        );
      };
      writeStatus(1);
      assert.equal(
        run('bash', [checker, '--status-file', statusFile]).status,
        0,
      );
      writeStatus(19);
      assert.equal(
        run('bash', [checker, '--status-file', statusFile]).status,
        1,
      );
      writeStatus(25);
      assert.equal(
        run('bash', [checker, '--status-file', statusFile]).status,
        2,
      );
      writeFileSync(
        statusFile,
        '{"outcome":"failed","observedAt":"2026-01-01T00:00:00Z"}\n',
      );
      assert.equal(
        run('bash', [checker, '--status-file', statusFile]).status,
        2,
      );

      const common = join(process.cwd(), 'docker/recovery/common.sh');
      const activeVolume = run('bash', [
        '-c',
        `. '${common}'; exact_remove_volume /bin/false genesis-postgres-data 0123456789abcdef`,
      ]);
      assert.notEqual(activeVolume.status, 0);
      assert.match(activeVolume.stderr, /active production volume is denied/u);

      const fakeDocker = join(root, 'docker');
      writeFileSync(
        fakeDocker,
        '#!/bin/bash\nif [ "$1 $2" = "network inspect" ]; then exit 0; fi\nif [ "$1" = inspect ]; then printf "wrong-run\\n"; exit 0; fi\nexit 1\n',
        { mode: 0o755 },
      );
      chmodSync(fakeDocker, 0o755);
      const wrongPrefix = run('bash', [
        '-c',
        `. '${common}'; exact_remove_network '${fakeDocker}' unexpected-network 0123456789abcdef`,
      ]);
      assert.notEqual(wrongPrefix.status, 0);
      assert.match(
        wrongPrefix.stderr,
        /refusing cleanup outside recovery prefix/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
