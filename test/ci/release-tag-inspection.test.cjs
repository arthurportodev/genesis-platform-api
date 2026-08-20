const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { EXIT, RESULT } = require('../../scripts/inspect-release-tag.cjs');

const SHA = 'a'.repeat(40);
const IMAGE_REPOSITORY = 'ghcr.io/arthurportodev/genesis-platform-api';
const IMAGE_REF = `${IMAGE_REPOSITORY}:sha-${SHA}`;
const MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;
const CONFIG_DIGEST = `sha256:${'c'.repeat(64)}`;
const LABELS = Object.freeze({
  'org.opencontainers.image.source':
    'https://github.com/arthurportodev/genesis-platform-api',
  'org.opencontainers.image.revision': SHA,
  'org.opencontainers.image.version': `sha-${SHA}`,
  'org.opencontainers.image.created': '2026-08-19T13:06:22-03:00',
  'org.opencontainers.image.title': 'genesis-platform-api',
  'org.opencontainers.image.description':
    'Backend API for the Genesis Platform',
});
const SCRIPT = join(process.cwd(), 'scripts', 'inspect-release-tag.cjs');

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-tag-inspection-'));
  const values = {
    stdout: JSON.stringify({ digest: MANIFEST_DIGEST }),
    stderr: '',
    manifest: JSON.stringify({ config: { digest: CONFIG_DIGEST } }),
    remoteImage: JSON.stringify({
      os: 'linux',
      architecture: 'amd64',
      config: { Labels: LABELS },
    }),
    localImage: JSON.stringify([
      {
        Os: 'linux',
        Architecture: 'amd64',
        Config: { Labels: LABELS },
      },
    ]),
    ...overrides,
  };
  const paths = {};
  for (const [name, value] of Object.entries(values)) {
    paths[name] = join(directory, `${name}.txt`);
    writeFileSync(paths[name], value, 'utf8');
  }
  return { directory, paths };
}

function execute({ command = 'inspect', status = 0, overrides = {} } = {}) {
  const { directory, paths } = fixture(overrides);
  const args = [SCRIPT, command, String(status), paths.stdout, paths.stderr];
  if (command === 'inspect') {
    args.push(paths.manifest, paths.remoteImage, paths.localImage);
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      IMAGE_REPOSITORY,
      IMAGE_REF,
      REQUESTED_SHA: SHA,
      EXPECTED_LOCAL_CONFIG_DIGEST: CONFIG_DIGEST,
    },
    windowsHide: true,
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

function assertOutcome(result, status, stdout, stderrPattern) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, `${stdout}\n`);
  if (stderrPattern) assert.match(result.stderr, stderrPattern);
  else assert.equal(result.stderr, '');
}

test('returns TAG_AVAILABLE only for a definitive absence tied to the exact ref', () => {
  const result = execute({
    status: 1,
    overrides: {
      stdout: '',
      stderr: `manifest unknown: ${IMAGE_REF}`,
      manifest: '',
      remoteImage: '',
    },
  });
  assertOutcome(result, EXIT.AVAILABLE, RESULT.AVAILABLE);
});

test('returns blocking TAG_ALREADY_EXISTS for the same scanned target', () => {
  const result = execute();
  assertOutcome(
    result,
    EXIT.ALREADY_EXISTS,
    RESULT.ALREADY_EXISTS,
    /already resolves to .*@sha256:[a-f0-9]{64}; refusing overwrite/u,
  );
});

test('returns blocking TAG_COLLISION for different existing content', () => {
  const result = execute({
    overrides: {
      manifest: JSON.stringify({
        config: { digest: `sha256:${'d'.repeat(64)}` },
      }),
    },
  });
  assertOutcome(
    result,
    EXIT.COLLISION,
    RESULT.COLLISION,
    /different content; refusing overwrite/u,
  );
});

test('fails closed on empty, malformed, and ambiguous registry responses', () => {
  const cases = [
    execute({ overrides: { stdout: '' } }),
    execute({ overrides: { stdout: '{}' } }),
    execute({ overrides: { stdout: '{not-json' } }),
    execute({
      status: 1,
      overrides: { stdout: '', stderr: `${IMAGE_REF}: not found` },
    }),
    execute({
      status: 1,
      overrides: {
        stdout: 'unexpected output',
        stderr: `manifest unknown: ${IMAGE_REF}`,
      },
    }),
  ];
  for (const result of cases) {
    assertOutcome(
      result,
      EXIT.LOOKUP_FAILED,
      RESULT.LOOKUP_FAILED,
      /empty, invalid, or ambiguous/u,
    );
  }
});

test('fails closed with sanitized diagnostics for 401 and 403 responses', () => {
  for (const statusCode of [401, 403]) {
    const result = execute({
      command: 'availability',
      status: 1,
      overrides: {
        stdout: '',
        stderr: `unexpected status ${statusCode}; token=do-not-print`,
      },
    });
    assertOutcome(
      result,
      EXIT.LOOKUP_FAILED,
      RESULT.LOOKUP_FAILED,
      /authentication or authorization failed/u,
    );
    assert.doesNotMatch(result.stderr, /do-not-print/u);
  }
});

test('fails closed with sanitized diagnostics for rate limits and server errors', () => {
  const cases = [
    {
      message: 'unexpected status 429; secret=do-not-print',
      pattern: /rate limit/u,
    },
    {
      message: 'unexpected status 500; secret=do-not-print',
      pattern: /server failure/u,
    },
    {
      message: 'unexpected status 503; secret=do-not-print',
      pattern: /server failure/u,
    },
  ];
  for (const entry of cases) {
    const result = execute({
      command: 'availability',
      status: 1,
      overrides: { stdout: '', stderr: entry.message },
    });
    assertOutcome(
      result,
      EXIT.LOOKUP_FAILED,
      RESULT.LOOKUP_FAILED,
      entry.pattern,
    );
    assert.doesNotMatch(result.stderr, /do-not-print/u);
  }
});

test('every non-absence outcome is nonzero and therefore cannot unlock push', () => {
  const results = [
    execute(),
    execute({
      overrides: {
        remoteImage: JSON.stringify({
          os: 'linux',
          architecture: 'arm64',
          config: { Labels: LABELS },
        }),
      },
    }),
    execute({ overrides: { manifest: '' } }),
    execute({
      command: 'availability',
      status: 1,
      overrides: { stdout: '', stderr: '401 Unauthorized' },
    }),
    execute({
      command: 'availability',
      status: 1,
      overrides: { stdout: '', stderr: '429 Too Many Requests' },
    }),
    execute({
      command: 'availability',
      status: 1,
      overrides: { stdout: '', stderr: '500 Internal Server Error' },
    }),
  ];
  for (const result of results) assert.notEqual(result.status, 0);
});
