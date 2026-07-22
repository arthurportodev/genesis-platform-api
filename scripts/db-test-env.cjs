const startedAt = Date.now();
const required = [
  'TEST_DATABASE_HOST',
  'TEST_DATABASE_PORT',
  'TEST_DATABASE_NAME',
  'TEST_DATABASE_USER',
  'TEST_DATABASE_PASSWORD',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_RUNTIME_ROLE',
  'DATABASE_MIGRATION_USER',
  'DATABASE_MIGRATION_PASSWORD',
];
const missing = required.filter((name) => !process.env[name]?.trim());
const failures = missing.map((name) => `missing ${name}`);
if (
  process.env.TEST_DATABASE_NAME &&
  !process.env.TEST_DATABASE_NAME.endsWith('_test')
) {
  failures.push('TEST_DATABASE_NAME must end in _test');
}
if (process.env.DATABASE_NAME && !process.env.DATABASE_NAME.endsWith('_test')) {
  failures.push('DATABASE_NAME must end in _test');
}
if (
  process.env.DATABASE_NAME &&
  process.env.TEST_DATABASE_NAME &&
  process.env.DATABASE_NAME !== process.env.TEST_DATABASE_NAME
) {
  failures.push('DATABASE_NAME must equal TEST_DATABASE_NAME');
}
if (
  process.env.DATABASE_RUNTIME_ROLE &&
  process.env.DATABASE_MIGRATION_USER &&
  process.env.DATABASE_RUNTIME_ROLE === process.env.DATABASE_MIGRATION_USER
) {
  failures.push('runtime and migration roles must be distinct');
}
if (
  process.env.DATABASE_USER &&
  process.env.DATABASE_RUNTIME_ROLE &&
  process.env.DATABASE_USER !== process.env.DATABASE_RUNTIME_ROLE
) {
  failures.push('DATABASE_USER must equal DATABASE_RUNTIME_ROLE');
}
console.log(
  JSON.stringify({
    command: 'npm run db:test:env',
    durationMs: Date.now() - startedAt,
    status: failures.length === 0 ? 'passed' : 'failed',
    database: process.env.TEST_DATABASE_NAME ?? null,
    failures,
  }),
);
if (failures.length > 0) process.exit(1);
