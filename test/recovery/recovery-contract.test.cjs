const assert = require('node:assert/strict');
const {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');
const {
  RUNTIME_FILES,
  validateRecoveryContract,
} = require('../../scripts/validate-recovery-contract.cjs');

function fixture() {
  const root = mkdtempSync(join(os.tmpdir(), 'genesis-recovery-contract-'));
  for (const path of RUNTIME_FILES) {
    const target = join(root, ...path.split('/'));
    cpSync(join(process.cwd(), ...path.split('/')), target, {
      recursive: true,
    });
  }
  return root;
}

function mutateJson(root, path, update) {
  const absolute = join(root, ...path.split('/'));
  const value = JSON.parse(readFileSync(absolute, 'utf8'));
  update(value);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

test('the incorporated recovery contract is internally valid', () => {
  assert.deepEqual(validateRecoveryContract().failures, []);
});

for (const scenario of [
  {
    name: 'rejects row-security-limited backup mode',
    path: 'config/recovery/backup-restore.v1.json',
    update: (value) => {
      value.database.dump.enableRowSecurity = true;
    },
    expected: 'row-security-limited dumps must be forbidden',
  },
  {
    name: 'rejects permanent Drive purge',
    path: 'config/recovery/backup-restore.v1.json',
    update: (value) => {
      value.transport.permanentPurge = true;
    },
    expected: 'Drive deletion must be trash-only',
  },
  {
    name: 'rejects a restore port',
    path: 'config/recovery/window-r-plan.v1.json',
    update: (value) => {
      value.docker.publishedPorts = 5432;
    },
    expected: 'Window R restore must publish zero ports',
  },
  {
    name: 'rejects candidate release identity in Window R',
    path: 'config/recovery/window-r-plan.v1.json',
    update: (value) => {
      value.committedReleaseIdentity.candidateIdentityAllowed = true;
    },
    expected: 'Window R candidate identity must be forbidden',
  },
  {
    name: 'rejects credential values in Window R',
    path: 'config/recovery/window-r-plan.v1.json',
    update: (value) => {
      value.credentialClasses[0].valueInPlan = true;
    },
    expected: 'credential classes must contain references only',
  },
  {
    name: 'rejects write-capable backup role contract',
    path: 'config/recovery/backup-restore.v1.json',
    update: (value) => {
      value.database.backupRole.forbiddenCapabilities = ['ownership'];
    },
    expected: 'dedicated backup role contract mismatch',
  },
  {
    name: 'rejects a mutable divergent-role budget',
    path: 'config/recovery/window-r-plan.v1.json',
    update: (value) => {
      value.futureMutationContract.backupRole.divergentStateMutationCount = 1;
    },
    expected: 'future backup-role mutation budget mismatch',
  },
  {
    name: 'rejects OAuth Testing as the required status',
    path: 'config/recovery/backup-restore.v1.json',
    update: (value) => {
      value.transport.oauth.requiredPublishingStatus = 'Testing';
    },
    expected: 'OAuth production-status evidence contract mismatch',
  },
  {
    name: 'rejects broad Drive as primary scope',
    path: 'config/recovery/window-r-plan.v1.json',
    update: (value) => {
      value.futureMutationContract.oauth.primaryScope =
        'https://www.googleapis.com/auth/drive';
    },
    expected: 'future OAuth preflight contract mismatch',
  },
]) {
  test(scenario.name, () => {
    const root = fixture();
    try {
      mutateJson(root, scenario.path, scenario.update);
      assert.ok(
        validateRecoveryContract(root).failures.includes(scenario.expected),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('runtime scripts contain no active-volume or destructive-compose operation', () => {
  const scripts = [
    'docker/recovery/backup-runner.sh',
    'docker/recovery/restore-proof-runner.sh',
    'docker/recovery/retention-runner.sh',
  ]
    .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
    .join('\n');
  assert.doesNotMatch(scripts, /docker\s+compose\s+down\s+-v/u);
  assert.doesNotMatch(
    readFileSync(
      join(process.cwd(), 'docker/recovery/restore-proof-runner.sh'),
      'utf8',
    ),
    /genesis-postgres-data/u,
  );
  assert.doesNotMatch(scripts, /--drive-use-trash=false|purge-permanent/u);
});

test('backup invokes bundled retention through bash without executable-mode dependence', () => {
  const backup = readFileSync(
    join(process.cwd(), 'docker/recovery/backup-runner.sh'),
    'utf8',
  );
  assert.match(
    backup,
    /\/bin\/bash "\$script_dir\/retention-runner\.sh" --env-file/u,
  );
  assert.doesNotMatch(backup, /^"\$script_dir\/retention-runner\.sh"/mu);
});

test('restore copies group-readable pgpass into private container tmpfs', () => {
  const restore = readFileSync(
    join(process.cwd(), 'docker/recovery/restore-proof-runner.sh'),
    'utf8',
  );
  assert.equal(
    (
      restore.match(
        /--tmpfs \/run\/genesis:rw,noexec,nosuid,nodev,size=1m,mode=0700/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (restore.match(/chmod 0600 \/run\/genesis\/pgpass/gu) ?? []).length,
    2,
  );
  assert.equal(
    (restore.match(/export PGPASSFILE=\/run\/genesis\/pgpass/gu) ?? []).length,
    2,
  );
  assert.doesNotMatch(restore, /PGPASSFILE=\/run\/secrets/u);
  assert.match(restore, /inspect --format '\{\{\.State\.Running\}\}'/u);
  assert.match(restore, /logs --tail 100 "\$api"/u);
  assert.match(
    restore,
    /SET ROLE genesis_migration; GRANT CONNECT ON DATABASE genesis_platform TO genesis_runtime; RESET ROLE/u,
  );
  assert.match(
    restore,
    /has_database_privilege\('genesis_runtime',current_database\(\),'CONNECT'\)/u,
  );
});
