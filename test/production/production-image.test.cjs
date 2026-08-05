const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

test('keeps the production image minimal and non-root', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');

  assert.match(dockerfile, /FROM node:24-alpine AS production/u);
  assert.match(dockerfile, /addgroup -S -g 10001 genesis/u);
  assert.match(dockerfile, /adduser -S -D -H -u 10001/u);
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.match(dockerfile, /CMD \["node", "dist\/main\.js"\]/u);
  assert.doesNotMatch(dockerfile, /\/app\/scripts/u);
  assert.doesNotMatch(dockerfile, /COPY --from=build[^\n]+\/app\/src/u);
  assert.doesNotMatch(dockerfile, /COPY --from=build[^\n]+\/app\/test/u);
});

test('excludes local, secret and development-only content from the context', () => {
  const dockerignore = readFileSync('.dockerignore', 'utf8');
  const required = [
    '.git',
    '.env',
    '.env.*',
    '.agents',
    '.codex',
    '.github',
    'coverage',
    'docs',
    'test',
  ];

  for (const entry of required) {
    assert.ok(
      dockerignore.split(/\r?\n/u).includes(entry),
      `${entry} must be excluded`,
    );
  }
  assert.doesNotMatch(dockerignore, /^!/mu);
});

test('keeps every versioned production secret field empty', () => {
  const example = readFileSync('.env.production.example', 'utf8');
  for (const variable of [
    'DATABASE_MIGRATION_PASSWORD',
    'DATABASE_RUNTIME_PASSWORD',
    'JWT_ACCESS_SECRET',
    'REFRESH_TOKEN_PEPPER',
  ]) {
    assert.match(example, new RegExp(`^${variable}=$`, 'mu'));
  }
  assert.doesNotMatch(
    example,
    /change-password|replace-with-a-long-random-secret/iu,
  );
});
