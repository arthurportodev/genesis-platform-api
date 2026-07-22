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
  { cwd = process.cwd(), encoding = 'utf8', allowFailure = false } = {},
) {
  const result = spawnSync('git', args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new GitCommandError(args, result);
  }
  return result;
}

function lines(value) {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function gitText(args, options) {
  return (runGit(args, options).stdout ?? '').trim();
}

function listCandidatePaths(baseSha, cwd = process.cwd(), exclusions = []) {
  const pathspec = ['.'].concat(
    exclusions.map((entry) => `:(exclude)${entry}`),
  );
  const tracked = lines(
    gitText(
      [
        'diff',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
        baseSha,
        '--',
        ...pathspec,
      ],
      { cwd },
    ),
  );
  const untracked = lines(
    gitText(['ls-files', '--others', '--exclude-standard'], { cwd }),
  ).filter((entry) => !exclusions.includes(entry));
  return {
    tracked: [...new Set(tracked)].sort(),
    untracked: [...new Set(untracked)].sort(),
  };
}

function binaryDiff(baseSha, cwd = process.cwd(), exclusions = []) {
  const pathspec = ['.'].concat(
    exclusions.map((entry) => `:(exclude)${entry}`),
  );
  return runGit(
    ['diff', '--binary', '--no-ext-diff', baseSha, '--', ...pathspec],
    { cwd, encoding: null },
  ).stdout;
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
  gitText,
  isIgnored,
  isTracked,
  lines,
  listCandidatePaths,
  runGit,
};
