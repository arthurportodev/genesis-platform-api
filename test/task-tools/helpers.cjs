const { execFileSync } = require('node:child_process');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');

const DEFAULT_SCRIPTS = {
  'format:check': 'node -e "process.exit(0)"',
  'format:check:task-tools': 'node -e "process.exit(0)"',
  lint: 'node -e "process.exit(0)"',
  build: 'node -e "process.exit(0)"',
  test: 'node -e "process.exit(0)"',
  'test:task-tools': 'node -e "process.exit(0)"',
  'task:preflight': 'node -e "process.exit(0)"',
  'task:validate': 'node -e "process.exit(0)"',
  'gate2:validate': 'node -e "process.exit(0)"',
  format: 'prettier --write .',
  'migration:revert': 'node -e "process.exit(0)"',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(cwd, path, content) {
  const target = join(cwd, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function defaultManifest(baseSha, overrides = {}) {
  return {
    version: 1,
    task: { id: 'test.1', title: 'Task tools test', class: 'normal' },
    git: { branch: 'task/test-tools', baseSha, requireCleanStage: true },
    scope: {
      allowedPaths: ['docs/**'],
      protectedPaths: ['src/auth/**'],
    },
    artifacts: {},
    validation: { profile: 'normal', focusedScripts: ['test:task-tools'] },
    ...overrides,
  };
}

function createTestRepository({
  manifestOverrides = {},
  packetIgnored = false,
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'genesis-task-tools-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'task-tools@example.invalid');
  git(cwd, 'config', 'user.name', 'Task Tools Test');
  write(cwd, 'README.md', '# Fixture\n');
  write(
    cwd,
    'package.json',
    `${JSON.stringify({ private: true, scripts: DEFAULT_SCRIPTS }, null, 2)}\n`,
  );
  git(cwd, 'add', 'README.md', 'package.json');
  git(cwd, 'commit', '-m', 'test base');
  const baseSha = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-c', 'task/test-tools');
  const manifest = defaultManifest(baseSha, manifestOverrides);
  write(
    cwd,
    '.codex/task-manifest.json',
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const excludePath = join(cwd, '.git', 'info', 'exclude');
  const packetRule = packetIgnored ? '\n.codex/task-packets/test.1.md\n' : '\n';
  writeFileSync(
    excludePath,
    `${readFileSync(excludePath, 'utf8')}\n.codex/task-manifest.json${packetRule}`,
  );
  return { cwd, baseSha, manifest };
}

module.exports = {
  DEFAULT_SCRIPTS,
  createTestRepository,
  defaultManifest,
  git,
  write,
};
