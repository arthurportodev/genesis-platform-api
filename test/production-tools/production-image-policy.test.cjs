const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const {
  scanImageBindingMatches,
} = require('../../scripts/verify-production-image.cjs');

const dockerfile = readFileSync('Dockerfile', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const publishWorkflow = readFileSync(
  '.github/workflows/publish-image.yml',
  'utf8',
);
const verifyProductionImage = readFileSync(
  'scripts/verify-production-image.cjs',
  'utf8',
);
const verifyVulnerabilityPolicy = readFileSync(
  'scripts/verify-vulnerability-policy.cjs',
  'utf8',
);

function assertOrdered(document, labels) {
  let previous = -1;
  for (const label of labels) {
    const current = document.indexOf(label);
    assert.ok(current > previous, `${label} is missing or out of order`);
    previous = current;
  }
}

test('binds scans by direct image ID or an exact RepoDigest intersection', () => {
  const digest = `genesis-platform-api@sha256:${'a'.repeat(64)}`;
  assert.equal(
    scanImageBindingMatches(
      { Id: `sha256:${'1'.repeat(64)}`, RepoDigests: [] },
      {
        source: {
          target: {
            imageID: `sha256:${'1'.repeat(64)}`,
            repoDigests: [],
          },
        },
      },
    ),
    true,
  );
  assert.equal(
    scanImageBindingMatches(
      { Id: `sha256:${'1'.repeat(64)}`, RepoDigests: [digest] },
      {
        source: {
          target: {
            imageID: `sha256:${'2'.repeat(64)}`,
            repoDigests: [digest],
          },
        },
      },
    ),
    true,
  );
  assert.equal(
    scanImageBindingMatches(
      { Id: `sha256:${'1'.repeat(64)}`, RepoDigests: [digest] },
      {
        source: {
          target: {
            imageID: `sha256:${'2'.repeat(64)}`,
            repoDigests: [`genesis-platform-api@sha256:${'b'.repeat(64)}`],
          },
        },
      },
    ),
    false,
  );
});

test('pins the approved build and Distroless runtime manifests', () => {
  const buildReference =
    'node:24.18.0-trixie-slim@sha256:5301bbf5e8046148348b1dea15436326f43c579031f8d76654a631225bdfe467';
  const runtimeReference =
    'gcr.io/distroless/nodejs24-debian13:nonroot-amd64@sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514';
  assert.match(
    dockerfile,
    new RegExp(`^ARG NODE_BUILD_BASE=${buildReference}$`, 'mu'),
  );
  assert.match(
    dockerfile,
    new RegExp(`^ARG DISTROLESS_BASE=${runtimeReference}$`, 'mu'),
  );
  assert.equal(
    dockerfile.match(/^FROM \$\{NODE_BUILD_BASE\} AS /gmu)?.length,
    2,
  );
  assert.equal(
    dockerfile.match(/^FROM \$\{DISTROLESS_BASE\} AS runtime$/gmu)?.length,
    1,
  );
  for (const stage of [
    'dependencies',
    'build',
    'production-dependencies',
    'runtime',
  ]) {
    assert.match(dockerfile, new RegExp(` AS ${stage}(?:\\r?\\n|$)`, 'u'));
  }
});

test('enforces the image-owned hardening invariants', () => {
  assert.match(dockerfile, /ENV NODE_ENV=production/u);
  assert.match(dockerfile, /^\s*TZ=UTC \\$/mu);
  assert.match(dockerfile, /USER nonroot/u);
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/u);
  assert.match(dockerfile, /CMD \["dist\/main\.js"\]/u);
  assert.match(dockerfile, /"\/nodejs\/bin\/node"/u);
  assert.match(dockerfile, /HEALTHCHECK/u);
  assert.doesNotMatch(dockerfile, /^RUN .*apt/u);
  assert.doesNotMatch(dockerfile, /^RUN .*rm/u);
  assert.doesNotMatch(dockerfile, /COPY --from=.*\/scripts/u);
  assert.doesNotMatch(dockerfile, /npm prune/u);
});

test('uses an allowlisted build context', () => {
  assert.match(dockerignore, /^\*\*/mu);
  for (const required of [
    '!package.json',
    '!package-lock.json',
    '!nest-cli.json',
    '!tsconfig.json',
    '!tsconfig.build.json',
    '!src/**',
  ]) {
    assert.ok(
      dockerignore.split(/\r?\n/u).includes(required),
      `missing build-context allowlist entry: ${required}`,
    );
  }
  assert.doesNotMatch(dockerignore, /!\.env/u);
});

test('pins every third-party workflow action by full commit SHA', () => {
  for (const workflow of [ciWorkflow, publishWorkflow]) {
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map(
      (match) => match[1],
    );
    assert.ok(uses.length > 0);
    for (const action of uses) {
      assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u);
    }
  }
});

test('keeps pull-request CI strictly non-publishing', () => {
  assert.doesNotMatch(ciWorkflow, /docker\s+(?:image\s+)?push/u);
  assert.doesNotMatch(ciWorkflow, /docker\/login-action/u);
  assert.match(ciWorkflow, /--platform linux\/amd64/u);
  assert.match(ciWorkflow, /fetch-depth: 0/u);
  assert.match(ciWorkflow, /fail-build: false/u);
  assert.doesNotMatch(ciWorkflow, /severity-cutoff:/u);
  const scan = ciWorkflow.indexOf('Scan final image with Grype');
  const runtime = ciWorkflow.indexOf('Verify hardened Linux runtime');
  const policy = ciWorkflow.indexOf('Apply vulnerability risk policy');
  assert.ok(scan > -1 && scan < runtime && runtime < policy);
  assert.match(ciWorkflow, /--mode ci-validation/u);
  assert.match(ciWorkflow, /Upload raw scanner evidence\n\s+if: always\(\)/u);
  assert.match(
    ciWorkflow,
    /Preserve immutable image metadata\n\s+if: always\(\)/u,
  );
  assert.match(
    ciWorkflow,
    /Upload policy and runtime evidence\n\s+if: always\(\)/u,
  );
});

test('binds both workflows exclusively to the approved active V2 decision', () => {
  for (const workflow of [ciWorkflow, publishWorkflow]) {
    assert.match(
      workflow,
      /RISK_ACCEPTANCE_PATH: security\/risk-acceptances\/0\.8\.2-f014-v2\.json/u,
    );
    assert.doesNotMatch(
      workflow,
      /RISK_ACCEPTANCE_PATH: security\/risk-acceptances\/0\.8\.2-f012\.json/u,
    );
  }
});

test('publishes exactly the scanned image under an immutable SHA tag', () => {
  assert.match(publishWorkflow, /^\s*workflow_dispatch:/mu);
  assert.match(publishWorkflow, /environment: production-image-publication/u);
  assert.match(publishWorkflow, /:sha-\$SOURCE_SHA/u);
  assert.doesNotMatch(publishWorkflow, /:latest/u);
  assert.equal(publishWorkflow.match(/docker buildx build/gu)?.length, 1);
  const scan = publishWorkflow.indexOf('Scan final image with Grype');
  const policy = publishWorkflow.indexOf(
    'Apply vulnerability publication policy',
  );
  const login = publishWorkflow.indexOf('Authenticate to GHCR');
  const push = publishWorkflow.indexOf('docker push');
  assert.ok(scan > -1 && scan < policy && policy < login && login < push);
  assert.match(publishWorkflow, /--mode publication/u);
  assert.match(publishWorkflow, /fail-build: false/u);
  assert.doesNotMatch(publishWorkflow, /severity-cutoff:/u);
  assert.match(
    publishWorkflow,
    /Upload raw scanner evidence\n\s+if: always\(\)/u,
  );
  assert.match(
    publishWorkflow,
    /Preserve immutable image metadata\n\s+if: always\(\)/u,
  );
});

test('resolves the real source SHA for pull requests, push, and dispatch', () => {
  assert.match(
    ciWorkflow,
    /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
  );
  assert.match(ciWorkflow, /EVENT_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(
    ciWorkflow,
    /if \[\[ "\$GITHUB_EVENT_NAME" == "pull_request" \]\]; then\s+SOURCE_SHA="\$PR_HEAD_SHA"\s+else\s+SOURCE_SHA="\$EVENT_SHA"/u,
  );
  assert.match(ciWorkflow, /echo "SOURCE_SHA=\$SOURCE_SHA" >> "\$GITHUB_ENV"/u);
});

test('fails closed for invalid, absent, or tree-mismatched source commits', () => {
  assert.match(ciWorkflow, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(ciWorkflow, /git cat-file -e "\$SOURCE_SHA\^\{commit\}"/u);
  assert.match(
    ciWorkflow,
    /CHECKOUT_TREE="\$\(git rev-parse HEAD\^\{tree\}\)"/u,
  );
  assert.match(
    ciWorkflow,
    /SOURCE_TREE="\$\(git rev-parse "\$SOURCE_SHA\^\{tree\}"\)"/u,
  );
  assert.match(
    ciWorkflow,
    /if \[\[ "\$CHECKOUT_TREE" != "\$SOURCE_TREE" \]\]; then[\s\S]*?exit 1/u,
  );
});

test('permits a merge checkout only when its tree equals the source tree', () => {
  assert.match(
    ciWorkflow,
    /if \[\[ "\$CHECKOUT_TREE" != "\$SOURCE_TREE" \]\]; then/u,
  );
  assert.match(
    ciWorkflow,
    /echo "SOURCE_TREE=\$SOURCE_TREE" >> "\$GITHUB_ENV"/u,
  );
  assert.doesNotMatch(ciWorkflow, /git checkout "?\$SOURCE_SHA/u);
});

test('binds OCI metadata and CI artifact names to SOURCE_SHA', () => {
  assert.match(ciWorkflow, /git show -s --format=%cI "\$SOURCE_SHA"/u);
  assert.match(ciWorkflow, /--build-arg OCI_REVISION="\$SOURCE_SHA"/u);
  assert.doesNotMatch(ciWorkflow, /OCI_REVISION="\$GITHUB_SHA"/u);
  assert.match(
    ciWorkflow,
    /name: production-image-raw-scan-\$\{\{ env\.SOURCE_SHA \}\}/u,
  );
  assert.match(
    ciWorkflow,
    /name: production-image-policy-\$\{\{ env\.SOURCE_SHA \}\}/u,
  );
  assert.doesNotMatch(
    ciWorkflow,
    /name: production-image-(?:raw-scan|policy)-\$\{\{ github\.sha \}\}/u,
  );
});

test('binds publication source, metadata, immutable tag, and artifacts to the approved input SHA', () => {
  assert.match(publishWorkflow, /SOURCE_SHA: \$\{\{ inputs\.commit_sha \}\}/u);
  assert.match(publishWorkflow, /ref: \$\{\{ env\.SOURCE_SHA \}\}/u);
  assert.match(publishWorkflow, /git cat-file -e "\$SOURCE_SHA\^\{commit\}"/u);
  assert.match(
    publishWorkflow,
    /git merge-base --is-ancestor "\$SOURCE_SHA" origin\/main/u,
  );
  assert.match(publishWorkflow, /git show -s --format=%cI "\$SOURCE_SHA"/u);
  assert.match(publishWorkflow, /--build-arg OCI_REVISION="\$SOURCE_SHA"/u);
  assert.match(publishWorkflow, /:sha-\$SOURCE_SHA/u);
  assert.match(
    publishWorkflow,
    /name: production-image-publication-raw-\$\{\{ env\.SOURCE_SHA \}\}/u,
  );
  assert.match(
    publishWorkflow,
    /name: production-image-publication-policy-\$\{\{ env\.SOURCE_SHA \}\}/u,
  );
});

test('hashes and uploads the runtime filesystem manifest on every workflow outcome', () => {
  for (const workflow of [ciWorkflow, publishWorkflow]) {
    assert.match(
      workflow,
      /RUNTIME_FILESYSTEM_EVIDENCE_PATH: \.codex\/task-packets\/0\.8\.2-runtime-filesystem\.json/u,
    );
    assert.match(
      workflow,
      /for artifact in [^\n]*"\$RUNTIME_FILESYSTEM_EVIDENCE_PATH"/u,
    );
    assert.match(
      workflow,
      /Upload policy and runtime evidence\n\s+if: always\(\)[\s\S]*?\.codex\/task-packets\/0\.8\.2-runtime-filesystem\.json/u,
    );
    assert.match(
      workflow,
      /Verify environmental evidence contract\n\s+if: always\(\)/u,
    );
  }
});

test('creates the filesystem manifest before evaluating runtime invariants', () => {
  const manifestWrite = verifyProductionImage.indexOf(
    'writeFileSync(\n      resolvedRuntimeFilesystemPath',
  );
  const runtimeInvariant = verifyProductionImage.indexOf(
    "'cve-2026-5435-unreachable-runtime'",
    manifestWrite,
  );
  assert.ok(manifestWrite > -1 && manifestWrite < runtimeInvariant);
});

test('activates the approved subject while preserving failed evidence and a nonzero exit code', () => {
  assert.match(
    verifyProductionImage,
    /security\/risk-acceptances\/0\.8\.2-f014-v2\.json/u,
  );
  assert.match(
    verifyProductionImage,
    /failureReasons\.push\('runtime-security-subject-v2-approved-mismatch'\)/u,
  );
  assert.doesNotMatch(
    verifyProductionImage,
    /failureReasons\.push\('runtime-subject-migration-pending-human-approval'\)/u,
  );
  assert.match(
    verifyProductionImage,
    /if \(evidence\.result !== 'passed'\) process\.exitCode = 1/u,
  );
  assert.match(
    verifyVulnerabilityPolicy,
    /if \(evidence\.result !== 'passed'\) process\.exitCode = 1/u,
  );
  assert.doesNotMatch(
    verifyVulnerabilityPolicy,
    /MIGRATION_PENDING_REASON[\s\S]{0,300}result:\s*'passed'/u,
  );
});

test('keeps publication operations after all verification and policy steps', () => {
  assertOrdered(publishWorkflow, [
    'Build approved Linux image once',
    'Generate SPDX JSON SBOM from final image',
    'Scan final image with Grype before publication',
    'Preserve immutable image metadata',
    'Verify hardened runtime before publication',
    'Verify environmental evidence contract',
    'Apply vulnerability publication policy',
    'Authenticate to GHCR only after successful verification',
    'Publish the exact scanned local image',
    'Attest build provenance for the published digest',
    'Attest SBOM for the same published digest',
  ]);
});
