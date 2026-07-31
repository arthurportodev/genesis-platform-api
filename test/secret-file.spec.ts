import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeOneTrailingNewline,
  resolveSecretFiles,
} from '../src/config/secret-file';

describe('runtime secret files', () => {
  const original = process.env.DATABASE_PASSWORD;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genesis-secret-file-'));
    delete process.env.DATABASE_PASSWORD;
    delete process.env.DATABASE_PASSWORD_FILE;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    if (original === undefined) delete process.env.DATABASE_PASSWORD;
    else process.env.DATABASE_PASSWORD = original;
    delete process.env.DATABASE_PASSWORD_FILE;
  });

  it('reads a regular file and removes exactly one trailing newline', () => {
    const path = join(directory, 'database-password');
    writeFileSync(path, 'synthetic-password\n\n', 'utf8');

    const result = resolveSecretFiles({ DATABASE_PASSWORD_FILE: path }, [
      'DATABASE_PASSWORD',
    ]);

    expect(result.DATABASE_PASSWORD).toBe('synthetic-password\n');
    expect(result).not.toHaveProperty('DATABASE_PASSWORD_FILE');
    expect(process.env.DATABASE_PASSWORD).toBe('synthetic-password\n');
  });

  it('rejects simultaneous direct and file values without exposing the path', () => {
    const path = join(directory, 'sensitive-location');
    writeFileSync(path, 'synthetic-password\n', 'utf8');

    expect(() =>
      resolveSecretFiles(
        {
          DATABASE_PASSWORD: 'direct-value',
          DATABASE_PASSWORD_FILE: path,
        },
        ['DATABASE_PASSWORD'],
      ),
    ).toThrow(
      'DATABASE_PASSWORD and DATABASE_PASSWORD_FILE are mutually exclusive.',
    );
  });

  it('does not include a secret path in read failures', () => {
    const path = join(directory, 'missing-sensitive-location');
    expect(() =>
      resolveSecretFiles({ DATABASE_PASSWORD_FILE: path }, [
        'DATABASE_PASSWORD',
      ]),
    ).toThrow('DATABASE_PASSWORD secret file could not be read.');
    try {
      resolveSecretFiles({ DATABASE_PASSWORD_FILE: path }, [
        'DATABASE_PASSWORD',
      ]);
    } catch (error) {
      expect((error as Error).message).not.toContain(path);
    }
  });

  it('preserves JSON content and removes only a final line ending', () => {
    expect(removeOneTrailingNewline('{\n  "1": "value"\n}\n')).toBe(
      '{\n  "1": "value"\n}',
    );
  });
});
