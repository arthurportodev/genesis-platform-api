const SURFACE_ORDER = ['memory', 'app', 'production', 'tooling'];

function hasPrefix(path, prefixes) {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function hasName(path, names) {
  return names.includes(path);
}

function rule(name, matches, surfaces, modifiers = {}) {
  return { name, matches, surfaces, modifiers };
}

const commonMemoryRules = [
  rule(
    'canonical-memory',
    (path) =>
      hasPrefix(path, ['docs/memory', 'test/project-memory']) ||
      hasName(path, [
        'docs/CURRENT_STATE.md',
        'scripts/validate-project-memory.cjs',
      ]) ||
      /^schemas\/(?:memory|project-state)/u.test(path) ||
      /^schemas\/genesis-harness\/project-state/u.test(path),
    ['memory'],
  ),
];

const commonDependencyRule = rule(
  'dependencies',
  (path) => hasName(path, ['package.json', 'package-lock.json']),
  ['app', 'production', 'tooling'],
  { imageBuildScan: true },
);

const commonToolingRule = rule(
  'development-tooling',
  (path) =>
    hasPrefix(path, [
      '.agents',
      '.codex',
      '.github',
      'schemas/development-operations',
      'test/ci',
      'test/task-tools',
    ]) ||
    /^scripts\/(?:ci-|task-|lib\/(?:ci-|task-)|validate-ci-workflow)/u.test(
      path,
    ) ||
    hasName(path, [
      '.gitattributes',
      '.gitignore',
      '.prettierignore',
      '.prettierrc',
      'AGENTS.md',
      'README.md',
      'docs/DEVELOPMENT_WORKFLOW.md',
      'docs/MULTI_AGENT_OPERATING_MODEL.md',
      'docs/PROMPT_TEMPLATES.md',
      'docs/TASK_CLASSIFICATION.md',
      'docs/TASK_LOG.md',
      'scripts/format-check-candidate.cjs',
      'scripts/gate2-validate.cjs',
      'scripts/project-agent-skills.cjs',
    ]),
  ['tooling'],
);

const apiRules = [
  ...commonMemoryRules,
  rule(
    'recovery',
    (path) =>
      hasPrefix(path, [
        'config/recovery',
        'docker/recovery',
        'test/recovery',
      ]) ||
      hasName(path, [
        'docs/RECOVERY_RUNBOOK.md',
        'docs/decisions/ADR-016-recovery-contract-and-tooling.md',
        'scripts/validate-recovery-contract.cjs',
      ]),
    ['production'],
    { recovery: true },
  ),
  rule(
    'legacy-adr018',
    (path) =>
      hasName(path, [
        'docker/production/deploy-api-release.py',
        'docker/production/release-tree-manager.py',
        'scripts/build-production-bundle.cjs',
        'scripts/lib/release-tree-contract.cjs',
        'scripts/validate-production-bundle.cjs',
        'test/production/deploy-api-release-linux.test.cjs',
        'test/production/deploy-api-release.test.py',
        'test/production/production-bundle.test.cjs',
        'test/production/release-tree-manager-linux.test.cjs',
        'test/production/release-tree-manager.test.py',
      ]),
    ['production'],
    { legacyProduction: true },
  ),
  rule(
    'database-migration',
    (path) => hasPrefix(path, ['src/database/migrations']),
    ['app', 'production'],
    { imageBuildScan: true },
  ),
  rule(
    'production-image',
    (path) =>
      hasName(path, ['Dockerfile', '.dockerignore']) ||
      path === '.github/workflows/release-image.yml',
    ['production'],
    { imageBuildScan: true },
  ),
  rule(
    'active-production',
    (path) =>
      hasPrefix(path, [
        'docker/postgres',
        'docker/production',
        'docker/traefik',
        'test/production',
      ]) ||
      /^compose\.(?:production|traefik)/u.test(path) ||
      hasName(path, [
        '.env.production.example',
        'compose.production.yml',
        'docs/PRODUCTION.md',
        'docs/decisions/ADR-013-mvp-production-baseline.md',
        'docs/decisions/ADR-014-versioned-production-contract.md',
        'docs/decisions/ADR-015-traefik-edge-and-tls.md',
        'docs/decisions/ADR-018-release-tree-atomic-activation.md',
        'docs/decisions/ADR-020-simple-vps-deployment.md',
        'scripts/validate-production-compose.cjs',
      ]),
    ['production'],
  ),
  rule(
    'release-image-tooling',
    (path) =>
      hasName(path, [
        'scripts/detect-image-impact.cjs',
        'scripts/dispatch-release-image.cjs',
        'scripts/inspect-release-tag.cjs',
      ]),
    ['production', 'tooling'],
    { imageBuildScan: true },
  ),
  commonDependencyRule,
  commonToolingRule,
  rule(
    'application',
    (path) =>
      hasPrefix(path, ['src', 'test']) ||
      /^test\/.*\.spec\.ts$/u.test(path) ||
      hasName(path, [
        '.env.example',
        'compose.yml',
        'compose.test.yml',
        'eslint.config.mjs',
        'jest.config.js',
        'nest-cli.json',
        'scripts/db-test-env.cjs',
        'scripts/prepare-runtime.cjs',
        'test/jest-e2e.json',
        'test/jest-integration.json',
        'tsconfig.build.json',
        'tsconfig.json',
      ]),
    ['app'],
  ),
  rule('runtime-version', (path) => hasName(path, ['.nvmrc']), [
    'app',
    'tooling',
  ]),
  rule('documentation', (path) => hasPrefix(path, ['docs']), ['tooling']),
];

const webRules = [
  ...commonMemoryRules,
  rule(
    'web-application-and-production',
    (path) =>
      hasPrefix(path, [
        'api',
        'scripts/deployment',
        'test/deployment',
        'test/vercel-function-package',
      ]) || hasName(path, ['playwright.production.config.cjs', 'vercel.json']),
    (path) =>
      hasPrefix(path, ['api']) ? ['app', 'production'] : ['production'],
  ),
  commonDependencyRule,
  rule('runtime-version', (path) => hasName(path, ['.nvmrc']), [
    'app',
    'tooling',
  ]),
  commonToolingRule,
  rule(
    'web-application',
    (path) =>
      hasPrefix(path, ['public', 'src', 'test/e2e']) ||
      (/^test\//u.test(path) &&
        !hasPrefix(path, [
          'test/deployment',
          'test/project-memory',
          'test/task-tools',
          'test/vercel-function-package',
        ])) ||
      hasName(path, [
        '.env.example',
        'components.json',
        'eslint.config.js',
        'index.html',
        'playwright.config.ts',
        'tsconfig.app.json',
        'tsconfig.json',
        'tsconfig.node.json',
        'vite.config.ts',
      ]),
    ['app'],
  ),
  rule('documentation', (path) => hasPrefix(path, ['docs']), ['tooling']),
];

const REPOSITORY_RULES = { api: apiRules, web: webRules };

function normalizePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('CI surface paths must be non-empty strings.');
  }
  if (path.includes('\\') || path.startsWith('/') || path.includes('\0')) {
    throw new Error(`CI surface path is not a normalized Git path: ${path}`);
  }
  return path.replace(/^\.\//u, '');
}

function canonicalSurfaces(surfaces) {
  return SURFACE_ORDER.filter((surface) => surfaces.includes(surface));
}

function classifyPaths(paths, repository) {
  const rules = REPOSITORY_RULES[repository];
  if (!rules)
    throw new Error(`unsupported repository classifier: ${repository}`);
  const normalizedPaths = [...new Set(paths.map(normalizePath))].sort();
  const surfaces = new Set();
  const unknownPaths = [];
  const reasons = [];
  const modifiers = {
    recovery: false,
    imageBuildScan: false,
    legacyProduction: false,
  };

  for (const path of normalizedPaths) {
    const matchingRule = rules.find((entry) => entry.matches(path));
    if (!matchingRule) {
      unknownPaths.push(path);
      continue;
    }
    const selectedSurfaces =
      typeof matchingRule.surfaces === 'function'
        ? matchingRule.surfaces(path)
        : matchingRule.surfaces;
    selectedSurfaces.forEach((surface) => surfaces.add(surface));
    for (const [modifier, enabled] of Object.entries(matchingRule.modifiers)) {
      if (enabled) modifiers[modifier] = true;
    }
    reasons.push({
      path,
      surfaces: canonicalSurfaces(selectedSurfaces),
      rules: [matchingRule.name],
    });
  }

  return {
    repository,
    surfaces: canonicalSurfaces([...surfaces]),
    reasons,
    unknownPaths,
    modifiers,
  };
}

function validateDeclaredSurfaces(classification, declaredSurfaces) {
  const declared = canonicalSurfaces(declaredSurfaces ?? []);
  const failures = classification.unknownPaths.map(
    (path) => `UNKNOWN_CI_SURFACE_PATH: ${path}`,
  );
  const missing = classification.surfaces.filter(
    (surface) => !declared.includes(surface),
  );
  if (missing.length > 0) {
    failures.push(
      `MANIFEST_SURFACE_UNDER_DECLARED: required ${missing.join(', ')}; declared ${declared.join(', ') || '(none)'}`,
    );
  }
  return { declaredSurfaces: declared, missingSurfaces: missing, failures };
}

function buildSelection(
  classification,
  declaredSurfaces,
  { full = false } = {},
) {
  if (full) {
    return {
      ...classification,
      surfaces: [...SURFACE_ORDER],
      modifiers: {
        recovery: true,
        imageBuildScan: true,
        legacyProduction: false,
      },
      declaredSurfaces: [...SURFACE_ORDER],
      failures: classification.unknownPaths.map(
        (path) => `UNKNOWN_CI_SURFACE_PATH: ${path}`,
      ),
    };
  }
  const declaration = validateDeclaredSurfaces(
    classification,
    declaredSurfaces ?? classification.surfaces,
  );
  return {
    ...classification,
    surfaces: canonicalSurfaces([
      ...classification.surfaces,
      ...declaration.declaredSurfaces,
    ]),
    declaredSurfaces: declaration.declaredSurfaces,
    failures: declaration.failures,
  };
}

module.exports = {
  REPOSITORY_RULES,
  SURFACE_ORDER,
  buildSelection,
  canonicalSurfaces,
  classifyPaths,
  normalizePath,
  validateDeclaredSurfaces,
};
