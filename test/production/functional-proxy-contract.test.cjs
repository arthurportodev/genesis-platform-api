const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const {
  API_RELEASE_BINDINGS,
  BASE_COMPOSE,
  FUNCTIONAL_COMPOSE,
  loadProductionCompose,
  validateComposeFileSelection,
} = require('../../scripts/validate-production-compose.cjs');

function loadFunctionalContract() {
  return loadProductionCompose({
    cwd: process.cwd(),
    composePaths: [resolve(BASE_COMPOSE), resolve(FUNCTIONAL_COMPOSE)],
    envFile: resolve('.env.production.example'),
    environment: { API_IMAGE: API_RELEASE_BINDINGS.current.image },
  });
}

test('keeps functional exposure an explicit additive override', () => {
  assert.deepEqual(
    validateComposeFileSelection([
      resolve(BASE_COMPOSE),
      resolve(FUNCTIONAL_COMPOSE),
    ]),
    [],
  );
  assert.notDeepEqual(
    validateComposeFileSelection([
      resolve(BASE_COMPOSE),
      resolve(FUNCTIONAL_COMPOSE),
      resolve(FUNCTIONAL_COMPOSE),
    ]),
    [],
  );

  const loaded = loadFunctionalContract();
  assert.equal(loaded.status, 'passed', loaded.failures.join('\n'));
  assert.equal(
    loaded.config.services.api.environment.WEB_PROXY_ATTESTATION_ENABLED,
    'true',
  );
  assert.equal(
    loaded.config.services.api.environment.FRONTEND_URL,
    'https://app.agenciagenesismkt.com.br',
  );
  assert.equal(
    loaded.config.services.traefik.environment.ORIGIN_PROXY_KEY_FILE,
    '/run/secrets/origin_proxy_key',
  );
  assert.deepEqual(loaded.config.services.traefik.group_add, ['70']);
  assert.deepEqual(loaded.config.services.traefik.secrets, [
    {
      source: 'origin_proxy_key',
      target: '/run/secrets/origin_proxy_key',
    },
  ]);
  assert.equal(
    loaded.config.secrets.origin_proxy_key.file,
    '/opt/genesis/secrets/origin-proxy-key',
  );
});

test('renders the origin key only into root-owned runtime configuration', () => {
  const renderer = readFileSync(
    'docker/traefik/render-static-config.sh',
    'utf8',
  );
  assert.match(renderer, /runtime_dynamic_root=\/run\/traefik\/dynamic/u);
  assert.match(
    renderer,
    /cp "\$source_dynamic_root\/api-health-only\.yml" "\$runtime_dynamic_root\/api-health-only\.yml"/u,
  );
  assert.match(renderer, /origin_key=\$\(cat "\$origin_key_file"\)/u);
  assert.match(renderer, /unset origin_key/u);
  assert.doesNotMatch(renderer, /set -x/u);
  assert.doesNotMatch(renderer, /--configFile=.*origin_key/u);

  const template = readFileSync(
    'docker/traefik/dynamic/api-functional.template.yml',
    'utf8',
  );
  assert.equal(template.match(/__ORIGIN_PROXY_KEY__/gu)?.length, 1);
  assert.match(
    template,
    /Host\(`api\.agenciagenesismkt\.com\.br`\) && \(Path\(`\/api\/v1`\) \|\| PathPrefix\(`\/api\/v1\/`\)\) && Header\(`X-Genesis-Origin-Key`, `__ORIGIN_PROXY_KEY__`\)/u,
  );
  assert.match(template, /X-Genesis-Origin-Key: ''/u);
  assert.match(template, /X-Genesis-Proxy-Attested: v1/u);
});

test('makes every static provider watch only the runtime dynamic directory', () => {
  for (const path of [
    'docker/traefik/traefik-internal.yml',
    'docker/traefik/traefik-acme-staging.yml',
    'docker/traefik/traefik-acme-production.yml',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /directory: \/run\/traefik\/dynamic/u, path);
    assert.doesNotMatch(source, /directory: \/etc\/traefik\/dynamic/u, path);
  }
});
