const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  AUTHORITY_REPOSITORY,
  CONTRACT_SET_PATH,
  CONTRACT_VERSION,
  normalizeRepoPath,
  stableStringify,
} = require('./lib/task-manifest.cjs');

const CONTRACT_SCHEMAS = [
  'task-manifest.v2.schema.json',
  'finding.v1.schema.json',
  'verifier-evidence.v1.schema.json',
  'handoff.v1.schema.json',
  'evidence-manifest.v1.schema.json',
];
const SKILLS = [
  'genesis-task-orchestrator',
  'genesis-frontend-product-engineer',
  'genesis-independent-verifier',
];
const SHARED_CONTRACT_FILES = [
  ...SKILLS.flatMap((name) => [
    `.agents/skills/${name}/SKILL.md`,
    `.agents/skills/${name}/agents/openai.yaml`,
  ]),
  ...CONTRACT_SCHEMAS.map((name) => `schemas/development-operations/${name}`),
].sort();

class ContractValidationError extends Error {
  constructor(failures) {
    super(
      `contract validation failed:\n${failures.map((entry) => `- ${entry}`).join('\n')}`,
    );
    this.name = 'ContractValidationError';
    this.failures = failures;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function candidateIdFor({ taskId, baseSha, contentFingerprint }) {
  return sha256(
    `GENESIS_TASK_CANDIDATE_ID_V2\0${stableStringify({
      taskId,
      baseSha,
      contractVersion: CONTRACT_VERSION,
      contentFingerprint,
    })}`,
  );
}

function readJson(cwd, path) {
  return JSON.parse(readFileSync(join(cwd, ...path.split('/')), 'utf8'));
}

function schemaTypeMatches(value, expected) {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  return typeof value === expected;
}

function resolveSchemaReference(reference, rootSchema, registry) {
  if (reference.startsWith('#/')) {
    return reference
      .slice(2)
      .split('/')
      .map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'))
      .reduce((current, segment) => current?.[segment], rootSchema);
  }
  return registry[reference];
}

function schemaFailures(
  value,
  schema,
  { rootSchema = schema, registry = {}, location = '$' } = {},
) {
  const failures = [];
  if (!schema || typeof schema !== 'object') {
    return [`${location} references an unavailable schema.`];
  }
  if (schema.$ref) {
    const resolved = resolveSchemaReference(schema.$ref, rootSchema, registry);
    const referencedRoot = schema.$ref.startsWith('#/') ? rootSchema : resolved;
    return schemaFailures(value, resolved, {
      rootSchema: referencedRoot,
      registry,
      location,
    });
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    failures.push(`${location} must equal ${JSON.stringify(schema.const)}.`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some(
      (entry) => stableStringify(entry) === stableStringify(value),
    )
  ) {
    failures.push(`${location} is not an allowed value.`);
  }
  const expectedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (
    expectedTypes.length > 0 &&
    !expectedTypes.some((expected) => schemaTypeMatches(value, expected))
  ) {
    failures.push(`${location} has an invalid type.`);
    return failures;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      failures.push(`${location} is shorter than ${schema.minLength}.`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      failures.push(`${location} does not match ${schema.pattern}.`);
    if (
      schema.format === 'date-time' &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) ||
        Number.isNaN(Date.parse(value)))
    ) {
      failures.push(`${location} is not a valid date-time.`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined) {
    if (value < schema.minimum)
      failures.push(`${location} is lower than ${schema.minimum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      failures.push(`${location} has fewer than ${schema.minItems} items.`);
    if (
      schema.uniqueItems &&
      new Set(value.map((entry) => stableStringify(entry))).size !==
        value.length
    ) {
      failures.push(`${location} must contain unique items.`);
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        failures.push(
          ...schemaFailures(entry, schema.items, {
            rootSchema,
            registry,
            location: `${location}[${index}]`,
          }),
        );
      });
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(value, field))
        failures.push(`${location}.${field} is required.`);
    }
    for (const [field, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, field)) continue;
      failures.push(
        ...schemaFailures(value[field], propertySchema, {
          rootSchema,
          registry,
          location: `${location}.${field}`,
        }),
      );
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!Object.hasOwn(properties, field))
          failures.push(`${location}.${field} is not allowed.`);
      }
    }
  }
  for (const child of schema.allOf ?? []) {
    failures.push(
      ...schemaFailures(value, child, { rootSchema, registry, location }),
    );
  }
  if (schema.if) {
    const condition = schemaFailures(value, schema.if, {
      rootSchema,
      registry,
      location,
    });
    if (condition.length === 0 && schema.then) {
      failures.push(
        ...schemaFailures(value, schema.then, {
          rootSchema,
          registry,
          location,
        }),
      );
    }
  }
  return failures;
}

function loadSchemaRegistry(cwd = process.cwd()) {
  return Object.fromEntries(
    CONTRACT_SCHEMAS.map((name) => [
      name,
      readJson(cwd, `schemas/development-operations/${name}`),
    ]),
  );
}

function validateSchemaInstance(
  schemaName,
  value,
  { cwd = process.cwd() } = {},
) {
  const registry = loadSchemaRegistry(cwd);
  const failures = schemaFailures(value, registry[schemaName], {
    rootSchema: registry[schemaName],
    registry,
  });
  if (failures.length > 0)
    throw new ContractValidationError([...new Set(failures)].sort());
  return value;
}

function validateFinding(finding) {
  let failures = [];
  try {
    validateSchemaInstance('finding.v1.schema.json', finding);
  } catch (error) {
    failures = [...(error.failures ?? [error.message])];
  }
  if (finding?.severity === 'critical' && finding.autonomousFixAllowed) {
    failures.push('Critical finding cannot allow an autonomous fix.');
  }
  if (finding?.autonomousFixAllowed && finding?.severity === 'high') {
    if (finding.decisionRequired)
      failures.push('autonomous finding cannot require a decision.');
    if (finding.scopeStatus !== 'within-authorized-scope') {
      failures.push('autonomous finding must remain within authorized scope.');
    }
    const evidence = finding.autonomyEvidence;
    const trueFields = [
      'approvedInvariant',
      'dominantFix',
      'local',
      'reversible',
      'objectivelyVerifiable',
      'specificRegressionTest',
      'focusedValidation',
      'criticalFinalValidation',
      'independentReverification',
    ];
    for (const field of trueFields) {
      if (evidence?.[field] !== true)
        failures.push(`autonomyEvidence.${field} must be true.`);
    }
    if (evidence?.materialDecision !== false) {
      failures.push('autonomyEvidence.materialDecision must be false.');
    }
    if (evidence?.forbiddenBoundaryChange !== false) {
      failures.push('autonomyEvidence.forbiddenBoundaryChange must be false.');
    }
  }
  if (
    finding?.severity === 'high' &&
    finding.status === 'resolved' &&
    (!finding.resolution?.regressionTest ||
      !Array.isArray(finding.resolution?.validationRuns) ||
      finding.resolution.validationRuns.length === 0)
  ) {
    failures.push(
      'resolved High finding requires a regression test and validation runs.',
    );
  }
  if (finding?.status === 'resolved') {
    const before = finding.resolution?.beforeFingerprintBinding;
    const after = finding.resolution?.afterFingerprintBinding;
    if (!finding.resolution?.independentVerifierRunId || !before || !after) {
      failures.push(
        'resolved finding requires before/after bindings and independent verifier run.',
      );
    } else {
      if (
        before.contentFingerprint === after.contentFingerprint ||
        before.candidateId === after.candidateId
      ) {
        failures.push(
          'resolved finding must record a new content fingerprint and candidate ID.',
        );
      }
      if (
        stableStringify(after) !== stableStringify(finding.fingerprintBinding)
      ) {
        failures.push('resolved finding must bind to the resolved candidate.');
      }
    }
  }
  if (finding?.status === 'reclassified') {
    const reclassification = finding.reclassification;
    for (const field of [
      'candidateUnchanged',
      'objectiveEvidence',
      'verifierRunId',
      'baseSha',
      'contentFingerprint',
      'candidateId',
    ]) {
      if (!reclassification?.[field])
        failures.push(`reclassification.${field} is required.`);
    }
    for (const field of [
      'materialDecision',
      'architectureChange',
      'securityChange',
      'contractChange',
    ]) {
      if (reclassification?.[field] !== false)
        failures.push(`reclassification.${field} must be false.`);
    }
    if (
      reclassification?.from !== 'critical' ||
      reclassification?.candidateUnchanged !== true
    ) {
      failures.push(
        'only an unchanged Critical candidate may use the formal reclassification exception.',
      );
    }
    if (
      reclassification?.baseSha !== finding.fingerprintBinding?.baseSha ||
      reclassification?.contentFingerprint !==
        finding.fingerprintBinding?.contentFingerprint ||
      reclassification?.candidateId !== finding.fingerprintBinding?.candidateId
    ) {
      failures.push(
        'reclassification must bind to the unchanged finding candidate.',
      );
    }
  }
  if (failures.length > 0) throw new ContractValidationError(failures);
  return finding;
}

function validateVerifierEvidence(
  evidence,
  { expectedCandidatePaths = null } = {},
) {
  let failures = [];
  try {
    validateSchemaInstance('verifier-evidence.v1.schema.json', evidence);
  } catch (error) {
    failures = [...(error.failures ?? [error.message])];
  }
  if (evidence?.executorId === evidence?.builderExecutorId)
    failures.push('verifier executor must differ from builder.');
  if (evidence?.implementedCandidate !== false)
    failures.push('verifier must not implement the candidate.');
  if (
    evidence?.readOnly !== true ||
    evidence?.readOnlyEvidence?.writeOperations !== 0
  )
    failures.push('verifier read-only evidence is invalid.');
  if (
    evidence?.readOnlyEvidence?.beforeStatusHash !==
    evidence?.readOnlyEvidence?.afterStatusHash
  )
    failures.push('repository status changed during verification.');
  if (evidence?.contentFingerprintBefore !== evidence?.contentFingerprintAfter)
    failures.push('candidate content changed during verification.');
  if (
    evidence?.gitStateFingerprintBefore !== evidence?.gitStateFingerprintAfter
  )
    failures.push('Git state changed during verification.');
  if (
    stableStringify([...(evidence?.candidatePaths ?? [])].sort()) !==
    stableStringify([...(evidence?.reviewedFiles ?? [])].sort())
  ) {
    failures.push('reviewed files must equal the candidate path set.');
  }
  if (
    evidence?.coverage?.candidatePathsReviewed !==
    evidence?.candidatePaths?.length
  ) {
    failures.push('coverage count must equal the candidate path set.');
  }
  const expectedCandidateId = candidateIdFor({
    taskId: evidence?.taskId,
    baseSha: evidence?.baseSha,
    contentFingerprint: evidence?.contentFingerprintAfter,
  });
  if (evidence?.candidateId !== expectedCandidateId) {
    failures.push(
      'verifier candidateId does not match task, base and content fingerprint.',
    );
  }
  for (const finding of evidence?.findings ?? []) {
    try {
      validateFinding(finding);
    } catch (error) {
      failures.push(...(error.failures ?? [error.message]));
    }
    if (
      finding?.fingerprintBinding?.baseSha !== evidence?.baseSha ||
      finding?.fingerprintBinding?.contentFingerprint !==
        evidence?.contentFingerprintAfter ||
      finding?.fingerprintBinding?.candidateId !== evidence?.candidateId
    ) {
      failures.push(
        `finding ${finding?.id ?? '<unknown>'} is not bound to the verifier candidate.`,
      );
    }
  }
  if (!Array.isArray(expectedCandidatePaths)) {
    failures.push(
      'verifier evidence requires the recomputed candidate path set.',
    );
  } else if (
    stableStringify([...expectedCandidatePaths].sort()) !==
    stableStringify([...(evidence?.candidatePaths ?? [])].sort())
  ) {
    failures.push(
      'evidence candidate paths do not match the current candidate.',
    );
  }
  if (evidence?.recommendation === 'approve') {
    if ((evidence?.coverage?.limitations ?? []).length > 0) {
      failures.push('approval cannot contain coverage limitations.');
    }
    const pending = (evidence?.findings ?? []).filter(
      (finding) => !['resolved', 'reclassified'].includes(finding?.status),
    );
    if (pending.length > 0) {
      failures.push(
        `approval cannot contain pending findings: ${pending
          .map((finding) => finding?.id ?? '<unknown>')
          .join(', ')}.`,
      );
    }
  }
  if (failures.length > 0) throw new ContractValidationError(failures);
  return evidence;
}

function validateHandoff(handoff) {
  return validateSchemaInstance('handoff.v1.schema.json', handoff);
}

function validateEvidenceManifest(manifest) {
  const failures = [];
  try {
    validateSchemaInstance('evidence-manifest.v1.schema.json', manifest);
  } catch (error) {
    failures.push(...(error.failures ?? [error.message]));
  }
  if (
    manifest?.mode === 'dry-run' &&
    stableStringify(manifest.initialState) !==
      stableStringify(manifest.finalState)
  )
    failures.push('dry run must not change state.');
  if (failures.length > 0) throw new ContractValidationError(failures);
  return manifest;
}

function validateContractInstance(schemaName, value, options = {}) {
  if (schemaName === 'finding.v1.schema.json') return validateFinding(value);
  if (schemaName === 'verifier-evidence.v1.schema.json')
    return validateVerifierEvidence(value, options);
  if (schemaName === 'handoff.v1.schema.json') return validateHandoff(value);
  if (schemaName === 'evidence-manifest.v1.schema.json')
    return validateEvidenceManifest(value);
  return validateSchemaInstance(schemaName, value);
}

function validateSkill(cwd, name) {
  const failures = [];
  const skillPath = `.agents/skills/${name}/SKILL.md`;
  const yamlPath = `.agents/skills/${name}/agents/openai.yaml`;
  const source = readFileSync(join(cwd, ...skillPath.split('/')), 'utf8');
  const yaml = readFileSync(join(cwd, ...yamlPath.split('/')), 'utf8');
  if (!source.startsWith('---\n'))
    failures.push(`${skillPath} has no YAML frontmatter.`);
  if (!source.includes(`\nname: ${name}\n`))
    failures.push(`${skillPath} has the wrong name.`);
  if (!/\ndescription: .+\n---\n/u.test(source))
    failures.push(`${skillPath} has no description.`);
  if (/TODO|\[TODO/u.test(source))
    failures.push(`${skillPath} contains a placeholder.`);
  if (!yaml.includes('interface:') || !yaml.includes('default_prompt:'))
    failures.push(`${yamlPath} lacks interface metadata.`);
  if (!yaml.includes(`$${name}`))
    failures.push(`${yamlPath} default prompt must invoke $${name}.`);
  return failures;
}

function validateRepositoryContracts({ cwd = process.cwd() } = {}) {
  const failures = [];
  const schemaRoot = 'schemas/development-operations';
  for (const name of CONTRACT_SCHEMAS) {
    const path = `${schemaRoot}/${name}`;
    try {
      const schema = readJson(cwd, path);
      if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema')
        failures.push(`${path} must use JSON Schema 2020-12.`);
      if (!schema.$id || !schema.title || schema.type !== 'object')
        failures.push(`${path} lacks schema identity.`);
    } catch (error) {
      failures.push(`${path} is invalid JSON: ${error.message}`);
    }
  }
  for (const name of SKILLS) {
    try {
      failures.push(...validateSkill(cwd, name));
    } catch (error) {
      failures.push(`Skill ${name} could not be read: ${error.message}`);
    }
  }
  try {
    validateSchemaInstance(
      'task-manifest.v2.schema.json',
      readJson(cwd, '.codex/task-manifest.example.json'),
      { cwd },
    );
  } catch (error) {
    failures.push(
      ...(error.failures ?? [error.message]).map(
        (entry) => `task manifest example: ${entry}`,
      ),
    );
  }
  try {
    const contractSet = readJson(cwd, CONTRACT_SET_PATH);
    if (contractSet.contractVersion !== CONTRACT_VERSION)
      failures.push('contract set version mismatch.');
    if (contractSet.authorityRepository !== AUTHORITY_REPOSITORY)
      failures.push('contract set authority mismatch.');
    if (!Array.isArray(contractSet.files) || contractSet.files.length === 0)
      failures.push('contract set must list hashed files.');
    const declaredPaths = [];
    for (const entry of contractSet.files ?? []) {
      let path;
      try {
        path = normalizeRepoPath(entry.path, 'contract set file path');
      } catch (error) {
        failures.push(error.message);
        continue;
      }
      declaredPaths.push(path);
      if (!/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) {
        failures.push(`contract hash is invalid: ${path}.`);
        continue;
      }
      const content = readFileSync(join(cwd, ...path.split('/')));
      if (sha256(content) !== entry.sha256)
        failures.push(`contract hash mismatch: ${path}.`);
    }
    if (
      stableStringify([...new Set(declaredPaths)].sort()) !==
      stableStringify(SHARED_CONTRACT_FILES)
    ) {
      failures.push(
        'contract set paths do not match the canonical shared files.',
      );
    }
  } catch (error) {
    failures.push(`contract set could not be validated: ${error.message}`);
  }
  if (failures.length > 0) throw new ContractValidationError(failures);
  return {
    command: 'npm run task:contracts',
    status: 'passed',
    contractVersion: CONTRACT_VERSION,
    schemas: CONTRACT_SCHEMAS.length,
    skills: SKILLS.length,
  };
}

function main() {
  try {
    const instanceIndex = process.argv.indexOf('--validate-instance');
    if (instanceIndex >= 0) {
      const schemaName = process.argv[instanceIndex + 1];
      const instancePath = process.argv[instanceIndex + 2];
      if (!CONTRACT_SCHEMAS.includes(schemaName) || !instancePath) {
        throw new Error(
          '--validate-instance requires a canonical schema name and JSON path.',
        );
      }
      const normalizedInstancePath = normalizeRepoPath(
        instancePath,
        'instance path',
      );
      const options =
        schemaName === 'verifier-evidence.v1.schema.json'
          ? {
              expectedCandidatePaths:
                require('./task-fingerprint.cjs').calculateFingerprint()
                  .candidatePaths,
            }
          : {};
      validateContractInstance(
        schemaName,
        readJson(process.cwd(), normalizedInstancePath),
        options,
      );
      console.log(
        JSON.stringify({
          command: 'npm run task:contracts -- --validate-instance',
          status: 'passed',
          schema: schemaName,
          instance: normalizedInstancePath,
        }),
      );
      return;
    }
    console.log(JSON.stringify(validateRepositoryContracts()));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  CONTRACT_SCHEMAS,
  ContractValidationError,
  SHARED_CONTRACT_FILES,
  SKILLS,
  candidateIdFor,
  sha256,
  validateContractInstance,
  validateEvidenceManifest,
  validateFinding,
  validateHandoff,
  validateRepositoryContracts,
  validateSchemaInstance,
  validateVerifierEvidence,
};
