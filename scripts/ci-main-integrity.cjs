const { spawnSync } = require('node:child_process');
const { classifyPaths } = require('./lib/ci-surface-classifier.cjs');
const { changedPaths } = require('./ci-surface-classify.cjs');

function command(commandName, args, cwd = process.cwd()) {
  const result = spawnSync(commandName, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${commandName} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function buildIntegrityPlan(repository) {
  const plan = [
    ['node', ['scripts/task-contracts.cjs']],
    ['node', ['scripts/validate-project-memory.cjs', '--mode', 'local']],
  ];
  if (repository === 'api') {
    plan.push(['node', ['scripts/validate-ci-workflow.cjs']]);
  }
  return plan;
}

function runIntegrity(
  { repository, head = 'HEAD' },
  { cwd = process.cwd(), execute = command, now = Date.now } = {},
) {
  const startedAt = now();
  const resolvedHead = execute('git', ['rev-parse', head], cwd);
  const parents = execute(
    'git',
    ['show', '-s', '--format=%P', head],
    cwd,
  ).split(/\s+/u);
  if (parents.length !== 1 || !parents[0]) {
    throw new Error(`MAIN_INTEGRITY_PARENT_MISMATCH: ${resolvedHead}`);
  }
  const parent = parents[0];
  execute('git', ['diff', '--check', parent, resolvedHead], cwd);
  const classification = classifyPaths(
    changedPaths(parent, resolvedHead, cwd),
    repository,
  );
  if (classification.unknownPaths.length > 0) {
    throw new Error(
      classification.unknownPaths
        .map((path) => `UNKNOWN_CI_SURFACE_PATH: ${path}`)
        .join('\n'),
    );
  }
  for (const [commandName, args] of buildIntegrityPlan(repository)) {
    execute(commandName, args, cwd);
  }
  return {
    command: 'main-integrity-check',
    status: 'passed',
    durationMs: now() - startedAt,
    repository,
    headSha: resolvedHead,
    parentSha: parent,
    surfaces: classification.surfaces,
    changedPaths: classification.reasons.length,
  };
}

function main() {
  try {
    const repositoryIndex = process.argv.indexOf('--repository');
    const headIndex = process.argv.indexOf('--head');
    const repository = process.argv[repositoryIndex + 1];
    const head = headIndex >= 0 ? process.argv[headIndex + 1] : 'HEAD';
    if (!['api', 'web'].includes(repository))
      throw new Error('--repository must be api or web.');
    console.log(JSON.stringify(runIntegrity({ repository, head })));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { buildIntegrityPlan, command, runIntegrity };
