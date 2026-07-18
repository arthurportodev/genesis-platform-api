import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DatabaseConfig } from '../config/database.config';
import { createBasePostgresOptions } from './typeorm-base.options';

export function createTypeOrmOptions(
  configService: ConfigService,
): TypeOrmModuleOptions {
  const database = configService.getOrThrow<DatabaseConfig>('database');

  return {
    ...createBasePostgresOptions(database),
    autoLoadEntities: true,
    migrationsRun: false,
    retryAttempts: 5,
    retryDelay: 3_000,
  };
}
