const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  existsSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join } = require('node:path');
const test = require('node:test');
const {
  ROOT,
  applySchema,
  safeRelative,
  validateContract,
  validateOverlay,
  validatePointer,
  validateRepository,
  validateStaticOrder,
} = require('../../scripts/validate-api-digest-deployment.cjs');

const SCRIPT = join(
  process.cwd(),
  'docker',
  'production',
  'api-digest-deployment.sh',
);
const CONTRACT = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      'config',
      'production',
      'api-digest-deployment-contract.json',
    ),
    'utf8',
  ),
);
const SCHEMA = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      'schemas',
      'production',
      'api-digest-deployment-contract.v1.schema.json',
    ),
    'utf8',
  ),
);
const BASH =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : 'bash';
const SECRET = 'synthetic-never-real-ghcr-value-09e';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function simulation(scenario, { forcedPath } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'genesis-09e-cleanup-'));
  const parent = join(root, 'run');
  const marker = join(root, 'cleanup.marker');
  mkdirSync(parent);
  const result = spawnSync(
    BASH,
    [
      SCRIPT.replaceAll('\\', '/'),
      '--simulate-credential-cleanup',
      scenario,
      parent.replaceAll('\\', '/'),
      marker.replaceAll('\\', '/'),
    ],
    {
      encoding: 'utf8',
      input: `${SECRET}\n`,
      env: {
        ...process.env,
        GENESIS_09E_FORCED_CONFIG_PATH: forcedPath?.replaceAll('\\', '/') ?? '',
      },
    },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { root, parent, marker, result, output };
}

function assertNoCredentialResidue(parent) {
  assert.deepEqual(
    readdirSync(parent).filter((name) => name.startsWith('genesis-ghcr-09e.')),
    [],
  );
}

test('versioned contract and static executable order are fail-closed', () => {
  assert.deepEqual(validateRepository(), {
    status: 'passed',
    contract: '0.8-MVP-09E.api-digest-deployment.v1',
  });
  validateStaticOrder(readFileSync(SCRIPT, 'utf8'));
});

test('contract rejects external/traversal paths, mutable tags and service expansion', () => {
  assert.equal(
    safeRelative('deployment-state/overlays', 'valid'),
    `${ROOT}/deployment-state/overlays`,
  );
  for (const path of [
    '/tmp/overlay',
    '../overlay',
    'deployment-state/../secrets',
    'deployment-state\\overlay',
  ]) {
    assert.throws(() => safeRelative(path, 'invalid'));
  }
  for (const mutation of [
    (value) => {
      value.root.path = '/opt/genesis';
    },
    (value) => {
      value.service = 'postgres';
    },
    (value) => {
      value.images.target =
        'ghcr.io/arthurportodev/genesis-platform-api:latest';
    },
    (value) => {
      value.policy.allowCredentials = true;
    },
    (value) => {
      value.policy.allowSymlinks = true;
    },
    (value) => {
      value.rollback.source = 'previous-pointer';
    },
  ]) {
    const invalid = clone(CONTRACT);
    mutation(invalid);
    assert.throws(() => validateContract(invalid));
  }
});

test('schema and semantic validator reject extras in every closed nested object', () => {
  applySchema(CONTRACT, SCHEMA, SCHEMA);
  for (const field of [
    'root',
    'state',
    'overlays',
    'pointers',
    'evidence',
    'images',
    'policy',
    'retention',
    'rollback',
  ]) {
    const invalid = clone(CONTRACT);
    invalid[field].unexpected = true;
    assert.throws(() => applySchema(invalid, SCHEMA, SCHEMA), field);
    assert.throws(() => validateContract(invalid), field);
  }
  for (const secretField of [
    'token',
    'credential',
    'password',
    'secret',
    'auth',
  ]) {
    const invalid = clone(CONTRACT);
    invalid.retention[secretField] = 'forbidden';
    assert.throws(() => applySchema(invalid, SCHEMA, SCHEMA));
    assert.throws(() => validateContract(invalid));
  }
});

test('overlay and atomic pointer shapes reject credentials, other services and unknown bundles', () => {
  const target = CONTRACT.images.target;
  const targetName = `deployment-state/overlays/${target.split('sha256:')[1]}`;
  const rollbackName = `deployment-state/overlays/${CONTRACT.images.rollback.split('sha256:')[1]}`;
  validateOverlay({ services: { api: { image: target } } }, target);
  validatePointer(
    { schemaVersion: '1.0.0', current: targetName, previous: rollbackName },
    new Set([targetName, rollbackName]),
  );
  assert.throws(() =>
    validateOverlay(
      { services: { api: { image: target }, postgres: { image: target } } },
      target,
    ),
  );
  assert.throws(() =>
    validateOverlay(
      { services: { api: { image: target, token: 'forbidden' } } },
      target,
    ),
  );
  assert.throws(() =>
    validatePointer(
      { schemaVersion: '1.0.0', current: '../outside', previous: rollbackName },
      new Set([rollbackName]),
    ),
  );
});

for (const [scenario, expectedStatus] of [
  ['normal', 0],
  ['fail-before-login', 41],
  ['fail-after-login', 42],
]) {
  test(`credential cleanup is exact and preserves ${scenario} exit status`, () => {
    const state = simulation(scenario);
    try {
      assert.equal(state.result.status, expectedStatus, state.output);
      assert.equal(readFileSync(state.marker, 'utf8'), 'effective-cleanup\n');
      assertNoCredentialResidue(state.parent);
      assert.equal(state.output.includes(SECRET), false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
}

for (const [signal, expectedStatus] of [
  ['INT', 130],
  ['TERM', 143],
  ['HUP', 129],
]) {
  test(
    `credential cleanup handles ${signal} once with no residue`,
    { timeout: 15_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), 'genesis-09e-signal-'));
      const parent = join(root, 'run');
      const marker = join(root, 'cleanup.marker');
      const ready = join(root, 'ready');
      const input = join(root, 'input');
      mkdirSync(parent);
      writeFileSync(input, `${SECRET}\n`);
      const command = [
        `export GENESIS_09E_READY_FILE='${ready.replaceAll('\\', '/')}'`,
        `exec timeout --preserve-status -s ${signal} 1 bash '${SCRIPT.replaceAll('\\', '/')}' --simulate-credential-cleanup wait-signal '${parent.replaceAll('\\', '/')}' '${marker.replaceAll('\\', '/')}' < '${input.replaceAll('\\', '/')}'`,
      ].join('\n');
      const result = spawnSync(BASH, ['-c', command], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      try {
        assert.equal(result.status, expectedStatus, output);
        assert.equal(readFileSync(marker, 'utf8'), 'effective-cleanup\n');
        assertNoCredentialResidue(parent);
        assert.equal(output.includes(SECRET), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test('invalid broad path and unexpected reparse point are rejected before credential read', () => {
  const broad = simulation('normal', {
    forcedPath: mkdtempSync(join(tmpdir(), 'genesis-09e-broad-')),
  });
  try {
    assert.notEqual(broad.result.status, 0);
    assert.equal(broad.output.includes(SECRET), false);
  } finally {
    rmSync(broad.root, { recursive: true, force: true });
  }

  const root = mkdtempSync(join(tmpdir(), 'genesis-09e-link-'));
  const real = join(root, 'real');
  const link = join(root, 'link');
  mkdirSync(real);
  symlinkSync(real, link, 'junction');
  const linked = simulation('normal', { forcedPath: link });
  try {
    assert.notEqual(linked.result.status, 0);
    assert.equal(linked.output.includes(SECRET), false);
  } finally {
    rmSync(linked.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('state preflight rejects an existing symlink before mutating its external target', () => {
  const root = mkdtempSync(join(tmpdir(), 'genesis-09e-state-link-'));
  const release = join(root, 'release');
  const external = join(root, 'external');
  const sentinel = join(external, 'sentinel');
  mkdirSync(release);
  mkdirSync(external);
  writeFileSync(sentinel, 'outside-bytes\n');
  chmodSync(sentinel, 0o640);
  const before = statSync(sentinel);
  symlinkSync(
    external,
    join(release, 'deployment-state'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = spawnSync(
    BASH,
    [
      SCRIPT.replaceAll('\\', '/'),
      '--simulate-state-preflight',
      release.replaceAll('\\', '/'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GENESIS_09E_TEST_MODE: '1',
        GENESIS_09E_TEST_RELEASE_ROOT: release.replaceAll('\\', '/'),
      },
    },
  );
  try {
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(sentinel, 'utf8'), 'outside-bytes\n');
    const after = statSync(sentinel);
    assert.equal(after.mode, before.mode);
    if (process.platform !== 'win32') {
      assert.equal(after.uid, before.uid);
      assert.equal(after.gid, before.gid);
    }
    assert.deepEqual(readdirSync(external), ['sentinel']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'Linux disposable filesystem rejects symlinks and divergent root metadata without mutation',
  { skip: process.env.GENESIS_09E_LINUX_TESTS !== '1', timeout: 30_000 },
  () => {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--mount',
        `type=bind,src=${SCRIPT.replaceAll('\\', '/')},dst=/repo/api-digest-deployment.sh,readonly`,
        'debian:trixie-slim',
        'bash',
        '-c',
        [
          'set -euo pipefail',
          'mkdir -p /work/release /work/external',
          "printf 'outside-bytes\\n' > /work/external/sentinel",
          'chmod 0640 /work/external/sentinel',
          "before=$(sha256sum /work/external/sentinel | awk '{print $1}')",
          "metadata=$(stat -c '%u:%g:%a' /work/external/sentinel)",
          'ln -s /work/external /work/release/deployment-state',
          'set +e',
          'GENESIS_09E_TEST_MODE=1 GENESIS_09E_TEST_RELEASE_ROOT=/work/release bash /repo/api-digest-deployment.sh --simulate-state-preflight /work/release',
          'status=$?',
          'set -e',
          '[ "$status" -ne 0 ]',
          '[ "$(sha256sum /work/external/sentinel | awk \'{print $1}\')" = "$before" ]',
          '[ "$(stat -c \'%u:%g:%a\' /work/external/sentinel)" = "$metadata" ]',
          '[ "$(find /work/external -mindepth 1 -maxdepth 1 -printf \'%f\\n\')" = sentinel ]',
          'mkdir /work/bad-release',
          'chmod 0775 /work/bad-release',
          "bad_metadata=$(stat -c '%u:%g:%a' /work/bad-release)",
          'set +e',
          'GENESIS_09E_TEST_MODE=1 GENESIS_09E_ENFORCE_ROOT_METADATA=1 GENESIS_09E_TEST_RELEASE_ROOT=/work/bad-release bash /repo/api-digest-deployment.sh --simulate-state-preflight /work/bad-release',
          'bad_status=$?',
          'set -e',
          '[ "$bad_status" -ne 0 ]',
          '[ ! -e /work/bad-release/deployment-state ]',
          '[ "$(stat -c \'%u:%g:%a\' /work/bad-release)" = "$bad_metadata" ]',
          'mkdir /work/bad-owner-release',
          'chmod 0755 /work/bad-owner-release',
          'chown 1234:1234 /work/bad-owner-release',
          "owner_metadata=$(stat -c '%u:%g:%a' /work/bad-owner-release)",
          'set +e',
          'GENESIS_09E_TEST_MODE=1 GENESIS_09E_ENFORCE_ROOT_METADATA=1 GENESIS_09E_TEST_RELEASE_ROOT=/work/bad-owner-release bash /repo/api-digest-deployment.sh --simulate-state-preflight /work/bad-owner-release',
          'owner_status=$?',
          'set -e',
          '[ "$owner_status" -ne 0 ]',
          '[ ! -e /work/bad-owner-release/deployment-state ]',
          '[ "$(stat -c \'%u:%g:%a\' /work/bad-owner-release)" = "$owner_metadata" ]',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  },
);

test(
  'KEEP to rollback to failed redeploy restores the pre-deployment current baseline',
  { skip: process.env.GENESIS_09E_LINUX_TESTS !== '1', timeout: 30_000 },
  () => {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--mount',
        `type=bind,src=${SCRIPT.replaceAll('\\', '/')},dst=/repo/api-digest-deployment.sh,readonly`,
        'debian:trixie-slim',
        'bash',
        '-c',
        [
          'set -euo pipefail',
          'mkdir -p -m 0755 /work/release',
          'set +e',
          'GENESIS_09E_TEST_MODE=1 GENESIS_09E_TEST_RELEASE_ROOT=/work/release bash /repo/api-digest-deployment.sh --simulate-pointer-cycle /work/release /work/rollback.marker',
          'status=$?',
          'set -e',
          '[ "$status" -eq 42 ]',
          '[ "$(cat /work/rollback.marker)" = \'rollback-complete\' ]',
          `expected='{"schemaVersion":"1.0.0","current":"deployment-state/overlays/${CONTRACT.images.rollback.split('sha256:')[1]}","previous":"deployment-state/overlays/${CONTRACT.images.target.split('sha256:')[1]}"}'`,
          '[ "$(cat /work/release/deployment-state/pointers.json)" = "$expected" ]',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  },
);

for (const [scenario, expectedStatus] of [
  ['no-op', 0],
  ['fail-pre-credential', 43],
  ['fail-after-create', 44],
]) {
  test(`raw evidence cleanup leaves no residue for ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'genesis-09e-raw-cleanup-'));
    const parent = join(root, 'run');
    mkdirSync(parent);
    const result = spawnSync(
      BASH,
      [
        SCRIPT.replaceAll('\\', '/'),
        '--simulate-raw-cleanup',
        scenario,
        parent.replaceAll('\\', '/'),
      ],
      { encoding: 'utf8' },
    );
    try {
      assert.equal(
        result.status,
        expectedStatus,
        `${result.stdout}\n${result.stderr}`,
      );
      assert.deepEqual(
        readdirSync(parent).filter((name) =>
          name.startsWith('genesis-09e-logs.'),
        ),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const stage of ['recreate', 'health', 'pointer']) {
  test(`rollback ${stage} failure exits 125 without false completion`, () => {
    const root = mkdtempSync(join(tmpdir(), 'genesis-09e-rollback-'));
    const marker = join(root, 'rollback.marker');
    const result = spawnSync(
      BASH,
      [
        SCRIPT.replaceAll('\\', '/'),
        '--simulate-rollback-failure',
        stage,
        marker.replaceAll('\\', '/'),
      ],
      { encoding: 'utf8' },
    );
    try {
      assert.equal(result.status, 125, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function sanitize(lines) {
  return lines.map(({ at, message }) => {
    let category = 'other';
    if (/fatal|unhandled|uncaught/iu.test(message)) category = 'fatal';
    else if (/database.*(?:error|failed|timeout)|ECONNREFUSED/iu.test(message))
      category = 'database-error';
    else if (/(?:^|[^0-9])5[0-9][0-9](?:[^0-9]|$)/u.test(message))
      category = 'http-5xx';
    return `${at}|${category}`;
  });
}

test('cumulative UTC snapshots cover boundaries and a failed checkpoint creates no gap', () => {
  const started = '2026-08-20T20:00:00.000Z';
  const ended = '2026-08-20T20:15:00.000Z';
  const logs = [
    ['2026-08-20T20:00:00.000Z', 'start body email@example.test'],
    ['2026-08-20T20:02:00.000Z', 'boundary token=hidden'],
    ['2026-08-20T20:02:00.001Z', 'after boundary'],
    ['2026-08-20T20:04:15.000Z', 'between checkpoints'],
    ['2026-08-20T20:05:00.000Z', 'five'],
    ['2026-08-20T20:10:00.000Z', 'ten'],
    ['2026-08-20T20:14:59.999Z', 'before final'],
    ['2026-08-20T20:15:00.000Z', 'exact final'],
  ].map(([at, message]) => ({ at, message }));
  const capture = (until) =>
    sanitize(logs.filter((entry) => entry.at >= started && entry.at <= until));
  const snapshots = [
    capture('2026-08-20T20:00:00.000Z'),
    capture('2026-08-20T20:02:00.000Z'),
    // T+5 capture fails. The cumulative start remains unchanged.
    capture('2026-08-20T20:10:00.000Z'),
    capture(ended),
  ];
  assert.deepEqual(
    snapshots.at(-1).map((line) => line.split('|')[0]),
    logs.map((entry) => entry.at),
  );
  assert.ok(
    snapshots.every((snapshot) =>
      snapshot.every((line) => line.endsWith('|other')),
    ),
  );
  assert.equal(
    snapshots.flat().join('\n').includes('email@example.test'),
    false,
  );
  assert.equal(snapshots.flat().join('\n').includes('token=hidden'), false);
  assert.ok(snapshots.flat().every((line) => line.endsWith('Z|other')));
});

test('real shell collector overlaps exclusive Docker bounds and filters to the closed UTC interval', () => {
  const root = mkdtempSync(join(tmpdir(), 'genesis-09e-log-shell-'));
  const release = join(root, 'release');
  const stub = join(root, 'bin');
  const fixture = join(root, 'fixture.log');
  const invocations = join(root, 'invocations.log');
  const failed = join(root, 'failed.once');
  mkdirSync(join(release, 'deployment-state', 'evidence'), { recursive: true });
  mkdirSync(join(root, 'raw'));
  mkdirSync(stub);
  const started = '2026-08-20T20:00:00.000000000Z';
  const ended = '2026-08-20T20:15:00.000000000Z';
  writeFileSync(
    fixture,
    [
      '2026-08-20T19:59:59.999999999Z before',
      `${started} exact-start request-body=private`,
      '2026-08-20T20:02:00.000000000Z two',
      '2026-08-20T20:02:00.000000001Z after-two',
      '2026-08-20T20:05:00.000000000Z five token=hidden',
      '2026-08-20T20:10:00.000000000Z ten',
      `${ended} exact-end email@example.test`,
      '2026-08-20T20:15:00.000000001Z after',
      '',
    ].join('\n'),
  );
  const dockerStub = join(stub, 'docker');
  writeFileSync(
    dockerStub,
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'since=""; until=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in --since) since="$2"; shift 2 ;; --until) until="$2"; shift 2 ;; *) shift ;; esac',
      'done',
      'printf "%s|%s\\n" "$since" "$until" >> "$GENESIS_09E_INVOCATIONS"',
      'if [ "${GENESIS_09E_FAIL_ONCE:-0}" = 1 ] && [ ! -e "$GENESIS_09E_FAILED_ONCE" ]; then touch "$GENESIS_09E_FAILED_ONCE"; exit 23; fi',
      'awk -v start="$since" -v finish="$until" \'$1 > start && $1 < finish\' "$GENESIS_09E_LOG_FIXTURE"',
      '',
    ].join('\n'),
  );
  chmodSync(dockerStub, 0o755);
  const run = (failOnce) =>
    spawnSync(
      BASH,
      [
        SCRIPT.replaceAll('\\', '/'),
        '--simulate-log-collection',
        root.replaceAll('\\', '/'),
        started,
        ended,
        'final',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stub}${delimiter}${process.env.PATH}`,
          GENESIS_09E_TEST_MODE: '1',
          GENESIS_09E_TEST_RELEASE_ROOT: release.replaceAll('\\', '/'),
          GENESIS_09E_LOG_FIXTURE: fixture.replaceAll('\\', '/'),
          GENESIS_09E_INVOCATIONS: invocations.replaceAll('\\', '/'),
          GENESIS_09E_FAIL_ONCE: failOnce ? '1' : '0',
          GENESIS_09E_FAILED_ONCE: failed.replaceAll('\\', '/'),
        },
      },
    );
  const first = run(true);
  const second = run(true);
  try {
    assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const calls = readFileSync(invocations, 'utf8').trim().split(/\r?\n/u);
    assert.deepEqual(calls, [
      '2026-08-20T19:59:59.999999999Z|2026-08-20T20:15:00.000000001Z',
      '2026-08-20T19:59:59.999999999Z|2026-08-20T20:15:00.000000001Z',
    ]);
    const sanitizedPath = join(
      release,
      'deployment-state',
      'evidence',
      'final.sanitized.log',
    );
    const sanitized = readFileSync(sanitizedPath, 'utf8');
    assert.match(sanitized, new RegExp(`^${started.replaceAll('.', '\\.')}`));
    assert.match(
      sanitized,
      new RegExp(`${ended.replaceAll('.', '\\.')}\\|other\\n$`),
    );
    assert.equal(sanitized.includes('19:59:59'), false);
    assert.equal(sanitized.includes('20:15:00.000000001'), false);
    assert.equal(sanitized.includes('private'), false);
    assert.equal(sanitized.includes('token'), false);
    assert.equal(sanitized.includes('email@'), false);
    if (process.platform !== 'win32') {
      assert.equal(statSync(sanitizedPath).mode & 0o777, 0o600);
      assert.equal(statSync(`${sanitizedPath}.sha256`).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
