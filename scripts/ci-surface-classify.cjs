const { appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildSelection,
  classifyPaths,
} = require('./lib/ci-surface-classifier.cjs');
const { loadTaskManifest } = require('./lib/task-manifest.cjs');

function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function changedPaths(base, head, cwd = process.cwd()) {
  return git(['diff', '--name-only', '-z', '--find-renames', base, head], cwd)
    .split('\0')
    .filter(Boolean);
}

function verifyPullRequestCheckout(base, head, cwd = process.cwd()) {
  const checkout = git(['rev-parse', 'HEAD'], cwd).trim();
  const parents = git(['show', '-s', '--format=%P', 'HEAD'], cwd)
    .trim()
    .split(/\s+/u);
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
    throw new Error(
      `PR_MERGE_REF_MISMATCH: checkout ${checkout} parents ${parents.join(', ')}; expected ${base}, ${head}`,
    );
  }
  return { checkoutSha: checkout, baseSha: base, headSha: head };
}

function verifyTreeIdentity(
  expectedCommit,
  integratedCommit,
  cwd = process.cwd(),
) {
  const expectedTree = git(
    ['rev-parse', `${expectedCommit}^{tree}`],
    cwd,
  ).trim();
  const integratedTree = git(
    ['rev-parse', `${integratedCommit}^{tree}`],
    cwd,
  ).trim();
  if (expectedTree !== integratedTree) {
    throw new Error(
      `SQUASH_TREE_MISMATCH: expected ${expectedTree}; integrated ${integratedTree}`,
    );
  }
  return { expectedCommit, integratedCommit, treeSha: expectedTree };
}

function parseArguments(argv) {
  const options = { full: false, verifyPullRequest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--full') options.full = true;
    else if (argument === '--verify-pr-checkout')
      options.verifyPullRequest = true;
    else if (argument.startsWith('--')) {
      const key = argument
        .slice(2)
        .replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = argv[index + 1];
      index += 1;
    } else throw new Error(`unexpected argument: ${argument}`);
  }
  return options;
}

function declaredSurfaces(manifestPath, cwd = process.cwd()) {
  if (!manifestPath) return null;
  const absolutePath = join(cwd, ...manifestPath.split('/'));
  if (!existsSync(absolutePath)) return null;
  const manifest = loadTaskManifest({
    manifestPath: absolutePath,
    packageJsonPath: join(cwd, 'package.json'),
  });
  return manifest.validation.mode === 'surfaces'
    ? manifest.validation.surfaces
    : null;
}

function githubOutputs(selection) {
  const selected = new Set(selection.surfaces);
  const values = {
    surfaces: JSON.stringify(selection.surfaces),
    memory: selected.has('memory'),
    app: selected.has('app'),
    production: selected.has('production'),
    tooling: selected.has('tooling'),
    recovery: selection.modifiers.recovery,
    image_build_scan: selection.modifiers.imageBuildScan,
    legacy_production: selection.modifiers.legacyProduction,
    needs_dependencies:
      selected.has('app') ||
      selected.has('production') ||
      selected.has('tooling'),
    playwright:
      selection.repository === 'web' &&
      (selected.has('app') || selected.has('production')),
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function run(options, cwd = process.cwd()) {
  if (!['api', 'web'].includes(options.repository)) {
    throw new Error('--repository must be api or web.');
  }
  let identity = null;
  let paths = [];
  if (!options.full) {
    if (!options.base || !options.head)
      throw new Error('--base and --head are required unless --full is used.');
    if (options.verifyPullRequest) {
      identity = verifyPullRequestCheckout(options.base, options.head, cwd);
    }
    paths = changedPaths(
      options.base,
      identity ? identity.checkoutSha : options.head,
      cwd,
    );
  }
  const classification = classifyPaths(paths, options.repository);
  const selection = buildSelection(
    classification,
    declaredSurfaces(options.manifest, cwd),
    { full: options.full },
  );
  const result = { ...selection, identity };
  if (selection.failures.length > 0) {
    const error = new Error(selection.failures.join('\n'));
    error.result = result;
    throw error;
  }
  return result;
}

function main() {
  const startedAt = Date.now();
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = run(options);
    const output = githubOutputs(result);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Delta-aware CI\n\n- Surfaces: ${result.surfaces.join(', ')}\n- Recovery: ${result.modifiers.recovery}\n- Image build/scan: ${result.modifiers.imageBuildScan}\n- Legacy Production: ${result.modifiers.legacyProduction}\n- Paths: ${result.reasons.length}\n`,
      );
    }
    console.log(
      JSON.stringify({
        command: 'ci-surface-classify',
        status: 'passed',
        durationMs: Date.now() - startedAt,
        ...result,
      }),
    );
  } catch (error) {
    if (error.result) console.error(JSON.stringify(error.result));
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  changedPaths,
  declaredSurfaces,
  githubOutputs,
  parseArguments,
  run,
  verifyTreeIdentity,
  verifyPullRequestCheckout,
};
