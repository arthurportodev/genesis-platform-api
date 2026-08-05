const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const {
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

function rejects(candidate, pattern) {
  assert.throws(() => validateWorkflowSource(candidate), pattern);
}

test('accepts the authoritative workflow contract', () => {
  const workflow = validateWorkflowSource(source);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [
    'build-and-scan',
    'publish-image',
    'validate',
  ]);
});

test('parser ignores comments and preserves job/step hierarchy', () => {
  const withAdversarialComments = source.replace(
    'name: CI',
    'name: CI\n# pull_request_target packages: write docker push latest PAT',
  );
  const workflow = validateWorkflowSource(withAdversarialComments);
  assert.equal(workflow.jobs.validate.steps[0].name, 'Checkout repository');
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

test('requires exactly three jobs and their dependencies', () => {
  rejects(
    mutated('    needs: validate', '    needs: publish-image'),
    /must need validate/u,
  );
  rejects(mutated('  publish-image:', '  release-image:'), /exactly validate/u);
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
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
      "github.event_name == 'workflow_dispatch'",
    ),
    /only for push/u,
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
      'GENESIS_PRODUCTION_ENV_FILE: ${{ runner.temp }}/genesis-production-ci.env',
      'GENESIS_PRODUCTION_ENV_FILE: .env.production',
    ),
    /synthetic runner\.temp/u,
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
  rejects(reordered, /runtime validation must precede/u);
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
  rejects(reordered, /scan paths must precede docker push/u);
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
      'image-ref: ${{ steps.existing.outputs.immutable_ref }}',
      'image-ref: ${{ env.IMAGE_REF }}',
    ),
    /immutable digest/u,
  );
  rejects(
    source.replaceAll("--format '{{json .Manifest}}'", "--format '{{.Name}}'"),
    /existing-tag path|generate image-identity/u,
  );
});

test('binds final identity to the exact existing or pushed digest that was scanned', () => {
  rejects(
    mutated(
      'imagetools inspect "$IMMUTABLE_REF"',
      'imagetools inspect "$IMAGE_REF"',
    ),
    /scanned immutable digest/u,
  );
  rejects(
    mutated(
      'EXPECTED_DIGEST: ${{ steps.selected.outputs.digest }}',
      `EXPECTED_DIGEST: sha256:${'a'.repeat(64)}`,
    ),
    /scanned immutable digest/u,
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
      "if (digest !== process.env.EXPECTED_DIGEST) throw new Error('remote digest does not match the scanned immutable image');",
      "if (false) throw new Error('remote digest does not match the scanned immutable image');",
    ),
    /scanned immutable digest/u,
  );
  rejects(
    mutated(
      "if (manifest?.config?.digest !== process.env.EXPECTED_CONFIG_DIGEST) throw new Error('remote config does not match the scanned local image');",
      "if (false) throw new Error('remote config does not match the scanned local image');",
    ),
    /scanned immutable digest/u,
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
    /scanned immutable digest/u,
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
