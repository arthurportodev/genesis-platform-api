const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const {
  SYNTHETIC_ENV_MATRIX,
  SYNTHETIC_PATH_ENV,
  SYNTHETIC_SECRET_FILES,
  WORKFLOW_PATH,
  parseYamlSubset,
  validateWorkflowSource,
} = require('../../scripts/validate-ci-workflow.cjs');

const source = readFileSync(
  join(process.cwd(), ...WORKFLOW_PATH.split('/')),
  'utf8',
);

function mutated(search, replacement) {
  assert.ok(source.includes(search), `fixture does not contain ${search}`);
  return source.replace(search, replacement);
}

function mutatedLast(search, replacement) {
  const index = source.lastIndexOf(search);
  assert.notEqual(index, -1, `fixture does not contain ${search}`);
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function rejects(candidate, pattern) {
  assert.throws(() => validateWorkflowSource(candidate), pattern);
}

test('accepts the authoritative workflow contract', () => {
  const workflow = validateWorkflowSource(source);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [
    'build-and-scan',
    'image-impact',
    'publish-image',
    'validate',
  ]);
});

test('requires canonical memory validation and tests before the CI contract', () => {
  rejects(
    mutated(
      'node scripts/validate-project-memory.cjs --mode local',
      'node scripts/validate-project-memory.cjs --mode render',
    ),
    /memory|missing exact command/u,
  );
  rejects(
    mutated(
      'node --test test/project-memory/project-memory.test.cjs',
      'node --test test/project-memory/missing.test.cjs',
    ),
    /memory|missing exact command/u,
  );
});

test('parser ignores comments and preserves job/step hierarchy', () => {
  const withAdversarialComments = source.replace(
    'name: CI',
    'name: CI\n# pull_request_target packages: write docker push latest PAT',
  );
  const workflow = validateWorkflowSource(withAdversarialComments);
  assert.equal(
    workflow.jobs.validate.steps[0].name,
    'Initialize synthetic production paths',
  );
  assert.equal(workflow.jobs.validate.steps[1].name, 'Checkout repository');
  assert.equal(workflow.jobs['publish-image'].permissions.packages, 'write');
});

test('parser rejects duplicate mapping keys', () => {
  assert.throws(
    () => parseYamlSubset('name: one\nname: two\n'),
    /duplicate YAML key/u,
  );
});

test('rejects forbidden or missing events', () => {
  rejects(
    mutated('  workflow_dispatch:', '  pull_request_target:'),
    /events|pull_request_target/u,
  );
});

test('requires pull request and push to target only main', () => {
  rejects(mutated('      - main', '      - develop'), /target only main/u);
});

test('restricts global and job permissions', () => {
  rejects(
    mutated(
      'permissions:\n  contents: read',
      'permissions:\n  contents: write',
    ),
    /global permissions/u,
  );
  rejects(
    mutated(
      '  build-and-scan:\n    name: Build and scan production image\n    permissions:\n      contents: read\n    runs-on:',
      '  build-and-scan:\n    name: Build and scan production image\n    permissions:\n      contents: read\n      packages: write\n    runs-on:',
    ),
    /build-and-scan permissions/u,
  );
});

test('requires exactly four jobs and their dependencies', () => {
  rejects(
    mutated('    needs: validate', '    needs: publish-image'),
    /must need validate/u,
  );
  rejects(mutated('  publish-image:', '  release-image:'), /exactly validate/u);
});

test('image-impact runs only for main pushes with read-only permissions', () => {
  rejects(
    mutated(
      '  image-impact:\n    name: Detect production image impact\n    permissions:\n      contents: read',
      '  image-impact:\n    name: Detect production image impact\n    permissions:\n      contents: read\n      packages: write',
    ),
    /image-impact permissions/u,
  );
  rejects(
    mutated(
      "    if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}\n    outputs:",
      "    if: ${{ github.event_name == 'workflow_dispatch' }}\n    outputs:",
    ),
    /image-impact must run only/u,
  );
});

test('image-impact uses full history and exact fail-closed endpoints', () => {
  rejects(mutated('fetch-depth: 0', 'fetch-depth: 1'), /complete history/u);
  rejects(
    mutated('persist-credentials: false', 'persist-credentials: true'),
    /no persisted credential/u,
  );
  rejects(
    mutated(
      'IMAGE_IMPACT_BASE_SHA: ${{ github.event.before }}',
      'IMAGE_IMPACT_BASE_SHA: ${{ github.sha }}',
    ),
    /exact push endpoints/u,
  );
  rejects(
    mutated(
      'node scripts/detect-image-impact.cjs --base "$IMAGE_IMPACT_BASE_SHA" --head "$IMAGE_IMPACT_HEAD_SHA"',
      'node scripts/detect-image-impact.cjs --base "$IMAGE_IMPACT_HEAD_SHA" --head "$IMAGE_IMPACT_HEAD_SHA"',
    ),
    /fail-closed detector/u,
  );
  rejects(
    mutated(
      '        id: detect\n        env:',
      '        id: detect\n        continue-on-error: true\n        env:',
    ),
    /fail-closed detector|continue on error/u,
  );
  rejects(
    mutated(
      '      - name: Detect image-affecting paths',
      '      - name: Extra command\n        run: node --version\n\n      - name: Detect image-affecting paths',
    ),
    /fail-closed detector/u,
  );
});

test('image-impact exposes only its canonical boolean and has no registry capability', () => {
  rejects(
    mutated(
      'should_publish: ${{ steps.detect.outputs.should_publish }}',
      "should_publish: 'yes'",
    ),
    /canonical detector boolean/u,
  );
  rejects(
    mutated(
      '      - name: Detect image-affecting paths',
      '      - name: Registry detour\n        run: docker login ghcr.io\n\n      - name: Detect image-affecting paths',
    ),
    /registry credentials|build, login/u,
  );
});

test('requires explicit ubuntu-24.04 runners', () => {
  rejects(
    mutated('runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest'),
    /ubuntu-24\.04/u,
  );
});

test('publish job is impossible outside push to main', () => {
  rejects(
    mutated(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.validate.result == 'success' && needs.image-impact.result == 'success' && needs.image-impact.outputs.should_publish == 'true'",
      "github.event_name == 'workflow_dispatch'",
    ),
    /successful validation and detection/u,
  );
});

test('publisher requires successful detector and canonical true output', () => {
  rejects(
    mutated('      - image-impact\n    if:', '      - validate\n    if:'),
    /must need validate and image-impact/u,
  );
  rejects(
    mutated(
      "needs.image-impact.result == 'success'",
      "needs.image-impact.result != 'cancelled'",
    ),
    /successful validation and detection/u,
  );
  rejects(
    mutated(
      "needs.image-impact.outputs.should_publish == 'true'",
      "needs.image-impact.outputs.should_publish != 'false'",
    ),
    /canonical true image impact/u,
  );
});

test('simulates docs skip, src authorization, and detector failure without publication', () => {
  const publishAuthorized = ({
    eventName = 'push',
    impactResult = 'success',
    ref = 'refs/heads/main',
    shouldPublish,
    validateResult = 'success',
  }) =>
    eventName === 'push' &&
    ref === 'refs/heads/main' &&
    validateResult === 'success' &&
    impactResult === 'success' &&
    shouldPublish === 'true';

  assert.equal(publishAuthorized({ shouldPublish: 'false' }), false);
  assert.equal(publishAuthorized({ shouldPublish: 'true' }), true);
  assert.equal(
    publishAuthorized({ impactResult: 'failure', shouldPublish: 'true' }),
    false,
  );
  assert.equal(
    publishAuthorized({ eventName: 'pull_request', shouldPublish: 'true' }),
    false,
  );
  assert.equal(
    publishAuthorized({
      eventName: 'workflow_dispatch',
      shouldPublish: 'true',
    }),
    false,
  );
});

test('build-and-scan is limited to pull requests and manual runs', () => {
  rejects(
    mutated(
      "github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'",
      "github.event_name == 'push'",
    ),
    /only for pull_request/u,
  );
});

test('validate cannot build, login, push, or receive package write', () => {
  rejects(
    mutated(
      '      - name: Run lint\n        run: npm run lint',
      '      - name: Run lint\n        run: docker build .',
    ),
    /validate must not build/u,
  );
  rejects(
    mutated(
      '    timeout-minutes: 25\n\n    services:',
      "    timeout-minutes: 25\n    if: ${{ github.event_name == 'pull_request' }}\n\n    services:",
    ),
    /validate must run for every/u,
  );
});

test('validate preserves the complete Critical command surface', () => {
  rejects(
    mutated('npm run test:production', 'npm run test'),
    /test:production/u,
  );
  rejects(
    mutated('npm run ci:contract:validate', 'npm run task:contracts'),
    /ci:contract:validate/u,
  );
});

test('Compose validation uses only a synthetic runner temp env file', () => {
  rejects(
    mutated(
      'GENESIS_PRODUCTION_ENV_FILE: ${{ env.PRODUCTION_CI_ENV_FILE }}',
      'GENESIS_PRODUCTION_ENV_FILE: .env.production',
    ),
    /synthetic RUNNER_TEMP/u,
  );
});

test('rejects the unavailable runner context structurally in jobs.*.env', () => {
  const historicalInvalidEnvironment = [
    '      PRODUCTION_CI_ROOT: ${{ runner.temp }}/genesis-production-ci',
    '      PRODUCTION_CI_ENV_FILE: ${{ runner.temp }}/genesis-production-ci/production.env',
    '      PRODUCTION_CI_SECRET_DIR: ${{ runner.temp }}/genesis-production-ci/secrets',
    '      PRODUCTION_CI_OVERRIDE_FILE: ${{ runner.temp }}/genesis-production-ci/secret-files.override.yml',
    '      PRODUCTION_CI_RENDER_FILE: ${{ runner.temp }}/genesis-production-ci/rendered.json',
  ].join('\n');
  rejects(
    mutated(
      '      DATABASE_MIGRATION_PASSWORD: test-only\n',
      `      DATABASE_MIGRATION_PASSWORD: test-only\n${historicalInvalidEnvironment}\n`,
    ),
    /jobs\.validate\.env\.PRODUCTION_CI_ROOT.*unavailable runner context/u,
  );
  rejects(
    mutated(
      'IMAGE_REF: ghcr.io/arthurportodev/genesis-platform-api:sha-${{ github.sha }}',
      'IMAGE_REF: ${{ runner.temp }}/invalid',
    ),
    /jobs\.build-and-scan\.env\.IMAGE_REF.*unavailable runner context/u,
  );
});

test('initializes exactly five fixed paths through GITHUB_ENV before consumers', () => {
  const workflow = validateWorkflowSource(source);
  const initialize = workflow.jobs.validate.steps[0];
  assert.equal(initialize.name, 'Initialize synthetic production paths');
  assert.equal(initialize.shell, 'bash');
  assert.match(initialize.run, /set -euo pipefail/u);
  assert.match(initialize.run, /RUNNER_TEMP/u);
  assert.match(initialize.run, /GITHUB_ENV/u);
  assert.equal(
    (initialize.run.match(/printf 'PRODUCTION_CI_[A-Z_]+=%s\\n'/gu) ?? [])
      .length,
    5,
  );
  for (const [name, path] of Object.entries(SYNTHETIC_PATH_ENV)) {
    const exportLine = `            printf '${name}=%s\\n' "${path}"\n`;
    assert.ok(source.includes(exportLine));
    rejects(
      mutated(exportLine, ''),
      /initialized exactly from RUNNER_TEMP through GITHUB_ENV/u,
    );
  }
  rejects(
    mutated(
      '    steps:\n      - name: Initialize synthetic production paths',
      '    steps:\n      - name: Premature synthetic path consumer\n        run: test -n "$PRODUCTION_CI_ROOT"\n\n      - name: Initialize synthetic production paths',
    ),
    /created, rendered, validated and immediately cleaned in order/u,
  );
  rejects(
    mutated('} >> "$GITHUB_ENV"', '} >> "$GITHUB_OUTPUT"'),
    /initialized exactly from RUNNER_TEMP through GITHUB_ENV/u,
  );
  rejects(
    mutated(
      '"$RUNNER_TEMP/genesis-production-ci"',
      '"$RUNNER_TEMP/${{ github.run_id }}"',
    ),
    /initialized exactly from RUNNER_TEMP through GITHUB_ENV/u,
  );
});

test('requires the complete exact synthetic non-secret production matrix', () => {
  for (const [name, value] of Object.entries(SYNTHETIC_ENV_MATRIX)) {
    rejects(
      mutated(`          ${name}=${value}\n`, ''),
      /complete approved matrix/u,
    );
  }
  rejects(
    mutated(
      '          DATABASE_RUNTIME_ROLE=genesis_runtime',
      '          DATABASE_RUNTIME_ROLE=genesis_migration',
    ),
    /complete approved matrix|valid and distinct/u,
  );
  rejects(
    mutated(
      '          JWT_ACCESS_EXPIRES_IN=15m',
      '          JWT_ACCESS_SECRET=synthetic-ci-not-environment-backed\n          JWT_ACCESS_EXPIRES_IN=15m',
    ),
    /complete approved matrix|must not contain JWT_ACCESS_SECRET/u,
  );
});

test('binds synthetic secret files to RUNNER_TEMP, mode 0600 and exact cleanup', () => {
  rejects(
    mutated(
      '"$RUNNER_TEMP/genesis-production-ci"',
      '"/tmp/genesis-production-ci"',
    ),
    /initialized exactly from RUNNER_TEMP/u,
  );
  rejects(mutated('chmod 0600', 'chmod 0644'), /mode 0600/u);
  for (const filename of Object.values(SYNTHETIC_SECRET_FILES)) {
    rejects(
      mutatedLast(
        `"$PRODUCTION_CI_SECRET_DIR/${filename}"`,
        `"$PRODUCTION_CI_SECRET_DIR/${filename}-missing"`,
      ),
      /cleanup is incomplete|cleanup must be exact/u,
    );
  }
  rejects(
    mutated(
      "          node <<'NODE'",
      '          cat "$PRODUCTION_CI_SECRET_DIR/jwt-access-secret"\n          node <<\'NODE\'',
    ),
    /never be printed/u,
  );
  rejects(
    mutated('        if: ${{ always() }}', '        if: ${{ success() }}'),
    /cleanup must be exact, unconditional/u,
  );
  rejects(
    mutated(
      'rmdir -- "$PRODUCTION_CI_ROOT"',
      'rm -f -- "$PRODUCTION_CI_ROOT"/*',
    ),
    /cleanup must be exact, unconditional/u,
  );
  rejects(
    mutated(
      'rmdir -- "$PRODUCTION_CI_ROOT"',
      'rm -rf -- "$PRODUCTION_CI_ROOT"',
    ),
    /cleanup must be exact, unconditional/u,
  );
  rejects(
    mutated(
      'rmdir -- "$PRODUCTION_CI_ROOT"',
      'rmdir -- "$PRODUCTION_CI_ROOT" || true',
    ),
    /cleanup must be exact, unconditional/u,
  );
  rejects(
    mutated(
      '      - name: Remove synthetic production Compose inputs',
      `      - name: Upload synthetic production inputs
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: synthetic-production-inputs
          path: \${{ env.PRODUCTION_CI_ROOT }}

      - name: Remove synthetic production Compose inputs`,
    ),
    /must not upload synthetic production inputs/u,
  );
});

test('requires immutable synthetic refs, fail-closed frontend and Lead version', () => {
  rejects(
    mutated(
      "const apiImage = 'ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659';",
      "const apiImage = 'ghcr.io/arthurportodev/genesis-platform-api:latest';",
    ),
    /render validation is incomplete or mutable/u,
  );
  rejects(
    mutated(
      "const postgresImage = 'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';",
      "const postgresImage = 'postgres:17-alpine';",
    ),
    /render validation is incomplete or mutable/u,
  );
  rejects(
    mutated(
      "FRONTEND_URL !== 'https://genesis.invalid'",
      "FRONTEND_URL !== 'https://app.example.invalid'",
    ),
    /render validation is incomplete or mutable/u,
  );
  rejects(
    mutated(
      "LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION) !== '1'",
      "LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION) !== '2'",
    ),
    /render validation is incomplete or mutable/u,
  );
});

test('allows at most one production linux/amd64 build per event', () => {
  rejects(
    mutated('target: production', 'target: build'),
    /target must be production/u,
  );
  rejects(
    mutated('platforms: linux/amd64', 'platforms: linux/arm64'),
    /linux\/amd64/u,
  );
});

test('requires load without action push, provenance, SBOM, cache, or build secrets', () => {
  rejects(mutated('load: true', 'load: false'), /load the local image/u);
  rejects(
    mutated('provenance: false', 'provenance: true'),
    /disable provenance/u,
  );
  rejects(mutated('sbom: false', 'sbom: true'), /disable SBOM/u);
  rejects(
    mutated(
      '          sbom: false',
      '          sbom: false\n          cache-to: type=gha',
    ),
    /must not set cache-to/u,
  );
});

test('requires Trivy v0.70.0 with fail-closed Critical policy', () => {
  rejects(mutated('version: v0.70.0', 'version: v0.69.3'), /Trivy version/u);
  rejects(
    mutated('severity: CRITICAL', 'severity: HIGH,CRITICAL'),
    /Trivy severity/u,
  );
  rejects(mutated("exit-code: '1'", "exit-code: '0'"), /Trivy exit-code/u);
  rejects(
    mutated('ignore-unfixed: false', 'ignore-unfixed: true'),
    /Trivy ignore-unfixed/u,
  );
});

test('requires real runtime validation after build and before every scan', () => {
  rejects(
    mutated(
      'run: node --test test/production/production-image.test.cjs',
      'run: node --version',
    ),
    /validate the loaded production runtime/u,
  );
  rejects(
    mutated(
      'PRODUCTION_IMAGE_UNDER_TEST: ${{ steps.existing.outputs.immutable_ref }}',
      'PRODUCTION_IMAGE_UNDER_TEST: ${{ env.IMAGE_REF }}',
    ),
    /both existing and new production runtimes/u,
  );
  rejects(
    mutated(
      'docker pull "${{ steps.existing.outputs.immutable_ref }}"',
      'docker image inspect "${{ steps.existing.outputs.immutable_ref }}"',
    ),
    /both existing and new production runtimes/u,
  );

  const runtimeMarker = '      - name: Validate new production runtime';
  const scanMarker = '      - name: Scan new local image';
  const runtimeStart = source.indexOf(runtimeMarker);
  const scanStart = source.indexOf(scanMarker);
  const pushStart = source.indexOf(
    '      - name: Push scanned image',
    scanStart,
  );
  const reordered = `${source.slice(0, runtimeStart)}${source.slice(scanStart, pushStart)}${source.slice(runtimeStart, scanStart)}${source.slice(pushStart)}`;
  rejects(reordered, /runtime validation and the local Trivy scan/u);
});

test('requires immutable full-SHA tag and all six OCI labels', () => {
  rejects(
    mutated('type=raw,value=sha-${{ github.sha }}', 'type=raw,value=latest'),
    /full-SHA tag/u,
  );
  rejects(
    mutated(
      'org.opencontainers.image.revision=${{ github.sha }}',
      'org.opencontainers.image.revision=main',
    ),
    /image\.revision/u,
  );
});

test('requires build then blocking scan then push', () => {
  const scanMarker = '      - name: Scan new local image';
  const pushMarker = '      - name: Push scanned image';
  const scanStart = source.indexOf(scanMarker);
  const pushStart = source.indexOf(pushMarker);
  const pushEnd = source.indexOf(
    '      - name: Select scanned immutable image',
    pushStart,
  );
  const reordered = `${source.slice(0, scanStart)}${source.slice(pushStart, pushEnd)}${source.slice(scanStart, pushStart)}${source.slice(pushEnd)}`;
  rejects(reordered, /runtime validation and the local Trivy scan/u);
});

test('PR and manual build never authenticate or publish', () => {
  rejects(
    mutated(
      '      - name: Scan local production image',
      '      - name: Publish local image\n        run: docker push "$IMAGE_REF"\n\n      - name: Scan local production image',
    ),
    /must not publish/u,
  );
});

test('existing immutable tag is validated and rescanned by digest without rebuild or overwrite', () => {
  rejects(
    mutated(
      "steps.existence.outputs.exists == 'true'",
      "steps.existence.outputs.exists == 'false'",
    ),
    /existing-tag path|rescanned/u,
  );
  rejects(
    mutated(
      'image-ref: ${{ steps.selected.outputs.immutable_ref }}',
      'image-ref: ${{ env.IMAGE_REF }}',
    ),
    /verified remote immutable digest/u,
  );
  rejects(
    source.replaceAll("--format '{{json .Manifest}}'", "--format '{{.Name}}'"),
    /existing-tag path|descriptor digest/u,
  );
  rejects(
    mutated(
      "      - name: Build one local production image\n        if: ${{ steps.existence.outputs.exists == 'false' }}",
      '      - name: Build one local production image',
    ),
    /may build only/u,
  );
});

test('binds final identity to descriptor digest and raw config digest', () => {
  rejects(
    mutated(
      'imagetools inspect "$IMMUTABLE_REF"',
      'imagetools inspect "$IMAGE_REF"',
    ),
    /descriptor digest/u,
  );
  rejects(
    mutated(
      'EXPECTED_DIGEST: ${{ steps.selected.outputs.digest }}',
      `EXPECTED_DIGEST: sha256:${'a'.repeat(64)}`,
    ),
    /descriptor digest|official API/u,
  );
  rejects(
    mutated(
      'PUSHED_IMMUTABLE_REF: ${{ steps.push.outputs.immutable_ref }}',
      'PUSHED_IMMUTABLE_REF: ${{ steps.existing.outputs.immutable_ref }}',
    ),
    /select only the scanned/u,
  );
  rejects(
    mutated(
      "if (manifestDigest !== process.env.EXPECTED_DIGEST) throw new Error('remote manifest digest does not match the scanned immutable image');",
      "if (false) throw new Error('remote manifest digest does not match the scanned immutable image');",
    ),
    /descriptor digest/u,
  );
  rejects(
    mutated(
      "if (configDigest !== process.env.EXPECTED_CONFIG_DIGEST) throw new Error('remote config does not match the scanned local image');",
      "if (false) throw new Error('remote config does not match the scanned local image');",
    ),
    /raw config digest/u,
  );
  rejects(
    mutated(
      'EXPECTED_LOCAL_CONFIG_DIGEST: ${{ steps.local.outputs.config_digest }}',
      `EXPECTED_LOCAL_CONFIG_DIGEST: sha256:${'c'.repeat(64)}`,
    ),
    /capture exactly one reported digest/u,
  );
  rejects(
    mutated(
      'if [ "$current_config_digest" != "$EXPECTED_LOCAL_CONFIG_DIGEST" ]; then',
      'if false; then',
    ),
    /capture exactly one reported digest/u,
  );
  rejects(
    mutated(
      "sed -nE 's/^.*digest: (sha256:[a-f0-9]{64})( size: [0-9]+)?$/\\1/p'",
      "sed -nE 's/^.*digest: (sha256:[a-f0-9]+).*$/\\1/p'",
    ),
    /capture exactly one reported digest/u,
  );
  rejects(
    mutated(
      'const immutableReference = process.env.IMMUTABLE_REF;',
      `const immutableReference = '${'sha256:'}${'b'.repeat(64)}';`,
    ),
    /descriptor digest/u,
  );
});

test('treats Manifest output as a descriptor and requires raw manifest config', () => {
  rejects(
    mutated(
      "const configDigest = manifest?.config?.digest ?? '';",
      "const configDigest = descriptor?.config?.digest ?? '';",
    ),
    /descriptor digest|raw config digest/u,
  );
  rejects(
    mutated(
      'imagetools inspect "$IMMUTABLE_REF" --raw',
      'imagetools inspect "$IMMUTABLE_REF" --format \'{{json .Manifest}}\'',
    ),
    /raw config digest/u,
  );
  rejects(
    mutated(
      "const configDigest = manifest?.config?.digest ?? '';",
      "const configDigest = '';",
    ),
    /raw config digest/u,
  );
});

test('rejects incorrect remote platform and OCI labels', () => {
  rejects(
    mutated(
      "image?.os !== 'linux' || image?.architecture !== 'amd64'",
      "image?.os !== 'linux' || image?.architecture !== 'arm64'",
    ),
    /existing-tag path|platform/u,
  );
  rejects(
    mutated(
      'if (labels[key] !== value) throw new Error(`existing image label mismatch: ${key}`);',
      'if (false) throw new Error(`existing image label mismatch: ${key}`);',
    ),
    /existing-tag path|labels/u,
  );
});

test('fails closed on package existence, public visibility, linkage, and tags', () => {
  rejects(
    mutated(
      'pkg = await request(`/users/${owner}/packages/container/${encoded}`);',
      'pkg = {};',
    ),
    /official API/u,
  );
  rejects(
    mutated("pkg?.visibility !== 'public'", "pkg?.visibility !== 'private'"),
    /public visibility/u,
  );
  rejects(
    mutated(
      'linkage !== process.env.GITHUB_REPOSITORY',
      'linkage === process.env.GITHUB_REPOSITORY',
    ),
    /repository linkage/u,
  );
  rejects(
    mutated(
      'tags.length !== 1 || tags[0] !== expectedTag',
      'tags.length === 0',
    ),
    /selected tag/u,
  );
  rejects(
    mutated("tag === 'latest' || tag === 'main'", "tag === 'release'"),
    /mutable tags/u,
  );
});

test('requires remote rescan after identity and package verification and before evidence', () => {
  rejects(
    mutated(
      'image-ref: ${{ steps.selected.outputs.immutable_ref }}',
      'image-ref: ${{ env.IMAGE_REF }}',
    ),
    /verified remote immutable digest/u,
  );
  const verifyMarker = '      - name: Verify scanned immutable image identity';
  const scanMarker = '      - name: Rescan verified remote immutable image';
  const evidenceMarker =
    '      - name: Generate verified image identity evidence';
  const verifyStart = source.indexOf(verifyMarker);
  const scanStart = source.indexOf(scanMarker);
  const evidenceStart = source.indexOf(evidenceMarker);
  const movedBeforeIdentity = `${source.slice(0, verifyStart)}${source.slice(scanStart, evidenceStart)}${source.slice(verifyStart, scanStart)}${source.slice(evidenceStart)}`;
  rejects(movedBeforeIdentity, /verification must precede remote rescan/u);

  const artifactStart = source.indexOf(
    '      - name: Upload immutable image identity',
    evidenceStart,
  );
  const artifactMovedBeforeScan = `${source.slice(0, scanStart)}${source.slice(artifactStart)}\n${source.slice(scanStart, artifactStart)}`;
  rejects(artifactMovedBeforeScan, /verification must precede remote rescan/u);
});

test('requires complete identity evidence only after a passing rescan', () => {
  rejects(
    mutated(
      'manifestDigest: process.env.MANIFEST_DIGEST,',
      'digest: process.env.MANIFEST_DIGEST,',
    ),
    /must include manifestDigest/u,
  );
  rejects(
    mutated(
      'configDigest: process.env.CONFIG_DIGEST,',
      'config: process.env.CONFIG_DIGEST,',
    ),
    /must include configDigest/u,
  );
  rejects(
    mutated("result: 'passed'", "result: 'unknown'"),
    /mode 0600|image-identity/u,
  );
  rejects(
    mutated('if-no-files-found: error', 'if-no-files-found: warn'),
    /fail if it is absent/u,
  );
});

test('selects both publish branches only from validated immutable outputs', () => {
  rejects(
    mutated(
      'immutable_ref="$EXISTING_IMMUTABLE_REF"',
      'immutable_ref="$IMAGE_REF"',
    ),
    /select only the scanned/u,
  );
  rejects(
    mutated(
      'immutable_ref="$PUSHED_IMMUTABLE_REF"',
      'immutable_ref="$IMAGE_REF"',
    ),
    /select only the scanned/u,
  );
  rejects(
    mutated(
      'echo "digest=$pushed_digest" >> "$GITHUB_OUTPUT"',
      'echo "digest=sha256:unobserved" >> "$GITHUB_OUTPUT"',
    ),
    /capture exactly one reported digest/u,
  );
});

test('ambiguous registry lookup fails closed', () => {
  rejects(
    mutated(
      'manifest unknown|name unknown|no such manifest|ghcr\\.io/arthurportodev/genesis-platform-api.*not found',
      '.*',
    ),
    /distinguish an absent tag/u,
  );
});

test('new tag builds once and pushes only after successful scan', () => {
  rejects(
    mutated(
      "      - name: Build one local production image\n        if: ${{ steps.existence.outputs.exists == 'false' }}",
      "      - name: Build one local production image\n        if: ${{ steps.existence.outputs.exists != 'true' }}",
    ),
    /may build only|existing-tag/u,
  );
});

test('pins every Action to the frozen full SHA', () => {
  rejects(
    mutated(
      'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25',
      'aquasecurity/trivy-action@v0.36.0',
    ),
    /aquasecurity\/trivy-action must use/u,
  );
});

test('uses only GITHUB_TOKEN and never introduces PAT or build secrets', () => {
  rejects(
    mutated('secrets.GITHUB_TOKEN', 'secrets.GHCR_PAT'),
    /new secrets and PATs|GITHUB_TOKEN/u,
  );
});

test('generates verified image identity and retains it for 14 days', () => {
  rejects(mutated('retention-days: 14', 'retention-days: 7'), /14 days/u);
  rejects(
    mutated('path: image-identity.json', 'path: metadata.json'),
    /image-identity/u,
  );
});

test('concurrency cancels only earlier runs of the same PR', () => {
  rejects(
    mutated(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      'cancel-in-progress: true',
    ),
    /only pull request/u,
  );
  rejects(mutated('github.run_id }}', 'github.ref }}'), /unique run ID/u);
});
