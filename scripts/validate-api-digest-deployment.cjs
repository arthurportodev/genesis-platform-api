const { readFileSync } = require('node:fs');
const { isAbsolute, posix } = require('node:path');

const CONTRACT_PATH = 'config/production/api-digest-deployment-contract.json';
const SCHEMA_PATH =
  'schemas/production/api-digest-deployment-contract.v1.schema.json';
const SCRIPT_PATH = 'docker/production/api-digest-deployment.sh';
const ROOT = '/opt/genesis/release';
const IMAGE_PATTERN =
  /^ghcr\.io\/arthurportodev\/genesis-platform-api@sha256:[a-f0-9]{64}$/u;
const RELATIVE_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[a-z0-9./-]+$/u;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys differ: ${actual.join(',')}`);
  }
}

function applySchema(value, schema, rootSchema, location = '$') {
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/$defs/'))
      fail(`${location} has an unsupported schema reference`);
    const definition = schema.$ref.slice('#/$defs/'.length);
    return applySchema(
      value,
      rootSchema.$defs[definition],
      rootSchema,
      location,
    );
  }
  if (
    Object.hasOwn(schema, 'const') &&
    JSON.stringify(value) !== JSON.stringify(schema.const)
  ) {
    fail(`${location} does not match its schema constant`);
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      fail(`${location} is not an object`);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required))
        fail(`${location}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key))
          fail(`${location}.${key} is not allowed by schema`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key))
        applySchema(value[key], childSchema, rootSchema, `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(`${location} is not an array`);
    const prefix = schema.prefixItems ?? [];
    if (schema.items === false && value.length > prefix.length)
      fail(`${location} contains additional items`);
    prefix.forEach((childSchema, index) => {
      if (index < value.length)
        applySchema(
          value[index],
          childSchema,
          rootSchema,
          `${location}[${index}]`,
        );
    });
  } else if (schema.type === 'string' && typeof value !== 'string') {
    fail(`${location} is not a string`);
  }
  if (
    schema.pattern &&
    typeof value === 'string' &&
    !new RegExp(schema.pattern, 'u').test(value)
  ) {
    fail(`${location} does not match schema pattern`);
  }
  return value;
}

function safeRelative(value, label) {
  if (
    typeof value !== 'string' ||
    !RELATIVE_PATTERN.test(value) ||
    isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    fail(`${label} is not a safe relative path`);
  }
  const resolved = posix.resolve(ROOT, value);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`)) {
    fail(`${label} escapes the fixed root`);
  }
  return resolved;
}

function validateContract(contract) {
  exactKeys(
    contract,
    [
      'schemaVersion',
      'contractId',
      'root',
      'state',
      'overlays',
      'pointers',
      'evidence',
      'images',
      'service',
      'policy',
      'retention',
      'observation',
      'rollback',
    ],
    'contract',
  );
  if (contract.schemaVersion !== '1.0.0') fail('schema version mismatch');
  if (contract.contractId !== '0.8-MVP-09E.api-digest-deployment.v1')
    fail('contract id mismatch');
  if (
    contract.root.path !== ROOT ||
    contract.root.owner !== 0 ||
    contract.root.group !== 0 ||
    contract.root.mode !== '0755'
  ) {
    fail('fixed root metadata mismatch');
  }
  exactKeys(contract.root, ['path', 'owner', 'group', 'mode'], 'root');
  exactKeys(
    contract.state,
    ['relativePath', 'owner', 'group', 'mode', 'stagingPrefix', 'stagingMode'],
    'state',
  );
  exactKeys(
    contract.overlays,
    [
      'relativePath',
      'owner',
      'group',
      'directoryMode',
      'fileName',
      'fileMode',
      'format',
      'requiredShape',
    ],
    'overlays',
  );
  exactKeys(
    contract.pointers,
    [
      'relativePath',
      'owner',
      'group',
      'temporaryPrefix',
      'schemaVersion',
      'fields',
      'atomicUpdate',
      'interruptionRecovery',
      'fileMode',
    ],
    'pointers',
  );
  exactKeys(
    contract.evidence,
    [
      'relativePath',
      'owner',
      'group',
      'directoryMode',
      'snapshotMode',
      'hashMode',
      'content',
      'rawLogRetention',
    ],
    'evidence',
  );
  exactKeys(contract.images, ['target', 'rollback'], 'images');
  exactKeys(
    contract.policy,
    [
      'allowMutableTags',
      'allowCredentials',
      'allowSymlinks',
      'allowExternalPaths',
      'allowedOverlayKeys',
      'forbiddenServices',
      'forbiddenFieldPatterns',
    ],
    'policy',
  );
  exactKeys(
    contract.retention,
    [
      'minimumValidatedBundles',
      'preserveCurrent',
      'preservePrevious',
      'cleanupPolicy',
      'automaticDeletion',
    ],
    'retention',
  );
  exactKeys(
    contract.observation,
    [
      'checkpointsMinutes',
      'requiredSmokes',
      'logWindow',
      'logClassification',
      'metricValidation',
      'thresholds',
      'failureAction',
    ],
    'observation',
  );
  exactKeys(
    contract.observation.thresholds,
    [
      'fatalCount',
      'databaseErrorCount',
      'consecutiveHttp5xxCheckpoints',
      'healthLatencySeconds',
      'consecutiveLatencyBreaches',
      'cpuPercent',
      'memoryPercent',
      'consecutiveResourceBreaches',
    ],
    'observation thresholds',
  );
  exactKeys(
    contract.rollback,
    [
      'source',
      'validateBeforeActivation',
      'activatePointerAfterHealth',
      'pullPolicy',
      'interruptedState',
      'interruptedAction',
    ],
    'rollback',
  );
  const statePath = safeRelative(contract.state.relativePath, 'state path');
  const overlaysPath = safeRelative(
    contract.overlays.relativePath,
    'overlays path',
  );
  const pointersPath = safeRelative(
    contract.pointers.relativePath,
    'pointers path',
  );
  const evidencePath = safeRelative(
    contract.evidence.relativePath,
    'evidence path',
  );
  if (statePath !== `${ROOT}/deployment-state`) fail('state path mismatch');
  if (overlaysPath !== `${statePath}/overlays`) fail('overlay path mismatch');
  if (pointersPath !== `${statePath}/pointers.json`)
    fail('pointer path mismatch');
  if (evidencePath !== `${statePath}/evidence`) fail('evidence path mismatch');
  if (
    contract.evidence.owner !== 0 ||
    contract.evidence.group !== 0 ||
    contract.evidence.directoryMode !== '0700' ||
    contract.evidence.snapshotMode !== '0600' ||
    contract.evidence.hashMode !== '0600' ||
    contract.evidence.content !== 'utc-timestamp-and-classification-only'
  ) {
    fail('sanitized evidence contract mismatch');
  }
  if (
    contract.overlays.owner !== 0 ||
    contract.overlays.group !== 0 ||
    contract.overlays.directoryMode !== '0755' ||
    contract.overlays.fileMode !== '0644' ||
    contract.overlays.fileName !== 'compose.api-image.json' ||
    contract.overlays.format !== 'compose-json-v1'
  ) {
    fail('overlay metadata contract mismatch');
  }
  if (
    JSON.stringify(contract.overlays.requiredShape) !==
    JSON.stringify({
      services: { api: { image: 'immutable-digest-reference' } },
    })
  ) {
    fail('overlay required shape mismatch');
  }
  if (
    contract.pointers.owner !== 0 ||
    contract.pointers.group !== 0 ||
    contract.pointers.fileMode !== '0644' ||
    contract.pointers.temporaryPrefix !== '.pointers.' ||
    contract.pointers.schemaVersion !== '1.0.0' ||
    contract.pointers.interruptionRecovery !==
      'validate-document-remove-temporaries-recover-live-target-to-current-baseline'
  ) {
    fail('pointer metadata contract mismatch');
  }
  for (const [role, image] of Object.entries(contract.images)) {
    if (!IMAGE_PATTERN.test(image)) fail(`${role} image is not digest-pinned`);
  }
  if (contract.images.target === contract.images.rollback)
    fail('target and rollback images must differ');
  if (contract.service !== 'api') fail('only api may be deployed');
  if (
    contract.policy.allowMutableTags !== false ||
    contract.policy.allowCredentials !== false ||
    contract.policy.allowSymlinks !== false ||
    contract.policy.allowExternalPaths !== false
  ) {
    fail('fail-closed policy mismatch');
  }
  if (
    JSON.stringify(contract.policy.allowedOverlayKeys) !==
      JSON.stringify(['services', 'api', 'image']) ||
    JSON.stringify(contract.policy.forbiddenFieldPatterns) !==
      JSON.stringify(['auth', 'credential', 'password', 'secret', 'token'])
  ) {
    fail('closed field policy mismatch');
  }
  if (
    JSON.stringify(contract.policy.forbiddenServices) !==
    JSON.stringify(['postgres', 'migrate', 'traefik'])
  ) {
    fail('forbidden service set mismatch');
  }
  if (
    JSON.stringify(contract.pointers.fields) !==
      JSON.stringify(['current', 'previous']) ||
    contract.pointers.atomicUpdate !== 'write-fsync-replace-fsync-directory'
  ) {
    fail('atomic pointer contract mismatch');
  }
  if (
    contract.retention.minimumValidatedBundles !== 2 ||
    contract.retention.preserveCurrent !== true ||
    contract.retention.preservePrevious !== true ||
    contract.retention.automaticDeletion !== false
  ) {
    fail('retention contract mismatch');
  }
  if (
    JSON.stringify(contract.observation.checkpointsMinutes) !==
      JSON.stringify([0, 2, 5, 10, 15]) ||
    JSON.stringify(contract.observation.requiredSmokes) !==
      JSON.stringify([
        'immutable-runtime-digest',
        'running-healthy-zero-restarts',
        'ready-with-database',
        'public-health-200',
        'missing-route-404',
        'invalid-method-404',
        'csrf-valid-synthetic-invalid-auth-401',
        'dependency-identities-unchanged',
        'cumulative-sanitized-log-evaluation',
        'latency-threshold',
        'resource-threshold',
      ]) ||
    contract.observation.logWindow !==
      'closed-cumulative-deployment-start-to-checkpoint' ||
    contract.observation.logClassification !== 'portable-case-insensitive' ||
    contract.observation.metricValidation !==
      'finite-nonnegative-decimal-fail-closed' ||
    JSON.stringify(contract.observation.thresholds) !==
      JSON.stringify({
        fatalCount: 0,
        databaseErrorCount: 0,
        consecutiveHttp5xxCheckpoints: 2,
        healthLatencySeconds: 2,
        consecutiveLatencyBreaches: 2,
        cpuPercent: 90,
        memoryPercent: 85,
        consecutiveResourceBreaches: 2,
      }) ||
    contract.observation.failureAction !== 'rollback-and-block-keep'
  ) {
    fail('observation contract mismatch');
  }
  if (
    contract.rollback.source !== 'pre-deployment-current-pointer' ||
    contract.rollback.validateBeforeActivation !== true ||
    contract.rollback.activatePointerAfterHealth !== true ||
    contract.rollback.pullPolicy !== 'never' ||
    contract.rollback.interruptedState !==
      'live-target-current-baseline-previous-validated' ||
    contract.rollback.interruptedAction !==
      'rollback-baseline-before-new-attempt'
  ) {
    fail('rollback contract mismatch');
  }
  return contract;
}

function validateOverlay(overlay, expectedImage) {
  if (!IMAGE_PATTERN.test(expectedImage)) fail('expected image is invalid');
  exactKeys(overlay, ['services'], 'overlay');
  exactKeys(overlay.services, ['api'], 'overlay services');
  exactKeys(overlay.services.api, ['image'], 'api overlay');
  if (overlay.services.api.image !== expectedImage)
    fail('overlay image binding mismatch');
  const serialized = JSON.stringify(overlay).toLowerCase();
  for (const pattern of ['auth', 'credential', 'password', 'secret', 'token']) {
    if (serialized.includes(pattern))
      fail('overlay contains a forbidden field');
  }
  return overlay;
}

function validatePointer(pointer, knownBundleNames) {
  exactKeys(pointer, ['schemaVersion', 'current', 'previous'], 'pointer');
  if (pointer.schemaVersion !== '1.0.0') fail('pointer schema mismatch');
  for (const field of ['current', 'previous']) {
    const value = pointer[field];
    safeRelative(value, `pointer ${field}`);
    if (!/^deployment-state\/overlays\/[a-f0-9]{64}$/u.test(value))
      fail(`pointer ${field} format mismatch`);
    if (!knownBundleNames.has(value)) fail(`pointer ${field} is unknown`);
  }
  return pointer;
}

function validateStaticOrder(script) {
  const required = [
    '# ORDER: create_private_docker_config',
    '# ORDER: validate_private_docker_config',
    '# ORDER: install_cleanup_traps',
    '# ORDER: read_registry_token',
    '# ORDER: docker login',
  ];
  let previous = -1;
  for (const token of required) {
    const index = script.indexOf(token, previous + 1);
    if (index < 0 || index <= previous)
      fail(`credential order missing: ${token}`);
    previous = index;
  }
  if (script.includes('docker logs --since 2m'))
    fail('relative moving log window is forbidden');
  for (const requiredToken of [
    'deploymentStartedAt',
    'observationEndedAt',
    'collect_cumulative_logs',
    'line=tolower($0)',
    'valid_finite_nonnegative_decimal',
    '--since "$query_since"',
    '--until "$query_until"',
    'collect_cumulative_logs final "$observationEndedAt"',
    'RESOLVED_AS_NON_REQUIRED_CHECK',
    'stat -c \'%u:%g:%a\' -- "$GENESIS_RELEASE_ROOT"',
    'bind_rollback_baseline',
    'recover_interrupted_activation',
    'negative_auth_smoke',
    'evaluate_sanitized_logs',
    'latency_breach_streak',
    'resource_breach_streak',
    'http5xx_breach_streak',
    'rollback-and-block-keep',
  ]) {
    if (!script.includes(requiredToken))
      fail(`script contract token missing: ${requiredToken}`);
  }
  const executeStart = script.indexOf('run_authorized_deployment()');
  const executeEnd = script.indexOf('\nrun_cleanup_simulation()', executeStart);
  const execute = script.slice(executeStart, executeEnd);
  const executeOrder = [
    'install_cleanup_traps',
    'TARGET_ALREADY_KEPT',
    'credential_phase',
    'create_raw_evidence_directory',
  ];
  previous = -1;
  for (const token of executeOrder) {
    const index = execute.indexOf(token, previous + 1);
    if (index < 0 || index <= previous)
      fail(`deployment cleanup order missing: ${token}`);
    previous = index;
  }
}

function validateRepository(cwd = process.cwd()) {
  const contractValue = JSON.parse(
    readFileSync(`${cwd}/${CONTRACT_PATH}`, 'utf8'),
  );
  const schema = JSON.parse(readFileSync(`${cwd}/${SCHEMA_PATH}`, 'utf8'));
  applySchema(contractValue, schema, schema);
  const contract = validateContract(contractValue);
  validateStaticOrder(readFileSync(`${cwd}/${SCRIPT_PATH}`, 'utf8'));
  return { status: 'passed', contract: contract.contractId };
}

function main() {
  try {
    console.log(JSON.stringify(validateRepository()));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  applySchema,
  CONTRACT_PATH,
  SCHEMA_PATH,
  IMAGE_PATTERN,
  ROOT,
  safeRelative,
  validateContract,
  validateOverlay,
  validatePointer,
  validateRepository,
  validateStaticOrder,
};
