import { DataSource } from 'typeorm';
import { CreateMultiTenantCore1784400000000 } from '../../src/database/migrations/1784400000000-CreateMultiTenantCore';
import { createBasePostgresOptions } from '../../src/database/typeorm-base.options';
import { Membership } from '../../src/modules/memberships/entities/membership.entity';
import { Organization } from '../../src/modules/organizations/entities/organization.entity';
import { User } from '../../src/modules/users/entities/user.entity';

export function createIntegrationDataSource(): DataSource {
  const databaseName =
    process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against unsafe database: ${databaseName}`,
    );
  }

  return new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: databaseName,
      user: process.env.TEST_DATABASE_USER ?? 'genesis_test',
      password: process.env.TEST_DATABASE_PASSWORD ?? 'test-only',
    }),
    entities: [User, Organization, Membership],
    migrations: [CreateMultiTenantCore1784400000000],
    migrationsTableName: 'migrations',
    logging: false,
  });
}
