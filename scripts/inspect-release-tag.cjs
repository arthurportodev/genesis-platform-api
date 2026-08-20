const { chmodSync, readFileSync, writeFileSync } = require('node:fs');

const { isDefinitiveManifestAbsence } = require('./validate-ci-workflow.cjs');

const RESULT = Object.freeze({
  AVAILABLE: 'TAG_AVAILABLE',
  ALREADY_EXISTS: 'TAG_ALREADY_EXISTS',
  LOOKUP_FAILED: 'TAG_LOOKUP_FAILED',
});

const RESPONSE_CLASS = Object.freeze({
  DEFINITIVE_TAG_ABSENCE: 'DEFINITIVE_TAG_ABSENCE',
  TAG_EXISTS: 'TAG_EXISTS',
  AUTHENTICATION_FAILURE: 'AUTHENTICATION_FAILURE',
  TRANSIENT_REGISTRY_FAILURE: 'TRANSIENT_REGISTRY_FAILURE',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  AMBIGUOUS_RESPONSE: 'AMBIGUOUS_RESPONSE',
});

const EXIT = Object.freeze({
  AVAILABLE: 0,
  ALREADY_EXISTS: 10,
  LOOKUP_FAILED: 12,
  USAGE: 64,
});

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${label} is unavailable`);
  }
}

function extractHttpStatus(stderr) {
  const source = String(stderr);
  const patterns = [
    /\bHTTP\/\d(?:\.\d)?\s+([1-5]\d\d)\b/iu,
    /\bstatus(?:\s+code)?\s*[:=]?\s*([1-5]\d\d)\b/iu,
    /\bunexpected status from (?:HEAD|GET) request to https:\/\/ghcr\.io\/v2\/[a-z0-9]+(?:[._/-][a-z0-9]+)*\/manifests\/sha-[a-f0-9]{40}: ([1-5]\d\d)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function classifyLookupFailure({ stdout, stderr }) {
  const httpStatus = extractHttpStatus(stderr);
  if (/\b(?:401|403)\b|unauthorized|forbidden|denied/iu.test(stderr)) {
    return {
      responseClass: RESPONSE_CLASS.AUTHENTICATION_FAILURE,
      httpStatus,
      diagnostic: 'registry authentication or authorization failed',
    };
  }
  if (/\b429\b|too many requests|rate[ -]?limit/iu.test(stderr)) {
    return {
      responseClass: RESPONSE_CLASS.TRANSIENT_REGISTRY_FAILURE,
      httpStatus,
      diagnostic: 'registry rate limit prevented a definitive lookup',
    };
  }
  if (
    /\b5\d\d\b|internal server error|service unavailable|timed? out|timeout|connection (?:refused|reset)|temporary failure|network is unreachable/iu.test(
      stderr,
    )
  ) {
    return {
      responseClass: RESPONSE_CLASS.TRANSIENT_REGISTRY_FAILURE,
      httpStatus,
      diagnostic:
        'registry transport or server failure prevented a definitive lookup',
    };
  }
  if (stdout.length === 0 && stderr.length === 0) {
    return {
      responseClass: RESPONSE_CLASS.EMPTY_RESPONSE,
      httpStatus,
      diagnostic: 'registry response was empty',
    };
  }
  return {
    responseClass: RESPONSE_CLASS.AMBIGUOUS_RESPONSE,
    httpStatus,
    diagnostic: 'registry response was invalid or ambiguous',
  };
}

function lookupFailureDiagnostic(stderr) {
  return classifyLookupFailure({ stdout: '', stderr }).diagnostic;
}

function outcome(
  result,
  exitCode,
  diagnostic = '',
  responseClass = RESPONSE_CLASS.AMBIGUOUS_RESPONSE,
  httpStatus = null,
) {
  return { result, exitCode, diagnostic, responseClass, httpStatus };
}

function isValidExistingDescriptor(stdout) {
  try {
    const descriptor = JSON.parse(stdout);
    return (
      descriptor !== null &&
      typeof descriptor === 'object' &&
      !Array.isArray(descriptor) &&
      DIGEST.test(descriptor.digest ?? '')
    );
  } catch {
    return false;
  }
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
    if (
      stdout.length === 0 ||
      stderr.length !== 0 ||
      !isValidExistingDescriptor(stdout)
    ) {
      const failure = classifyLookupFailure({ stdout, stderr });
      return outcome(
        RESULT.LOOKUP_FAILED,
        EXIT.LOOKUP_FAILED,
        failure.diagnostic,
        failure.responseClass,
        failure.httpStatus,
      );
    }
    return outcome(
      RESULT.ALREADY_EXISTS,
      EXIT.ALREADY_EXISTS,
      'immutable tag already exists; refusing reuse or overwrite',
      RESPONSE_CLASS.TAG_EXISTS,
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
    return outcome(
      RESULT.AVAILABLE,
      EXIT.AVAILABLE,
      '',
      RESPONSE_CLASS.DEFINITIVE_TAG_ABSENCE,
    );
  }
  const failure = classifyLookupFailure({ stdout, stderr });
  return outcome(
    RESULT.LOOKUP_FAILED,
    EXIT.LOOKUP_FAILED,
    failure.diagnostic,
    failure.responseClass,
    failure.httpStatus,
  );
}

function parseStatus(value) {
  if (!/^\d{1,3}$/u.test(value ?? '')) return Number.NaN;
  return Number(value);
}

function loadAvailability(args, env) {
  if (args.length !== 3) return null;
  return {
    status: parseStatus(args[0]),
    stdout: readText(args[1], 'registry stdout'),
    stderr: readText(args[2], 'registry stderr'),
    expectedImageRef: env.IMAGE_REF,
  };
}

function redactStandaloneBasicCredentials(value) {
  return value.replace(
    /(?<![a-z0-9+/])(?:[a-z0-9+/]{8,}={0,2})(?![a-z0-9+/=])/giu,
    (candidate) => {
      if (candidate.length % 4 !== 0) return candidate;
      const decodedBytes = Buffer.from(candidate, 'base64');
      const canonical = decodedBytes.toString('base64').replace(/=+$/u, '');
      if (canonical !== candidate.replace(/=+$/u, '')) return candidate;
      const decoded = decodedBytes.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(decodedBytes)) return candidate;
      if (!/^[!-~]{1,256}:[ -~]{0,512}$/u.test(decoded)) return candidate;
      return '[REDACTED]';
    },
  );
}

function redactStandaloneJwt(value) {
  return value.replace(
    /(?<![a-z0-9_-])([a-z0-9_-]{8,})\.([a-z0-9_-]{8,})\.([a-z0-9_-]{8,})(?![a-z0-9_-])/giu,
    (candidate, encodedHeader, encodedPayload) => {
      try {
        const header = JSON.parse(
          Buffer.from(encodedHeader, 'base64url').toString('utf8'),
        );
        const payload = JSON.parse(
          Buffer.from(encodedPayload, 'base64url').toString('utf8'),
        );
        if (
          header !== null &&
          typeof header === 'object' &&
          !Array.isArray(header) &&
          typeof header.alg === 'string' &&
          payload !== null &&
          typeof payload === 'object' &&
          !Array.isArray(payload)
        ) {
          return '[REDACTED]';
        }
      } catch {
        // Non-JWT dotted registry evidence remains available to operators.
      }
      return candidate;
    },
  );
}

function redactStandaloneSecrets(value) {
  const githubClassicPat = /\bgh[pousr]_[a-z0-9]{20,}\b/giu;
  const githubFineGrainedPat = /\bgithub_pat_[a-z0-9_]{20,}\b/giu;
  return redactStandaloneBasicCredentials(
    redactStandaloneJwt(
      value
        .replace(githubFineGrainedPat, '[REDACTED]')
        .replace(githubClassicPat, '[REDACTED]'),
    ),
  );
}

function sanitizeDiagnosticText(value) {
  let sanitized = String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '[ANSI_REMOVED]')
    .replace(
      /(\b(?:authorization|proxy-authorization|www-authenticate)\s*:\s*)[^\r\n]*/giu,
      '$1[REDACTED]',
    )
    .replace(/(\b(?:bearer|basic)\s+)[a-z0-9._~+/-]+=*/giu, '$1[REDACTED]')
    .replace(
      /(["']?)(\b(?:access[_-]?token|identity[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|credentials?|auth)\b)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      (_match, quote, key, separator, secretValue) => {
        const redactedValue = secretValue.startsWith('"')
          ? '"[REDACTED]"'
          : secretValue.startsWith("'")
            ? "'[REDACTED]'"
            : '[REDACTED]';
        return `${quote}${key}${quote}${separator}${redactedValue}`;
      },
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu, '$1[REDACTED]@')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '\ufffd');
  sanitized = redactStandaloneSecrets(sanitized);
  const maximumLength = 4096;
  if (sanitized.length > maximumLength) {
    sanitized = `${sanitized.slice(0, maximumLength)}[TRUNCATED]`;
  }
  return sanitized;
}

function createLookupDiagnostic({ availability, result, recordedAt }) {
  return {
    schemaVersion: 1,
    recordedAt: recordedAt ?? new Date().toISOString(),
    logicalCommand: `docker buildx imagetools inspect ${availability.expectedImageRef} --format {{json .Manifest}}`,
    imageRef: availability.expectedImageRef,
    lookupExitCode: Number.isInteger(availability.status)
      ? availability.status
      : null,
    classifierResult: result.result,
    responseClass: result.responseClass,
    httpStatus: result.httpStatus,
    stdout: sanitizeDiagnosticText(availability.stdout),
    stderr: sanitizeDiagnosticText(availability.stderr),
    sanitized: true,
  };
}

function writeLookupDiagnostic(path, diagnostic) {
  writeFileSync(path, `${JSON.stringify(diagnostic, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function runCli(args = process.argv.slice(2), env = process.env) {
  const [command, ...values] = args;
  try {
    const availability = loadAvailability(values, env);
    if (!availability || command !== 'availability') {
      return outcome(
        RESULT.LOOKUP_FAILED,
        EXIT.USAGE,
        'invalid release tag inspection invocation',
      );
    }
    return classifyAvailability(availability);
  } catch {
    return outcome(
      RESULT.LOOKUP_FAILED,
      EXIT.LOOKUP_FAILED,
      'registry response was invalid or ambiguous',
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  let result = runCli(args);
  if (process.env.TAG_LOOKUP_DIAGNOSTIC_PATH) {
    try {
      const availability = loadAvailability(args.slice(1), process.env);
      if (!availability) throw new Error('lookup inputs are unavailable');
      writeLookupDiagnostic(
        process.env.TAG_LOOKUP_DIAGNOSTIC_PATH,
        createLookupDiagnostic({ availability, result }),
      );
    } catch {
      result = outcome(
        RESULT.LOOKUP_FAILED,
        EXIT.LOOKUP_FAILED,
        'sanitized registry diagnostic could not be preserved',
      );
    }
  }
  process.stdout.write(`${result.result}\n`);
  if (result.diagnostic) {
    process.stderr.write(`${result.result}: ${result.diagnostic}\n`);
  }
  process.exitCode = result.exitCode;
}

if (require.main === module) main();

module.exports = {
  EXIT,
  RESPONSE_CLASS,
  RESULT,
  classifyAvailability,
  classifyLookupFailure,
  createLookupDiagnostic,
  extractHttpStatus,
  isValidExistingDescriptor,
  lookupFailureDiagnostic,
  runCli,
  sanitizeDiagnosticText,
  writeLookupDiagnostic,
};
