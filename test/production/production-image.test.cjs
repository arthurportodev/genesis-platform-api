const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const test = require('node:test');

function logicalDockerfileLines(source) {
  const lines = [];
  let current = '';

  for (const rawLine of source.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    current = current ? `${current} ${trimmed}` : trimmed;
    if (current.endsWith('\\')) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }

    lines.push(current);
    current = '';
  }

  if (current) lines.push(current);
  return lines;
}

function parseDockerfile(source) {
  const stages = [];
  let currentStage = null;

  for (const line of logicalDockerfileLines(source)) {
    const [keywordToken, ...rest] = line.split(/\s+/u);
    const keyword = keywordToken.toUpperCase();
    const value = rest.join(' ');

    if (keyword === 'FROM') {
      const match = value.match(/^([^\s]+)(?:\s+AS\s+([a-z0-9._-]+))?$/iu);
      assert.ok(match, `invalid FROM instruction: ${line}`);
      currentStage = {
        base: match[1],
        name: match[2]?.toLowerCase() ?? null,
        instructions: [],
      };
      stages.push(currentStage);
      continue;
    }

    assert.ok(currentStage, `instruction before first stage: ${line}`);
    currentStage.instructions.push({ keyword, value });
  }

  return stages;
}

function validateProductionDockerfile(source) {
  const failures = [];
  const stages = parseDockerfile(source);
  const byName = new Map(stages.map((stage) => [stage.name, stage]));
  const dependencies = byName.get('dependencies');
  const build = byName.get('build');
  const production = byName.get('production');

  if (stages.length !== 3) failures.push('exactly three stages are required');
  if (dependencies?.base !== 'node:24-alpine3.24') {
    failures.push('dependencies must use node:24-alpine3.24');
  }
  if (build?.base !== 'dependencies') {
    failures.push('build must inherit the dependencies stage');
  }
  if (production?.base !== 'alpine:3.24') {
    failures.push('production must use alpine:3.24');
  }
  if (!production) return failures;

  const values = (keyword) =>
    production.instructions
      .filter((instruction) => instruction.keyword === keyword)
      .map((instruction) => instruction.value);
  const copies = values('COPY');

  const requiredCopies = [
    '--from=dependencies /usr/local/bin/node /usr/local/bin/node',
    '--from=build --chown=10001:10001 /app/node_modules ./node_modules',
    '--from=build --chown=10001:10001 /app/dist ./dist',
    '--from=build --chown=10001:10001 /app/package.json ./package.json',
  ];
  if (
    copies.length !== requiredCopies.length ||
    requiredCopies.some((copy) => !copies.includes(copy))
  ) {
    failures.push('production COPY set must contain only runtime artifacts');
  }

  const runInstructions = values('RUN');
  if (
    runInstructions.length !== 1 ||
    !/^apk add --no-cache libstdc\+\+ && addgroup -S -g 10001 genesis && adduser -S -D -H -u 10001 -G genesis genesis$/u.test(
      runInstructions[0],
    )
  ) {
    failures.push(
      'production must install only libstdc++ and create UID 10001',
    );
  }
  if (values('ENV').join('\n') !== 'NODE_ENV=production') {
    failures.push('production NODE_ENV must be production');
  }
  if (values('USER').join('\n') !== '10001:10001') {
    failures.push('production user must be 10001:10001');
  }
  if (values('CMD').join('\n') !== '["node", "dist/main.js"]') {
    failures.push('production CMD must invoke Node directly');
  }
  if (values('ENTRYPOINT').length !== 0) {
    failures.push('production must not override the direct Node command');
  }

  const forbiddenRuntimeTokens =
    /(?:^|[\s/])(npm|npx|yarn|corepack)(?:[\s/]|$)/iu;
  if (
    production.instructions.some((instruction) =>
      forbiddenRuntimeTokens.test(instruction.value),
    )
  ) {
    failures.push('package managers must not enter the production stage');
  }

  return failures;
}

const dockerfile = readFileSync('Dockerfile', 'utf8');

test('keeps the production image minimal, package-manager-free and non-root', () => {
  assert.deepEqual(validateProductionDockerfile(dockerfile), []);
});

test('rejects weakened production runtime structures', () => {
  const mutations = [
    dockerfile.replace(
      'FROM alpine:3.24 AS production',
      'FROM node:24-alpine3.24 AS production',
    ),
    dockerfile.replace(
      '/usr/local/bin/node /usr/local/bin/node',
      '/usr/local /usr/local',
    ),
    dockerfile.replace(
      'RUN apk add --no-cache libstdc++',
      'RUN apk add --no-cache libstdc++ npm',
    ),
    dockerfile.replace(
      'COPY --from=build --chown=10001:10001 /app/dist ./dist',
      'COPY --from=build --chown=10001:10001 /app/src ./src',
    ),
    dockerfile.replace('USER 10001:10001', 'USER root'),
    dockerfile.replace(
      'CMD ["node", "dist/main.js"]',
      'CMD ["npm", "run", "start:prod"]',
    ),
  ];

  for (const mutation of mutations) {
    assert.notDeepEqual(validateProductionDockerfile(mutation), []);
  }
});

const image = process.env.PRODUCTION_IMAGE_UNDER_TEST;

test(
  'validates the built image configuration and filesystem when requested',
  { skip: !image },
  () => {
    const inspection = JSON.parse(
      execFileSync('docker', ['image', 'inspect', image], {
        encoding: 'utf8',
      }),
    )[0];

    assert.equal(inspection.Os, 'linux');
    assert.equal(inspection.Architecture, 'amd64');
    assert.equal(inspection.Config.User, '10001:10001');
    assert.deepEqual(inspection.Config.Cmd, ['node', 'dist/main.js']);
    assert.equal(inspection.Config.Entrypoint ?? null, null);
    assert.ok(inspection.Config.Env.includes('NODE_ENV=production'));

    const auditScript = String.raw`
      const fs = require('node:fs');
      const path = require('node:path');
      const forbidden = [
        '/usr/local/bin/npm',
        '/usr/local/bin/npx',
        '/usr/local/bin/yarn',
        '/usr/local/bin/corepack',
        '/usr/local/lib/node_modules'
      ];
      const failures = forbidden.filter((entry) => fs.existsSync(entry));
      const allowedAppEntries = new Set(['dist', 'node_modules', 'package.json']);
      for (const entry of fs.readdirSync('/app')) {
        if (!allowedAppEntries.has(entry)) failures.push('/app/' + entry);
      }
      const queue = ['/app/node_modules'];
      while (queue.length) {
        const current = queue.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const child = path.join(current, entry.name);
          if (entry.name === 'tar') failures.push(child);
          if (entry.name !== '.bin') queue.push(child);
        }
      }
      if (!fs.existsSync('/app/node_modules/typeorm/cli.js')) {
        failures.push('typeorm migration CLI');
      }
      process.stdout.write(JSON.stringify({ failures, node: process.version }));
    `;
    const runtimeAudit = JSON.parse(
      execFileSync(
        'docker',
        ['run', '--rm', '--entrypoint', 'node', image, '-e', auditScript],
        { encoding: 'utf8' },
      ),
    );

    assert.match(runtimeAudit.node, /^v24\./u);
    assert.deepEqual(runtimeAudit.failures, []);
    assert.doesNotThrow(() =>
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          'node',
          image,
          'node_modules/typeorm/cli.js',
          '--version',
        ],
        { encoding: 'utf8' },
      ),
    );
  },
);

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

test('keeps versioned production configuration free of secret fields', () => {
  const example = readFileSync('.env.production.example', 'utf8');
  for (const variable of [
    'POSTGRES_PASSWORD',
    'DATABASE_MIGRATION_PASSWORD',
    'DATABASE_RUNTIME_PASSWORD',
    'DATABASE_PASSWORD',
    'JWT_ACCESS_SECRET',
    'REFRESH_TOKEN_PEPPER',
    'LEAD_IDEMPOTENCY_KEYS',
  ]) {
    assert.doesNotMatch(example, new RegExp(`^${variable}=`, 'mu'));
  }
  assert.doesNotMatch(example, /^GENESIS_API_IMAGE=/mu);
  assert.match(example, /^DATABASE_BOOTSTRAP_USER=genesis_bootstrap$/mu);
});

module.exports = { parseDockerfile, validateProductionDockerfile };
