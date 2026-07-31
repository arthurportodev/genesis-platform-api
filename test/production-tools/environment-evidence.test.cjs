const assert = require('node:assert/strict');
const test = require('node:test');
const {
  validateEnvironmentEvidence,
} = require('../../scripts/verify-environment-evidence.cjs');

const HASH = 'a'.repeat(64);
const BASE = 'aedafa41eff756ce0e66ed559e91e0ae2d610847';

function validEvidence() {
  return {
    schemaVersion: 'environment-evidence.v1',
    taskId: '0.8.2',
    baseSha: BASE,
    candidateId: HASH,
    builderExecutorId: 'builder-1',
    executor: {
      id: 'builder-1',
      role: 'builder',
      readOnly: false,
      writeOperations: 1,
    },
    environment: {
      os: 'linux',
      kernel: '6.6.0-linuxkit',
      architecture: 'amd64',
      dockerVersion: '29.6.1',
      buildxVersion: '0.35.0',
    },
    baseImage: {
      reference:
        'gcr.io/distroless/nodejs24-debian13:nonroot-amd64@sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514',
      indexDigest:
        'sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212',
      manifestDigest:
        'sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514',
    },
    candidateImage: {
      reference: 'genesis-platform-api:gate2-local',
      imageId: `sha256:${HASH}`,
      platform: 'linux/amd64',
    },
    commands: [
      {
        command: 'docker inspect candidate',
        startedAt: '2026-07-30T20:00:00.000Z',
        completedAt: '2026-07-30T20:00:01.000Z',
        exitCode: 0,
        stdoutSha256: HASH,
        stderrSha256: HASH,
      },
    ],
    artifacts: {
      runtimeLogSha256: HASH,
      sbomSha256: HASH,
      scanSha256: HASH,
    },
    invariants: [
      {
        name: 'non-root',
        required: true,
        result: 'passed',
        evidence: 'uid=1000 gid=1000',
      },
    ],
    startedAt: '2026-07-30T20:00:00.000Z',
    completedAt: '2026-07-30T20:00:02.000Z',
  };
}

test('accepts complete Linux/amd64 evidence bound to the candidate', () => {
  const evidence = validEvidence();
  assert.equal(
    validateEnvironmentEvidence(evidence, {
      expectedCandidateId: HASH,
      expectedBaseSha: BASE,
    }),
    evidence,
  );
});

test('rejects a required environmental invariant that did not pass', () => {
  const evidence = validEvidence();
  evidence.invariants[0].result = 'failed';
  assert.throws(
    () => validateEnvironmentEvidence(evidence),
    /required invariant did not pass: non-root/u,
  );
});

test('requires an independent read-only verifier executor', () => {
  const evidence = validEvidence();
  evidence.executor = {
    id: 'builder-1',
    role: 'verifier',
    readOnly: false,
    writeOperations: 1,
  };
  assert.throws(
    () => validateEnvironmentEvidence(evidence),
    /verifier executor must be distinct/u,
  );
});
