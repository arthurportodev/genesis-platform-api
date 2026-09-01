const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const {
  SkillProjectionError,
  loadProjectionContract,
  parseArgs,
  projectAgentSkills,
  sha256,
} = require('../../scripts/project-agent-skills.cjs');

const SOURCE_ROOT = process.cwd();

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'genesis-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function projectedPath(root, repoPath) {
  return join(root, ...repoPath.split('/'));
}

test('exports all three Skills deterministically and check accepts the projection', (t) => {
  const destination = temporaryRoot(t);
  const contract = loadProjectionContract(SOURCE_ROOT);
  const first = projectAgentSkills({
    mode: 'write',
    destination,
    sourceRoot: SOURCE_ROOT,
  });
  assert.equal(first.skills, 3);
  assert.equal(first.files, 6);
  assert.equal(
    projectAgentSkills({
      mode: 'check',
      destination,
      sourceRoot: SOURCE_ROOT,
    }).status,
    'passed',
  );
  const before = contract.entries.map((entry) =>
    sha256(readFileSync(projectedPath(destination, entry.path))),
  );
  projectAgentSkills({ mode: 'write', destination, sourceRoot: SOURCE_ROOT });
  const after = contract.entries.map((entry) =>
    sha256(readFileSync(projectedPath(destination, entry.path))),
  );
  assert.deepEqual(after, before);
});

test('check fails closed for a missing or divergent projection file', (t) => {
  const destination = temporaryRoot(t);
  const { entries } = loadProjectionContract(SOURCE_ROOT);
  projectAgentSkills({ mode: 'write', destination, sourceRoot: SOURCE_ROOT });

  const target = projectedPath(destination, entries[0].path);
  unlinkSync(target);
  assert.throws(
    () =>
      projectAgentSkills({
        mode: 'check',
        destination,
        sourceRoot: SOURCE_ROOT,
      }),
    /projection file is missing/u,
  );

  projectAgentSkills({ mode: 'write', destination, sourceRoot: SOURCE_ROOT });
  writeFileSync(target, 'drift\n');
  assert.throws(
    () =>
      projectAgentSkills({
        mode: 'check',
        destination,
        sourceRoot: SOURCE_ROOT,
      }),
    /projection hash mismatch/u,
  );
});

test('rejects the canonical source and unexpected managed files without editing them', (t) => {
  assert.throws(
    () =>
      projectAgentSkills({
        mode: 'write',
        destination: SOURCE_ROOT,
        sourceRoot: SOURCE_ROOT,
      }),
    /must not be the canonical source/u,
  );

  const destination = temporaryRoot(t);
  projectAgentSkills({ mode: 'write', destination, sourceRoot: SOURCE_ROOT });
  const unexpected = join(
    destination,
    '.agents',
    'skills',
    'genesis-task-orchestrator',
    'UNDECLARED.md',
  );
  writeFileSync(unexpected, 'outside contract\n');
  assert.throws(
    () =>
      projectAgentSkills({
        mode: 'write',
        destination,
        sourceRoot: SOURCE_ROOT,
      }),
    /unexpected managed projection file/u,
  );
  assert.equal(readFileSync(unexpected, 'utf8'), 'outside contract\n');
});

test('rejects an irregular destination ancestor before writing a projection', (t) => {
  const destination = temporaryRoot(t);
  writeFileSync(join(destination, '.agents'), 'not a directory\n');
  assert.throws(
    () =>
      projectAgentSkills({
        mode: 'write',
        destination,
        sourceRoot: SOURCE_ROOT,
      }),
    /destination \.agents must be a regular directory/u,
  );
  assert.equal(
    readFileSync(join(destination, '.agents'), 'utf8'),
    'not a directory\n',
  );
});

test('rejects an incorrect canonical hash before writing the destination', (t) => {
  const fixtureRoot = temporaryRoot(t);
  const destination = join(fixtureRoot, 'destination');
  const source = join(fixtureRoot, 'source');
  const { entries } = loadProjectionContract(SOURCE_ROOT);
  for (const entry of entries) {
    const target = projectedPath(source, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(projectedPath(SOURCE_ROOT, entry.path), target);
  }
  const contractPath = join(
    source,
    'schemas',
    'development-operations',
    'contract-set.json',
  );
  mkdirSync(dirname(contractPath), { recursive: true });
  const contract = JSON.parse(
    readFileSync(
      join(
        SOURCE_ROOT,
        'schemas',
        'development-operations',
        'contract-set.json',
      ),
      'utf8',
    ),
  );
  contract.files.find((entry) =>
    entry.path.startsWith('.agents/skills/'),
  ).sha256 = '0'.repeat(64);
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  assert.throws(
    () =>
      projectAgentSkills({ mode: 'write', destination, sourceRoot: source }),
    /canonical Skill hash mismatch/u,
  );
  assert.throws(
    () => readFileSync(join(destination, '.agents', 'skills')),
    /ENOENT/u,
  );
});

test('rejects a contract path that escapes the declared projection tree', (t) => {
  const fixtureRoot = temporaryRoot(t);
  const source = join(fixtureRoot, 'source');
  const contractPath = join(
    source,
    'schemas',
    'development-operations',
    'contract-set.json',
  );
  mkdirSync(dirname(contractPath), { recursive: true });
  writeFileSync(
    contractPath,
    `${JSON.stringify({
      files: [
        {
          path: '.agents/skills/genesis-task-orchestrator/../../outside',
          sha256: '0'.repeat(64),
        },
      ],
    })}\n`,
  );
  assert.throws(
    () => loadProjectionContract(source),
    /must not contain '\.\.'/u,
  );
});

test('requires exactly one supported mode and an explicit destination', () => {
  assert.deepEqual(parseArgs(['--write', 'target']), {
    mode: 'write',
    destination: 'target',
  });
  assert.deepEqual(parseArgs(['--check', 'target']), {
    mode: 'check',
    destination: 'target',
  });
  assert.throws(() => parseArgs(['--write']), SkillProjectionError);
  assert.throws(() => parseArgs(['--sync', 'target']), SkillProjectionError);
  assert.throws(
    () => parseArgs(['--write', 'target', 'unexpected']),
    SkillProjectionError,
  );
});
