const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const nestCli = join(
  process.cwd(),
  'node_modules',
  '@nestjs',
  'cli',
  'bin',
  'nest.js',
);
const compiledDataSource = join(
  process.cwd(),
  'dist',
  'database',
  'data-source.js',
);

if (existsSync(nestCli)) {
  const result = spawnSync(process.execPath, [nestCli, 'build'], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} else if (!existsSync(compiledDataSource)) {
  console.error(
    'Compiled database runtime is missing and Nest CLI is unavailable.',
  );
  process.exit(1);
}
