const { createHash } = require('node:crypto');
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { SKILLS } = require('./task-contracts.cjs');
const { normalizeRepoPath } = require('./lib/task-manifest.cjs');

const CONTRACT_SET_PATH = 'schemas/development-operations/contract-set.json';
const SKILL_PREFIX = '.agents/skills/';
const REQUIRED_SKILL_FILES = ['SKILL.md', 'agents/openai.yaml'];

class SkillProjectionError extends Error {
  constructor(failures) {
    super(
      `skill projection failed:\n${failures.map((entry) => `- ${entry}`).join('\n')}`,
    );
    this.name = 'SkillProjectionError';
    this.failures = failures;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function toRepoPath(path) {
  return path.split(sep).join('/');
}

function isWithin(path, parent) {
  const value = relative(parent, path);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
}

function walkFiles(root, current = root) {
  if (!existsSync(current)) return [];
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) {
    throw new SkillProjectionError([
      `projection path must not be a symbolic link: ${current}.`,
    ]);
  }
  if (stat.isFile()) return [current];
  if (!stat.isDirectory()) {
    throw new SkillProjectionError([
      `projection path has an unsupported type: ${current}.`,
    ]);
  }
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) =>
    walkFiles(root, join(current, entry.name)),
  );
}

function loadProjectionContract(sourceRoot) {
  const contractPath = join(sourceRoot, ...CONTRACT_SET_PATH.split('/'));
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const failures = [];
  const entries = [];
  for (const entry of contract.files ?? []) {
    let path;
    try {
      path = normalizeRepoPath(entry.path, 'contract projection path');
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    if (path.startsWith(SKILL_PREFIX)) {
      entries.push({ ...entry, path, content: null });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const skills = [...new Set(entries.map((entry) => entry.path.split('/')[2]))]
    .filter(Boolean)
    .sort();

  for (const skill of skills) {
    const paths = entries
      .filter((entry) => entry.path.split('/')[2] === skill)
      .map((entry) => entry.path.split('/').slice(3).join('/'))
      .sort();
    if (
      JSON.stringify(paths) !== JSON.stringify([...REQUIRED_SKILL_FILES].sort())
    ) {
      failures.push(
        `Skill ${skill} must declare exactly ${REQUIRED_SKILL_FILES.join(', ')}.`,
      );
    }
  }
  if (JSON.stringify(skills) !== JSON.stringify([...SKILLS].sort())) {
    failures.push(
      `contract must declare exactly the canonical Skills: ${SKILLS.join(', ')}.`,
    );
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    failures.push('contract must not declare duplicate Skill paths.');
  }

  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) {
      failures.push(`invalid contract hash: ${entry.path}.`);
      continue;
    }
    const sourcePath = join(sourceRoot, ...entry.path.split('/'));
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
      failures.push(
        `canonical Skill file is missing or irregular: ${entry.path}.`,
      );
      continue;
    }
    if (lstatSync(sourcePath).isSymbolicLink()) {
      failures.push(
        `canonical Skill file must not be a symbolic link: ${entry.path}.`,
      );
      continue;
    }
    entry.content = readFileSync(sourcePath);
    if (sha256(entry.content) !== entry.sha256) {
      failures.push(`canonical Skill hash mismatch: ${entry.path}.`);
    }
  }

  if (failures.length > 0) throw new SkillProjectionError(failures.sort());
  return { contract, entries, skills };
}

function validateDestination(sourceRoot, destinationRoot, entries, skills) {
  const failures = [];
  const sourceSkillsRoot = realpathSync(join(sourceRoot, '.agents', 'skills'));
  for (const [path, label] of [
    [destinationRoot, 'destination'],
    [join(destinationRoot, '.agents'), 'destination .agents'],
    [join(destinationRoot, '.agents', 'skills'), 'destination Skills root'],
  ]) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      failures.push(`${label} must be a regular directory: ${path}.`);
    }
  }
  if (resolve(destinationRoot) === resolve(sourceRoot)) {
    failures.push('destination must not be the canonical source repository.');
  }
  const destinationSkillsRoot = join(destinationRoot, '.agents', 'skills');
  if (
    existsSync(destinationSkillsRoot) &&
    lstatSync(destinationSkillsRoot).isDirectory() &&
    !lstatSync(destinationSkillsRoot).isSymbolicLink() &&
    realpathSync(destinationSkillsRoot) === sourceSkillsRoot
  ) {
    failures.push('destination resolves to the canonical Skills directory.');
  }

  const expected = new Set(entries.map((entry) => entry.path));
  for (const skill of skills) {
    const skillRoot = join(destinationSkillsRoot, skill);
    let files = [];
    try {
      files = walkFiles(skillRoot);
    } catch (error) {
      failures.push(...(error.failures ?? [error.message]));
      continue;
    }
    for (const file of files) {
      const repoPath = `${SKILL_PREFIX}${skill}/${toRepoPath(relative(skillRoot, file))}`;
      if (!expected.has(repoPath)) {
        failures.push(`unexpected managed projection file: ${repoPath}.`);
      }
      if (!isWithin(resolve(file), resolve(skillRoot))) {
        failures.push(
          `projection file escapes its managed Skill: ${repoPath}.`,
        );
      }
    }
  }
  if (failures.length > 0) throw new SkillProjectionError(failures.sort());
}

function projectAgentSkills({
  mode,
  destination,
  sourceRoot = process.cwd(),
} = {}) {
  if (!['write', 'check'].includes(mode)) {
    throw new SkillProjectionError(['mode must be write or check.']);
  }
  if (!destination) {
    throw new SkillProjectionError(['an explicit destination is required.']);
  }

  const canonicalRoot = resolve(sourceRoot);
  const destinationRoot = resolve(destination);
  const { entries, skills } = loadProjectionContract(canonicalRoot);
  validateDestination(canonicalRoot, destinationRoot, entries, skills);
  const failures = [];

  for (const entry of entries) {
    const target = join(destinationRoot, ...entry.path.split('/'));
    if (mode === 'write') {
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          failures.push(
            `projection target is not a regular file: ${entry.path}.`,
          );
          continue;
        }
      }
      writeFileSync(target, entry.content);
    }
    if (!existsSync(target)) {
      failures.push(`projection file is missing: ${entry.path}.`);
      continue;
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      failures.push(`projection target is not a regular file: ${entry.path}.`);
      continue;
    }
    if (sha256(readFileSync(target)) !== entry.sha256) {
      failures.push(`projection hash mismatch: ${entry.path}.`);
    }
  }

  if (failures.length > 0) throw new SkillProjectionError(failures.sort());
  return {
    command: 'project-agent-skills',
    status: 'passed',
    mode,
    destination: destinationRoot,
    skills: skills.length,
    files: entries.length,
  };
}

function parseArgs(argv) {
  if (argv.length !== 2 || !['--write', '--check'].includes(argv[0])) {
    throw new SkillProjectionError([
      'usage: project-agent-skills.cjs (--write|--check) <destination-root>.',
    ]);
  }
  return { mode: argv[0].slice(2), destination: argv[1] };
}

function main() {
  try {
    console.log(
      JSON.stringify(projectAgentSkills(parseArgs(process.argv.slice(2)))),
    );
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  SkillProjectionError,
  loadProjectionContract,
  parseArgs,
  projectAgentSkills,
  sha256,
};
