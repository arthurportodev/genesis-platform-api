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

function observationSimulation(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'genesis-09e-observation-'));
  const release = join(root, 'release');
  const stub = join(root, 'bin');
  const rollbackMarker = join(root, 'rollback.marker');
  const keepMarker = join(root, 'keep.marker');
  const invocations = join(root, 'invocations.log');
  mkdirSync(join(release, 'deployment-state', 'evidence'), { recursive: true });
  mkdirSync(join(release, 'raw'));
  mkdirSync(stub);
  const dockerStub = join(stub, 'docker');
  writeFileSync(
    dockerStub,
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'label="${GENESIS_09E_CHECKPOINT_LABEL:-none}"',
      'scenario="${GENESIS_09E_OBSERVATION_SCENARIO:-success}"',
      'record() { printf "%s:%s\\n" "$1" "$label" >> "$GENESIS_09E_INVOCATIONS"; }',
      'case "${1:-}" in',
      '  inspect)',
      '    case "$*" in',
      '      *".Config.Image}}|"*) record state; restarts=0; health=healthy; [ "$scenario:$label" != restart:t-plus-5 ] || restarts=1; [ "$scenario:$label" != container-health:t-plus-5 ] || health=unhealthy; printf "%s|running|%s|%s\\n" "$GENESIS_09E_TARGET_IMAGE" "$health" "$restarts" ;;',
      '      *"{{.Image}}"*) record image-id; printf "sha256:runtime-image-id\\n" ;;',
      '      *genesis-postgres-1*) record dependency-postgres; if [ "$scenario:$label" = dependency:t-plus-5 ]; then printf "postgres-drift\\n"; else printf "postgres-stable-id\\n"; fi ;;',
      '      *genesis-traefik-1*) record dependency-traefik; printf "traefik-stable-id\\n" ;;',
      '      *) exit 91 ;;',
      '    esac ;;',
      '  image)',
      '    record digest; if [ "$scenario:$label" = digest:t-plus-5 ]; then printf "[]\\n"; else printf "[\\"%s\\"]\\n" "$GENESIS_09E_TARGET_IMAGE"; fi ;;',
      '  exec)',
      '    record ready; if [ "$scenario:$label" = ready:t-plus-5 ]; then printf "503\\n"; else printf "200\\n"; fi ;;',
      '  stats)',
      '    record resources; case "$scenario:$label" in resource:t-plus-2|resource:t-plus-5) printf "91.0%%|10.0%%\\n" ;; memory:t-plus-2|memory:t-plus-5) printf "10.0%%|86.0%%\\n" ;; resource-malformed:t-plus-5) printf "N/A|20.0%%\\n" ;; resource-nan:t-plus-5) printf "nan%%|20.0%%\\n" ;; resource-inf:t-plus-5) printf "inf%%|20.0%%\\n" ;; resource-missing:t-plus-5) printf "|20.0%%\\n" ;; resource-partial:t-plus-5) printf "10.0%%|20.0%%|partial\\n" ;; resource-negative:t-plus-5) printf "-1.0%%|20.0%%\\n" ;; memory-malformed:t-plus-5) printf "10.0%%|N/A\\n" ;; memory-nan:t-plus-5) printf "10.0%%|nan%%\\n" ;; memory-inf:t-plus-5) printf "10.0%%|inf%%\\n" ;; memory-missing:t-plus-5) printf "10.0%%|\\n" ;; memory-partial:t-plus-5) printf "10.0%%|20.0%%|partial\\n" ;; memory-negative:t-plus-5) printf "10.0%%|-1.0%%\\n" ;; *) printf "10.0%%|20.0%%\\n" ;; esac ;;',
      '  logs)',
      '    record logs',
      "    printf '%s\\n' '2026-08-20T20:00:00.000000000Z request-body=private email@example.test token=hidden'",
      '    case "$label" in t-plus-2|t-plus-5|t-plus-10|t-plus-15) printf "%s\\n" "2026-08-20T20:01:00.000000000Z status 500" ;; esac',
      '    case "$scenario" in http5xx|http5xx-uppercase) case "$label" in t-plus-5|t-plus-10|t-plus-15) printf "%s\\n" "2026-08-20T20:04:00.000000000Z HTTP STATUS 503" ;; esac ;; esac',
      '    if [ "$scenario:$label" = fatal:t-plus-5 ]; then printf "%s\\n" "2026-08-20T20:04:00.000000000Z fatal private payload"; fi',
      '    if [ "$scenario:$label" = database:t-plus-5 ]; then printf "%s\\n" "2026-08-20T20:04:00.000000000Z database connection failed user@example.test"; fi',
      '    if [ "$scenario:$label" = fatal-uppercase:t-plus-5 ]; then printf "%s\\n" "2026-08-20T20:04:00.000000000Z FATAL private payload"; fi',
      '    if [ "$scenario:$label" = fatal-mixed:t-plus-5 ]; then printf "%s\\n" "2026-08-20T20:04:00.000000000Z UnHaNdLeD private payload"; fi',
      '    if [ "$scenario:$label" = database-uppercase:t-plus-5 ]; then printf "%s\\n" "2026-08-20T20:04:00.000000000Z DATABASE CONNECTION FAILED"; fi',
      '    if [ "$scenario:$label" = database-mixed:t-plus-5 ]; then printf "%s\\n" "2026-08-20T20:04:00.000000000Z DaTaBaSe ErRoR"; fi',
      '    [ "$scenario:$label" != log-capture:t-plus-5 ] || exit 23 ;;',
      '  *) exit 92 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(dockerStub, 0o755);
  const curlStub = join(stub, 'curl');
  writeFileSync(
    curlStub,
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'label="${GENESIS_09E_CHECKPOINT_LABEL:-none}"',
      'scenario="${GENESIS_09E_OBSERVATION_SCENARIO:-success}"',
      'args="$*"',
      'record() { printf "%s:%s\\n" "$1" "$label" >> "$GENESIS_09E_INVOCATIONS"; }',
      'case "$args" in',
      '  *auth/csrf*)',
      '    record csrf; previous=""; for value in "$@"; do if [ "$previous" = -c ]; then printf "synthetic-cookie\\n" > "$value"; fi; previous="$value"; done; printf "%s\\n" \'{"csrfToken":"synthetic-csrf"}\' ;;',
      '  *auth/login*) record auth; if [ "$scenario:$label" = auth:t-plus-5 ]; then printf 403; else printf 401; fi ;;',
      '  *__genesis_09e_missing*) record missing; if [ "$scenario:$label" = route:t-plus-5 ]; then printf 500; else printf 404; fi ;;',
      '  *"-X POST"*) record method; if [ "$scenario:$label" = method:t-plus-5 ]; then printf 405; else printf 404; fi ;;',
      '  *api.agenciagenesismkt.com.br/health*)',
      '    record health; status=200; [ "$scenario:$label" != health:t-plus-5 ] || status=503',
      '    latency=0.100; case "$scenario:$label" in latency:t-plus-2|latency:t-plus-5) latency=2.500 ;; latency-malformed:t-plus-5) latency=N/A ;; latency-nan:t-plus-5) latency=nan ;; latency-inf:t-plus-5) latency=inf ;; latency-missing:t-plus-5) latency= ;; latency-partial:t-plus-5) latency="0.100|partial" ;; latency-negative:t-plus-5) latency=-1.0 ;; esac',
      '    printf "%s|%s" "$status" "$latency" ;;',
      '  *) exit 93 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(curlStub, 0o755);
  const pythonStub = join(stub, 'python3');
  writeFileSync(
    pythonStub,
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'cat >/dev/null',
      "printf 'synthetic-csrf\\n'",
      '',
    ].join('\n'),
  );
  chmodSync(pythonStub, 0o755);
  const result = spawnSync(
    BASH,
    [
      SCRIPT.replaceAll('\\', '/'),
      '--simulate-observation',
      release.replaceAll('\\', '/'),
      scenario,
      rollbackMarker.replaceAll('\\', '/'),
      keepMarker.replaceAll('\\', '/'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: process.env.PATH,
        GENESIS_09E_TEST_MODE: '1',
        GENESIS_09E_TEST_RELEASE_ROOT: release.replaceAll('\\', '/'),
        GENESIS_09E_INVOCATIONS: invocations.replaceAll('\\', '/'),
        GENESIS_09E_TARGET_IMAGE: CONTRACT.images.target,
        GENESIS_09E_DOCKER_BIN: dockerStub.replaceAll('\\', '/'),
        GENESIS_09E_CURL_BIN: curlStub.replaceAll('\\', '/'),
        GENESIS_09E_PYTHON_BIN: pythonStub.replaceAll('\\', '/'),
      },
    },
  );
  return { root, release, rollbackMarker, keepMarker, invocations, result };
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
    'observation',
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
  const nested = clone(CONTRACT);
  nested.observation.thresholds.token = 'forbidden';
  assert.throws(() => applySchema(nested, SCHEMA, SCHEMA));
  assert.throws(() => validateContract(nested));
});

test('observation and interrupted recovery criteria are closed and exact', () => {
  assert.deepEqual(CONTRACT.observation.checkpointsMinutes, [0, 2, 5, 10, 15]);
  assert.equal(CONTRACT.observation.failureAction, 'rollback-and-block-keep');
  assert.equal(
    CONTRACT.observation.logClassification,
    'portable-case-insensitive',
  );
  assert.equal(
    CONTRACT.observation.metricValidation,
    'finite-nonnegative-decimal-fail-closed',
  );
  assert.equal(
    CONTRACT.rollback.interruptedAction,
    'rollback-baseline-before-new-attempt',
  );
  for (const mutate of [
    (value) => value.observation.checkpointsMinutes.splice(1, 1),
    (value) => (value.observation.thresholds.cpuPercent = 91),
    (value) => (value.observation.logClassification = 'gawk-ignorecase'),
    (value) => (value.observation.metricValidation = 'coerce-to-zero'),
    (value) => (value.observation.failureAction = 'continue'),
    (value) => (value.rollback.interruptedAction = 'continue-ambiguously'),
  ]) {
    const invalid = clone(CONTRACT);
    mutate(invalid);
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
        `exec timeout --preserve-status -s ${signal} 3 bash '${SCRIPT.replaceAll('\\', '/')}' --simulate-credential-cleanup wait-signal '${parent.replaceAll('\\', '/')}' '${marker.replaceAll('\\', '/')}' < '${input.replaceAll('\\', '/')}'`,
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
  'Linux mawk classifies uppercase and mixed-case fatal, database and HTTP 5xx logs',
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
          'awk -W version 2>&1 | grep -qi mawk',
          "printf '%s\\n' '2026-08-20T20:00:00.000000000Z FATAL event' '2026-08-20T20:01:00.000000000Z UnHaNdLeD event' '2026-08-20T20:02:00.000000000Z DATABASE CONNECTION FAILED' '2026-08-20T20:03:00.000000000Z DaTaBaSe ErRoR' '2026-08-20T20:04:00.000000000Z HTTP STATUS 503' > /tmp/raw.log",
          'bash /repo/api-digest-deployment.sh --simulate-log-sanitizer /tmp/raw.log /tmp/sanitized.log 2026-08-20T20:00:00.000000000Z 2026-08-20T20:04:00.000000000Z',
          "expected='2026-08-20T20:00:00.000000000Z|fatal\\n2026-08-20T20:01:00.000000000Z|fatal\\n2026-08-20T20:02:00.000000000Z|database-error\\n2026-08-20T20:03:00.000000000Z|database-error\\n2026-08-20T20:04:00.000000000Z|http-5xx'",
          '[ "$(cat /tmp/sanitized.log)" = "$(printf "$expected")" ]',
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

test('all five checkpoints execute every smoke and allow KEEP only after success', () => {
  const state = observationSimulation('success');
  try {
    assert.equal(
      state.result.status,
      0,
      `${state.result.stdout}\n${state.result.stderr}`,
    );
    assert.equal(existsSync(state.keepMarker), true);
    assert.equal(existsSync(state.rollbackMarker), false);
    const calls = readFileSync(state.invocations, 'utf8')
      .trim()
      .split(/\r?\n/u);
    for (const checkpoint of [
      't-plus-0',
      't-plus-2',
      't-plus-5',
      't-plus-10',
      't-plus-15',
    ]) {
      for (const required of [
        'state',
        'image-id',
        'digest',
        'dependency-postgres',
        'dependency-traefik',
        'ready',
        'health',
        'missing',
        'method',
        'csrf',
        'auth',
        'resources',
        'logs',
      ]) {
        assert.ok(
          calls.includes(`${required}:${checkpoint}`),
          `${required}:${checkpoint}`,
        );
      }
    }
    const evidenceDirectory = join(
      state.release,
      'deployment-state',
      'evidence',
    );
    const evidence = readdirSync(evidenceDirectory)
      .filter((name) => name.endsWith('.sanitized.log'))
      .map((name) => readFileSync(join(evidenceDirectory, name), 'utf8'))
      .join('\n');
    assert.equal(readdirSync(evidenceDirectory).length, 10);
    assert.equal(evidence.includes('request-body'), false);
    assert.equal(evidence.includes('email@'), false);
    assert.equal(evidence.includes('token='), false);
    assert.equal(evidence.includes('synthetic-invalid'), false);
    assert.equal(existsSync(join(state.release, 'raw')), false);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  'restart',
  'container-health',
  'digest',
  'dependency',
  'ready',
  'health',
  'route',
  'method',
  'auth',
  'latency',
  'resource',
  'memory',
  'fatal',
  'database',
  'http5xx',
  'fatal-uppercase',
  'fatal-mixed',
  'database-uppercase',
  'database-mixed',
  'http5xx-uppercase',
  'latency-malformed',
  'latency-nan',
  'latency-inf',
  'latency-missing',
  'latency-partial',
  'latency-negative',
  'resource-malformed',
  'resource-nan',
  'resource-inf',
  'resource-missing',
  'resource-partial',
  'resource-negative',
  'memory-malformed',
  'memory-nan',
  'memory-inf',
  'memory-missing',
  'memory-partial',
  'memory-negative',
  'log-capture',
]) {
  test(`${scenario} observation failure rolls back and blocks KEEP`, () => {
    const state = observationSimulation(scenario);
    try {
      assert.notEqual(
        state.result.status,
        0,
        `${state.result.stdout}\n${state.result.stderr}`,
      );
      assert.equal(existsSync(state.keepMarker), false);
      assert.equal(
        readFileSync(state.rollbackMarker, 'utf8'),
        'rollback-complete\n',
      );
      assert.equal(existsSync(join(state.release, 'raw')), false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
}

test(
  'SIGKILL state live target with current rollback recovers baseline before a new attempt',
  { skip: process.env.GENESIS_09E_LINUX_TESTS !== '1', timeout: 30_000 },
  () => {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--mount',
        `type=bind,src=${SCRIPT.replaceAll('\\', '/')},dst=/repo/api-digest-deployment.sh,readonly`,
        'python:3.13-slim-trixie',
        'bash',
        '-c',
        [
          'set -euo pipefail',
          'mkdir -p -m 0755 /work/release',
          'set +e',
          'GENESIS_09E_TEST_MODE=1 GENESIS_09E_TEST_RELEASE_ROOT=/work/release bash /repo/api-digest-deployment.sh --simulate-crash-state /work/release /work/live.image /work/recovery.trace',
          'crash_status=$?',
          'set -e',
          '[ "$crash_status" -eq 137 ]',
          `target='${CONTRACT.images.target}'`,
          `rollback='${CONTRACT.images.rollback}'`,
          `target_relative='deployment-state/overlays/${CONTRACT.images.target.split('sha256:')[1]}'`,
          `rollback_relative='deployment-state/overlays/${CONTRACT.images.rollback.split('sha256:')[1]}'`,
          '[ "$(cat /work/live.image)" = "$target" ]',
          'expected_before="{\\"schemaVersion\\":\\"1.0.0\\",\\"current\\":\\"$rollback_relative\\",\\"previous\\":\\"$target_relative\\"}"',
          '[ "$(cat /work/release/deployment-state/pointers.json)" = "$expected_before" ]',
          'GENESIS_09E_TEST_MODE=1 GENESIS_09E_TEST_RELEASE_ROOT=/work/release bash /repo/api-digest-deployment.sh --simulate-crash-recovery /work/release /work/live.image /work/recovery.trace',
          '[ "$(cat /work/live.image)" = "$rollback" ]',
          '[ "$(cat /work/release/deployment-state/pointers.json)" = "$expected_before" ]',
          "expected_trace='target-live-current-baseline\\nrollback-recreated\\nrollback-health-validated\\nnew-attempt-allowed'",
          '[ "$(cat /work/recovery.trace)" = "$(printf "$expected_trace")" ]',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  },
);

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
          GENESIS_09E_DOCKER_BIN: dockerStub.replaceAll('\\', '/'),
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
