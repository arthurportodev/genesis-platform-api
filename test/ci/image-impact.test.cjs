const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');
const {
  ImageImpactError,
  analyzeNameStatus,
  detectImageImpact,
  isImageAffectingPath,
  normalizeGitPath,
  parseCliArguments,
  parseNameStatusZ,
  validateSha,
  writeGithubOutput,
} = require('../../scripts/detect-image-impact.cjs');

const SCRIPT = join(process.cwd(), 'scripts', 'detect-image-impact.cjs');

function statusBuffer(...fields) {
  return Buffer.from(`${fields.join('\0')}\0`, 'utf8');
}

function run(cwd, command, args = []) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(repo, path, value) {
  const target = join(repo, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}

function commit(repo, message) {
  run(repo, 'git', ['add', '--all']);
  run(repo, 'git', ['commit', '--quiet', '-m', message]);
  return run(repo, 'git', ['rev-parse', 'HEAD']);
}

function repository() {
  const repo = mkdtempSync(join(tmpdir(), 'genesis-image-impact-'));
  run(repo, 'git', ['init', '--quiet']);
  run(repo, 'git', ['config', 'user.name', 'Image Impact Test']);
  run(repo, 'git', ['config', 'user.email', 'image-impact@example.invalid']);
  write(repo, 'docs/base.md', 'base\n');
  const base = commit(repo, 'base');
  return { base, repo };
}

function withRepository(callback) {
  const fixture = repository();
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture.repo, { force: true, recursive: true });
  }
}

test('matches only the canonical root build inputs and src tree', () => {
  for (const path of [
    'Dockerfile',
    '.dockerignore',
    '.npmrc',
    'package.json',
    'package-lock.json',
    'nest-cli.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'tsconfig.release.strict.json',
    'src/main.ts',
    'src/database/migrations/0001.ts',
  ]) {
    assert.equal(isImageAffectingPath(path), true, path);
  }
});

test('does not match operational paths or misleading names', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    'scripts/detect-image-impact.cjs',
    'scripts/validate-ci-workflow.cjs',
    'scripts/validate-project-memory.cjs',
    'test/ci/image-impact.test.cjs',
    'test/ci/ci-workflow.test.cjs',
    'test/project-memory/project-memory.test.cjs',
    'docs/PRODUCTION.md',
    'docs/SECURITY.md',
    'docs/CURRENT_STATE.md',
    'docs/ROADMAP.md',
    'docs/TASK_LOG.md',
    'docs/runbooks/first-deploy.md',
    'README.md',
    'compose.production.yml',
    '.env.production.example',
    'schemas/image-impact.json',
    'schemas/genesis-harness/project-state.v1.schema.json',
    '.agents/skills/example.md',
    '.codex/task-manifest.json',
    'docker/postgres/init-runtime-role.sh',
    'docs/src/example.md',
    'src-old/main.ts',
    'Dockerfile.backup',
    'package.json.md',
    'TSConfig.json',
    'Src/main.ts',
  ]) {
    assert.equal(isImageAffectingPath(path), false, path);
  }
});

test('path matching is structural and unaffected by comment-like text', () => {
  assert.equal(
    isImageAffectingPath('docs/Dockerfile package.json src.md'),
    false,
  );
  assert.equal(isImageAffectingPath('test/comments/Dockerfile.md'), false);
});

test('normalizes separators but rejects traversal, absolute, empty, and control paths', () => {
  assert.equal(normalizeGitPath('src\\nested\\main.ts'), 'src/nested/main.ts');
  for (const path of [
    '',
    '/src/main.ts',
    'C:/src/main.ts',
    '../src/main.ts',
    'docs/../src/main.ts',
    './src/main.ts',
    'src//main.ts',
    'src/main\n.ts',
  ]) {
    assert.throws(() => normalizeGitPath(path), ImageImpactError, path);
  }
});

test('parses additions, modifications, deletions, and type changes', () => {
  assert.deepEqual(
    parseNameStatusZ(
      statusBuffer(
        'A',
        'src/added.ts',
        'M',
        'package.json',
        'D',
        'src/deleted.ts',
        'T',
        'Dockerfile',
      ),
    ),
    [
      { status: 'A', paths: ['src/added.ts'] },
      { status: 'M', paths: ['package.json'] },
      { status: 'D', paths: ['src/deleted.ts'] },
      { status: 'T', paths: ['Dockerfile'] },
    ],
  );
});

test('a rename entering or leaving the image boundary publishes', () => {
  assert.equal(
    analyzeNameStatus(statusBuffer('R100', 'docs/main.ts', 'src/main.ts'))
      .shouldPublish,
    true,
  );
  assert.equal(
    analyzeNameStatus(statusBuffer('R075', 'src/main.ts', 'docs/main.ts'))
      .shouldPublish,
    true,
  );
});

test('a rename wholly outside the image boundary does not publish', () => {
  assert.equal(
    analyzeNameStatus(statusBuffer('R100', 'docs/old.md', 'docs/new.md'))
      .shouldPublish,
    false,
  );
});

test('rejects malformed, ambiguous, unsafe, and non-UTF-8 Git output', () => {
  for (const output of [
    Buffer.from('M\0src/main.ts', 'utf8'),
    statusBuffer('M'),
    statusBuffer('R100', 'src/old.ts'),
    statusBuffer('R101', 'src/old.ts', 'src/new.ts'),
    statusBuffer('Q', 'src/main.ts'),
    statusBuffer('U', 'src/main.ts'),
    statusBuffer('X', 'src/main.ts'),
    statusBuffer('B', 'src/main.ts'),
    statusBuffer('M', '../src/main.ts'),
    Buffer.from([0x4d, 0x00, 0xff, 0x00]),
  ]) {
    assert.throws(() => parseNameStatusZ(output), ImageImpactError);
  }
  assert.throws(() => parseNameStatusZ('M\0src/main.ts\0'), ImageImpactError);
});

test('requires lowercase non-zero full SHAs and both CLI arguments', () => {
  const sha = 'a'.repeat(40);
  assert.equal(validateSha(sha, 'base'), sha);
  for (const invalid of [
    '',
    'a'.repeat(39),
    'a'.repeat(41),
    'A'.repeat(40),
    'g'.repeat(40),
    '0'.repeat(40),
  ]) {
    assert.throws(() => validateSha(invalid, 'base'), ImageImpactError);
  }
  assert.deepEqual(parseCliArguments(['--base', sha, '--head', sha]), {
    base: sha,
    head: sha,
  });
  assert.throws(() => parseCliArguments(['--base', sha]), ImageImpactError);
  assert.throws(
    () => parseCliArguments(['--head', sha, '--base', sha]),
    ImageImpactError,
  );
});

test('invokes Git without a shell and with full explicit endpoints', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ args, command, options });
    return {
      error: undefined,
      signal: null,
      status: 0,
      stdout:
        args[0] === 'diff' ? statusBuffer('M', 'src/main.ts') : Buffer.alloc(0),
    };
  };
  assert.equal(
    detectImageImpact({ base, head, spawn: fakeSpawn }).shouldPublish,
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['cat-file', '-e', `${base}^{commit}`],
      ['cat-file', '-e', `${head}^{commit}`],
      ['diff', '--name-status', '-z', '--find-renames', base, head, '--'],
    ],
  );
  assert.ok(
    calls.every(
      (call) => call.command === 'git' && call.options.shell === false,
    ),
  );
});

test('fails closed when either object or the diff range cannot be resolved', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const failedSpawn = () => ({
    error: undefined,
    signal: null,
    status: 128,
    stdout: Buffer.alloc(0),
  });
  assert.throws(
    () => detectImageImpact({ base, head, spawn: failedSpawn }),
    /could not prove/u,
  );
  const ambiguousSpawn = () => ({
    error: undefined,
    signal: null,
    status: 0,
    stderr: Buffer.from('warning', 'utf8'),
    stdout: Buffer.alloc(0),
  });
  assert.throws(
    () => detectImageImpact({ base, head, spawn: ambiguousSpawn }),
    /ambiguous diagnostic/u,
  );
});

test('writes one canonical boolean and rejects non-boolean results', () => {
  const directory = mkdtempSync(join(tmpdir(), 'genesis-image-output-'));
  const output = join(directory, 'github-output');
  try {
    writeGithubOutput(output, true);
    writeGithubOutput(output, false);
    assert.equal(
      readFileSync(output, 'utf8'),
      'should_publish=true\nshould_publish=false\n',
    );
    assert.throws(() => writeGithubOutput(output, 'true'), /must be boolean/u);
    assert.throws(() => writeGithubOutput('', true), /GITHUB_OUTPUT/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('detects multiple commits and src creation, modification, and deletion', () =>
  withRepository(({ repo }) => {
    write(repo, 'src/modified.ts', 'before\n');
    write(repo, 'src/deleted.ts', 'delete me\n');
    const base = commit(repo, 'prepare source baseline');
    write(repo, 'src/created.ts', 'one\n');
    commit(repo, 'create source');
    write(repo, 'src/modified.ts', 'after\n');
    commit(repo, 'modify source');
    unlinkSync(join(repo, 'src', 'deleted.ts'));
    const head = commit(repo, 'delete source');
    assert.equal(
      detectImageImpact({ base, head, cwd: repo }).shouldPublish,
      true,
    );
  }));

test('documentation-only multi-commit push returns false', () =>
  withRepository(({ base, repo }) => {
    write(repo, 'docs/one.md', 'one\n');
    commit(repo, 'docs one');
    write(repo, 'docs/two.md', 'two\n');
    const head = commit(repo, 'docs two');
    const result = detectImageImpact({ base, head, cwd: repo });
    assert.equal(result.shouldPublish, false);
    assert.deepEqual(result.changedPaths, ['docs/one.md', 'docs/two.md']);
  }));

test('CLI emits no stdout and writes only false for a documentation push', () =>
  withRepository(({ base, repo }) => {
    write(repo, 'docs/change.md', 'change\n');
    const head = commit(repo, 'docs');
    const output = join(repo, 'github-output');
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--base', base, '--head', head],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
        shell: false,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(readFileSync(output, 'utf8'), 'should_publish=false\n');
  }));

test('CLI emits no boolean output and exits non-zero on an unresolved range', () =>
  withRepository(({ base, repo }) => {
    const output = join(repo, 'github-output');
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--base', base, '--head', 'b'.repeat(40)],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
        shell: false,
        windowsHide: true,
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /could not prove/u);
    assert.throws(() => readFileSync(output, 'utf8'));
  }));
