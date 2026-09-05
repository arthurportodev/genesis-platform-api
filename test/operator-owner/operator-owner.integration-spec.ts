import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ActivateNewInvitationUser1785174000000 } from '../../src/database/migrations/1785174000000-ActivateNewInvitationUser';
import { AddLeadOperationalReadIndexes1785606000000 } from '../../src/database/migrations/1785606000000-AddLeadOperationalReadIndexes';
import { CreateAuthSessions1784486400000 } from '../../src/database/migrations/1784486400000-CreateAuthSessions';
import { CreateLeadFoundation1785346800000 } from '../../src/database/migrations/1785346800000-CreateLeadFoundation';
import { CreateMultiTenantCore1784400000000 } from '../../src/database/migrations/1784400000000-CreateMultiTenantCore';
import { CreateOrganizationInvitations1785004800000 } from '../../src/database/migrations/1785004800000-CreateOrganizationInvitations';
import { DeliverInvitationAcceptance1785087600000 } from '../../src/database/migrations/1785087600000-DeliverInvitationAcceptance';
import { ManageLeadActivitiesFollowUp1785519600000 } from '../../src/database/migrations/1785519600000-ManageLeadActivitiesFollowUp';
import { ManageLeadCommercialPipeline1785433200000 } from '../../src/database/migrations/1785433200000-ManageLeadCommercialPipeline';
import { ManageMembershipOwnership1785260400000 } from '../../src/database/migrations/1785260400000-ManageMembershipOwnership';
import {
  OperatorOwnerError,
  prepareOperatorOwnerIdentity,
} from '../../src/database/operator-owner/operator-owner.model';
import {
  assertOperatorOwnerOperationalRole,
  OperatorOwnerService,
} from '../../src/database/operator-owner/operator-owner.service';
import { createBasePostgresOptions } from '../../src/database/typeorm-base.options';
import { verifyPassword } from '../../src/modules/credentials/password-policy';
import { prepareIntegrationRuntimeRole } from '../support/integration-data-source';

jest.setTimeout(120_000);

const MIGRATION_ROLE = 'genesis_migration_owner_test';
const MIGRATION_PASSWORD = 'migration-owner-test-only';

describe('private operator OWNER database integration', () => {
  let bootstrap: DataSource;
  let owner: DataSource;

  beforeAll(async () => {
    process.env.DATABASE_RUNTIME_ROLE = 'genesis_runtime_test';
    bootstrap = createBootstrapDataSource();
    await bootstrap.initialize();
    await resetDisposableDatabase(bootstrap);
    await prepareIntegrationRuntimeRole(bootstrap);
    await prepareMigrationOwner(bootstrap);
    owner = createOwnerDataSource();
    await owner.initialize();
    await owner.runMigrations();
  });

  afterAll(async () => {
    if (owner?.isInitialized) {
      await resetDisposableDatabase(owner);
      await owner.destroy();
    }
    if (bootstrap?.isInitialized) {
      await restoreBootstrapOwnership(bootstrap);
      await bootstrap.destroy();
    }
  });

  beforeEach(async () => {
    await resetDisposableDatabase(owner);
    await owner.runMigrations();
  });

  it('creates exactly one active OWNER atomically with a login-compatible hash and zero operational data', async () => {
    await expect(
      assertOperatorOwnerOperationalRole(owner),
    ).resolves.toBeUndefined();
    await expect(
      assertOperatorOwnerOperationalRole(bootstrap),
    ).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });

    const identity = identityFor('success');
    const passwordText = 'correct-test-password-10A';
    const password = Buffer.from(passwordText);
    const service = new OperatorOwnerService(owner);
    const result = await service.create(identity, password);

    expect(result).toMatchObject({
      status: 'CREATED',
      organization: identity.organizationName,
      organizationSlug: identity.organizationSlug,
      emailNormalized: identity.emailNormalized,
      role: 'OWNER',
      organizationActive: true,
      userActive: true,
      membershipActive: true,
      initialLeads: 0,
      initialSessions: 0,
      initialRefreshTokens: 0,
    });
    expect([...password]).toEqual(new Array(password.length).fill(0));
    expect(JSON.stringify(result)).not.toContain(passwordText);
    expect(JSON.stringify(result)).not.toMatch(
      /\$argon|passwordHash|tokenHash/iu,
    );

    const [credential] = await owner.query<Array<{ passwordHash: string }>>(
      `SELECT password_hash AS "passwordHash" FROM public.users WHERE id=$1`,
      [result.userId],
    );
    expect(credential?.passwordHash).toMatch(/^\$argon2id\$/u);
    await expect(
      verifyPassword(credential?.passwordHash ?? '', passwordText),
    ).resolves.toBe(true);

    await expect(
      service.status({
        organizationId: result.organizationId,
        userId: result.userId,
        membershipId: result.membershipId,
      }),
    ).resolves.toMatchObject({
      status: 'READY',
      invariantsValid: true,
      role: 'OWNER',
      organizationActive: true,
      userActive: true,
      membershipActive: true,
      leads: 0,
      sessions: 0,
      refreshTokens: 0,
      effectiveOwners: 1,
      issues: [],
    });
    await expect(readCardinality(owner)).resolves.toEqual({
      organizations: 1,
      users: 1,
      memberships: 1,
      leads: 0,
      sessions: 0,
      refreshTokens: 0,
    });
  });

  it('rejects duplicate email case-insensitively and duplicate organization/slug without partial creation', async () => {
    const service = new OperatorOwnerService(owner);
    const firstIdentity = identityFor('duplicate');
    const first = await service.create(
      firstIdentity,
      Buffer.from('correct-test-password-10A'),
    );
    const baseline = await readCardinality(owner);

    const duplicateEmail = prepareOperatorOwnerIdentity({
      organizationName: 'Different Organization 10A',
      ownerName: 'Different Owner',
      email: firstIdentity.emailNormalized.toUpperCase(),
    });
    await expect(
      service.create(duplicateEmail, Buffer.from('correct-test-password-10A')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const duplicateOrganization = prepareOperatorOwnerIdentity({
      organizationName: firstIdentity.organizationName.toUpperCase(),
      ownerName: 'Another Owner',
      email: `another-${randomUUID()}@example.invalid`,
    });
    await expect(
      service.create(
        duplicateOrganization,
        Buffer.from('correct-test-password-10A'),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readCardinality(owner)).toEqual(baseline);
    await expect(
      service.status({
        organizationId: first.organizationId,
        userId: first.userId,
        membershipId: first.membershipId,
      }),
    ).resolves.toMatchObject({ status: 'READY' });
  });

  it.each(['user_created', 'membership_created'] as const)(
    'rolls back organization, User and Membership when %s fails',
    async (failingStep) => {
      const service = new OperatorOwnerService(owner, {
        afterStep: (step) => {
          if (step === failingStep)
            throw new Error('injected database failure');
          return Promise.resolve();
        },
      });
      const passwordText = 'rollback-test-password-10A';
      const password = Buffer.from(passwordText);
      let failure: unknown;
      try {
        await service.create(identityFor(failingStep), password);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OperatorOwnerError);
      expect(failure).toMatchObject({ code: 'UNEXPECTED_FAILURE' });
      expect(JSON.stringify(failure)).not.toContain(passwordText);
      expect([...password]).toEqual(new Array(password.length).fill(0));
      await expect(readCardinality(owner)).resolves.toEqual({
        organizations: 0,
        users: 0,
        memberships: 0,
        leads: 0,
        sessions: 0,
        refreshTokens: 0,
      });
    },
  );

  it('rejects an invalid password before touching the database', async () => {
    const password = Buffer.from('short');
    await expect(
      new OperatorOwnerService(owner).create(identityFor('password'), password),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    expect([...password]).toEqual(new Array(password.length).fill(0));
    await expect(readCardinality(owner)).resolves.toMatchObject({
      organizations: 0,
      users: 0,
      memberships: 0,
    });
  });

  it('serializes simultaneous equal identities so exactly one creation can commit', async () => {
    const identity = identityFor('concurrent');
    const attempts = await Promise.allSettled([
      new OperatorOwnerService(owner).create(
        identity,
        Buffer.from('concurrent-test-password-10A'),
      ),
      new OperatorOwnerService(owner).create(
        identity,
        Buffer.from('concurrent-test-password-10A'),
      ),
    ]);
    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    const reason: unknown =
      rejected?.status === 'rejected' ? rejected.reason : undefined;
    expect(reason).toBeInstanceOf(OperatorOwnerError);
    expect(reason).toMatchObject({ code: 'CONFLICT' });
    await expect(readCardinality(owner)).resolves.toMatchObject({
      organizations: 1,
      users: 1,
      memberships: 1,
    });
  });

  it('status reads only the three explicitly supplied identifiers', async () => {
    const created = await new OperatorOwnerService(owner).create(
      identityFor('scoped'),
      Buffer.from('scoped-test-password-10A'),
    );
    const unrelatedId = randomUUID();
    const status = await new OperatorOwnerService(owner).status({
      organizationId: created.organizationId,
      userId: unrelatedId,
      membershipId: created.membershipId,
    });
    expect(status).toMatchObject({
      status: 'NOT_FOUND',
      organizationId: created.organizationId,
      userId: unrelatedId,
      membershipId: created.membershipId,
      invariantsValid: false,
      issues: ['TARGET_NOT_FOUND'],
    });
    expect(status).not.toHaveProperty('emailNormalized');
    expect(status).not.toHaveProperty('organization');
  });

  it('resolves one exact OWNER identity without modifying any database row', async () => {
    const service = new OperatorOwnerService(owner);
    const identity = identityFor('resolve');
    const created = await service.create(
      identity,
      Buffer.from('resolve-test-password-10A'),
    );
    const before = await readDatabaseState(owner);

    await expect(
      service.resolve({
        emailNormalized: identity.emailNormalized,
        organizationSlug: identity.organizationSlug,
      }),
    ).resolves.toEqual({
      status: 'RESOLVED',
      organizationId: created.organizationId,
      userId: created.userId,
      membershipId: created.membershipId,
      organization: identity.organizationName,
      organizationSlug: identity.organizationSlug,
      emailNormalized: identity.emailNormalized,
      role: 'OWNER',
      organizationActive: true,
      userActive: true,
      membershipActive: true,
    });

    expect(await readDatabaseState(owner)).toEqual(before);
    await expect(
      service.status({
        organizationId: created.organizationId,
        userId: created.userId,
        membershipId: created.membershipId,
      }),
    ).resolves.toMatchObject({
      status: 'READY',
      sessions: 0,
      refreshTokens: 0,
      leads: 0,
    });
  });

  it('fails closed for missing and mismatched recovery keys without changing data', async () => {
    const service = new OperatorOwnerService(owner);
    const firstIdentity = identityFor('resolve-first');
    const secondIdentity = identityFor('resolve-second');
    await service.create(
      firstIdentity,
      Buffer.from('resolve-first-password-10A'),
    );
    await service.create(
      secondIdentity,
      Buffer.from('resolve-second-password-10A'),
    );
    const before = await readDatabaseState(owner);

    await expect(
      service.resolve({
        emailNormalized: 'missing@example.invalid',
        organizationSlug: firstIdentity.organizationSlug,
      }),
    ).resolves.toEqual({ status: 'NOT_FOUND' });
    await expect(
      service.resolve({
        emailNormalized: firstIdentity.emailNormalized,
        organizationSlug: secondIdentity.organizationSlug,
      }),
    ).resolves.toEqual({ status: 'NOT_FOUND' });

    expect(await readDatabaseState(owner)).toEqual(before);
  });
});

function identityFor(label: string) {
  const suffix = randomUUID();
  return prepareOperatorOwnerIdentity({
    organizationName: `Production ${label} ${suffix}`,
    ownerName: `Owner ${label}`,
    email: `${label}-${suffix}@example.invalid`,
  });
}

async function readCardinality(connection: DataSource): Promise<{
  organizations: number;
  users: number;
  memberships: number;
  leads: number;
  sessions: number;
  refreshTokens: number;
}> {
  const [row] = await connection.query<
    Array<{
      organizations: number;
      users: number;
      memberships: number;
      leads: number;
      sessions: number;
      refreshTokens: number;
    }>
  >(
    `SELECT
       (SELECT count(*)::int FROM public.organizations) AS organizations,
       (SELECT count(*)::int FROM public.users) AS users,
       (SELECT count(*)::int FROM public.memberships) AS memberships,
       (SELECT count(*)::int FROM public.leads) AS leads,
       (SELECT count(*)::int FROM public.auth_sessions) AS sessions,
       (SELECT count(*)::int FROM public.auth_refresh_tokens) AS "refreshTokens"`,
  );
  if (row === undefined) throw new Error('Missing cardinality evidence.');
  return row;
}

async function readDatabaseState(connection: DataSource): Promise<unknown> {
  const [row] = await connection.query<Array<{ state: unknown }>>(
    `SELECT jsonb_build_object(
       'organizations', (SELECT coalesce(jsonb_agg(to_jsonb(record) ORDER BY record.id), '[]'::jsonb) FROM public.organizations record),
       'users', (SELECT coalesce(jsonb_agg(to_jsonb(record) ORDER BY record.id), '[]'::jsonb) FROM public.users record),
       'memberships', (SELECT coalesce(jsonb_agg(to_jsonb(record) ORDER BY record.id), '[]'::jsonb) FROM public.memberships record),
       'sessions', (SELECT coalesce(jsonb_agg(to_jsonb(record) ORDER BY record.id), '[]'::jsonb) FROM public.auth_sessions record),
       'refreshTokens', (SELECT coalesce(jsonb_agg(to_jsonb(record) ORDER BY record.id), '[]'::jsonb) FROM public.auth_refresh_tokens record),
       'leads', (SELECT coalesce(jsonb_agg(to_jsonb(record) ORDER BY record.id), '[]'::jsonb) FROM public.leads record)
     ) AS state`,
  );
  if (row === undefined) throw new Error('Missing read-only state evidence.');
  return row.state;
}

function createOwnerDataSource(): DataSource {
  return new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test',
      user: MIGRATION_ROLE,
      password: MIGRATION_PASSWORD,
    }),
    applicationName: 'operator-owner-migration-owner',
    entities: [],
    migrations: [
      CreateMultiTenantCore1784400000000,
      CreateAuthSessions1784486400000,
      CreateOrganizationInvitations1785004800000,
      DeliverInvitationAcceptance1785087600000,
      ActivateNewInvitationUser1785174000000,
      ManageMembershipOwnership1785260400000,
      CreateLeadFoundation1785346800000,
      ManageLeadCommercialPipeline1785433200000,
      ManageLeadActivitiesFollowUp1785519600000,
      AddLeadOperationalReadIndexes1785606000000,
    ],
    migrationsTableName: 'migrations',
    logging: false,
  });
}

function createBootstrapDataSource(): DataSource {
  return new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test',
      user: process.env.TEST_DATABASE_USER ?? 'genesis_test',
      password: process.env.TEST_DATABASE_PASSWORD ?? 'test-only',
    }),
    applicationName: 'operator-owner-bootstrap',
  });
}

async function prepareMigrationOwner(connection: DataSource): Promise<void> {
  const database = process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
  if (!database.endsWith('_test')) throw new Error('Unsafe test database.');
  const [{ exists }] = await connection.query<Array<{ exists: boolean }>>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists',
    [MIGRATION_ROLE],
  );
  await connection.query(
    `${exists ? 'ALTER' : 'CREATE'} ROLE "${MIGRATION_ROLE}"
     LOGIN PASSWORD '${MIGRATION_PASSWORD}' NOSUPERUSER NOCREATEDB
     NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await connection.query(
    `ALTER DATABASE "${database}" OWNER TO "${MIGRATION_ROLE}"`,
  );
  await connection.query(`ALTER SCHEMA public OWNER TO "${MIGRATION_ROLE}"`);
  await connection.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await connection.query(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${database}" TO "${MIGRATION_ROLE}"`,
  );
  await connection.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO "${MIGRATION_ROLE}"`,
  );
}

async function restoreBootstrapOwnership(
  connection: DataSource,
): Promise<void> {
  const database = process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
  const bootstrapRole = process.env.TEST_DATABASE_USER ?? 'genesis_test';
  await connection.query(`ALTER SCHEMA public OWNER TO "${bootstrapRole}"`);
  await connection.query(
    `ALTER DATABASE "${database}" OWNER TO "${bootstrapRole}"`,
  );
}

async function resetDisposableDatabase(connection: DataSource): Promise<void> {
  const [identity] = await connection.query<Array<{ name: string }>>(
    'SELECT current_database() AS name',
  );
  if (identity?.name === undefined || !identity.name.endsWith('_test')) {
    throw new Error('Refusing to reset a non-test database.');
  }
  await connection.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await connection.query('DROP SCHEMA IF EXISTS public CASCADE');
  await connection.query('CREATE SCHEMA public');
}
