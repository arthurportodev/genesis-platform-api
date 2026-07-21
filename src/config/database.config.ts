import { registerAs } from '@nestjs/config';

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export function assertRuntimeDatabaseIdentity(
  databaseUser: string | undefined,
  runtimeRole: string | undefined,
): void {
  if (databaseUser !== runtimeRole) {
    throw new Error(
      'DATABASE_USER must equal DATABASE_RUNTIME_ROLE for the API runtime.',
    );
  }
}

export default registerAs('database', (): DatabaseConfig => {
  assertRuntimeDatabaseIdentity(
    process.env.DATABASE_USER,
    process.env.DATABASE_RUNTIME_ROLE,
  );
  return {
    host: process.env.DATABASE_HOST as string,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    name: process.env.DATABASE_NAME as string,
    user: process.env.DATABASE_USER as string,
    password: process.env.DATABASE_PASSWORD as string,
  };
});
