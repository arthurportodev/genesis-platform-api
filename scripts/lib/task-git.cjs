const { spawnSync } = require('node:child_process');

class GitCommandError extends Error {
  constructor(args, result) {
    super(
      `git ${args.join(' ')} failed with exit code ${result.status ?? 1}: ${(result.stderr ?? '').trim()}`,
    );
    this.name = 'GitCommandError';
    this.exitCode = result.status ?? 1;
  }
}

function runGit(
  args,
  { cwd = process.cwd(), encoding = 'utf8', allowFailure = false, input } = {},
) {
  const result = spawnSync('git', args, {
    cwd,
    encoding,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw new GitCommandError(args, result);
  return result;
}

function lines(value) {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function nulEntries(value) {
  return value.split('\0').filter(Boolean);
}

function gitText(args, options) {
  return (runGit(args, options).stdout ?? '').trim();
}

function gitNulEntries(args, cwd = process.cwd()) {
  return nulEntries(runGit(args, { cwd }).stdout ?? '');
}

function exclusionPathspec(exclusions) {
  return ['.'].concat(exclusions.map((entry) => `:(exclude)${entry}`));
}

function listCandidatePaths(baseSha, cwd = process.cwd(), exclusions = []) {
  const pathspec = exclusionPathspec(exclusions);
  const tracked = gitNulEntries(
    [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--diff-filter=ACDMRTUXB',
      baseSha,
      '--',
      ...pathspec,
    ],
    cwd,
  );
  const untracked = gitNulEntries(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    cwd,
  ).filter((entry) => !exclusions.includes(entry));
  return {
    tracked: [...new Set(tracked)].sort(),
    untracked: [...new Set(untracked)].sort(),
  };
}

function binaryDiff(baseSha, cwd = process.cwd(), exclusions = []) {
  return runGit(
    [
      'diff',
      '--binary',
      '--no-renames',
      '--no-ext-diff',
      baseSha,
      '--',
      ...exclusionPathspec(exclusions),
    ],
    { cwd, encoding: null },
  ).stdout;
}

function listGitState(baseSha, cwd = process.cwd(), exclusions = []) {
  const pathspec = exclusionPathspec(exclusions);
  const committedPaths = gitNulEntries(
    [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      `${baseSha}..HEAD`,
      '--',
      ...pathspec,
    ],
    cwd,
  );
  const stagedPaths = gitNulEntries(
    [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      '--no-renames',
      '--',
      ...pathspec,
    ],
    cwd,
  );
  const unstagedPaths = gitNulEntries(
    ['diff', '--name-only', '-z', '--no-renames', '--', ...pathspec],
    cwd,
  );
  const untrackedPaths = gitNulEntries(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    cwd,
  ).filter((entry) => !exclusions.includes(entry));
  return {
    branch: gitText(['branch', '--show-current'], { cwd }),
    baseSha,
    headSha: gitText(['rev-parse', 'HEAD'], { cwd }),
    committedPaths: [...new Set(committedPaths)].sort(),
    stagedPaths: [...new Set(stagedPaths)].sort(),
    unstagedPaths: [...new Set(unstagedPaths)].sort(),
    untrackedPaths: [...new Set(untrackedPaths)].sort(),
  };
}

function gitModeForPath(baseSha, path, cwd = process.cwd()) {
  const raw = gitText(
    ['diff', '--raw', '--no-abbrev', '--no-renames', baseSha, '--', path],
    { cwd },
  );
  const rawMatch = raw.match(
    /^:[0-7]{6} ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ [A-Z]/mu,
  );
  if (rawMatch) return rawMatch[1];
  const indexed = gitText(['ls-files', '--stage', '--', path], { cwd });
  return indexed.match(/^([0-7]{6})\s/u)?.[1] ?? null;
}

function pathExistsInBase(baseSha, path, cwd = process.cwd()) {
  return (
    runGit(['cat-file', '-e', `${baseSha}:${path}`], {
      cwd,
      allowFailure: true,
    }).status === 0
  );
}

function isIgnored(path, cwd = process.cwd()) {
  return (
    runGit(['check-ignore', '-q', '--', path], { cwd, allowFailure: true })
      .status === 0
  );
}

function isTracked(path, cwd = process.cwd()) {
  return gitText(['ls-files', '--', path], { cwd }) !== '';
}

module.exports = {
  GitCommandError,
  binaryDiff,
  gitModeForPath,
  gitNulEntries,
  gitText,
  isIgnored,
  isTracked,
  lines,
  listCandidatePaths,
  listGitState,
  nulEntries,
  pathExistsInBase,
  runGit,
};
