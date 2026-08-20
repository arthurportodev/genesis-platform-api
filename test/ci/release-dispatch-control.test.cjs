const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const {
  DISPATCH_REF,
  DispatchApiError,
  DispatchControlError,
  EXIT,
  IMAGE_SOURCE_INPUT,
  RELEASE_WORKFLOW,
  controlDispatch,
  createDispatchPayload,
  createGhAdapter,
  safeFailure,
} = require('../../scripts/dispatch-release-image.cjs');

const WORKFLOW_SHA = 'b00a111735aade7689d7abd8d6833ce7b93efeac';
const MOVED_SHA = 'c00a111735aade7689d7abd8d6833ce7b93efeac';
const IMAGE_SOURCE_SHA = '0a56a8aee7c64bda59a1981888418e1ad03950c0';
const WORKFLOW = { id: 55, path: RELEASE_WORKFLOW };
const STARTED_AT = new Date('2026-08-20T17:00:00.500Z');
const CORRECT_RUN = Object.freeze({
  id: 9001,
  workflow_id: WORKFLOW.id,
  path: RELEASE_WORKFLOW,
  event: 'workflow_dispatch',
  created_at: '2026-08-20T17:00:01.000Z',
  head_sha: WORKFLOW_SHA,
  head_branch: DISPATCH_REF,
  html_url: 'https://github.example.invalid/actions/runs/9001',
});
const FIXTURE = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures', 'workflow-dispatch', 'attempt-5-http-422.json'),
    'utf8',
  ),
);

function githubFixture({
  remoteMainSha = WORKFLOW_SHA,
  before = [],
  polls = [[CORRECT_RUN]],
  dispatchResponse = { status: 204 },
  dispatchError = null,
  workflow = WORKFLOW,
  cancelError = null,
} = {}) {
  const state = {
    getWorkflowCalls: 0,
    mainCalls: 0,
    listCalls: 0,
    dispatchCalls: 0,
    cancelCalls: 0,
    payloads: [],
    cancelled: [],
  };
  let pollIndex = 0;
  return {
    state,
    github: {
      async getWorkflow() {
        state.getWorkflowCalls += 1;
        return workflow;
      },
      async getRemoteMainSha() {
        state.mainCalls += 1;
        return remoteMainSha;
      },
      async listWorkflowRuns() {
        state.listCalls += 1;
        if (state.listCalls === 1) return before;
        const value = polls[Math.min(pollIndex, polls.length - 1)] ?? [];
        pollIndex += 1;
        return value;
      },
      async dispatchWorkflow(_workflowId, payload) {
        state.dispatchCalls += 1;
        state.payloads.push(structuredClone(payload));
        if (dispatchError) throw dispatchError;
        return dispatchResponse;
      },
      async cancelWorkflowRun(runId) {
        state.cancelCalls += 1;
        state.cancelled.push(runId);
        if (cancelError) throw cancelError;
        return { status: 202 };
      },
    },
  };
}

function options(overrides = {}) {
  return {
    workflowRef: WORKFLOW_SHA,
    imageSourceSha: IMAGE_SOURCE_SHA,
    pollAttempts: 1,
    pollIntervalMs: 0,
    ...overrides,
  };
}

function dependencies(github, overrides = {}) {
  return {
    github,
    now: () => STARTED_AT,
    sleep: async () => {},
    ...overrides,
  };
}

async function rejectsResult(promise, result, exitCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof DispatchControlError, true);
    assert.equal(error.result, result);
    assert.equal(error.exitCode, exitCode);
    return true;
  });
}

test('1. attempt-5 raw SHA ref reproduces sanitized HTTP 422 through a local mock only', async () => {
  assert.equal(FIXTURE.requestedRef, WORKFLOW_SHA);
  assert.equal(FIXTURE.httpStatus, 422);
  assert.equal(FIXTURE.createdRun, false);
  assert.equal(FIXTURE.retryPerformed, false);
  assert.equal(FIXTURE.source.sanitized, true);
  assert.equal(FIXTURE.source.containsSecrets, false);
  let calls = 0;
  const adapter = createGhAdapter({
    repository: 'arthurportodev/genesis-platform-api',
    spawn(_command, args, spawnOptions) {
      calls += 1;
      assert.equal(args.includes('dispatches'), false);
      assert.equal(
        args.some((arg) => arg.endsWith('/dispatches')),
        true,
      );
      assert.equal(JSON.parse(spawnOptions.input).ref, FIXTURE.requestedRef);
      return {
        error: undefined,
        signal: null,
        status: 1,
        stdout: '',
        stderr:
          'gh: No ref found for requested immutable workflow commit (HTTP 422)',
      };
    },
  });
  await assert.rejects(
    adapter.dispatchWorkflow(WORKFLOW.id, {
      ref: FIXTURE.requestedRef,
      inputs: { [IMAGE_SOURCE_INPUT]: IMAGE_SOURCE_SHA },
    }),
    (error) => error instanceof DispatchApiError && error.status === 422,
  );
  assert.equal(calls, 1);
});

test('2. HTTP 422 fails closed after exactly one dispatch call', async () => {
  const fixture = githubFixture({ dispatchError: new DispatchApiError(422) });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'DISPATCH_REJECTED_HTTP_422',
    EXIT.DISPATCH_HTTP_422,
  );
  assert.equal(fixture.state.dispatchCalls, 1);
  assert.equal(fixture.state.listCalls, 1);
});

test('3. ref main produces the exact workflow payload', () => {
  assert.deepEqual(createDispatchPayload(IMAGE_SOURCE_SHA), {
    ref: 'main',
    inputs: { full_sha: IMAGE_SOURCE_SHA, confirm_release: 'true' },
  });
});

test('3b. the gh adapter proves the real 204 status without exposing response headers', async () => {
  let calls = 0;
  const adapter = createGhAdapter({
    repository: 'arthurportodev/genesis-platform-api',
    spawn(_command, args, spawnOptions) {
      calls += 1;
      assert.equal(args.includes('--include'), true);
      assert.deepEqual(JSON.parse(spawnOptions.input), {
        ref: 'main',
        inputs: { full_sha: IMAGE_SOURCE_SHA, confirm_release: 'true' },
      });
      return {
        error: undefined,
        signal: null,
        status: 0,
        stdout: 'HTTP/2.0 204 No Content\r\nX-Test: safe\r\n\r\n',
        stderr: '',
      };
    },
  });
  assert.deepEqual(
    await adapter.dispatchWorkflow(
      WORKFLOW.id,
      createDispatchPayload(IMAGE_SOURCE_SHA),
    ),
    { status: 204 },
  );
  assert.equal(calls, 1);
});

test('4. main equal to approved workflowRef permits one dispatch', async () => {
  const fixture = githubFixture();
  const result = await controlDispatch(options(), dependencies(fixture.github));
  assert.equal(result.result, 'DISPATCH_CONFIRMED');
  assert.equal(fixture.state.mainCalls, 1);
  assert.equal(fixture.state.dispatchCalls, 1);
});

test('5. moved main returns MAIN_MOVED_BEFORE_DISPATCH with zero dispatch', async () => {
  const fixture = githubFixture({ remoteMainSha: MOVED_SHA });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'MAIN_MOVED_BEFORE_DISPATCH',
    EXIT.MAIN_MOVED_BEFORE_DISPATCH,
  );
  assert.equal(fixture.state.dispatchCalls, 0);
  assert.equal(fixture.state.cancelCalls, 0);
});

test('6. main moving between precheck and run creation is cancelled and rejected', async () => {
  const run = { ...CORRECT_RUN, head_sha: MOVED_SHA };
  const fixture = githubFixture({ polls: [[run]] });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'DISPATCHED_WORKFLOW_SHA_MISMATCH',
    EXIT.WORKFLOW_SHA_MISMATCH,
  );
  assert.deepEqual(fixture.state.cancelled, [run.id]);
  assert.equal(fixture.state.dispatchCalls, 1);
});

test('7. exact run head SHA and branch are accepted', async () => {
  const fixture = githubFixture();
  const result = await controlDispatch(options(), dependencies(fixture.github));
  assert.equal(result.runId, CORRECT_RUN.id);
  assert.equal(result.approvedWorkflowRef, WORKFLOW_SHA);
  assert.equal(result.dispatchRef, 'main');
  assert.equal(fixture.state.cancelCalls, 0);
});

test('8. divergent run head SHA is rejected fail-closed', async () => {
  const fixture = githubFixture({
    polls: [[{ ...CORRECT_RUN, head_sha: MOVED_SHA }]],
  });
  await assert.rejects(
    controlDispatch(options(), dependencies(fixture.github)),
    (error) => {
      assert.equal(error.result, 'DISPATCHED_WORKFLOW_SHA_MISMATCH');
      assert.equal(error.details.requiresEnvironmentDisable, true);
      assert.equal(error.details.cancellationRequested, true);
      return true;
    },
  );
});

test('9. divergent run head branch is cancelled and rejected', async () => {
  const fixture = githubFixture({
    polls: [[{ ...CORRECT_RUN, head_branch: 'release-candidate' }]],
  });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'DISPATCHED_WORKFLOW_BRANCH_MISMATCH',
    EXIT.WORKFLOW_BRANCH_MISMATCH,
  );
  assert.deepEqual(fixture.state.cancelled, [CORRECT_RUN.id]);
});

test('10. zero new runs remains inconclusive and is never redispatched', async () => {
  const fixture = githubFixture({ polls: [[]] });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'DISPATCH_RUN_NOT_FOUND',
    EXIT.RUN_NOT_FOUND,
  );
  assert.equal(fixture.state.dispatchCalls, 1);
});

test('11. multiple new runs remain ambiguous and are never redispatched', async () => {
  const fixture = githubFixture({
    polls: [[CORRECT_RUN, { ...CORRECT_RUN, id: 9002 }]],
  });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'DISPATCH_RUN_AMBIGUOUS',
    EXIT.RUN_AMBIGUOUS,
  );
  assert.equal(fixture.state.dispatchCalls, 1);
});

test('11b. a second concurrent run appearing after the first is detected as ambiguous', async () => {
  const fixture = githubFixture({
    polls: [[CORRECT_RUN], [CORRECT_RUN, { ...CORRECT_RUN, id: 9002 }]],
  });
  await rejectsResult(
    controlDispatch(options({ pollAttempts: 2 }), dependencies(fixture.github)),
    'DISPATCH_RUN_AMBIGUOUS',
    EXIT.RUN_AMBIGUOUS,
  );
  assert.equal(fixture.state.dispatchCalls, 1);
});

test('11c. a concurrent non-main run does not contaminate main uniqueness', async () => {
  const nonMain = {
    ...CORRECT_RUN,
    id: 9002,
    head_branch: 'other',
    head_sha: MOVED_SHA,
  };
  const fixture = githubFixture({ polls: [[CORRECT_RUN, nonMain]] });
  const result = await controlDispatch(options(), dependencies(fixture.github));
  assert.equal(result.result, 'DISPATCH_CONFIRMED');
  assert.equal(result.runId, CORRECT_RUN.id);
  assert.equal(fixture.state.cancelCalls, 0);
  assert.equal(fixture.state.dispatchCalls, 1);
});

test('12. a run from a different workflow is ignored and cannot prove dispatch', async () => {
  const fixture = githubFixture({
    polls: [
      [
        {
          ...CORRECT_RUN,
          workflow_id: 99,
          path: '.github/workflows/other.yml',
        },
      ],
    ],
  });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'DISPATCH_RUN_NOT_FOUND',
    EXIT.RUN_NOT_FOUND,
  );
});

test('13. imageSourceSha is preserved byte-for-byte only in full_sha input', async () => {
  const fixture = githubFixture();
  await controlDispatch(options(), dependencies(fixture.github));
  assert.deepEqual(fixture.state.payloads, [
    {
      ref: 'main',
      inputs: { full_sha: IMAGE_SOURCE_SHA, confirm_release: 'true' },
    },
  ]);
  assert.equal(
    JSON.stringify(fixture.state.payloads).includes(WORKFLOW_SHA),
    false,
  );
});

test('14. a 204 without runId enters bounded polling and accepts the later run', async () => {
  const fixture = githubFixture({ polls: [[], [CORRECT_RUN]] });
  let sleeps = 0;
  const result = await controlDispatch(
    options({ pollAttempts: 2, pollIntervalMs: 5 }),
    dependencies(fixture.github, {
      sleep: async (milliseconds) => {
        assert.equal(milliseconds, 5);
        sleeps += 1;
      },
    }),
  );
  assert.equal(result.runId, CORRECT_RUN.id);
  assert.equal(sleeps, 1);
  assert.equal(fixture.state.dispatchCalls, 1);
});

test('15. an ambiguous dispatch response causes no second dispatch call', async () => {
  const fixture = githubFixture({ dispatchResponse: { status: 202 } });
  await rejectsResult(
    controlDispatch(options(), dependencies(fixture.github)),
    'DISPATCH_RESPONSE_AMBIGUOUS',
    EXIT.DISPATCH_FAILED,
  );
  assert.equal(fixture.state.dispatchCalls, 1);
  assert.equal(fixture.state.listCalls, 1);
});

test('16. tokens, authorization headers, and adapter diagnostics never reach structured logs', async () => {
  const classicToken = `ghp_${'A'.repeat(36)}`;
  const fixture = githubFixture({
    dispatchError: new Error(
      `Authorization: Bearer ${classicToken}; X-GitHub-Token: header-secret`,
    ),
  });
  let observed;
  try {
    await controlDispatch(options(), dependencies(fixture.github));
    assert.fail('dispatch unexpectedly succeeded');
  } catch (error) {
    observed = JSON.stringify(safeFailure(error));
  }
  assert.doesNotMatch(observed, /Authorization|Bearer|ghp_|header-secret/u);
  assert.match(observed, /DISPATCH_RESPONSE_AMBIGUOUS/u);
});

test('17. dry-run proves identities and payload without any mutation', async () => {
  const fixture = githubFixture();
  const result = await controlDispatch(
    options({ dryRun: true }),
    dependencies(fixture.github),
  );
  assert.equal(result.result, 'DRY_RUN_READY');
  assert.equal(result.mutationCount, 0);
  assert.equal(result.payload.ref, 'main');
  assert.equal(fixture.state.dispatchCalls, 0);
  assert.equal(fixture.state.cancelCalls, 0);
  assert.equal(fixture.state.listCalls, 0);
  assert.equal(fixture.state.mainCalls, 1);
});
