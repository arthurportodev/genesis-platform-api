import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createBasePostgresOptions } from './typeorm-base.options';

const requiredVariables = [
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_MIGRATION_USER',
  'DATABASE_MIGRATION_PASSWORD',
  'DATABASE_RUNTIME_ROLE',
] as const;

for (const variable of requiredVariables) {
  if (!process.env[variable]) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }
}

export default new DataSource({
  ...createBasePostgresOptions({
    host: process.env.DATABASE_HOST as string,
    port: Number(process.env.DATABASE_PORT),
    name: process.env.DATABASE_NAME as string,
    user: process.env.DATABASE_MIGRATION_USER as string,
    password: process.env.DATABASE_MIGRATION_PASSWORD as string,
  }),
  entities: [`${__dirname}/../**/*.entity{.ts,.js}`],
  migrations: [`${__dirname}/migrations/*{.ts,.js}`],
});
