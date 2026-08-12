const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const CONTRACT_VERSION = '0.8-MVP-07A.v1';
const WINDOW_PLAN_VERSION = '0.8-MVP-07B.window-r.v1';
const POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const API_IMAGE =
  'ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659';
const RUNTIME_FILES = [
  'config/recovery/backup-restore.v1.json',
  'config/recovery/recovery.env.example',
  'config/recovery/window-r-plan.v1.json',
  'docker/recovery/backup-runner.sh',
  'docker/recovery/check-status.sh',
  'docker/recovery/common.sh',
  'docker/recovery/install-pinned-tools.sh',
  'docker/recovery/restore-proof-runner.sh',
  'docker/recovery/retention-runner.sh',
  'docker/recovery/systemd/genesis-backup.service',
  'docker/recovery/systemd/genesis-backup.timer',
  'docs/RECOVERY_RUNBOOK.md',
].sort();

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, ...path.split('/')), 'utf8'));
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRecoveryContract(root = process.cwd()) {
  const cwd = resolve(root);
  const failures = [];
  let contract;
  let plan;
  try {
    contract = readJson(cwd, 'config/recovery/backup-restore.v1.json');
    plan = readJson(cwd, 'config/recovery/window-r-plan.v1.json');
  } catch (error) {
    return {
      status: 'failed',
      failures: [`invalid recovery JSON: ${error.message}`],
    };
  }

  check(
    contract.contractVersion === CONTRACT_VERSION,
    'backup contract version mismatch',
    failures,
  );
  check(
    contract.lifecycle === 'incorporated-not-activated',
    'backup contract must remain inactive',
    failures,
  );
  check(
    contract.database?.majorVersion === 17,
    'PostgreSQL major version must be 17',
    failures,
  );
  check(
    contract.database?.image === POSTGRES_IMAGE,
    'PostgreSQL image must use the approved digest',
    failures,
  );
  check(
    contract.database?.platform === 'linux/amd64',
    'recovery platform must be linux/amd64',
    failures,
  );
  check(
    contract.database?.activeVolumeAccess === 'forbidden',
    'active database volume must be forbidden',
    failures,
  );
  check(
    contract.database?.dump?.format === 'custom',
    'pg_dump format must be custom',
    failures,
  );
  check(
    contract.database?.dump?.compression === 'zstd:6',
    'pg_dump compression must be zstd:6',
    failures,
  );
  check(
    contract.database?.dump?.lockWaitTimeout === '60s',
    'pg_dump lock wait timeout must be explicit',
    failures,
  );
  check(
    contract.database?.dump?.enableRowSecurity === false,
    'row-security-limited dumps must be forbidden',
    failures,
  );
  check(
    contract.database?.restore?.exitOnError === true,
    'pg_restore must exit on error',
    failures,
  );
  check(
    contract.database?.restore?.publishedPorts === 0,
    'restore must publish zero ports',
    failures,
  );
  check(
    contract.paths?.containerSecretGid === 70,
    'recovery container secret group must be 70',
    failures,
  );
  check(
    contract.object?.plaintextHash === 'forbidden',
    'plaintext hashes must be forbidden',
    failures,
  );
  check(
    contract.object?.partialSuffix === '.partial',
    'partial suffix mismatch',
    failures,
  );
  check(
    contract.transport?.account === 'admreserva433@gmail.com',
    'dedicated Drive account mismatch',
    failures,
  );
  check(
    contract.transport?.primaryScope === 'drive.file',
    'primary Drive scope mismatch',
    failures,
  );
  check(
    contract.transport?.fallbackRequiresFutureCredentialGate === true,
    'Drive scope fallback must require a future gate',
    failures,
  );
  check(
    contract.transport?.uploadCompletionIsVerification === false,
    'upload completion cannot be verification',
    failures,
  );
  check(
    contract.transport?.deleteMode === 'trash-only' &&
      contract.transport?.permanentPurge === false,
    'Drive deletion must be trash-only',
    failures,
  );
  check(
    contract.schedule?.frequencyHours === 12,
    'backup frequency must be 12 hours',
    failures,
  );
  check(
    contract.schedule?.businessRpoHours === 24,
    'business RPO must be 24 hours',
    failures,
  );
  check(
    contract.schedule?.staleWarningHours === 18 &&
      contract.schedule?.staleCriticalHours === 24,
    'staleness thresholds mismatch',
    failures,
  );
  check(
    contract.retention?.regularDays === 30 &&
      contract.retention?.checkpointDays === 90,
    'retention ages mismatch',
    failures,
  );
  check(
    contract.retention?.minimumVerifiedCopies === 2,
    'at least two verified copies must be protected',
    failures,
  );
  check(
    contract.retention?.cleanupIdentity === 'exact-path-and-object-id',
    'cleanup must bind exact path and object ID',
    failures,
  );
  check(
    contract.recoveryObjective?.logicalRtoHours === 4,
    'logical RTO must be four hours',
    failures,
  );

  const tools = contract.tools ?? {};
  check(
    same(tools.age, {
      version: '1.3.1',
      architecture: 'linux-amd64',
      source:
        'https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-linux-amd64.tar.gz',
      archiveSha256:
        'bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377',
      binary: '/opt/genesis/recovery/bin/age',
    }),
    'age provenance mismatch',
    failures,
  );
  check(
    same(tools.rclone, {
      version: '1.74.4',
      architecture: 'linux-amd64',
      source:
        'https://downloads.rclone.org/v1.74.4/rclone-v1.74.4-linux-amd64.zip',
      archiveSha256:
        'fe435e0c36228e7c2f116a8701f01127bb1f694005fc11d1f27186c8bca4115d',
      binary: '/opt/genesis/recovery/bin/rclone',
    }),
    'rclone provenance mismatch',
    failures,
  );

  check(
    plan.planVersion === WINDOW_PLAN_VERSION,
    'Window R plan version mismatch',
    failures,
  );
  check(
    plan.status === 'planned-not-authorized',
    'Window R must remain unauthorized',
    failures,
  );
  check(
    plan.requiresCommittedRelease === true,
    'Window R must require a committed release',
    failures,
  );
  check(
    plan.docker?.allowedImage === POSTGRES_IMAGE,
    'Window R PostgreSQL digest mismatch',
    failures,
  );
  check(
    plan.docker?.allowedApiImage === API_IMAGE,
    'Window R API digest mismatch',
    failures,
  );
  check(
    plan.docker?.publishedPorts === 0,
    'Window R restore must publish zero ports',
    failures,
  );
  check(
    plan.docker?.activeVolumeDenylist?.includes('genesis-postgres-data'),
    'active volume denylist is missing',
    failures,
  );
  check(
    plan.forbiddenActions?.includes('permanent-drive-purge'),
    'permanent Drive purge must be forbidden',
    failures,
  );
  check(
    plan.forbiddenActions?.includes('docker-compose-down-v'),
    'destructive Compose teardown must be forbidden',
    failures,
  );
  check(
    plan.stopConditions?.includes('active-volume-reference-detected'),
    'active-volume stop condition is missing',
    failures,
  );
  check(
    plan.attemptLimits?.restoreProof === 2 && plan.attemptLimits?.oauth === 1,
    'Window R attempt limits mismatch',
    failures,
  );
  check(
    plan.committedReleaseIdentity?.bundleMode === 'committed-release',
    'Window R must reject candidate bundles',
    failures,
  );
  check(
    plan.committedReleaseIdentity?.candidateIdentityAllowed === false,
    'Window R candidate identity must be forbidden',
    failures,
  );
  check(
    Array.isArray(plan.credentialClasses) &&
      plan.credentialClasses.every(
        (entry) =>
          entry.valueInPlan === false &&
          entry.reference?.startsWith('/opt/genesis/'),
      ),
    'credential classes must contain references only',
    failures,
  );

  const backup = readFileSync(
    join(cwd, 'docker/recovery/backup-runner.sh'),
    'utf8',
  );
  const restore = readFileSync(
    join(cwd, 'docker/recovery/restore-proof-runner.sh'),
    'utf8',
  );
  const retention = readFileSync(
    join(cwd, 'docker/recovery/retention-runner.sh'),
    'utf8',
  );
  const installer = readFileSync(
    join(cwd, 'docker/recovery/install-pinned-tools.sh'),
    'utf8',
  );
  const service = readFileSync(
    join(cwd, 'docker/recovery/systemd/genesis-backup.service'),
    'utf8',
  );
  const timer = readFileSync(
    join(cwd, 'docker/recovery/systemd/genesis-backup.timer'),
    'utf8',
  );
  check(
    backup.includes('--format=custom') &&
      backup.includes('--compress=zstd:6') &&
      backup.includes('--lock-wait-timeout=60s'),
    'backup runner pg_dump arguments mismatch',
    failures,
  );
  check(
    backup.includes('require_root_control_file "$environment_file"') &&
      restore.includes(
        'require_root_control_file "$release_dir/release-manifest.json"',
      ),
    'recovery control files must be root-owned and non-writable',
    failures,
  );
  check(
    !backup.includes('--enable-row-security'),
    'backup runner must not enable row security',
    failures,
  );
  check(
    backup.includes('.partial') &&
      backup.includes('sha256sum') &&
      backup.indexOf('sha256sum') < backup.indexOf('--immutable copyto'),
    'backup atomic/hash/upload sequence mismatch',
    failures,
  );
  check(
    backup.includes('rolbypassrls') && backup.includes('has_table_privilege'),
    'backup runner lacks RLS completeness proof',
    failures,
  );
  check(
    restore.includes('pg_restore --no-password --exit-on-error'),
    'restore runner must fail closed on pg_restore error',
    failures,
  );
  check(
    restore.includes('--no-owner --role genesis_migration') &&
      restore.includes("pg_get_userbyid(c.relowner)<>'genesis_migration'") &&
      restore.includes("n.nspname='public'") &&
      restore.includes("c.relkind IN ('r','p','S')"),
    'restore runner must converge and verify production ownership',
    failures,
  );
  check(
    backup.includes('/bin/bash "$script_dir/retention-runner.sh" --env-file'),
    'backup runner must invoke bundled retention through bash',
    failures,
  );
  check(
    restore.includes('--expected-source-commit') &&
      restore.includes("m.bundleMode!=='committed-release'") &&
      restore.includes('m.operational!==true'),
    'restore runner must bind an operational committed-release identity',
    failures,
  );
  check(
    restore.includes('network create --internal') &&
      !restore.includes(' --publish '),
    'restore isolation or zero-port contract mismatch',
    failures,
  );
  check(
    restore.includes('/api/v1/health/ready') &&
      restore.includes('/api/v1/health/live'),
    'restore API health smoke is missing',
    failures,
  );
  check(
    restore.includes('--group-add "$RECOVERY_CONTAINER_SECRET_GID"'),
    'restore containers must receive only the approved secret group',
    failures,
  );
  check(
    restore.includes('--remote-object') &&
      restore.includes('--expected-object-id') &&
      restore.includes('remote recovery object identity mismatch') &&
      restore.includes('copyto "$remote_object" "$remote_partial"'),
    'restore runner must download the exact selected remote object',
    failures,
  );
  check(
    !restore.includes('genesis-postgres-data'),
    'restore runner must not reference the active volume',
    failures,
  );
  check(
    retention.includes('--drive-use-trash=true') &&
      !retention.includes('--drive-use-trash=false'),
    'retention must use Drive trash',
    failures,
  );
  check(
    retention.includes('current_marker_id') &&
      retention.includes('current_cipher_id') &&
      retention.includes('retention marker object ID binding mismatch'),
    'retention must reverify exact object IDs',
    failures,
  );
  check(
    !/curl[^\n|]*\|\s*(?:ba)?sh/u.test(installer),
    'installer must not use curl pipe shell',
    failures,
  );
  check(
    installer.includes("age_version='1.3.1'") &&
      installer.includes("rclone_version='1.74.4'"),
    'installer versions are not pinned',
    failures,
  );
  check(
    installer.includes('sha256sum --check --strict'),
    'installer must verify public checksums',
    failures,
  );
  check(
    service.includes('ExecStart=/bin/bash') &&
      service.includes('NoNewPrivileges=true'),
    'systemd service hardening mismatch',
    failures,
  );
  check(
    timer.includes('OnCalendar=*-*-* 00,12:15:00 UTC') &&
      timer.includes('Persistent=true'),
    'systemd 12-hour schedule mismatch',
    failures,
  );

  for (const path of RUNTIME_FILES) {
    try {
      const source = readFileSync(join(cwd, ...path.split('/')), 'utf8');
      check(!source.includes('\r'), `${path} must use LF`, failures);
    } catch (error) {
      failures.push(`missing recovery runtime file ${path}: ${error.message}`);
    }
  }
  return {
    command: 'validate-recovery-contract',
    status: failures.length === 0 ? 'passed' : 'failed',
    contractVersion: contract.contractVersion,
    windowPlanVersion: plan.planVersion,
    runtimeFiles: RUNTIME_FILES,
    failures: [...new Set(failures)].sort(),
  };
}

function main() {
  const result = validateRecoveryContract();
  for (const failure of result.failures) console.error(`FAIL: ${failure}`);
  console.log(JSON.stringify(result));
  if (result.status !== 'passed') process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  API_IMAGE,
  CONTRACT_VERSION,
  POSTGRES_IMAGE,
  RUNTIME_FILES,
  WINDOW_PLAN_VERSION,
  validateRecoveryContract,
};
