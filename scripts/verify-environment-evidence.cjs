const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;

const SCHEMA_PATHS = {
  'environment-evidence.v1':
    'schemas/production/environment-evidence.v1.schema.json',
  'environment-evidence.v2':
    'schemas/production/environment-evidence.v2.schema.json',
};

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function validateEnvironmentEvidence(evidence, options = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('environment evidence is missing or is not an object.');
  }
  const schemaPath = options.schemaPath ?? SCHEMA_PATHS[evidence.schemaVersion];
  if (!schemaPath) {
    throw new Error(
      `unsupported environment evidence version: ${evidence.schemaVersion}`,
    );
  }
  const schema = readJson(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const failures = [];

  if (!validate(evidence)) {
    failures.push(
      ...(validate.errors ?? []).map(
        (entry) => `${entry.instancePath || '/'} ${entry.message}`,
      ),
    );
  }
  if (failures.length > 0) {
    const error = new Error([...new Set(failures)].sort().join('\n'));
    error.failures = failures;
    throw error;
  }
  if (Date.parse(evidence.startedAt) > Date.parse(evidence.completedAt)) {
    failures.push('completedAt precedes startedAt.');
  }
  for (const command of evidence.commands ?? []) {
    if (Date.parse(command.startedAt) > Date.parse(command.completedAt)) {
      failures.push(
        `command completedAt precedes startedAt: ${command.command}`,
      );
    }
    if (evidence.result !== 'failed' && command.exitCode !== 0) {
      failures.push(`command failed: ${command.command}`);
    }
  }
  for (const invariant of evidence.invariants ?? []) {
    if (
      evidence.result !== 'failed' &&
      (invariant.required !== true || invariant.result !== 'passed')
    ) {
      failures.push(`required invariant did not pass: ${invariant.name}`);
    }
  }
  if (
    evidence.schemaVersion === 'environment-evidence.v2' &&
    evidence.result === 'failed' &&
    evidence.failureReasons.length === 0
  ) {
    failures.push('failed evidence must contain failureReasons.');
  }
  if (
    evidence.executor?.role === 'verifier' &&
    (evidence.executor.id === evidence.builderExecutorId ||
      evidence.executor.readOnly !== true ||
      evidence.executor.writeOperations !== 0)
  ) {
    failures.push(
      'verifier executor must be distinct, read-only, and write zero files.',
    );
  }
  if (
    options.expectedCandidateId &&
    evidence.candidateId !== options.expectedCandidateId
  ) {
    failures.push('candidateId does not match the expected candidate.');
  }
  if (options.expectedBaseSha && evidence.baseSha !== options.expectedBaseSha) {
    failures.push('baseSha does not match the expected base.');
  }

  if (failures.length > 0) {
    const error = new Error([...new Set(failures)].sort().join('\n'));
    error.failures = failures;
    throw error;
  }
  return evidence;
}

function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    throw new Error('usage: verify-environment-evidence.cjs <evidence.json>');
  }
  const evidence = validateEnvironmentEvidence(readJson(evidencePath), {
    expectedCandidateId: process.env.EXPECTED_CANDIDATE_ID,
    expectedBaseSha: process.env.EXPECTED_BASE_SHA,
  });
  console.log(
    JSON.stringify({
      command: 'verify-environment-evidence',
      status: evidence.result,
      candidateId: evidence.candidateId,
      executor: evidence.executor.id,
      invariants: evidence.invariants.length,
      failures: evidence.failureReasons?.length ?? 0,
    }),
  );
  if (evidence.result === 'failed') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { SCHEMA_PATHS, validateEnvironmentEvidence };
