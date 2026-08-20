const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  EXIT,
  RESULT,
  classifyAvailability,
  extractHttpStatus,
  sanitizeDiagnosticText,
} = require('../../scripts/inspect-release-tag.cjs');

const SHA = 'a'.repeat(40);
const IMAGE_REPOSITORY = 'ghcr.io/arthurportodev/genesis-platform-api';
const IMAGE_REF = `${IMAGE_REPOSITORY}:sha-${SHA}`;
const MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;
const SCRIPT = join(process.cwd(), 'scripts', 'inspect-release-tag.cjs');
const REAL_ABSENCE_FIXTURE = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      'test',
      'ci',
      'fixtures',
      'ghcr-tag-inspection',
      'definitive-absence-buildx.json',
    ),
    'utf8',
  ),
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function classifyDiagnosticFixture(candidate) {
  const buildx = classifyAvailability({
    status: candidate.buildx.exitCode,
    stdout: candidate.buildx.stdout,
    stderr: candidate.buildx.stderr,
    expectedImageRef: candidate.imageRef,
  });
  let ociBody;
  try {
    ociBody = JSON.parse(candidate.oci.body);
  } catch {
    return 'AMBIGUOUS_RESPONSE';
  }
  const ociDefinitiveAbsence =
    candidate.oci.httpStatus === 404 &&
    candidate.oci.contentType === 'application/json' &&
    candidate.oci.errorCode === 'MANIFEST_UNKNOWN' &&
    candidate.oci.errorMessage === 'manifest unknown' &&
    ociBody?.errors?.length === 1 &&
    ociBody.errors[0]?.code === 'MANIFEST_UNKNOWN' &&
    ociBody.errors[0]?.message === 'manifest unknown';
  return buildx.result === RESULT.AVAILABLE && ociDefinitiveAbsence
    ? 'DEFINITIVE_TAG_ABSENCE'
    : 'AMBIGUOUS_RESPONSE';
}

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-tag-inspection-'));
  const values = {
    stdout: JSON.stringify({ digest: MANIFEST_DIGEST }),
    stderr: '',
    ...overrides,
  };
  const paths = {};
  for (const [name, value] of Object.entries(values)) {
    paths[name] = join(directory, `${name}.txt`);
    writeFileSync(paths[name], value, 'utf8');
  }
  return { directory, paths };
}

function execute({
  command = 'availability',
  status = 0,
  overrides = {},
  env = {},
  captureDiagnostic = false,
} = {}) {
  const { directory, paths } = fixture(overrides);
  const diagnosticPath = join(directory, 'tag-lookup-diagnostic.json');
  const args = [SCRIPT, command, String(status), paths.stdout, paths.stderr];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      IMAGE_REPOSITORY,
      IMAGE_REF,
      ...(captureDiagnostic
        ? { TAG_LOOKUP_DIAGNOSTIC_PATH: diagnosticPath }
        : {}),
      ...env,
    },
    windowsHide: true,
  });
  result.diagnostic = captureDiagnostic
    ? JSON.parse(readFileSync(diagnosticPath, 'utf8'))
    : null;
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
    },
  });
  assertOutcome(result, EXIT.AVAILABLE, RESULT.AVAILABLE);
});

test('real Buildx and OCI fixtures bind the proven GHCR definitive-absence signature', () => {
  const observed = REAL_ABSENCE_FIXTURE;
  assert.equal(observed.classification, 'DEFINITIVE_TAG_ABSENCE');
  assert.equal(observed.stableReads, 3);
  assert.equal(sha256(observed.buildx.stdout), observed.buildx.stdoutSha256);
  assert.equal(sha256(observed.buildx.stderr), observed.buildx.stderrSha256);
  assert.equal(sha256(observed.oci.body), observed.oci.bodySha256);
  assert.equal(observed.oci.httpStatus, 404);
  assert.equal(observed.oci.errorCode, 'MANIFEST_UNKNOWN');
  assert.equal(observed.credentialsExposed, false);
  assert.equal(observed.mutableCallPerformed, false);

  const result = execute({
    command: 'availability',
    status: observed.buildx.exitCode,
    overrides: {
      stdout: observed.buildx.stdout,
      stderr: observed.buildx.stderr,
    },
    env: { IMAGE_REF: observed.imageRef },
  });
  assertOutcome(result, EXIT.AVAILABLE, RESULT.AVAILABLE);
  assert.equal(classifyDiagnosticFixture(observed), 'DEFINITIVE_TAG_ABSENCE');
});

test('a disagreement between the Buildx and OCI observations is never definitive absence', () => {
  for (const mutate of [
    (candidate) => {
      candidate.oci.httpStatus = 200;
    },
    (candidate) => {
      candidate.oci.errorCode = 'UNAUTHORIZED';
    },
    (candidate) => {
      candidate.oci.body = '{"errors":[]}\n';
    },
    (candidate) => {
      candidate.buildx.stderr = `ERROR: ${candidate.imageRef}: unauthorized`;
    },
  ]) {
    const divergent = structuredClone(REAL_ABSENCE_FIXTURE);
    mutate(divergent);
    assert.equal(classifyDiagnosticFixture(divergent), 'AMBIGUOUS_RESPONSE');
  }
});

test('real not-found signature stays exact, single-line, and tied to the full target ref', () => {
  const { imageRef } = REAL_ABSENCE_FIXTURE;
  const exact = REAL_ABSENCE_FIXTURE.buildx.stderr;
  const rejected = [
    `${imageRef}: not found`,
    'ERROR: not found',
    `ERROR: ${imageRef.slice(0, -1)}: not found`,
    `ERROR: ${imageRef}: not found `,
    `prefix ${exact}`,
    `${exact} suffix`,
    `${exact}\n401 Unauthorized`,
    `\u001b[31m${exact}\u001b[0m`,
  ];
  for (const stderr of rejected) {
    const result = execute({
      command: 'availability',
      status: 1,
      overrides: { stdout: '', stderr },
      env: { IMAGE_REF: imageRef },
    });
    assertOutcome(
      result,
      EXIT.LOOKUP_FAILED,
      RESULT.LOOKUP_FAILED,
      /invalid or ambiguous|authentication or authorization/u,
    );
  }
});

test('returns blocking TAG_ALREADY_EXISTS for the same scanned target', () => {
  const result = execute();
  assertOutcome(
    result,
    EXIT.ALREADY_EXISTS,
    RESULT.ALREADY_EXISTS,
    /already exists; refusing reuse or overwrite/u,
  );
});

test('treats every existing descriptor, including a collision, as blocking TAG_ALREADY_EXISTS', () => {
  const result = execute({
    overrides: {
      stdout: JSON.stringify({ digest: `sha256:${'d'.repeat(64)}` }),
    },
  });
  assertOutcome(
    result,
    EXIT.ALREADY_EXISTS,
    RESULT.ALREADY_EXISTS,
    /already exists; refusing reuse or overwrite/u,
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
      /empty|invalid or ambiguous/u,
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

test('preserves a structured sanitized diagnostic for the proven absence', () => {
  const observed = REAL_ABSENCE_FIXTURE;
  const result = execute({
    command: 'availability',
    status: observed.buildx.exitCode,
    overrides: {
      stdout: observed.buildx.stdout,
      stderr: observed.buildx.stderr,
    },
    env: { IMAGE_REF: observed.imageRef },
    captureDiagnostic: true,
  });
  assertOutcome(result, EXIT.AVAILABLE, RESULT.AVAILABLE);
  assert.equal(result.diagnostic.schemaVersion, 1);
  assert.match(
    result.diagnostic.recordedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );
  assert.equal(
    result.diagnostic.logicalCommand,
    `docker buildx imagetools inspect ${observed.imageRef} --format {{json .Manifest}}`,
  );
  assert.equal(result.diagnostic.imageRef, observed.imageRef);
  assert.equal(result.diagnostic.lookupExitCode, 1);
  assert.equal(result.diagnostic.classifierResult, RESULT.AVAILABLE);
  assert.equal(result.diagnostic.responseClass, 'DEFINITIVE_TAG_ABSENCE');
  assert.equal(result.diagnostic.httpStatus, null);
  assert.equal(result.diagnostic.stdout, '');
  assert.equal(result.diagnostic.stderr, observed.buildx.stderr);
  assert.equal(result.diagnostic.sanitized, true);
});

test('future failure diagnostics preserve status and channels without credentials', () => {
  const result = execute({
    command: 'availability',
    status: 1,
    overrides: {
      stdout: 'ambiguous output token=stdout-secret',
      stderr:
        'unexpected status 401\nAuthorization: Bearer header-secret\nWWW-Authenticate: Bearer realm="registry"\nhttps://user:password@ghcr.io/v2/',
    },
    captureDiagnostic: true,
  });
  assertOutcome(
    result,
    EXIT.LOOKUP_FAILED,
    RESULT.LOOKUP_FAILED,
    /authentication or authorization failed/u,
  );
  assert.equal(result.diagnostic.lookupExitCode, 1);
  assert.equal(result.diagnostic.responseClass, 'AUTHENTICATION_FAILURE');
  assert.equal(result.diagnostic.httpStatus, 401);
  assert.match(result.diagnostic.stdout, /token=\[REDACTED\]/u);
  assert.match(result.diagnostic.stderr, /Authorization: \[REDACTED\]/u);
  assert.match(result.diagnostic.stderr, /WWW-Authenticate: \[REDACTED\]/u);
  assert.match(result.diagnostic.stderr, /https:\/\/\[REDACTED\]@ghcr\.io/u);
  assert.doesNotMatch(
    JSON.stringify(result.diagnostic),
    /stdout-secret|header-secret|realm=|user:password/u,
  );
});

test('sanitizer redacts JSON, underscored, header, assignment, and URL credential forms', () => {
  const unsafe = [
    '{"access_token":"json-access"}',
    '{"identitytoken":"json-identity"}',
    '{"token":"json-token"}',
    '{"auth":"base64-auth"}',
    '{"password":"json-password"}',
    '{"secret":"json-secret"}',
    'access_token=assignment-access',
    "refresh-token='assignment-refresh'",
    'Authorization: Bearer header-secret',
    'WWW-Authenticate: Bearer realm="registry"',
    'https://user:password@ghcr.io/v2/',
  ].join('\n');
  const sanitized = sanitizeDiagnosticText(unsafe);
  assert.doesNotMatch(
    sanitized,
    /json-access|json-identity|json-token|base64-auth|json-password|json-secret|assignment-access|assignment-refresh|header-secret|realm=|user:password/u,
  );
  assert.match(sanitized, /"access_token":"\[REDACTED\]"/u);
  assert.match(sanitized, /"identitytoken":"\[REDACTED\]"/u);
  assert.match(sanitized, /"auth":"\[REDACTED\]"/u);
  assert.match(sanitized, /access_token=\[REDACTED\]/u);
  assert.match(sanitized, /refresh-token='\[REDACTED\]'/u);
  assert.match(sanitized, /Authorization: \[REDACTED\]/u);
  assert.match(sanitized, /WWW-Authenticate: \[REDACTED\]/u);
  assert.match(sanitized, /https:\/\/\[REDACTED\]@ghcr\.io/u);
});

test('sanitizer redacts standalone GitHub tokens, JWTs, and Basic credentials before artifact custody', () => {
  const classicPat = `ghp_${'A'.repeat(36)}`;
  const fineGrainedPat = `github_pat_${'B'.repeat(82)}`;
  const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'c'.repeat(32)}`;
  const whitespaceJwt = [
    Buffer.from('{\n  "alg": "HS256"}', 'utf8').toString('base64url'),
    Buffer.from('{"sub":"atypical-header"}', 'utf8').toString('base64url'),
    `${'d'.repeat(31)}_`,
  ].join('.');
  const basicCredential = Buffer.from(
    'diagnostic-user:basic-password',
    'utf8',
  ).toString('base64');
  const result = execute({
    command: 'availability',
    status: 1,
    overrides: {
      stdout: `standalone ${classicPat} ${jwt} ${whitespaceJwt}`,
      stderr: `registry failure ${fineGrainedPat} ${basicCredential}`,
    },
    captureDiagnostic: true,
  });
  assertOutcome(
    result,
    EXIT.LOOKUP_FAILED,
    RESULT.LOOKUP_FAILED,
    /invalid or ambiguous/u,
  );
  const artifact = JSON.stringify(result.diagnostic);
  for (const secret of [
    classicPat,
    fineGrainedPat,
    jwt,
    whitespaceJwt,
    basicCredential,
  ]) {
    assert.doesNotMatch(artifact, new RegExp(secret, 'u'));
  }
  assert.match(
    result.diagnostic.stdout,
    /standalone \[REDACTED\] \[REDACTED\] \[REDACTED\]/u,
  );
  assert.match(
    result.diagnostic.stderr,
    /registry failure \[REDACTED\] \[REDACTED\]/u,
  );
});

test('standalone secret redaction preserves useful non-secret registry evidence', () => {
  const safe = `ERROR: ${IMAGE_REF}: not found; HTTP/1.1 404; digest=${MANIFEST_DIGEST}`;
  assert.equal(sanitizeDiagnosticText(safe), safe);
});

test('extracts only explicit HTTP status forms including the canonical GHCR 404', () => {
  const manifestUrl =
    'https://ghcr.io/v2/arthurportodev/genesis-platform-api/manifests/sha-' +
    '0a56a8aee7c64bda59a1981888418e1ad03950c0';
  assert.equal(
    extractHttpStatus(
      `ERROR: unexpected status from HEAD request to ${manifestUrl}: 404 Not Found`,
    ),
    404,
  );
  assert.equal(extractHttpStatus('unexpected status 401'), 401);
  assert.equal(extractHttpStatus('status code: 403'), 403);
  assert.equal(extractHttpStatus('status=429'), 429);
  assert.equal(extractHttpStatus('HTTP/1.1 503 Service Unavailable'), 503);
  assert.equal(
    extractHttpStatus(
      'sha256:4040000000000000000000000000000000000000000000000000000000000000',
    ),
    null,
  );
});

test('timeouts, empty channels, malformed payloads, and unknown responses remain fail closed', () => {
  const cases = [
    {
      status: 1,
      stdout: '',
      stderr: 'request timed out',
      responseClass: 'TRANSIENT_REGISTRY_FAILURE',
    },
    {
      status: 1,
      stdout: '',
      stderr: '',
      responseClass: 'EMPTY_RESPONSE',
    },
    {
      status: 1,
      stdout: '{not-json',
      stderr: '',
      responseClass: 'AMBIGUOUS_RESPONSE',
    },
    {
      status: 2,
      stdout: '',
      stderr: `ERROR: ${IMAGE_REF}: not found`,
      responseClass: 'AMBIGUOUS_RESPONSE',
    },
  ];
  for (const entry of cases) {
    const result = execute({
      command: 'availability',
      status: entry.status,
      overrides: { stdout: entry.stdout, stderr: entry.stderr },
      captureDiagnostic: true,
    });
    assertOutcome(
      result,
      EXIT.LOOKUP_FAILED,
      RESULT.LOOKUP_FAILED,
      /empty|invalid or ambiguous|transport or server failure/u,
    );
    assert.equal(result.diagnostic.responseClass, entry.responseClass);
    assert.notEqual(result.status, 0);
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
    execute({ overrides: { stdout: '{}' } }),
    execute({ overrides: { stdout: '{invalid-json' } }),
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
