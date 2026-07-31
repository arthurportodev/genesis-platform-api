const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const dockerfile = readFileSync('Dockerfile', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const publishWorkflow = readFileSync(
  '.github/workflows/publish-image.yml',
  'utf8',
);

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
  assert.match(ciWorkflow, /severity-cutoff: high/u);
});

test('publishes exactly the scanned image under an immutable SHA tag', () => {
  assert.match(publishWorkflow, /^\s*workflow_dispatch:/mu);
  assert.match(publishWorkflow, /environment: production-image-publication/u);
  assert.match(publishWorkflow, /:sha-\$COMMIT_SHA/u);
  assert.doesNotMatch(publishWorkflow, /:latest/u);
  assert.equal(publishWorkflow.match(/docker buildx build/gu)?.length, 1);
  const scan = publishWorkflow.indexOf('Scan final image with Grype');
  const login = publishWorkflow.indexOf('Authenticate to GHCR');
  const push = publishWorkflow.indexOf('docker push');
  assert.ok(scan > -1 && scan < login && login < push);
});
