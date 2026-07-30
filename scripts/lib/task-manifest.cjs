const { readFileSync } = require('node:fs');
const { isAbsolute, posix, win32 } = require('node:path');
const { focusedScriptFailure } = require('./task-focused-script-policy.cjs');

const MANIFEST_VERSION = 2;
const SUPPORTED_MANIFEST_VERSIONS = new Set([1, 2]);
const CONTRACT_VERSION = '2.0.0';
const CONTRACT_SET_PATH = 'schemas/development-operations/contract-set.json';
const AUTHORITY_REPOSITORY = 'arthurportodev/genesis-platform-api';
const TASK_CLASSES = new Set(['simple', 'normal', 'critical']);
const VALIDATION_PROFILES = new Set(['docs', 'focused', 'normal', 'critical']);
const VALIDATION_LEVELS = new Set([
  'immediate',
  'focused',
  'integration',
  'complete',
]);
const EXPECTED_TRANSITIONS = new Set(['untracked-to-tracked']);
const REPOSITORY_WIDE_PROBES = [
  'package.json',
  '.hidden',
  'src/auth/token.ts',
  'arbitrary/deep/file.bin',
];

class ManifestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

function fail(message) {
  throw new ManifestValidationError(message);
}

function assertObject(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${location} must be an object.`);
  }
}

function assertKnownKeys(value, allowed, location) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`${location} has unknown field(s): ${unknown.sort().join(', ')}.`);
  }
}

function requiredString(value, location) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${location} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredBoolean(value, location) {
  if (typeof value !== 'boolean') fail(`${location} must be a boolean.`);
  return value;
}

function normalizeRepoPath(value, location = 'path') {
  const candidate = requiredString(value, location);
  if (
    candidate.includes('\\') ||
    candidate.includes('\0') ||
    candidate.startsWith(':') ||
    isAbsolute(candidate) ||
    posix.isAbsolute(candidate) ||
    win32.isAbsolute(candidate)
  ) {
    fail(
      `${location} must be a repository-relative POSIX path without Git pathspec magic.`,
    );
  }
  const segments = candidate.split('/');
  if (segments.includes('..')) fail(`${location} must not contain '..'.`);
  const normalized = candidate.replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
  if (normalized === '' || normalized.endsWith('/')) {
    fail(`${location} must identify a path or glob.`);
  }
  return normalized;
}

function validateStringList(value, location, allowed = null) {
  if (!Array.isArray(value)) fail(`${location} must be an array.`);
  const normalized = value.map((entry, index) =>
    requiredString(entry, `${location}[${index}]`),
  );
  const duplicates = normalized.filter(
    (entry, index) => normalized.indexOf(entry) !== index,
  );
  if (duplicates.length > 0) {
    fail(
      `${location} contains duplicate value(s): ${[...new Set(duplicates)].join(', ')}.`,
    );
  }
  if (allowed) {
    const unknown = normalized.find((entry) => !allowed.has(entry));
    if (unknown) fail(`${location} contains unknown value: ${unknown}.`);
  }
  return normalized;
}

function validatePathList(value, location, allowBroadPaths) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${location} must be a non-empty array.`);
  }
  const normalized = value.map((entry, index) =>
    normalizeRepoPath(entry, `${location}[${index}]`),
  );
  if (!allowBroadPaths) {
    const broad = normalized.find((entry) => isRepositoryWideGlob(entry));
    if (broad) {
      fail(
        `${location} contains repository-wide glob '${broad}' without allowBroadPaths.`,
      );
    }
  }
  const duplicates = normalized.filter(
    (entry, index) => normalized.indexOf(entry) !== index,
  );
  if (duplicates.length > 0) {
    fail(
      `${location} contains duplicate path(s): ${[...new Set(duplicates)].join(', ')}.`,
    );
  }
  return normalized;
}

function defaultLevels(profile) {
  if (profile === 'docs' || profile === 'focused') {
    return ['immediate', 'focused'];
  }
  if (profile === 'normal') return ['immediate', 'focused', 'integration'];
  return ['immediate', 'focused', 'integration', 'complete'];
}

function validateCommon(rawManifest, packageJson, sourceVersion) {
  assertObject(rawManifest.task, 'manifest.task');
  assertKnownKeys(rawManifest.task, ['id', 'title', 'class'], 'manifest.task');
  const taskClass = requiredString(
    rawManifest.task.class,
    'manifest.task.class',
  );
  if (!TASK_CLASSES.has(taskClass)) {
    fail(`manifest.task.class is unknown: ${taskClass}.`);
  }

  assertObject(rawManifest.git, 'manifest.git');
  assertKnownKeys(
    rawManifest.git,
    sourceVersion === 1
      ? ['branch', 'baseSha', 'requireCleanStage']
      : ['branch', 'baseSha', 'requireCleanStage', 'expectedTransitions'],
    'manifest.git',
  );
  const baseSha = requiredString(
    rawManifest.git.baseSha,
    'manifest.git.baseSha',
  );
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) {
    fail('manifest.git.baseSha must be a full lowercase 40-character SHA.');
  }
  const requireCleanStage =
    rawManifest.git.requireCleanStage === undefined
      ? true
      : requiredBoolean(
          rawManifest.git.requireCleanStage,
          'manifest.git.requireCleanStage',
        );
  const expectedTransitions =
    sourceVersion === 1
      ? []
      : validateStringList(
          rawManifest.git.expectedTransitions,
          'manifest.git.expectedTransitions',
          EXPECTED_TRANSITIONS,
        );

  assertObject(rawManifest.scope, 'manifest.scope');
  assertKnownKeys(
    rawManifest.scope,
    ['allowedPaths', 'protectedPaths', 'allowBroadPaths'],
    'manifest.scope',
  );
  const allowBroadPaths = rawManifest.scope.allowBroadPaths === true;
  if (
    rawManifest.scope.allowBroadPaths !== undefined &&
    typeof rawManifest.scope.allowBroadPaths !== 'boolean'
  ) {
    fail('manifest.scope.allowBroadPaths must be a boolean.');
  }
  const allowedPaths = validatePathList(
    rawManifest.scope.allowedPaths,
    'manifest.scope.allowedPaths',
    allowBroadPaths,
  );
  const protectedPaths = validatePathList(
    rawManifest.scope.protectedPaths,
    'manifest.scope.protectedPaths',
    true,
  );
  const overlaps = allowedPaths.filter((entry) =>
    protectedPaths.includes(entry),
  );
  if (overlaps.length > 0) {
    fail(`allowedPaths and protectedPaths overlap: ${overlaps.join(', ')}.`);
  }

  assertObject(rawManifest.artifacts, 'manifest.artifacts');
  const artifactKeys =
    sourceVersion === 1
      ? ['taskPacket']
      : ['taskPacket', 'findings', 'verifierEvidence', 'handoff'];
  assertKnownKeys(rawManifest.artifacts, artifactKeys, 'manifest.artifacts');
  const artifacts = {};
  for (const key of artifactKeys) {
    artifacts[key] =
      rawManifest.artifacts[key] === undefined
        ? null
        : normalizeRepoPath(
            rawManifest.artifacts[key],
            `manifest.artifacts.${key}`,
          );
  }

  assertObject(rawManifest.validation, 'manifest.validation');
  assertKnownKeys(
    rawManifest.validation,
    sourceVersion === 1
      ? ['profile', 'focusedScripts']
      : ['profile', 'focusedScripts', 'levels'],
    'manifest.validation',
  );
  const profile = requiredString(
    rawManifest.validation.profile,
    'manifest.validation.profile',
  );
  if (!VALIDATION_PROFILES.has(profile)) {
    fail(`manifest.validation.profile is unknown: ${profile}.`);
  }
  const packageScripts = packageJson?.scripts;
  if (
    packageScripts === null ||
    typeof packageScripts !== 'object' ||
    Array.isArray(packageScripts)
  ) {
    fail('package.json scripts are unavailable.');
  }
  const focusedScripts = validateStringList(
    rawManifest.validation.focusedScripts,
    'manifest.validation.focusedScripts',
  ).map((name) => {
    if (!Object.hasOwn(packageScripts, name)) {
      fail(`focused script does not exist in package.json: ${name}.`);
    }
    const policyFailure = focusedScriptFailure(name, packageScripts);
    if (policyFailure) fail(policyFailure);
    return name;
  });
  if (profile === 'focused' && focusedScripts.length === 0) {
    fail('focused profile requires at least one focused script.');
  }
  const levels =
    sourceVersion === 1
      ? defaultLevels(profile)
      : validateStringList(
          rawManifest.validation.levels,
          'manifest.validation.levels',
          VALIDATION_LEVELS,
        );
  for (const requiredLevel of defaultLevels(profile)) {
    if (!levels.includes(requiredLevel)) {
      fail(`${profile} profile requires validation level: ${requiredLevel}.`);
    }
  }
  if (taskClass === 'critical' && profile !== 'critical') {
    fail('critical task requires the critical validation profile.');
  }
  if (taskClass === 'critical' && artifacts.taskPacket === null) {
    fail('critical task requires a Task Packet.');
  }

  return {
    taskClass,
    baseSha,
    requireCleanStage,
    expectedTransitions,
    allowedPaths,
    protectedPaths,
    allowBroadPaths,
    artifacts,
    profile,
    focusedScripts,
    levels,
  };
}

function validateManifest(rawManifest, packageJson) {
  assertObject(rawManifest, 'manifest');
  if (!SUPPORTED_MANIFEST_VERSIONS.has(rawManifest.version)) {
    fail('manifest.version must be 1 or 2.');
  }
  const sourceVersion = rawManifest.version;
  assertKnownKeys(
    rawManifest,
    sourceVersion === 1
      ? ['version', 'task', 'git', 'scope', 'artifacts', 'validation']
      : [
          'version',
          'contractVersion',
          'task',
          'git',
          'scope',
          'artifacts',
          'validation',
          'rehydration',
          'autonomy',
          'contracts',
        ],
    'manifest',
  );
  if (sourceVersion === 2 && rawManifest.contractVersion !== CONTRACT_VERSION) {
    fail(`manifest.contractVersion must be ${CONTRACT_VERSION}.`);
  }

  const common = validateCommon(rawManifest, packageJson, sourceVersion);
  let rehydration = { directSources: [], expansionTriggers: [] };
  let autonomy = {
    allowHighCorrections: false,
    requireIndependentReverification: common.taskClass === 'critical',
  };
  let contracts = {
    authorityRepository: AUTHORITY_REPOSITORY,
    contractSet: CONTRACT_SET_PATH,
  };

  if (sourceVersion === 2) {
    assertObject(rawManifest.rehydration, 'manifest.rehydration');
    assertKnownKeys(
      rawManifest.rehydration,
      ['directSources', 'expansionTriggers'],
      'manifest.rehydration',
    );
    rehydration = {
      directSources: validatePathList(
        rawManifest.rehydration.directSources,
        'manifest.rehydration.directSources',
        true,
      ),
      expansionTriggers: validateStringList(
        rawManifest.rehydration.expansionTriggers,
        'manifest.rehydration.expansionTriggers',
      ),
    };

    assertObject(rawManifest.autonomy, 'manifest.autonomy');
    assertKnownKeys(
      rawManifest.autonomy,
      ['allowHighCorrections', 'requireIndependentReverification'],
      'manifest.autonomy',
    );
    autonomy = {
      allowHighCorrections: requiredBoolean(
        rawManifest.autonomy.allowHighCorrections,
        'manifest.autonomy.allowHighCorrections',
      ),
      requireIndependentReverification: requiredBoolean(
        rawManifest.autonomy.requireIndependentReverification,
        'manifest.autonomy.requireIndependentReverification',
      ),
    };
    if (
      common.taskClass === 'critical' &&
      !autonomy.requireIndependentReverification
    ) {
      fail('critical task requires independent reverification.');
    }

    assertObject(rawManifest.contracts, 'manifest.contracts');
    assertKnownKeys(
      rawManifest.contracts,
      ['authorityRepository', 'contractSet'],
      'manifest.contracts',
    );
    contracts = {
      authorityRepository: requiredString(
        rawManifest.contracts.authorityRepository,
        'manifest.contracts.authorityRepository',
      ),
      contractSet: normalizeRepoPath(
        rawManifest.contracts.contractSet,
        'manifest.contracts.contractSet',
      ),
    };
    if (contracts.authorityRepository !== AUTHORITY_REPOSITORY) {
      fail(
        `manifest.contracts.authorityRepository must be ${AUTHORITY_REPOSITORY}.`,
      );
    }
    if (contracts.contractSet !== CONTRACT_SET_PATH) {
      fail(`manifest.contracts.contractSet must be ${CONTRACT_SET_PATH}.`);
    }
  }

  return {
    version: sourceVersion,
    normalizedVersion: MANIFEST_VERSION,
    contractVersion: CONTRACT_VERSION,
    task: {
      id: requiredString(rawManifest.task.id, 'manifest.task.id'),
      title: requiredString(rawManifest.task.title, 'manifest.task.title'),
      class: common.taskClass,
    },
    git: {
      branch: requiredString(rawManifest.git.branch, 'manifest.git.branch'),
      baseSha: common.baseSha,
      requireCleanStage: common.requireCleanStage,
      expectedTransitions: common.expectedTransitions,
    },
    scope: {
      allowedPaths: common.allowedPaths,
      protectedPaths: common.protectedPaths,
      allowBroadPaths: common.allowBroadPaths,
    },
    artifacts: common.artifacts,
    validation: {
      profile: common.profile,
      focusedScripts: common.focusedScripts,
      levels: common.levels,
    },
    rehydration,
    autonomy,
    contracts,
  };
}

function readJson(path, location) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${location} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${location} is invalid JSON: ${error.message}`);
  }
}

function loadTaskManifest({
  manifestPath = '.codex/task-manifest.json',
  packageJsonPath = 'package.json',
} = {}) {
  return validateManifest(
    readJson(manifestPath, manifestPath),
    readJson(packageJsonPath, packageJsonPath),
  );
}

function globToRegExp(glob) {
  let expression = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

function matchesAny(repoPath, globs) {
  const normalized = repoPath.replace(/\\/gu, '/').replace(/^\.\//u, '');
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function isRepositoryWideGlob(glob) {
  const pattern = globToRegExp(glob);
  return REPOSITORY_WIDE_PROBES.every((path) => pattern.test(path));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  AUTHORITY_REPOSITORY,
  CONTRACT_SET_PATH,
  CONTRACT_VERSION,
  EXPECTED_TRANSITIONS,
  MANIFEST_VERSION,
  ManifestValidationError,
  SUPPORTED_MANIFEST_VERSIONS,
  TASK_CLASSES,
  VALIDATION_LEVELS,
  VALIDATION_PROFILES,
  globToRegExp,
  isRepositoryWideGlob,
  loadTaskManifest,
  matchesAny,
  normalizeRepoPath,
  stableStringify,
  validateManifest,
};
