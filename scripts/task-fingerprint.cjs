const { createHash } = require('node:crypto');
const { join } = require('node:path');
const {
  MANIFEST_PATH,
  assertCandidate,
  candidateExclusions,
  readCandidateEntry,
} = require('./lib/task-candidate.cjs');
const { binaryDiff } = require('./lib/task-git.cjs');
const {
  loadTaskManifest,
  stableStringify,
} = require('./lib/task-manifest.cjs');

function fingerprintIdentity(manifest) {
  return {
    version: manifest.version,
    task: {
      id: manifest.task.id,
      class: manifest.task.class,
    },
    git: {
      branch: manifest.git.branch,
      baseSha: manifest.git.baseSha,
    },
  };
}

function serializeUntrackedEntry(path, entry) {
  const header = Buffer.from(
    `${path}\0${entry.type}\0${entry.mode ?? 'none'}\0${entry.content.length}\0`,
    'utf8',
  );
  return Buffer.concat([header, entry.content, Buffer.from('\0', 'utf8')]);
}

function calculateFingerprint({ cwd = process.cwd() } = {}) {
  const manifest = loadTaskManifest({
    manifestPath: join(cwd, ...MANIFEST_PATH.split('/')),
    packageJsonPath: join(cwd, 'package.json'),
  });
  const candidate = assertCandidate(manifest, cwd);
  const hash = createHash('sha256');
  hash.update('GENESIS_TASK_FINGERPRINT_V1\0');
  hash.update(stableStringify(fingerprintIdentity(manifest)));
  hash.update('\0TRACKED\0');
  hash.update(
    binaryDiff(manifest.git.baseSha, cwd, candidateExclusions(manifest)),
  );
  hash.update('\0UNTRACKED\0');
  for (const path of candidate.untracked) {
    const entry = readCandidateEntry(cwd, path);
    hash.update(serializeUntrackedEntry(path, entry));
  }
  return {
    task: manifest.task.id,
    baseSha: manifest.git.baseSha,
    trackedFiles: candidate.tracked.length,
    untrackedFiles: candidate.untracked.length,
    fingerprint: hash.digest('hex'),
  };
}

function main() {
  try {
    const result = calculateFingerprint();
    if (process.argv.slice(2).includes('--json')) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`Task: ${result.task}`);
    console.log(`Base: ${result.baseSha}`);
    console.log(`Tracked files: ${result.trackedFiles}`);
    console.log(`Untracked files: ${result.untrackedFiles}`);
    console.log(`Fingerprint: ${result.fingerprint}`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  calculateFingerprint,
  fingerprintIdentity,
  serializeUntrackedEntry,
};
