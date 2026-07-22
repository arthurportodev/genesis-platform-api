const FOCUSED_SCRIPT_ALLOWLIST = new Set([
  'build',
  'db:test:env',
  'format:check',
  'format:check:task-tools',
  'lint',
  'test',
  'test:e2e',
  'test:integration',
  'test:task-tools',
]);

function focusedScriptFailure(name, packageScripts) {
  if (!FOCUSED_SCRIPT_ALLOWLIST.has(name)) {
    return `focused script is not in the read-only validation allowlist: ${name}.`;
  }
  for (const lifecycleName of [`pre${name}`, `post${name}`]) {
    if (Object.hasOwn(packageScripts, lifecycleName)) {
      return `focused script has a lifecycle hook and is not safe to dispatch: ${name}.`;
    }
  }
  return null;
}

module.exports = { FOCUSED_SCRIPT_ALLOWLIST, focusedScriptFailure };
