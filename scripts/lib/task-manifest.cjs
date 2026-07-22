const { readFileSync } = require('node:fs');
const { isAbsolute, posix, win32 } = require('node:path');
const { focusedScriptFailure } = require('./task-focused-script-policy.cjs');

const MANIFEST_VERSION = 1;
const TASK_CLASSES = new Set(['simple', 'normal', 'critical']);
const VALIDATION_PROFILES = new Set(['docs', 'focused', 'normal', 'critical']);
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
  if (segments.includes('..')) {
    fail(`${location} must not contain '..'.`);
  }

  const normalized = candidate.replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
  if (normalized === '' || normalized.endsWith('/')) {
    fail(`${location} must identify a path or glob.`);
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

function validateManifest(rawManifest, packageJson) {
  assertObject(rawManifest, 'manifest');
  assertKnownKeys(
    rawManifest,
    ['version', 'task', 'git', 'scope', 'artifacts', 'validation'],
    'manifest',
  );
  if (rawManifest.version !== MANIFEST_VERSION) {
    fail(`manifest.version must be ${MANIFEST_VERSION}.`);
  }

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
    ['branch', 'baseSha', 'requireCleanStage'],
    'manifest.git',
  );
  const baseSha = requiredString(
    rawManifest.git.baseSha,
    'manifest.git.baseSha',
  );
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) {
    fail('manifest.git.baseSha must be a full lowercase 40-character SHA.');
  }
  if (
    rawManifest.git.requireCleanStage !== undefined &&
    typeof rawManifest.git.requireCleanStage !== 'boolean'
  ) {
    fail('manifest.git.requireCleanStage must be a boolean.');
  }

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
  assertKnownKeys(rawManifest.artifacts, ['taskPacket'], 'manifest.artifacts');
  const taskPacket =
    rawManifest.artifacts.taskPacket === undefined
      ? null
      : normalizeRepoPath(
          rawManifest.artifacts.taskPacket,
          'manifest.artifacts.taskPacket',
        );

  assertObject(rawManifest.validation, 'manifest.validation');
  assertKnownKeys(
    rawManifest.validation,
    ['profile', 'focusedScripts'],
    'manifest.validation',
  );
  const profile = requiredString(
    rawManifest.validation.profile,
    'manifest.validation.profile',
  );
  if (!VALIDATION_PROFILES.has(profile)) {
    fail(`manifest.validation.profile is unknown: ${profile}.`);
  }
  if (!Array.isArray(rawManifest.validation.focusedScripts)) {
    fail('manifest.validation.focusedScripts must be an array.');
  }
  const packageScripts = packageJson?.scripts;
  if (
    packageScripts === null ||
    typeof packageScripts !== 'object' ||
    Array.isArray(packageScripts)
  ) {
    fail('package.json scripts are unavailable.');
  }
  const focusedScripts = rawManifest.validation.focusedScripts.map(
    (script, index) => {
      const name = requiredString(
        script,
        `manifest.validation.focusedScripts[${index}]`,
      );
      if (!Object.hasOwn(packageScripts, name)) {
        fail(`focused script does not exist in package.json: ${name}.`);
      }
      const policyFailure = focusedScriptFailure(name, packageScripts);
      if (policyFailure) fail(policyFailure);
      return name;
    },
  );
  if (profile === 'focused' && focusedScripts.length === 0) {
    fail('focused profile requires at least one focused script.');
  }
  if (taskClass === 'critical' && profile !== 'critical') {
    fail('critical task requires the critical validation profile.');
  }
  if (taskClass === 'critical' && taskPacket === null) {
    fail('critical task requires a Task Packet.');
  }

  return {
    version: MANIFEST_VERSION,
    task: {
      id: requiredString(rawManifest.task.id, 'manifest.task.id'),
      title: requiredString(rawManifest.task.title, 'manifest.task.title'),
      class: taskClass,
    },
    git: {
      branch: requiredString(rawManifest.git.branch, 'manifest.git.branch'),
      baseSha,
      requireCleanStage: rawManifest.git.requireCleanStage !== false,
    },
    scope: {
      allowedPaths,
      protectedPaths,
      allowBroadPaths,
    },
    artifacts: { taskPacket },
    validation: { profile, focusedScripts },
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
  MANIFEST_VERSION,
  ManifestValidationError,
  TASK_CLASSES,
  VALIDATION_PROFILES,
  globToRegExp,
  isRepositoryWideGlob,
  loadTaskManifest,
  matchesAny,
  normalizeRepoPath,
  stableStringify,
  validateManifest,
};
