const { readFileSync } = require('node:fs');

const {
  OCI_LABELS,
  isDefinitiveManifestAbsence,
} = require('./validate-ci-workflow.cjs');

const RESULT = Object.freeze({
  AVAILABLE: 'TAG_AVAILABLE',
  ALREADY_EXISTS: 'TAG_ALREADY_EXISTS',
  COLLISION: 'TAG_COLLISION',
  LOOKUP_FAILED: 'TAG_LOOKUP_FAILED',
});

const EXIT = Object.freeze({
  AVAILABLE: 0,
  ALREADY_EXISTS: 10,
  COLLISION: 11,
  LOOKUP_FAILED: 12,
  USAGE: 64,
});

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${label} is unavailable`);
  }
}

function parseJson(text, label) {
  if (text.length === 0) throw new Error(`${label} is empty`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

function lookupFailureDiagnostic(stderr) {
  if (/\b(?:401|403)\b|unauthorized|forbidden|denied/iu.test(stderr)) {
    return 'registry authentication or authorization failed';
  }
  if (/\b429\b|too many requests|rate[ -]?limit/iu.test(stderr)) {
    return 'registry rate limit prevented a definitive lookup';
  }
  if (/\b5\d\d\b|internal server error|service unavailable/iu.test(stderr)) {
    return 'registry server failure prevented a definitive lookup';
  }
  return 'registry response was empty, invalid, or ambiguous';
}

function outcome(result, exitCode, diagnostic = '') {
  return { result, exitCode, diagnostic };
}

function classifyAvailability({ status, stdout, stderr, expectedImageRef }) {
  if (!Number.isInteger(status) || status < 0 || status > 255) {
    return outcome(
      RESULT.LOOKUP_FAILED,
      EXIT.LOOKUP_FAILED,
      'registry lookup status was invalid',
    );
  }
  if (status === 0) {
    if (stdout.length === 0 || stderr.length !== 0) {
      return outcome(
        RESULT.LOOKUP_FAILED,
        EXIT.LOOKUP_FAILED,
        lookupFailureDiagnostic(stderr),
      );
    }
    return outcome(
      RESULT.ALREADY_EXISTS,
      EXIT.ALREADY_EXISTS,
      'immutable tag already exists; refusing overwrite',
    );
  }
  if (
    isDefinitiveManifestAbsence({
      status,
      stdout,
      stderr,
      expectedImageRef,
    })
  ) {
    return outcome(RESULT.AVAILABLE, EXIT.AVAILABLE);
  }
  return outcome(
    RESULT.LOOKUP_FAILED,
    EXIT.LOOKUP_FAILED,
    lookupFailureDiagnostic(stderr),
  );
}

function validateExpectedIdentity({
  expectedImageRef,
  imageRepository,
  requestedSha,
  expectedLocalConfigDigest,
}) {
  if (!SHA.test(requestedSha)) throw new Error('requested SHA is invalid');
  if (!DIGEST.test(expectedLocalConfigDigest)) {
    throw new Error('expected local config digest is invalid');
  }
  if (
    expectedImageRef !== `${imageRepository}:sha-${requestedSha}` ||
    !/^ghcr\.io\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(imageRepository)
  ) {
    throw new Error('expected image identity is invalid');
  }
}

function classifyExistingTag({
  descriptor,
  manifest,
  remoteImage,
  localImage,
  imageRepository,
  requestedSha,
  expectedLocalConfigDigest,
}) {
  const digest = descriptor?.digest;
  const remoteConfigDigest = manifest?.config?.digest;
  const remoteLabels = remoteImage?.config?.Labels;
  const localLabels = localImage?.Config?.Labels;
  if (!DIGEST.test(digest ?? '')) {
    throw new Error('existing manifest digest is invalid');
  }
  if (!DIGEST.test(remoteConfigDigest ?? '')) {
    throw new Error('existing config digest is invalid');
  }
  if (
    !remoteImage ||
    typeof remoteImage !== 'object' ||
    Array.isArray(remoteImage) ||
    !remoteLabels ||
    typeof remoteLabels !== 'object' ||
    Array.isArray(remoteLabels)
  ) {
    throw new Error('remote image identity is invalid');
  }
  if (
    !localImage ||
    typeof localImage !== 'object' ||
    Array.isArray(localImage) ||
    !localLabels ||
    typeof localLabels !== 'object' ||
    Array.isArray(localLabels)
  ) {
    throw new Error('local image identity is invalid');
  }
  for (const name of OCI_LABELS) {
    if (typeof localLabels[name] !== 'string') {
      throw new Error('local image labels are incomplete');
    }
  }

  const equivalent =
    remoteConfigDigest === expectedLocalConfigDigest &&
    remoteImage.os === 'linux' &&
    remoteImage.architecture === 'amd64' &&
    remoteLabels['org.opencontainers.image.revision'] === requestedSha &&
    remoteLabels['org.opencontainers.image.version'] ===
      `sha-${requestedSha}` &&
    OCI_LABELS.every((name) => remoteLabels[name] === localLabels[name]);

  if (equivalent) {
    return outcome(
      RESULT.ALREADY_EXISTS,
      EXIT.ALREADY_EXISTS,
      `immutable tag already resolves to ${imageRepository}@${digest}; refusing overwrite`,
    );
  }
  return outcome(
    RESULT.COLLISION,
    EXIT.COLLISION,
    'immutable tag resolves to different content; refusing overwrite',
  );
}

function inspectTag({
  status,
  stdout,
  stderr,
  manifestText,
  remoteImageText,
  localImageText,
  expectedImageRef,
  imageRepository,
  requestedSha,
  expectedLocalConfigDigest,
}) {
  const availability = classifyAvailability({
    status,
    stdout,
    stderr,
    expectedImageRef,
  });
  if (availability.result !== RESULT.ALREADY_EXISTS) return availability;

  try {
    validateExpectedIdentity({
      expectedImageRef,
      imageRepository,
      requestedSha,
      expectedLocalConfigDigest,
    });
    const descriptor = parseJson(stdout, 'registry descriptor');
    const manifest = parseJson(manifestText, 'registry manifest');
    const remoteImage = parseJson(remoteImageText, 'remote image identity');
    const localImages = parseJson(localImageText, 'local image identity');
    if (!Array.isArray(localImages) || localImages.length !== 1) {
      throw new Error('local image identity is ambiguous');
    }
    return classifyExistingTag({
      descriptor,
      manifest,
      remoteImage,
      localImage: localImages[0],
      imageRepository,
      requestedSha,
      expectedLocalConfigDigest,
    });
  } catch {
    return outcome(
      RESULT.LOOKUP_FAILED,
      EXIT.LOOKUP_FAILED,
      'registry response was empty, invalid, or ambiguous',
    );
  }
}

function parseStatus(value) {
  if (!/^\d{1,3}$/u.test(value ?? '')) return Number.NaN;
  return Number(value);
}

function loadAvailability(args, env) {
  if (args.length < 3) return null;
  return {
    status: parseStatus(args[0]),
    stdout: readText(args[1], 'registry stdout'),
    stderr: readText(args[2], 'registry stderr'),
    expectedImageRef: env.IMAGE_REF,
  };
}

function runCli(args = process.argv.slice(2), env = process.env) {
  const [command, ...values] = args;
  let result;
  try {
    const availability = loadAvailability(values, env);
    if (
      !availability ||
      !['availability', 'inspect'].includes(command) ||
      (command === 'availability' && values.length !== 3) ||
      (command === 'inspect' && values.length !== 6)
    ) {
      return outcome(
        RESULT.LOOKUP_FAILED,
        EXIT.USAGE,
        'invalid release tag inspection invocation',
      );
    }
    if (command === 'availability') {
      result = classifyAvailability(availability);
    } else {
      result = inspectTag({
        ...availability,
        manifestText: readText(values[3], 'registry manifest'),
        remoteImageText: readText(values[4], 'remote image identity'),
        localImageText: readText(values[5], 'local image identity'),
        imageRepository: env.IMAGE_REPOSITORY,
        requestedSha: env.REQUESTED_SHA,
        expectedLocalConfigDigest: env.EXPECTED_LOCAL_CONFIG_DIGEST,
      });
    }
  } catch {
    result = outcome(
      RESULT.LOOKUP_FAILED,
      EXIT.LOOKUP_FAILED,
      'registry response was empty, invalid, or ambiguous',
    );
  }
  return result;
}

function main() {
  const result = runCli();
  process.stdout.write(`${result.result}\n`);
  if (result.diagnostic) {
    process.stderr.write(`${result.result}: ${result.diagnostic}\n`);
  }
  process.exitCode = result.exitCode;
}

if (require.main === module) main();

module.exports = {
  EXIT,
  RESULT,
  classifyAvailability,
  classifyExistingTag,
  inspectTag,
  lookupFailureDiagnostic,
  runCli,
};
