import { lstatSync, readFileSync } from 'node:fs';

export const API_RUNTIME_SECRET_NAMES = [
  'DATABASE_PASSWORD',
  'JWT_ACCESS_SECRET',
  'REFRESH_TOKEN_PEPPER',
  'INVITATION_TOKEN_KEYS',
  'RESEND_API_KEY',
  'LEAD_FORM_KEYS',
  'LEAD_IDEMPOTENCY_KEYS',
] as const;

export const WORKER_RUNTIME_SECRET_NAMES = [
  'DATABASE_PASSWORD',
  'INVITATION_TOKEN_KEYS',
  'RESEND_API_KEY',
] as const;

type Environment = Record<string, unknown>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function removeOneTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, '');
}

export function resolveSecretFiles(
  environment: Environment,
  names: readonly string[],
): Environment {
  const resolved = { ...environment };

  for (const name of names) {
    const fileName = `${name}_FILE`;
    const directValue = nonEmptyString(resolved[name]);
    const secretFile = nonEmptyString(resolved[fileName]);

    if (directValue !== null && secretFile !== null) {
      throw new Error(`${name} and ${fileName} are mutually exclusive.`);
    }

    if (secretFile !== null) {
      try {
        const metadata = lstatSync(secretFile);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error('not a regular file');
        }
        if (metadata.size > 1_048_576) {
          throw new Error('file is too large');
        }
        const value = removeOneTrailingNewline(
          readFileSync(secretFile, { encoding: 'utf8' }),
        );
        resolved[name] = value;
        process.env[name] = value;
      } catch {
        throw new Error(`${name} secret file could not be read.`);
      }
    } else if (directValue !== null) {
      process.env[name] = directValue;
    }

    delete resolved[fileName];
    delete process.env[fileName];
  }

  return resolved;
}
