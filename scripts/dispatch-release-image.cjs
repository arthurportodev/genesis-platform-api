const { spawnSync } = require('node:child_process');

const DISPATCH_REF = 'main';
const DEFAULT_REPOSITORY = 'arthurportodev/genesis-platform-api';
const RELEASE_WORKFLOW = '.github/workflows/release-image.yml';
const IMAGE_SOURCE_INPUT = 'full_sha';
const FULL_SHA = /^[a-f0-9]{40}$/u;

const EXIT = Object.freeze({
  OK: 0,
  INVALID_ARGUMENT: 10,
  MAIN_MOVED_BEFORE_DISPATCH: 20,
  DISPATCH_HTTP_422: 21,
  DISPATCH_FAILED: 22,
  RUN_NOT_FOUND: 23,
  RUN_AMBIGUOUS: 24,
  WORKFLOW_SHA_MISMATCH: 25,
  WORKFLOW_BRANCH_MISMATCH: 26,
  GITHUB_READ_FAILED: 27,
});

class DispatchControlError extends Error {
  constructor(result, exitCode, details = {}) {
    super(result);
    this.name = 'DispatchControlError';
    this.result = result;
    this.exitCode = exitCode;
    this.details = details;
  }
}

class DispatchApiError extends Error {
  constructor(status = null) {
    super('GitHub rejected or did not conclusively acknowledge the dispatch.');
    this.name = 'DispatchApiError';
    this.status = status;
  }
}

function validateSha(value, label) {
  if (
    typeof value !== 'string' ||
    !FULL_SHA.test(value) ||
    /^0{40}$/u.test(value)
  ) {
    throw new DispatchControlError('INVALID_ARGUMENT', EXIT.INVALID_ARGUMENT, {
      field: label,
    });
  }
  return value;
}

function validateRepository(value) {
  if (value !== DEFAULT_REPOSITORY) {
    throw new DispatchControlError('INVALID_ARGUMENT', EXIT.INVALID_ARGUMENT, {
      field: 'repository',
    });
  }
  return value;
}

function createDispatchPayload(imageSourceSha) {
  return {
    ref: DISPATCH_REF,
    inputs: {
      [IMAGE_SOURCE_INPUT]: validateSha(imageSourceSha, 'imageSourceSha'),
      confirm_release: 'true',
    },
  };
}

function parseCliArguments(argv) {
  const values = {
    repository: DEFAULT_REPOSITORY,
    dryRun: false,
  };
  const allowed = new Set(['--workflow-ref', '--image-source-sha']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (values.dryRun) {
        throw new DispatchControlError(
          'INVALID_ARGUMENT',
          EXIT.INVALID_ARGUMENT,
          { field: 'dryRun' },
        );
      }
      values.dryRun = true;
      continue;
    }
    if (!allowed.has(argument) || index + 1 >= argv.length) {
      throw new DispatchControlError(
        'INVALID_ARGUMENT',
        EXIT.INVALID_ARGUMENT,
        {
          field: 'arguments',
        },
      );
    }
    const key = {
      '--workflow-ref': 'workflowRef',
      '--image-source-sha': 'imageSourceSha',
    }[argument];
    if (values[key] !== undefined) {
      throw new DispatchControlError(
        'INVALID_ARGUMENT',
        EXIT.INVALID_ARGUMENT,
        {
          field: key,
        },
      );
    }
    values[key] = argv[index + 1];
    index += 1;
  }
  values.workflowRef = validateSha(values.workflowRef, 'workflowRef');
  values.imageSourceSha = validateSha(values.imageSourceSha, 'imageSourceSha');
  values.repository = validateRepository(values.repository);
  return values;
}

function workflowMatches(run, workflow) {
  return (
    run &&
    Number.isSafeInteger(run.id) &&
    run.workflow_id === workflow.id &&
    run.path === workflow.path &&
    run.event === 'workflow_dispatch'
  );
}

function createdAfter(run, startedAt) {
  const created = Date.parse(run?.created_at);
  return Number.isFinite(created) && created >= Date.parse(startedAt);
}

function newWorkflowDispatchRuns({ runs, beforeIds, workflow, startedAt }) {
  if (!Array.isArray(runs)) {
    throw new DispatchControlError(
      'GITHUB_READ_FAILED',
      EXIT.GITHUB_READ_FAILED,
    );
  }
  return runs.filter(
    (run) =>
      workflowMatches(run, workflow) &&
      !beforeIds.has(run.id) &&
      createdAfter(run, startedAt),
  );
}

function newDispatchRuns(context) {
  return newWorkflowDispatchRuns(context).filter(
    (run) => run.head_branch === DISPATCH_REF,
  );
}

async function cancelMismatch(github, run) {
  try {
    await github.cancelWorkflowRun(run.id);
    return true;
  } catch {
    return false;
  }
}

async function controlDispatch(
  {
    repository = DEFAULT_REPOSITORY,
    workflowRef,
    imageSourceSha,
    dryRun = false,
    pollAttempts = 10,
    pollIntervalMs = 2_000,
  },
  {
    github,
    now = () => new Date(),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
) {
  validateRepository(repository);
  validateSha(workflowRef, 'workflowRef');
  const payload = createDispatchPayload(imageSourceSha);
  if (
    !github ||
    !Number.isSafeInteger(pollAttempts) ||
    pollAttempts < 1 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0
  ) {
    throw new DispatchControlError('INVALID_ARGUMENT', EXIT.INVALID_ARGUMENT);
  }

  let workflow;
  try {
    workflow = await github.getWorkflow(RELEASE_WORKFLOW);
  } catch {
    throw new DispatchControlError(
      'GITHUB_READ_FAILED',
      EXIT.GITHUB_READ_FAILED,
    );
  }
  if (
    !workflow ||
    !Number.isSafeInteger(workflow.id) ||
    workflow.path !== RELEASE_WORKFLOW
  ) {
    throw new DispatchControlError(
      'GITHUB_READ_FAILED',
      EXIT.GITHUB_READ_FAILED,
    );
  }

  if (dryRun) {
    let remoteMainSha;
    try {
      remoteMainSha = await github.getRemoteMainSha();
    } catch {
      throw new DispatchControlError(
        'GITHUB_READ_FAILED',
        EXIT.GITHUB_READ_FAILED,
      );
    }
    if (remoteMainSha !== workflowRef) {
      throw new DispatchControlError(
        'MAIN_MOVED_BEFORE_DISPATCH',
        EXIT.MAIN_MOVED_BEFORE_DISPATCH,
        { approvedWorkflowRef: workflowRef, remoteMainSha },
      );
    }
    return {
      result: 'DRY_RUN_READY',
      dispatchRef: DISPATCH_REF,
      approvedWorkflowRef: workflowRef,
      imageSourceSha,
      workflow: RELEASE_WORKFLOW,
      payload,
      mutationCount: 0,
      automaticRetry: false,
    };
  }

  let before;
  try {
    before = await github.listWorkflowRuns(workflow.id);
  } catch {
    throw new DispatchControlError(
      'GITHUB_READ_FAILED',
      EXIT.GITHUB_READ_FAILED,
    );
  }
  if (!Array.isArray(before)) {
    throw new DispatchControlError(
      'GITHUB_READ_FAILED',
      EXIT.GITHUB_READ_FAILED,
    );
  }
  const beforeIds = new Set(
    before.filter((run) => Number.isSafeInteger(run?.id)).map((run) => run.id),
  );
  const started = now();
  if (!(started instanceof Date) || !Number.isFinite(started.getTime())) {
    throw new DispatchControlError('INVALID_ARGUMENT', EXIT.INVALID_ARGUMENT);
  }
  const startedAt = new Date(
    Math.floor(started.getTime() / 1_000) * 1_000,
  ).toISOString();

  let remoteMainSha;
  try {
    remoteMainSha = await github.getRemoteMainSha();
  } catch {
    throw new DispatchControlError(
      'GITHUB_READ_FAILED',
      EXIT.GITHUB_READ_FAILED,
    );
  }
  if (remoteMainSha !== workflowRef) {
    throw new DispatchControlError(
      'MAIN_MOVED_BEFORE_DISPATCH',
      EXIT.MAIN_MOVED_BEFORE_DISPATCH,
      { approvedWorkflowRef: workflowRef, remoteMainSha },
    );
  }

  let response;
  try {
    response = await github.dispatchWorkflow(workflow.id, payload);
  } catch (error) {
    if (error instanceof DispatchApiError && error.status === 422) {
      throw new DispatchControlError(
        'DISPATCH_REJECTED_HTTP_422',
        EXIT.DISPATCH_HTTP_422,
        { automaticRetry: false },
      );
    }
    throw new DispatchControlError(
      'DISPATCH_RESPONSE_AMBIGUOUS',
      EXIT.DISPATCH_FAILED,
      { automaticRetry: false },
    );
  }
  if (!response || response.status !== 204) {
    throw new DispatchControlError(
      'DISPATCH_RESPONSE_AMBIGUOUS',
      EXIT.DISPATCH_FAILED,
      { automaticRetry: false },
    );
  }

  let observedRuns = [];
  let candidates = [];
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    let runs;
    try {
      runs = await github.listWorkflowRuns(workflow.id);
    } catch {
      throw new DispatchControlError(
        'GITHUB_READ_FAILED_AFTER_DISPATCH',
        EXIT.GITHUB_READ_FAILED,
        { automaticRetry: false, requiresEnvironmentDisable: true },
      );
    }
    const context = { runs, beforeIds, workflow, startedAt };
    observedRuns = newWorkflowDispatchRuns(context);
    candidates = newDispatchRuns(context);
    if (candidates.length > 1 || attempt === pollAttempts) break;
    await sleep(pollIntervalMs);
  }

  if (
    candidates.length === 0 &&
    observedRuns.length === 1 &&
    observedRuns[0].head_branch !== DISPATCH_REF
  ) {
    const [run] = observedRuns;
    const cancellationRequested = await cancelMismatch(github, run);
    throw new DispatchControlError(
      'DISPATCHED_WORKFLOW_BRANCH_MISMATCH',
      EXIT.WORKFLOW_BRANCH_MISMATCH,
      {
        runId: run.id,
        observedHeadBranch: run.head_branch,
        cancellationRequested,
        automaticRetry: false,
        requiresEnvironmentDisable: true,
      },
    );
  }
  if (candidates.length === 0) {
    throw new DispatchControlError(
      'DISPATCH_RUN_NOT_FOUND',
      EXIT.RUN_NOT_FOUND,
      { automaticRetry: false, requiresEnvironmentDisable: true },
    );
  }
  if (candidates.length !== 1) {
    throw new DispatchControlError(
      'DISPATCH_RUN_AMBIGUOUS',
      EXIT.RUN_AMBIGUOUS,
      {
        candidateCount: candidates.length,
        automaticRetry: false,
        requiresEnvironmentDisable: true,
      },
    );
  }

  const [run] = candidates;
  if (run.head_sha !== workflowRef) {
    const cancellationRequested = await cancelMismatch(github, run);
    throw new DispatchControlError(
      'DISPATCHED_WORKFLOW_SHA_MISMATCH',
      EXIT.WORKFLOW_SHA_MISMATCH,
      {
        runId: run.id,
        approvedWorkflowRef: workflowRef,
        observedHeadSha: run.head_sha,
        cancellationRequested,
        automaticRetry: false,
        requiresEnvironmentDisable: true,
      },
    );
  }
  if (run.head_branch !== DISPATCH_REF) {
    const cancellationRequested = await cancelMismatch(github, run);
    throw new DispatchControlError(
      'DISPATCHED_WORKFLOW_BRANCH_MISMATCH',
      EXIT.WORKFLOW_BRANCH_MISMATCH,
      {
        runId: run.id,
        observedHeadBranch: run.head_branch,
        cancellationRequested,
        automaticRetry: false,
        requiresEnvironmentDisable: true,
      },
    );
  }

  return {
    result: 'DISPATCH_CONFIRMED',
    runId: run.id,
    runUrl: run.html_url,
    dispatchRef: DISPATCH_REF,
    approvedWorkflowRef: workflowRef,
    imageSourceSha,
    workflow: RELEASE_WORKFLOW,
    startedAt,
    automaticRetry: false,
  };
}

function createGhAdapter({ repository, spawn = spawnSync }) {
  const repo = validateRepository(repository);

  function api(args, { input } = {}) {
    const result = spawn('gh', ['api', ...args], {
      encoding: 'utf8',
      input,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    if (
      result.error ||
      result.signal !== null ||
      result.status !== 0 ||
      typeof result.stdout !== 'string'
    ) {
      const diagnostic = typeof result.stderr === 'string' ? result.stderr : '';
      const status = /(?:HTTP[^0-9]*|status(?: code)?[^0-9]*|\()422\b/iu.test(
        diagnostic,
      )
        ? 422
        : null;
      throw new DispatchApiError(status);
    }
    return result.stdout;
  }

  function readJson(args) {
    const output = api(args);
    try {
      return JSON.parse(output);
    } catch {
      throw new DispatchApiError();
    }
  }

  function responseStatus(output) {
    const statuses = [...output.matchAll(/^HTTP\/\S+\s+([0-9]{3})\b/gmu)];
    if (statuses.length === 0) throw new DispatchApiError();
    return Number(statuses.at(-1)[1]);
  }

  return {
    async getRemoteMainSha() {
      const ref = readJson([`repos/${repo}/git/ref/heads/${DISPATCH_REF}`]);
      return validateSha(ref?.object?.sha, 'remoteMainSha');
    },
    async getWorkflow() {
      const encoded = encodeURIComponent(RELEASE_WORKFLOW);
      const workflow = readJson([`repos/${repo}/actions/workflows/${encoded}`]);
      return { id: workflow.id, path: workflow.path };
    },
    async listWorkflowRuns(workflowId) {
      const response = readJson([
        `repos/${repo}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&per_page=100`,
      ]);
      if (!Array.isArray(response.workflow_runs)) throw new DispatchApiError();
      return response.workflow_runs;
    },
    async dispatchWorkflow(workflowId, payload) {
      const output = api(
        [
          '--include',
          '--method',
          'POST',
          `repos/${repo}/actions/workflows/${workflowId}/dispatches`,
          '--input',
          '-',
        ],
        { input: JSON.stringify(payload) },
      );
      return { status: responseStatus(output) };
    },
    async cancelWorkflowRun(runId) {
      const output = api([
        '--include',
        '--method',
        'POST',
        `repos/${repo}/actions/runs/${runId}/cancel`,
      ]);
      if (responseStatus(output) !== 202) throw new DispatchApiError();
      return { status: 202 };
    },
  };
}

function safeFailure(error) {
  if (error instanceof DispatchControlError) {
    return {
      result: error.result,
      ...error.details,
      exitCode: error.exitCode,
    };
  }
  return { result: 'UNEXPECTED_FAILURE', exitCode: EXIT.DISPATCH_FAILED };
}

async function main() {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const result = await controlDispatch(options, {
      github: createGhAdapter({ repository: options.repository }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = safeFailure(error);
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = failure.exitCode;
  }
}

if (require.main === module) void main();

module.exports = {
  DEFAULT_REPOSITORY,
  DISPATCH_REF,
  DispatchApiError,
  DispatchControlError,
  EXIT,
  IMAGE_SOURCE_INPUT,
  RELEASE_WORKFLOW,
  controlDispatch,
  createDispatchPayload,
  createGhAdapter,
  newDispatchRuns,
  newWorkflowDispatchRuns,
  parseCliArguments,
  safeFailure,
};
