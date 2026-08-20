const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const {
  RELEASE_WORKFLOW_PATH,
  WORKFLOW_PATH,
  isDefinitiveManifestAbsence,
  parseYamlSubset,
  validateAutomaticWorkflowDocument,
  validateManualReleaseDocument,
  validateReleaseRunShellSyntax,
  validateReleaseWorkflowSource,
  validateWorkflowSource,
} = require('../../scripts/validate-ci-workflow.cjs');

const automaticSource = readFileSync(
  join(process.cwd(), ...WORKFLOW_PATH.split('/')),
  'utf8',
);
const releaseSource = readFileSync(
  join(process.cwd(), ...RELEASE_WORKFLOW_PATH.split('/')),
  'utf8',
);

function clone(value) {
  return structuredClone(value);
}

function automaticMutation(mutate) {
  const document = clone(parseYamlSubset(automaticSource));
  mutate(document);
  return validateAutomaticWorkflowDocument(document);
}

function releaseMutation(mutate) {
  const document = clone(parseYamlSubset(releaseSource));
  mutate(document);
  return validateManualReleaseDocument(document);
}

function rejects(failures, pattern) {
  assert.notEqual(failures.length, 0);
  assert.match(failures.join('\n'), pattern);
}

const ABSENT_REF =
  'ghcr.io/arthurportodev/genesis-platform-api:sha-0123456789abcdef0123456789abcdef01234567';
const IMAGE_SOURCE_SHA = '0a56a8aee7c64bda59a1981888418e1ad03950c0';

function classifyAbsence(stderr, overrides = {}) {
  return isDefinitiveManifestAbsence({
    status: 1,
    stdout: '',
    stderr,
    expectedImageRef: ABSENT_REF,
    ...overrides,
  });
}

test('accepts both authoritative release-control workflows', () => {
  const automatic = validateWorkflowSource(automaticSource);
  const release = validateReleaseWorkflowSource(releaseSource);
  assert.deepEqual(Object.keys(automatic.jobs).sort(), [
    'build-and-scan',
    'validate',
  ]);
  assert.deepEqual(Object.keys(release.on), ['workflow_dispatch']);
  assert.equal(
    release.jobs['publish-image'].environment,
    'ghcr-production-release',
  );
});

test('parser preserves the GitHub Actions on key and rejects duplicates', () => {
  const parsed = parseYamlSubset('name: test\non:\n  workflow_dispatch:\n');
  assert.deepEqual(parsed.on, { workflow_dispatch: {} });
  assert.throws(
    () => parseYamlSubset('name: one\nname: two\n'),
    /duplicate YAML key/u,
  );
});

test('positive automatic graph retains tests, local build, and blocking scan', () => {
  const workflow = parseYamlSubset(automaticSource);
  const validateRuns = workflow.jobs.validate.steps.map(
    (step) => step.run ?? '',
  );
  const buildSteps = workflow.jobs['build-and-scan'].steps;
  assert.ok(validateRuns.includes('npm run test -- --runInBand'));
  assert.ok(validateRuns.includes('npm run test:e2e -- --runInBand'));
  assert.ok(validateRuns.includes('npm run test:integration'));
  assert.equal(
    buildSteps.find((step) =>
      String(step.uses ?? '').startsWith('docker/build-push-action@'),
    ).with.push,
    false,
  );
  assert.equal(
    buildSteps.find((step) =>
      String(step.uses ?? '').startsWith('aquasecurity/trivy-action@'),
    ).with['exit-code'],
    '1',
  );
});

test('negative 1 rejects packages write in automatic CI', () => {
  rejects(
    automaticMutation((workflow) => {
      workflow.jobs.validate.permissions.packages = 'write';
    }),
    /permissions|packages/u,
  );
});

test('negative 2 rejects registry login in automatic CI', () => {
  rejects(
    automaticMutation((workflow) => {
      workflow.jobs.validate.steps.push({
        uses: 'docker/login-action@dbcb813823bdd20940b903addbd779551569679f',
      });
    }),
    /registry login/u,
  );
});

test('negative 3 rejects image push commands in automatic CI', () => {
  rejects(
    automaticMutation((workflow) => {
      workflow.jobs['build-and-scan'].steps.push({
        run: 'docker push "$IMAGE_REF"',
      });
    }),
    /publication capability/u,
  );
});

test('negative 4 rejects build action push true in automatic CI', () => {
  rejects(
    automaticMutation((workflow) => {
      const step = workflow.jobs['build-and-scan'].steps.find((candidate) =>
        String(candidate.uses ?? '').startsWith('docker/build-push-action@'),
      );
      step.with.push = true;
    }),
    /registry login|push false/u,
  );
});

test('negative 5 rejects automatic reusable workflow calls', () => {
  rejects(
    automaticMutation((workflow) => {
      workflow.jobs['build-and-scan'].uses =
        './.github/workflows/release-image.yml';
    }),
    /reusable workflow/u,
  );
});

test('negative 6 rejects any non-dispatch release trigger', () => {
  rejects(
    releaseMutation((workflow) => {
      workflow.on.push = { branches: ['main'] };
    }),
    /only by workflow_dispatch/u,
  );
});

test('negative 7 rejects release without full SHA enforcement', () => {
  rejects(
    releaseMutation((workflow) => {
      const authorize = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'authorize',
      );
      authorize.run = authorize.run.replace('^[a-f0-9]{40}$', '^[a-f0-9]+$');
    }),
    /full SHA/u,
  );
});

test('negative 8 rejects overlap between workflow tooling and image source checkout paths', () => {
  rejects(
    releaseMutation((workflow) => {
      const checkouts = workflow.jobs['publish-image'].steps.filter((step) =>
        String(step.uses ?? '').startsWith('actions/checkout@'),
      );
      checkouts[0].with.path = 'image-source';
    }),
    /isolate workflow-revision tooling/u,
  );
});

test('negative 9 rejects publication without main ancestry proof', () => {
  rejects(
    releaseMutation((workflow) => {
      const authorize = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'authorize',
      );
      authorize.run = authorize.run.replace(
        'git merge-base --is-ancestor "$REQUESTED_SHA" refs/remotes/origin/main',
        'git rev-parse refs/remotes/origin/main',
      );
    }),
    /main ancestry/u,
  );
});

test('negative 10 rejects registry login before fail-closed authorization', () => {
  rejects(
    releaseMutation((workflow) => {
      const steps = workflow.jobs['publish-image'].steps;
      const loginIndex = steps.findIndex((step) =>
        String(step.uses ?? '').startsWith('docker/login-action@'),
      );
      const [login] = steps.splice(loginIndex, 1);
      steps.unshift(login);
    }),
    /order|precede registry login/u,
  );
});

test('negative 11 rejects missing dedicated Environment', () => {
  rejects(
    releaseMutation((workflow) => {
      delete workflow.jobs['publish-image'].environment;
    }),
    /Environment/u,
  );
});

test('negative 12 rejects missing remote enablement variable', () => {
  rejects(
    releaseMutation((workflow) => {
      delete workflow.jobs['publish-image'].env.RELEASE_ENABLED;
    }),
    /MANUAL_IMAGE_RELEASE_ENABLED/u,
  );
});

test('negative 13 rejects packages write outside the manual publisher', () => {
  rejects(
    releaseMutation((workflow) => {
      workflow.jobs.helper = {
        permissions: { contents: 'read', packages: 'write' },
        'runs-on': 'ubuntu-24.04',
        steps: [],
      };
    }),
    /packages write|exactly one/u,
  );
});

test('negative 14 rejects publication when scan no longer precedes login', () => {
  rejects(
    releaseMutation((workflow) => {
      const steps = workflow.jobs['publish-image'].steps;
      const scanIndex = steps.findIndex((step) =>
        String(step.uses ?? '').startsWith('aquasecurity/trivy-action@'),
      );
      const [scan] = steps.splice(scanIndex, 1);
      steps.push(scan);
    }),
    /order/u,
  );
});

test('negative 15 rejects missing digest capture or registry reinspection', () => {
  rejects(
    releaseMutation((workflow) => {
      const verify = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'verify',
      );
      verify.run = 'echo "$EXPECTED_DIGEST"';
    }),
    /reinspect and verify/u,
  );
});

test('negative 16 rejects deployment capability in image release', () => {
  rejects(
    releaseMutation((workflow) => {
      workflow.jobs['publish-image'].steps.push({
        run: 'ssh release-host restart-service',
      });
    }),
    /no deployment capability/u,
  );
});

test('negative 17 rejects latest as operational image tag', () => {
  rejects(
    releaseMutation((workflow) => {
      workflow.jobs['publish-image'].env.IMAGE_TAG = 'latest';
    }),
    /immutable full SHA tag|latest/u,
  );
});

test('manual release remains publication-only and ends with verified digest evidence', () => {
  const workflow = parseYamlSubset(releaseSource);
  const steps = workflow.jobs['publish-image'].steps;
  assert.ok(steps.some((step) => step.id === 'verify'));
  assert.ok(
    String(steps.find((step) => step.id === 'evidence').run).includes(
      'IMAGE_PUBLISHED_AND_DIGEST_VERIFIED',
    ),
  );
  assert.deepEqual(validateManualReleaseDocument(workflow), []);
});

test('manual release serializes the same SHA and derives stable image metadata from the commit', () => {
  const workflow = parseYamlSubset(releaseSource);
  const identity = workflow.jobs['publish-image'].steps.find(
    (step) => step.id === 'identity',
  );
  assert.equal(
    workflow.concurrency.group,
    'manual-image-release-${{ inputs.full_sha }}',
  );
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(identity.run, /git show -s --format=%cI "\$REQUESTED_SHA"/u);
  assert.doesNotMatch(identity.run, /new Date/u);
});

test('workflow-revision tooling survives the old image-source checkout in a separate path', () => {
  const workflow = parseYamlSubset(releaseSource);
  const steps = workflow.jobs['publish-image'].steps;
  const checkouts = steps.filter((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@'),
  );
  assert.deepEqual(
    checkouts.map((step) => ({
      ref: step.with.ref,
      path: step.with.path,
      fetchDepth: step.with['fetch-depth'],
      persistCredentials: step.with['persist-credentials'],
    })),
    [
      {
        ref: '${{ github.workflow_sha }}',
        path: 'release-control',
        fetchDepth: 1,
        persistCredentials: false,
      },
      {
        ref: 'main',
        path: 'image-source',
        fetchDepth: 0,
        persistCredentials: false,
      },
    ],
  );

  const oldSourceLookup = spawnSync(
    'git',
    ['cat-file', '-e', `${IMAGE_SOURCE_SHA}:scripts/inspect-release-tag.cjs`],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.notEqual(
    oldSourceLookup.status,
    0,
    'the approved old image source must model the missing tooling that caused F-001',
  );

  const modeledWorkspace = new Set();
  const modelCheckout = (path, files) => {
    for (const entry of [...modeledWorkspace]) {
      if (entry.startsWith(`${path}/`)) modeledWorkspace.delete(entry);
    }
    for (const file of files) modeledWorkspace.add(`${path}/${file}`);
  };
  modelCheckout(checkouts[0].with.path, ['scripts/inspect-release-tag.cjs']);
  modelCheckout(checkouts[1].with.path, ['package.json', 'Dockerfile']);
  assert.ok(
    modeledWorkspace.has('release-control/scripts/inspect-release-tag.cjs'),
  );
  assert.equal(
    modeledWorkspace.has('image-source/scripts/inspect-release-tag.cjs'),
    false,
  );

  const selection = steps.find(
    (step) => step.name === 'Select the exact authorized image source',
  );
  assert.equal(selection['working-directory'], 'image-source');
  assert.equal(
    selection.env.AUTHORIZED_SHA,
    '${{ steps.authorize.outputs.sha }}',
  );
  assert.match(selection.run, /git checkout --detach "\$AUTHORIZED_SHA"/u);

  const build = steps.find((step) =>
    String(step.uses ?? '').startsWith('docker/build-push-action@'),
  );
  const runtime = steps.find(
    (step) =>
      String(step.run ?? '').trim() ===
      'node --test test/production/production-image.test.cjs',
  );
  assert.equal(build.with.context, './image-source');
  assert.equal(runtime['working-directory'], 'image-source');

  for (const stepId of ['existence', 'push']) {
    const run = String(steps.find((step) => step.id === stepId).run);
    assert.match(
      run,
      /node release-control\/scripts\/inspect-release-tag\.cjs/u,
    );
    assert.doesNotMatch(
      run,
      /node (?:\.\/)?image-source\/scripts\/inspect-release-tag\.cjs/u,
    );
  }
});

test('rejects resolving release inspection tooling from the old image source', () => {
  rejects(
    releaseMutation((workflow) => {
      for (const stepId of ['existence', 'push']) {
        const step = workflow.jobs['publish-image'].steps.find(
          (candidate) => candidate.id === stepId,
        );
        step.run = step.run.replace(
          'node release-control/scripts/inspect-release-tag.cjs',
          'node image-source/scripts/inspect-release-tag.cjs',
        );
      }
    }),
    /versioned inspection script|tag classifier/u,
  );
});

test('absent full-SHA path performs one guarded push only after scan, login, and lookup', () => {
  const workflow = parseYamlSubset(releaseSource);
  const steps = workflow.jobs['publish-image'].steps;
  const scanIndex = steps.findIndex((step) => step.id === 'scan');
  const loginIndex = steps.findIndex((step) =>
    String(step.uses ?? '').startsWith('docker/login-action@'),
  );
  const existenceIndex = steps.findIndex((step) => step.id === 'existence');
  const pushIndex = steps.findIndex((step) => step.id === 'push');
  const pushSteps = steps.filter((step) =>
    /\bdocker\s+push\b/u.test(String(step.run ?? '')),
  );
  assert.ok(scanIndex < loginIndex && loginIndex < existenceIndex);
  assert.ok(existenceIndex < pushIndex);
  assert.equal(pushSteps.length, 1);
  assert.equal(
    pushSteps[0].if,
    "${{ steps.existence.outputs.state == 'TAG_AVAILABLE' }}",
  );
  assert.match(pushSteps[0].run, /TAG_AVAILABLE/u);
  const existence = steps[existenceIndex];
  assert.match(
    existence.run,
    /release-control\/scripts\/inspect-release-tag\.cjs availability "\$lookup_status"/u,
  );
  assert.match(
    pushSteps[0].run,
    /release-control\/scripts\/inspect-release-tag\.cjs availability "\$prepush_status"/u,
  );
  assert.match(
    existence.run,
    /> "\$\{\{ runner\.temp \}\}\/existing-descriptor\.json" 2> "\$\{\{ runner\.temp \}\}\/existing-error\.txt"/u,
  );
  assert.match(
    pushSteps[0].run,
    /> "\$\{\{ runner\.temp \}\}\/prepush-output\.txt" 2> "\$\{\{ runner\.temp \}\}\/prepush-error\.txt"/u,
  );
  assert.doesNotMatch(pushSteps[0].run, /\/dev\/null/u);
  assert.doesNotMatch(`${existence.run}\n${pushSteps[0].run}`, /grep\s+-/u);
  assert.equal(
    existence.env.TAG_LOOKUP_DIAGNOSTIC_PATH,
    '${{ runner.temp }}/tag-inspection-diagnostic.json',
  );
  assert.equal(
    pushSteps[0].env.TAG_LOOKUP_DIAGNOSTIC_PATH,
    '${{ runner.temp }}/prepush-tag-inspection-diagnostic.json',
  );
  assert.doesNotMatch(existence.run, /--raw|json \.Image/u);
  assert.equal(
    (existence.run.match(/\bdocker buildx imagetools inspect\b/gu) ?? [])
      .length,
    1,
  );
});

test('failed registry lookups preserve only structured sanitized diagnostics', () => {
  const workflow = parseYamlSubset(releaseSource);
  const steps = workflow.jobs['publish-image'].steps;
  const uploads = steps.filter((step) =>
    String(step.with?.path ?? '').includes('tag-inspection-diagnostic.json'),
  );
  assert.deepEqual(
    uploads.map((step) => ({
      action: step.uses,
      condition: step.if,
      name: step.with.name,
      path: step.with.path,
      missing: step.with['if-no-files-found'],
      retention: step.with['retention-days'],
    })),
    [
      {
        action:
          'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        condition: "${{ failure() && steps.existence.outcome == 'failure' }}",
        name: 'tag-inspection-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}',
        path: '${{ runner.temp }}/tag-inspection-diagnostic.json',
        missing: 'error',
        retention: 14,
      },
      {
        action:
          'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        condition: "${{ failure() && steps.push.outcome == 'failure' }}",
        name: 'prepush-tag-inspection-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}',
        path: '${{ runner.temp }}/prepush-tag-inspection-diagnostic.json',
        missing: 'error',
        retention: 14,
      },
    ],
  );
  assert.equal(workflow.jobs['publish-image'].permissions.packages, 'write');
  assert.deepEqual(Object.keys(workflow.jobs), ['publish-image']);
  assert.doesNotMatch(
    uploads.map((step) => step.with.path).join('\n'),
    /existing-error|prepush-error|docker.*config|authorization|token/iu,
  );
  assert.deepEqual(validateManualReleaseDocument(workflow), []);
});

test('existing full-SHA tag is classified by a versioned script and never reaches push', () => {
  const workflow = parseYamlSubset(releaseSource);
  const steps = workflow.jobs['publish-image'].steps;
  const existence = steps.find((step) => step.id === 'existence');
  assert.doesNotMatch(existence.run, /\bdocker\s+push\b/u);
  assert.match(existence.run, /inspect-release-tag\.cjs availability/u);
  assert.match(existence.run, /TAG_AVAILABLE/u);
  assert.doesNotMatch(existence.run, /<<-?\s*['"]?[A-Za-z_]/u);
  assert.equal(
    steps.find((step) => step.id === 'push').if,
    "${{ steps.existence.outputs.state == 'TAG_AVAILABLE' }}",
  );
});

test('rejects removal of immutable-tag overwrite protection or an unconditional push', () => {
  rejects(
    releaseMutation((workflow) => {
      const push = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'push',
      );
      delete push.if;
      push.run = push.run.replace(
        /set \+e[\s\S]*?current_config_digest=/u,
        'current_config_digest=',
      );
    }),
    /guarded push|order/u,
  );
});

test('rejects an existing tag path that bypasses the versioned classifier', () => {
  rejects(
    releaseMutation((workflow) => {
      const existence = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'existence',
      );
      existence.run = existence.run.replace(
        'node release-control/scripts/inspect-release-tag.cjs availability',
        'node scripts/untrusted-tag-check.cjs availability',
      );
    }),
    /existing full-SHA tag/u,
  );
});

test('rejects ambiguous lookup handling that could continue to registry mutation', () => {
  rejects(
    releaseMutation((workflow) => {
      const existence = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'existence',
      );
      existence.run = existence.run.replace(
        'exit "$inspection_status"',
        'echo "state=TAG_AVAILABLE" >> "$GITHUB_OUTPUT"',
      );
    }),
    /existing full-SHA tag/u,
  );
});

test('strict absence classifier accepts only the exact trailing-LF signature', () => {
  const message = `ERROR: ${ABSENT_REF}: not found\n`;
  assert.equal(classifyAbsence(message), true, message);
});

test('strict absence classifier rejects credential, plugin, auth, transport, timeout, rate-limit, permission, and ambiguous errors', () => {
  const rejected = [
    `error getting credentials - err: exec: "docker-credential-ghcr": executable file not found in PATH, out: ${ABSENT_REF}`,
    `failed to load plugin for ${ABSENT_REF}: plugin not found`,
    `ERROR: unexpected status from HEAD request for ${ABSENT_REF}: 401 Unauthorized`,
    `ERROR: failed to do request for ${ABSENT_REF}: dial tcp: connection refused`,
    `ERROR: request for ${ABSENT_REF} timed out`,
    `ERROR: unexpected status from HEAD request for ${ABSENT_REF}: 429 Too Many Requests`,
    `ERROR: denied: permission denied for ${ABSENT_REF}`,
    `ERROR: manifest unknown: ${ABSENT_REF}`,
    `name unknown: ${ABSENT_REF}`,
    `no such manifest: ${ABSENT_REF}`,
    `${ABSENT_REF}: manifest unknown`,
    `ERROR: ${ABSENT_REF}: not found`,
    `ERROR: ${ABSENT_REF}: not found\r\n`,
    `ERROR: ${ABSENT_REF}: not found\n\n`,
    `ERROR: ${ABSENT_REF}: not found \n`,
    `ERROR: ${ABSENT_REF.toUpperCase()}: not found\n`,
    `ERROR: unexpected status from HEAD request to https://ghcr.io/v2/arthurportodev/genesis-platform-api/manifests/sha-0123456789abcdef0123456789abcdef01234567: 404 Not Found`,
    `${ABSENT_REF}: not found`,
    'manifest unknown',
    `MANIFEST UNKNOWN: ${ABSENT_REF}`,
    'name unknown: ghcr.io/arthurportodev/another-image:sha-0123456789abcdef0123456789abcdef01234567',
    `manifest unknown: ${ABSENT_REF}\nerror getting credentials: helper not found`,
    `prefix manifest unknown: ${ABSENT_REF}`,
  ];
  for (const message of rejected) {
    assert.equal(classifyAbsence(message), false, message);
  }
});

test('strict absence classifier requires failure status one and an exactly empty stdout channel', () => {
  const canonical = `ERROR: ${ABSENT_REF}: not found\n`;
  assert.equal(classifyAbsence(canonical, { status: 0 }), false);
  assert.equal(classifyAbsence(canonical, { status: 2 }), false);
  for (const stdout of [
    'operational output',
    ' ',
    '\t',
    '\n',
    `descriptor for ${ABSENT_REF}`,
  ]) {
    assert.equal(classifyAbsence(canonical, { stdout }), false, stdout);
  }
});

test('strict absence classifier rejects all relevant line separators and combined-channel content', () => {
  const canonical = `ERROR: ${ABSENT_REF}: not found\n`;
  for (const separator of ['\r', '\n', '\u0085', '\u2028', '\u2029']) {
    for (const stderr of [
      `${separator}${canonical}`,
      `${canonical}${separator}`,
      `manifest unknown:${separator}${ABSENT_REF}`,
      `manifest${separator} unknown: ${ABSENT_REF}`,
    ]) {
      assert.equal(classifyAbsence(stderr), false, JSON.stringify(stderr));
    }
    assert.equal(
      classifyAbsence(canonical, { stdout: `output${separator}` }),
      false,
    );
  }
  assert.equal(
    classifyAbsence(canonical, {
      stdout: 'successful descriptor',
      stderr: canonical,
    }),
    false,
  );
});

test('rejects replacing the centralized absence classifier with a generic text match', () => {
  rejects(
    releaseMutation((workflow) => {
      const existence = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'existence',
      );
      existence.run = existence.run.replace(
        /node release-control\/scripts\/inspect-release-tag\.cjs availability[^\n]+/u,
        'grep -Eiq \'manifest unknown|not found\' "${{ runner.temp }}/existing-error.txt"',
      );
    }),
    /existing full-SHA tag|centralized strict absence classifier/u,
  );
});

test('rejects discarded or unclassified stdout in either absence lookup', () => {
  rejects(
    releaseMutation((workflow) => {
      const push = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'push',
      );
      push.run = push.run.replace(
        '> "${{ runner.temp }}/prepush-output.txt"',
        '> /dev/null',
      );
    }),
    /guarded push|centralized strict absence classifier/u,
  );
  rejects(
    releaseMutation((workflow) => {
      const existence = workflow.jobs['publish-image'].steps.find(
        (step) => step.id === 'existence',
      );
      existence.run = existence.run.replace(
        '"${{ runner.temp }}/existing-descriptor.json" 2> "${{ runner.temp }}/existing-error.txt"',
        '"${{ runner.temp }}/existing-descriptor.json" 2> /dev/null',
      );
    }),
    /existing full-SHA tag|centralized strict absence classifier/u,
  );
});

test('validates every release run block with Bash and rejects an unvalidated critical heredoc', () => {
  const workflow = parseYamlSubset(releaseSource);
  const runSteps = workflow.jobs['publish-image'].steps.filter(
    (step) => typeof step.run === 'string',
  );
  assert.ok(runSteps.length > 0);
  assert.deepEqual(validateReleaseRunShellSyntax(workflow), []);

  const existence = workflow.jobs['publish-image'].steps.find(
    (step) => step.id === 'existence',
  );
  existence.run +=
    "\nif true; then\n  node <<'NODE'\n  process.exit(0);\n  NODE\nfi";
  rejects(
    validateReleaseRunShellSyntax(workflow),
    /shell syntax is invalid|here-document/u,
  );
});
