export interface PostgresConnectionConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export interface BasePostgresOptions {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  uuidExtension: 'pgcrypto';
  synchronize: false;
}

export function createBasePostgresOptions(
  config: PostgresConnectionConfig,
): BasePostgresOptions {
  return {
    type: 'postgres',
    host: config.host,
    port: config.port,
    database: config.name,
    username: config.user,
    password: config.password,
    uuidExtension: 'pgcrypto',
    synchronize: false,
  };
}
