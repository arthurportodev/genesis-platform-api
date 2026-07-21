import { DataSource } from 'typeorm';
import { CreateMultiTenantCore1784400000000 } from '../../src/database/migrations/1784400000000-CreateMultiTenantCore';
import { CreateAuthSessions1784486400000 } from '../../src/database/migrations/1784486400000-CreateAuthSessions';
import { CreateOrganizationInvitations1785004800000 } from '../../src/database/migrations/1785004800000-CreateOrganizationInvitations';
import { createBasePostgresOptions } from '../../src/database/typeorm-base.options';
import { AuthAuditLog } from '../../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthRefreshToken } from '../../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../../src/modules/auth-sessions/entities/auth-session.entity';
import { Membership } from '../../src/modules/memberships/entities/membership.entity';
import { Organization } from '../../src/modules/organizations/entities/organization.entity';
import { User } from '../../src/modules/users/entities/user.entity';
import { OrganizationInvitation } from '../../src/modules/invitations/entities/organization-invitation.entity';
import { InvitationDeliveryOutbox } from '../../src/modules/invitations/entities/invitation-delivery-outbox.entity';
import { OrganizationCommandIdempotency } from '../../src/modules/invitations/entities/organization-command-idempotency.entity';
import { OrganizationAuditLog } from '../../src/modules/organization-audit/entities/organization-audit-log.entity';

export const INTEGRATION_RUNTIME_PASSWORD = 'runtime-test-only';

const integrationEntities = [
  User,
  Organization,
  Membership,
  AuthSession,
  AuthRefreshToken,
  AuthAuditLog,
  OrganizationInvitation,
  InvitationDeliveryOutbox,
  OrganizationCommandIdempotency,
  OrganizationAuditLog,
];

export function createIntegrationDataSource(): DataSource {
  process.env.DATABASE_RUNTIME_ROLE ??= 'genesis_runtime_test';
  const databaseName =
    process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against unsafe database: ${databaseName}`,
    );
  }

  const dataSource = new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: databaseName,
      user: process.env.TEST_DATABASE_USER ?? 'genesis_test',
      password: process.env.TEST_DATABASE_PASSWORD ?? 'test-only',
    }),
    entities: integrationEntities,
    migrations: [
      CreateMultiTenantCore1784400000000,
      CreateAuthSessions1784486400000,
      CreateOrganizationInvitations1785004800000,
    ],
    migrationsTableName: 'migrations',
    logging: false,
  });
  const typeormDropDatabase = dataSource.dropDatabase.bind(dataSource);
  dataSource.dropDatabase = async (): Promise<void> => {
    const [identity] = await dataSource.query<
      Array<{ currentDatabase: string }>
    >(`SELECT current_database() AS "currentDatabase"`);
    if (
      identity?.currentDatabase !== databaseName ||
      !identity.currentDatabase.endsWith('_test')
    ) {
      throw new Error(
        `Refusing to drop unsafe integration database: ${identity?.currentDatabase ?? 'unknown'}`,
      );
    }

    await typeormDropDatabase();
    await dataSource.query(
      `DROP FUNCTION IF EXISTS app_private.lock_auth_refresh_user(uuid)`,
    );
    await dataSource.query(
      `DROP FUNCTION IF EXISTS app_private.lock_invitation_context(uuid[], uuid[], uuid[])`,
    );
    await dataSource.query(`DROP SCHEMA IF EXISTS app_private`);
    await dataSource.query(
      `DROP FUNCTION IF EXISTS public.reject_organization_audit_mutation()`,
    );
    await dataSource.query(
      `DROP FUNCTION IF EXISTS public.revoke_invitations_for_inactive_membership()`,
    );
    await dataSource.query(
      `DROP FUNCTION IF EXISTS public.revoke_invitations_for_inactive_user()`,
    );
  };
  return dataSource;
}

export function configureIntegrationRuntimeEnvironment(): void {
  process.env.DATABASE_RUNTIME_ROLE ??= 'genesis_runtime_test';
  process.env.DATABASE_USER = process.env.DATABASE_RUNTIME_ROLE;
  process.env.DATABASE_PASSWORD = INTEGRATION_RUNTIME_PASSWORD;
}

export function createIntegrationRuntimeDataSource(): DataSource {
  const databaseName =
    process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run runtime tests against unsafe database: ${databaseName}`,
    );
  }
  const runtimeRole =
    process.env.DATABASE_RUNTIME_ROLE ?? 'genesis_runtime_test';
  return new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: databaseName,
      user: runtimeRole,
      password: INTEGRATION_RUNTIME_PASSWORD,
    }),
    entities: integrationEntities,
    migrations: [],
    logging: false,
  });
}

export async function prepareIntegrationRuntimeRole(
  connection: DataSource,
): Promise<void> {
  const role = process.env.DATABASE_RUNTIME_ROLE ?? 'genesis_runtime_test';
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(role)) {
    throw new Error('Unsafe integration runtime role name.');
  }
  const rows = await connection.query<Array<{ exists: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS "exists"`,
    [role],
  );
  const command = rows[0]?.exists ? 'ALTER ROLE' : 'CREATE ROLE';
  await connection.query(
    `${command} "${role}" LOGIN PASSWORD '${INTEGRATION_RUNTIME_PASSWORD}'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
}
