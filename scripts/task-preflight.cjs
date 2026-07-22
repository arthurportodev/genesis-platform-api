const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const expectedBranch = 'feature/invitation-new-user-activation';
const expectedBase = '410f0576a98e373c39bf178f73b80838b40d2924';
const startedAt = Date.now();

function git(args, print = true) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (print) {
    process.stdout.write(`$ git ${args.join(' ')}\n`);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  return (result.stdout ?? '').trim();
}

const branch = git(['branch', '--show-current']);
const sha = git(['rev-parse', 'HEAD']);
git(['merge-base', '--is-ancestor', expectedBase, 'HEAD']);
const staged = git(['diff', '--cached', '--name-only']);
const trimmedStatus = git(['status', '--short']);
const status = /^[MADRCU] /u.test(trimmedStatus)
  ? ` ${trimmedStatus}`
  : trimmedStatus;
const divergence = git(['rev-list', '--left-right', '--count', 'main...HEAD']);
const diffCheck = spawnSync('git', ['diff', '--check'], { encoding: 'utf8' });
process.stdout.write('$ git diff --check\n');
process.stdout.write(diffCheck.stdout ?? '');
process.stderr.write(diffCheck.stderr ?? '');

const packetTracked = git(
  ['ls-files', '.codex/task-packets/0.2.5.3.md'],
  false,
);
const untracked = git(['ls-files', '--others', '--exclude-standard'], false)
  .split(/\r?\n/u)
  .filter(Boolean)
  .sort();
const diff = git(['diff', '--binary', 'HEAD'], false);
const changedPaths = status
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => line.slice(3).split(' -> ').at(-1));
const allowed = [
  /^\.env\.example$/u,
  /^compose\.yml$/u,
  /^package\.json$/u,
  /^README\.md$/u,
  /^docs\//u,
  /^scripts\//u,
  /^src\/config\//u,
  /^src\/database\/migrations\/1785174000000-ActivateNewInvitationUser\.ts$/u,
  /^src\/modules\/auth\/(auth\.module|auth\.service|services\/password\.service)\.ts$/u,
  /^src\/modules\/credentials\//u,
  /^src\/modules\/invitations\//u,
  /^src\/modules\/organization-audit\/enums\/organization-audit-event-type\.enum\.ts$/u,
  /^src\/modules\/users\/entities\/user\.entity\.ts$/u,
  /^test\//u,
];
const fingerprint = createHash('sha256');
fingerprint.update(diff);
for (const file of untracked) {
  fingerprint.update(`\0${file}\0`);
  fingerprint.update(readFileSync(file));
}

const failures = [];
if (branch !== expectedBranch) failures.push(`branch=${branch}`);
if (sha !== expectedBase) failures.push(`HEAD=${sha}`);
if (staged !== '') failures.push('stage is not empty');
if (packetTracked !== '') failures.push('Task Packet is tracked');
if (diffCheck.status !== 0) failures.push('git diff --check failed');
if (!existsSync('.codex/task-packets/0.2.5.3.md')) {
  failures.push('Task Packet is missing');
}
const packetIgnored = spawnSync(
  'git',
  ['check-ignore', '-q', '.codex/task-packets/0.2.5.3.md'],
  { encoding: 'utf8' },
);
if (packetIgnored.status !== 0) failures.push('Task Packet is not excluded');
for (const path of changedPaths) {
  if (path !== undefined && !allowed.some((pattern) => pattern.test(path))) {
    failures.push(`file outside approved scope: ${path}`);
  }
}
if (
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[A-Z0-9]{16}\b/u.test(
    diff,
  )
) {
  failures.push('possible committed secret in diff');
}

const durationMs = Date.now() - startedAt;
const candidate = fingerprint.digest('hex');
console.log(
  JSON.stringify({
    command: 'npm run task:preflight',
    durationMs,
    status: failures.length === 0 ? 'passed' : 'failed',
    branch,
    sha,
    divergence,
    changedEntries: status === '' ? 0 : status.split(/\r?\n/u).length,
    fingerprint: candidate,
    failures,
  }),
);
if (failures.length > 0) process.exit(1);
