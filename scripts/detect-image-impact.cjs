const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const FULL_SHA = /^[a-f0-9]{40}$/u;
const ZERO_SHA = /^0{40}$/u;
const IMAGE_AFFECTING_ROOT_FILES = new Set([
  '.dockerignore',
  '.npmrc',
  'Dockerfile',
  'nest-cli.json',
  'package-lock.json',
  'package.json',
]);
const ROOT_TSCONFIG = /^tsconfig(?:\.[a-zA-Z0-9_-]+)*\.json$/u;
const SIMPLE_STATUS = new Set(['A', 'D', 'M', 'T']);
const SCORED_STATUS = /^([CR])([0-9]{1,3})$/u;

class ImageImpactError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageImpactError';
  }
}

function validateSha(value, label) {
  if (
    typeof value !== 'string' ||
    !FULL_SHA.test(value) ||
    ZERO_SHA.test(value)
  ) {
    throw new ImageImpactError(
      `${label} must be a non-zero full lowercase Git SHA.`,
    );
  }
  return value;
}

function normalizeGitPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ImageImpactError('Git emitted an empty path.');
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ImageImpactError('Git emitted an unsafe path.');
  }
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new ImageImpactError('Git emitted a non-canonical path.');
  }
  return normalized;
}

function isImageAffectingPath(value) {
  const path = normalizeGitPath(value);
  return (
    IMAGE_AFFECTING_ROOT_FILES.has(path) ||
    ROOT_TSCONFIG.test(path) ||
    path.startsWith('src/')
  );
}

function decodeField(value) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new ImageImpactError('Git emitted a non-UTF-8 field.');
  }
}

function parseNameStatusZ(output) {
  if (!Buffer.isBuffer(output)) {
    throw new ImageImpactError('Git output must be a byte buffer.');
  }
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) {
    throw new ImageImpactError('Git output is not NUL terminated.');
  }

  const fields = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    fields.push(decodeField(output.subarray(start, index)));
    start = index + 1;
  }
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    index += 1;
    if (SIMPLE_STATUS.has(status)) {
      if (index >= fields.length) {
        throw new ImageImpactError('Git output ended before a changed path.');
      }
      changes.push({ status, paths: [normalizeGitPath(fields[index])] });
      index += 1;
      continue;
    }

    const scored = SCORED_STATUS.exec(status);
    if (!scored || Number(scored[2]) > 100 || index + 1 >= fields.length) {
      throw new ImageImpactError(
        'Git emitted an unsupported or ambiguous status.',
      );
    }
    changes.push({
      status,
      paths: [
        normalizeGitPath(fields[index]),
        normalizeGitPath(fields[index + 1]),
      ],
    });
    index += 2;
  }
  return changes;
}

function analyzeNameStatus(output) {
  const changes = parseNameStatusZ(output);
  const changedPaths = [
    ...new Set(changes.flatMap((change) => change.paths)),
  ].sort();
  return {
    changedPaths,
    shouldPublish: changedPaths.some(isImageAffectingPath),
  };
}

function runGit(args, { cwd = process.cwd(), spawn = spawnSync } = {}) {
  const result = spawn('git', args, {
    cwd,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new ImageImpactError(
      'Git could not prove the requested commit range.',
    );
  }
  if (
    result.stderr !== undefined &&
    (!Buffer.isBuffer(result.stderr) || result.stderr.length !== 0)
  ) {
    throw new ImageImpactError('Git returned an ambiguous diagnostic channel.');
  }
  if (!Buffer.isBuffer(result.stdout)) {
    throw new ImageImpactError('Git returned an invalid output channel.');
  }
  return result.stdout;
}

function detectImageImpact({
  base,
  head,
  cwd = process.cwd(),
  spawn = spawnSync,
}) {
  const validBase = validateSha(base, 'base');
  const validHead = validateSha(head, 'head');
  runGit(['cat-file', '-e', `${validBase}^{commit}`], { cwd, spawn });
  runGit(['cat-file', '-e', `${validHead}^{commit}`], { cwd, spawn });
  const output = runGit(
    [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      validBase,
      validHead,
      '--',
    ],
    { cwd, spawn },
  );
  return analyzeNameStatus(output);
}

function parseCliArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--base' || argv[2] !== '--head') {
    throw new ImageImpactError('Expected --base <full-sha> --head <full-sha>.');
  }
  return { base: argv[1], head: argv[3] };
}

function writeGithubOutput(outputPath, shouldPublish) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new ImageImpactError('GITHUB_OUTPUT is required.');
  }
  if (typeof shouldPublish !== 'boolean') {
    throw new ImageImpactError('Image impact result must be boolean.');
  }
  appendFileSync(
    outputPath,
    `should_publish=${shouldPublish ? 'true' : 'false'}\n`,
    {
      encoding: 'utf8',
    },
  );
}

function main() {
  try {
    const { base, head } = parseCliArguments(process.argv.slice(2));
    const result = detectImageImpact({ base, head });
    writeGithubOutput(process.env.GITHUB_OUTPUT, result.shouldPublish);
  } catch (error) {
    console.error(
      error instanceof ImageImpactError
        ? `Image impact detection failed: ${error.message}`
        : 'Image impact detection failed unexpectedly.',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  FULL_SHA,
  IMAGE_AFFECTING_ROOT_FILES,
  ImageImpactError,
  ROOT_TSCONFIG,
  analyzeNameStatus,
  detectImageImpact,
  isImageAffectingPath,
  normalizeGitPath,
  parseCliArguments,
  parseNameStatusZ,
  validateSha,
  writeGithubOutput,
};
