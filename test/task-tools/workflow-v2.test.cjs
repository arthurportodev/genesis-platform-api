const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function read(path) {
  return readFileSync(join(process.cwd(), ...path.split('/')), 'utf8');
}

test('CI enforces contracts, formatting and task-tool tests', () => {
  const workflow = read('.github/workflows/ci.yml');
  const contracts = workflow.indexOf('npm run task:contracts');
  const formatting = workflow.indexOf('npm run format:check:task-tools');
  const tests = workflow.indexOf('npm run test:task-tools');
  const application = workflow.indexOf('npm run format:check\n');
  assert.ok(contracts > 0);
  assert.ok(formatting > contracts);
  assert.ok(tests > formatting);
  assert.ok(application > tests);
});

test('documents explicit Critical Skill invocation and fallback', () => {
  const agents = read('AGENTS.md');
  const prompts = read('docs/PROMPT_TEMPLATES.md');
  const workflow = read('docs/DEVELOPMENT_WORKFLOW.md');
  for (const name of [
    '$genesis-task-orchestrator',
    '$genesis-independent-verifier',
  ]) {
    assert.match(agents, new RegExp(`\\${name}`, 'u'));
    assert.match(prompts, new RegExp(`\\${name}`, 'u'));
  }
  assert.match(
    agents,
    /invocação das duas\s+Skills é explícita em tarefas Critical/u,
  );
  assert.match(workflow, /dual-read/u);
});

test('keeps the remote operator conceptual and separately authorized', () => {
  const production = read('docs/PRODUCTION.md');
  assert.match(production, /ainda não está\s+implementado/u);
  assert.match(production, /um writer por recurso compartilhado/u);
  assert.match(production, /evidence-manifest\.v1/u);
});

test('binds verifier instance validation to recomputed candidate paths', () => {
  const contracts = read('scripts/task-contracts.cjs');
  assert.match(contracts, /--validate-instance/u);
  assert.match(contracts, /expectedCandidatePaths/u);
  assert.match(contracts, /calculateFingerprint\(\)/u);
  assert.match(
    contracts,
    /verifier evidence requires the recomputed candidate path set/u,
  );
});
