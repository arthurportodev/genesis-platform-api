const { lstatSync, readFileSync, readlinkSync } = require('node:fs');
const { join } = require('node:path');
const { matchesAny } = require('./task-manifest.cjs');
const {
  binaryDiff,
  gitModeForPath,
  isIgnored,
  isTracked,
  listCandidatePaths,
  nulEntries,
  pathExistsInBase,
  runGit,
} = require('./task-git.cjs');

const MANIFEST_PATH = '.codex/task-manifest.json';
const SECRET_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}/u;

class CandidateValidationError extends Error {
  constructor(failures) {
    super(
      `candidate is invalid:\n${failures.map((entry) => `- ${entry}`).join('\n')}`,
    );
    this.name = 'CandidateValidationError';
    this.failures = failures;
  }
}

function isLocalTransientArtifact(path, cwd = process.cwd()) {
  if (!path || isTracked(path, cwd) || !isIgnored(path, cwd)) return false;
  try {
    return lstatSync(join(cwd, ...path.split('/'))).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function candidateExclusions(manifest, cwd = process.cwd()) {
  return [MANIFEST_PATH, ...Object.values(manifest.artifacts)].filter((path) =>
    isLocalTransientArtifact(path, cwd),
  );
}

function artifactFailure(path) {
  const normalized = path.replace(/\\/gu, '/');
  const lower = normalized.toLowerCase();
  const segments = lower.split('/');
  const name = segments.at(-1);
  if (
    (name === '.env' || name.startsWith('.env.')) &&
    name !== '.env.example' &&
    !name.endsWith('.example')
  ) {
    return `real environment file is not allowed: ${normalized}`;
  }
  if (
    segments.some((entry) =>
      [
        'node_modules',
        'coverage',
        '.cache',
        'cache',
        'dist',
        'docker-data',
        'postgres-data',
        'volumes',
      ].includes(entry),
    )
  ) {
    return `generated artifact is not allowed: ${normalized}`;
  }
  if (/\.(?:log|dump|bak|tmp)$/u.test(lower)) {
    return `log, dump, backup or temporary file is not allowed: ${normalized}`;
  }
  return null;
}

function inspectCandidate(manifest, cwd = process.cwd()) {
  const paths = listCandidatePaths(
    manifest.git.baseSha,
    cwd,
    candidateExclusions(manifest, cwd),
  );
  const failures = [];
  for (const path of [...paths.tracked, ...paths.untracked]) {
    if (matchesAny(path, manifest.scope.protectedPaths)) {
      failures.push(`protected path changed: ${path}`);
    } else if (!matchesAny(path, manifest.scope.allowedPaths)) {
      failures.push(`file outside allowed scope: ${path}`);
    }
    const artifact = artifactFailure(path);
    if (artifact) failures.push(artifact);
  }
  for (const path of [...paths.tracked, ...paths.untracked]) {
    const entry = readCandidateEntry(cwd, path, manifest.git.baseSha);
    if (entry.type === 'other') {
      failures.push(`candidate entry has an irregular type: ${path}.`);
    }
    if (paths.untracked.includes(path) && entry.type !== 'file') {
      failures.push(`untracked candidate must be a regular file: ${path}.`);
    }
  }
  return { ...paths, failures: [...new Set(failures)].sort() };
}

function assertCandidate(manifest, cwd = process.cwd()) {
  const candidate = inspectCandidate(manifest, cwd);
  if (candidate.failures.length > 0) {
    throw new CandidateValidationError(candidate.failures);
  }
  return candidate;
}

function readCandidateEntry(cwd, path, baseSha = null) {
  const absolutePath = join(cwd, ...path.split('/'));
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (baseSha && pathExistsInBase(baseSha, path, cwd)) {
      return { type: 'deleted', mode: '000000', content: Buffer.alloc(0) };
    }
    return { type: 'other', mode: null, content: Buffer.alloc(0) };
  }
  if (stats.isSymbolicLink()) {
    return {
      type: 'symlink',
      mode: '120000',
      content: Buffer.from(readlinkSync(absolutePath), 'utf8'),
    };
  }
  if (!stats.isFile()) {
    return { type: 'other', mode: null, content: Buffer.alloc(0) };
  }
  return {
    type: 'file',
    mode:
      (baseSha && gitModeForPath(path, cwd)) ??
      (stats.mode & 0o111 ? '100755' : '100644'),
    content: readFileSync(absolutePath),
  };
}

function readIndexCandidateEntry(cwd, path, baseSha = null) {
  const entries = nulEntries(
    runGit(['ls-files', '--stage', '-z', '--', path], { cwd }).stdout ?? '',
  );
  if (entries.length === 0) {
    if (baseSha && pathExistsInBase(baseSha, path, cwd)) {
      return {
        type: 'deleted',
        mode: '000000',
        content: Buffer.alloc(0),
      };
    }
    return { type: 'other', mode: null, content: Buffer.alloc(0) };
  }
  if (entries.length !== 1) {
    return { type: 'other', mode: null, content: Buffer.alloc(0) };
  }
  const separator = entries[0].indexOf('\t');
  const metadata = entries[0].slice(0, separator).split(' ');
  const [mode, objectId, stage] = metadata;
  if (separator < 0 || stage !== '0' || !/^[a-f0-9]+$/u.test(objectId ?? '')) {
    return { type: 'other', mode: null, content: Buffer.alloc(0) };
  }
  const type =
    mode === '120000'
      ? 'symlink'
      : /^100[0-7]{3}$/u.test(mode)
        ? 'file'
        : 'other';
  return {
    type,
    mode,
    content:
      type === 'other' ? Buffer.alloc(0) : Buffer.from(objectId, 'ascii'),
  };
}

function hasObviousSecret(manifest, candidate, cwd = process.cwd()) {
  const diff = binaryDiff(
    manifest.git.baseSha,
    cwd,
    candidateExclusions(manifest, cwd),
  ).toString('utf8');
  if (SECRET_PATTERN.test(diff)) return true;
  return candidate.untracked.some((path) => {
    const content = readCandidateEntry(cwd, path).content;
    if (content.includes(0)) return false;
    return SECRET_PATTERN.test(content.toString('utf8'));
  });
}

module.exports = {
  CandidateValidationError,
  MANIFEST_PATH,
  SECRET_PATTERN,
  artifactFailure,
  assertCandidate,
  candidateExclusions,
  hasObviousSecret,
  inspectCandidate,
  isLocalTransientArtifact,
  readCandidateEntry,
  readIndexCandidateEntry,
};
