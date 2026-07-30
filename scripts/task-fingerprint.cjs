const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const {
  MANIFEST_PATH,
  assertCandidate,
  candidateExclusions,
  readCandidateEntry,
  readIndexCandidateEntry,
} = require('./lib/task-candidate.cjs');
const {
  binaryDiff,
  gitText,
  listGitState,
  runGit,
} = require('./lib/task-git.cjs');
const {
  loadTaskManifest,
  stableStringify,
} = require('./lib/task-manifest.cjs');

function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function fingerprintIdentity(manifest) {
  return {
    version: manifest.version,
    task: { id: manifest.task.id, class: manifest.task.class },
    git: { branch: manifest.git.branch, baseSha: manifest.git.baseSha },
  };
}

function serializeCanonicalEntry(path, entry) {
  const header = Buffer.from(
    `${path}\0${entry.type}\0${entry.mode ?? 'none'}\0${entry.content.length}\0`,
    'utf8',
  );
  return Buffer.concat([header, entry.content, Buffer.from('\0', 'utf8')]);
}

function serializeUntrackedEntry(path, entry) {
  return serializeCanonicalEntry(path, entry);
}

function canonicalWorktreeEntry(cwd, path, baseSha) {
  const entry = readCandidateEntry(cwd, path, baseSha);
  if (entry.type === 'file') {
    const objectId = gitText(
      ['hash-object', `--path=${path}`, '--', join(cwd, ...path.split('/'))],
      { cwd },
    );
    return { ...entry, content: Buffer.from(objectId, 'ascii') };
  }
  if (entry.type === 'symlink') {
    const objectId = (
      runGit(['hash-object', '--stdin'], {
        cwd,
        input: entry.content,
      }).stdout ?? ''
    ).trim();
    return { ...entry, content: Buffer.from(objectId, 'ascii') };
  }
  return entry;
}

function calculateLegacyFingerprint(manifest, candidate, cwd) {
  const hash = createHash('sha256');
  hash.update('GENESIS_TASK_FINGERPRINT_V1\0');
  hash.update(stableStringify(fingerprintIdentity(manifest)));
  hash.update('\0TRACKED\0');
  hash.update(
    binaryDiff(manifest.git.baseSha, cwd, candidateExclusions(manifest, cwd)),
  );
  hash.update('\0UNTRACKED\0');
  for (const path of candidate.untracked) {
    hash.update(
      serializeCanonicalEntry(
        path,
        readCandidateEntry(cwd, path, manifest.git.baseSha),
      ),
    );
  }
  return hash.digest('hex');
}

function calculateContentFingerprint(manifest, candidate, cwd) {
  const hash = createHash('sha256');
  hash.update('GENESIS_TASK_CONTENT_FINGERPRINT_V2\0');
  const candidatePaths = [
    ...new Set([...candidate.tracked, ...candidate.untracked]),
  ].sort();
  for (const path of candidatePaths) {
    hash.update(
      serializeCanonicalEntry(
        path,
        canonicalWorktreeEntry(cwd, path, manifest.git.baseSha),
      ),
    );
  }
  return { contentFingerprint: hash.digest('hex'), candidatePaths };
}

function calculateIndexContentFingerprint(manifest, candidatePaths, cwd) {
  const hash = createHash('sha256');
  const failures = [];
  hash.update('GENESIS_TASK_CONTENT_FINGERPRINT_V2\0');
  for (const path of candidatePaths) {
    const entry = readIndexCandidateEntry(cwd, path, manifest.git.baseSha);
    if (entry.type === 'other') {
      failures.push(`candidate path is absent or irregular in index: ${path}.`);
      continue;
    }
    hash.update(serializeCanonicalEntry(path, entry));
  }
  return {
    complete: failures.length === 0,
    contentFingerprint: failures.length === 0 ? hash.digest('hex') : null,
    failures,
  };
}

function calculateFingerprint({ cwd = process.cwd() } = {}) {
  const manifest = loadTaskManifest({
    manifestPath: join(cwd, ...MANIFEST_PATH.split('/')),
    packageJsonPath: join(cwd, 'package.json'),
  });
  const candidate = assertCandidate(manifest, cwd);
  const legacyFingerprint = calculateLegacyFingerprint(
    manifest,
    candidate,
    cwd,
  );
  const { contentFingerprint, candidatePaths } = calculateContentFingerprint(
    manifest,
    candidate,
    cwd,
  );
  const indexSnapshot = calculateIndexContentFingerprint(
    manifest,
    candidatePaths,
    cwd,
  );
  const gitState = listGitState(
    manifest.git.baseSha,
    cwd,
    candidateExclusions(manifest, cwd),
  );
  const gitStateFingerprint = sha256(
    'GENESIS_TASK_GIT_STATE_FINGERPRINT_V2\0',
    stableStringify(gitState),
  );
  const candidateId = sha256(
    'GENESIS_TASK_CANDIDATE_ID_V2\0',
    stableStringify({
      taskId: manifest.task.id,
      baseSha: manifest.git.baseSha,
      contractVersion: manifest.contractVersion,
      contentFingerprint,
    }),
  );
  return {
    task: manifest.task.id,
    baseSha: manifest.git.baseSha,
    manifestSourceVersion: manifest.version,
    fingerprintVersion: 2,
    trackedFiles: candidate.tracked.length,
    untrackedFiles: candidate.untracked.length,
    candidatePaths,
    expectedTransitions: manifest.git.expectedTransitions,
    fingerprint: legacyFingerprint,
    legacyFingerprint,
    contentFingerprint,
    gitStateFingerprint,
    candidateId,
    gitState,
    indexSnapshot,
  };
}

function verifyExpectedGitTransition(before, after, expectedTransitions = []) {
  const failures = [];
  if (before.task !== after.task || before.baseSha !== after.baseSha) {
    failures.push('task or base changed.');
  }
  if (
    stableStringify(before.expectedTransitions ?? []) !==
    stableStringify(after.expectedTransitions ?? [])
  ) {
    failures.push('declared Git transitions changed.');
  }
  if (
    before.contentFingerprint !== after.contentFingerprint ||
    before.candidateId !== after.candidateId
  ) {
    failures.push('candidate content identity changed.');
  }
  if (!after.indexSnapshot?.complete) {
    failures.push(
      ...(after.indexSnapshot?.failures ?? ['index snapshot is incomplete.']),
    );
  } else if (
    after.indexSnapshot.contentFingerprint !== before.contentFingerprint
  ) {
    failures.push(
      'index/commit content does not match the approved candidate.',
    );
  }
  if (
    stableStringify(before.candidatePaths) !==
    stableStringify(after.candidatePaths)
  ) {
    failures.push('candidate paths changed.');
  }
  if (
    before.gitState?.branch !== after.gitState?.branch ||
    before.gitState?.baseSha !== after.gitState?.baseSha
  ) {
    failures.push('branch or Git-state base changed.');
  }
  const beforeUntracked = new Set(before.gitState?.untrackedPaths ?? []);
  const afterUntracked = new Set(after.gitState?.untrackedPaths ?? []);
  for (const path of afterUntracked) {
    if (!beforeUntracked.has(path)) {
      failures.push(`unexpected untracked candidate appeared: ${path}.`);
    }
  }
  for (const path of beforeUntracked) {
    if (
      !afterUntracked.has(path) &&
      !expectedTransitions.includes('untracked-to-tracked')
    ) {
      failures.push(
        `untracked-to-tracked transition was not declared: ${path}.`,
      );
    }
  }
  if ((before.gitState?.stagedPaths ?? []).length > 0) {
    failures.push('approved reference must have an empty stage.');
  }
  if (
    (after.gitState?.stagedPaths ?? []).length === 0 &&
    (after.gitState?.committedPaths ?? []).length === 0
  ) {
    failures.push('candidate is neither staged nor committed.');
  }
  if (
    (after.gitState?.unstagedPaths ?? []).length > 0 ||
    (after.gitState?.untrackedPaths ?? []).length > 0
  ) {
    failures.push('candidate is not fully staged or committed.');
  }
  return {
    allowed: failures.length === 0,
    stateChanged: before.gitStateFingerprint !== after.gitStateFingerprint,
    failures,
  };
}

function main() {
  try {
    const transitionIndex = process.argv.indexOf('--verify-transition');
    if (transitionIndex >= 0) {
      const referencePath = process.argv[transitionIndex + 1];
      if (!referencePath)
        throw new Error('--verify-transition requires a JSON reference path.');
      const before = JSON.parse(
        readFileSync(
          isAbsolute(referencePath)
            ? referencePath
            : join(process.cwd(), referencePath),
          'utf8',
        ),
      );
      const after = calculateFingerprint();
      const verification = verifyExpectedGitTransition(
        before,
        after,
        before.expectedTransitions,
      );
      console.log(JSON.stringify({ verification, before, after }));
      if (!verification.allowed) process.exitCode = 1;
      return;
    }
    const result = calculateFingerprint();
    if (process.argv.slice(2).includes('--json')) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`Task: ${result.task}`);
    console.log(`Base: ${result.baseSha}`);
    console.log(`Tracked files: ${result.trackedFiles}`);
    console.log(`Untracked files: ${result.untrackedFiles}`);
    console.log(`Legacy fingerprint: ${result.legacyFingerprint}`);
    console.log(`Content fingerprint: ${result.contentFingerprint}`);
    console.log(`Git state fingerprint: ${result.gitStateFingerprint}`);
    console.log(`Candidate ID: ${result.candidateId}`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  calculateContentFingerprint,
  calculateFingerprint,
  calculateIndexContentFingerprint,
  canonicalWorktreeEntry,
  calculateLegacyFingerprint,
  fingerprintIdentity,
  serializeCanonicalEntry,
  serializeUntrackedEntry,
  sha256,
  verifyExpectedGitTransition,
};
