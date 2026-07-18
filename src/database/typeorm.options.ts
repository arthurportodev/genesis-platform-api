import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DatabaseConfig } from '../config/database.config';

export function createTypeOrmOptions(
  configService: ConfigService,
): TypeOrmModuleOptions {
  const database = configService.getOrThrow<DatabaseConfig>('database');

  return {
    type: 'postgres',
    host: database.host,
    port: database.port,
    database: database.name,
    username: database.user,
    password: database.password,
    autoLoadEntities: true,
    synchronize: false,
    migrationsRun: false,
    retryAttempts: 5,
    retryDelay: 3_000,
  };
}
