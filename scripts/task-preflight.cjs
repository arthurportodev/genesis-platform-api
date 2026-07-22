const { existsSync } = require('node:fs');
const { join } = require('node:path');
const {
  MANIFEST_PATH,
  hasObviousSecret,
  inspectCandidate,
} = require('./lib/task-candidate.cjs');
const {
  gitText,
  isIgnored,
  isTracked,
  lines,
  runGit,
} = require('./lib/task-git.cjs');
const { loadTaskManifest } = require('./lib/task-manifest.cjs');

function runPreflight({ cwd = process.cwd(), startedAt = Date.now() } = {}) {
  const manifestPath = join(cwd, ...MANIFEST_PATH.split('/'));
  const manifest = loadTaskManifest({
    manifestPath,
    packageJsonPath: join(cwd, 'package.json'),
  });
  const failures = [];
  const branch = gitText(['branch', '--show-current'], { cwd });
  const sha = gitText(['rev-parse', 'HEAD'], { cwd });
  const baseExists = runGit(
    ['cat-file', '-e', `${manifest.git.baseSha}^{commit}`],
    { cwd, allowFailure: true },
  );
  const ancestor = runGit(
    ['merge-base', '--is-ancestor', manifest.git.baseSha, 'HEAD'],
    { cwd, allowFailure: true },
  );
  const staged = lines(gitText(['diff', '--cached', '--name-only'], { cwd }));
  const diffCheck =
    baseExists.status === 0
      ? runGit(['diff', '--check', manifest.git.baseSha], {
          cwd,
          allowFailure: true,
        })
      : { status: 1, stdout: '' };
  const candidate =
    baseExists.status === 0
      ? inspectCandidate(manifest, cwd)
      : { tracked: [], untracked: [], failures: [] };

  if (branch !== manifest.git.branch) {
    failures.push(
      `branch mismatch: expected ${manifest.git.branch}, got ${branch}.`,
    );
  }
  if (baseExists.status !== 0) {
    failures.push(`base commit is unavailable: ${manifest.git.baseSha}.`);
  }
  if (ancestor.status !== 0) {
    failures.push(`HEAD is not based on ${manifest.git.baseSha}.`);
  }
  if (manifest.git.requireCleanStage && staged.length > 0) {
    failures.push(`stage is not empty: ${staged.join(', ')}.`);
  }
  if (baseExists.status === 0 && diffCheck.status !== 0) {
    failures.push(
      `git diff --check failed: ${(diffCheck.stdout ?? '').trim()}`,
    );
  }
  if (!existsSync(manifestPath)) failures.push('task manifest is missing.');
  if (!isIgnored(MANIFEST_PATH, cwd))
    failures.push('task manifest is not ignored.');
  if (isTracked(MANIFEST_PATH, cwd)) failures.push('task manifest is tracked.');

  const packet = manifest.artifacts.taskPacket;
  if (packet) {
    const packetPath = join(cwd, ...packet.split('/'));
    if (!existsSync(packetPath))
      failures.push(`Task Packet is missing: ${packet}.`);
    if (!isIgnored(packet, cwd))
      failures.push(`Task Packet is not ignored: ${packet}.`);
    if (isTracked(packet, cwd))
      failures.push(`Task Packet is tracked: ${packet}.`);
  }

  failures.push(...candidate.failures);
  if (baseExists.status === 0 && hasObviousSecret(manifest, candidate, cwd)) {
    failures.push('possible secret found in candidate content.');
  }

  const result = {
    command: 'npm run task:preflight',
    status: failures.length === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - startedAt,
    task: manifest.task.id,
    branch,
    sha,
    baseSha: manifest.git.baseSha,
    stagedFiles: staged.length,
    trackedFiles: candidate.tracked.length,
    untrackedFiles: candidate.untracked.length,
    failures: [...new Set(failures)].sort(),
  };
  return result;
}

function main() {
  try {
    const result = runPreflight();
    for (const failure of result.failures) console.error(`FAIL: ${failure}`);
    console.log(JSON.stringify(result));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { runPreflight };
