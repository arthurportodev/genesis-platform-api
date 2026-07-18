import { DataSource } from 'typeorm';
import { seedInitialTenant } from '../src/database/seeds/initial-tenant.seed';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import { createIntegrationDataSource } from './support/integration-data-source';

interface NameRow {
  name: string;
}

interface CountRow {
  count: string;
}

describe('Multi-tenant database integration', () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = createIntegrationDataSource();
    await connection.initialize();
    await connection.dropDatabase();
  });

  afterAll(async () => {
    if (connection.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('migrates an empty database, rolls back, and migrates again', async () => {
    await connection.runMigrations();

    const tables = await connection.query<NameRow[]>(`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('users', 'organizations', 'memberships')
      ORDER BY tablename
    `);
    expect(tables.map((row) => row.name)).toEqual([
      'memberships',
      'organizations',
      'users',
    ]);

    await connection.undoLastMigration();
    const tablesAfterRollback = await connection.query<CountRow[]>(`
      SELECT count(*)::text AS count
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('users', 'organizations', 'memberships')
    `);
    expect(tablesAfterRollback[0]?.count).toBe('0');

    await connection.runMigrations();
    const tablesAfterRerun = await connection.query<CountRow[]>(`
      SELECT count(*)::text AS count
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('users', 'organizations', 'memberships')
    `);
    expect(tablesAfterRerun[0]?.count).toBe('3');
  });

  it('creates enums, foreign keys, unique constraints, and indexes', async () => {
    const enumTypes = await connection.query<NameRow[]>(`
      SELECT typname AS name
      FROM pg_type
      WHERE typname IN (
        'user_status_enum',
        'organization_status_enum',
        'membership_role_enum',
        'membership_status_enum'
      )
      ORDER BY typname
    `);
    expect(enumTypes).toHaveLength(4);

    const constraints = await connection.query<NameRow[]>(`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conname IN (
        'UQ_users_email',
        'UQ_organizations_slug',
        'UQ_memberships_user_organization',
        'FK_memberships_user',
        'FK_memberships_organization'
      )
      ORDER BY conname
    `);
    expect(constraints).toHaveLength(5);

    const indexes = await connection.query<NameRow[]>(`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'IDX_memberships_user_id',
          'IDX_memberships_organization_id',
          'IDX_memberships_organization_status'
        )
      ORDER BY indexname
    `);
    expect(indexes).toHaveLength(3);
  });

  it('enforces email, slug, membership uniqueness, and foreign keys', async () => {
    const users = connection.getRepository(User);
    const organizations = connection.getRepository(Organization);
    const memberships = connection.getRepository(Membership);

    const user = await users.save(
      users.create({
        email: 'constraint@example.com',
        name: 'Constraint User',
        status: UserStatus.ACTIVE,
      }),
    );
    await expect(
      users.save(
        users.create({
          email: user.email,
          name: 'Duplicate User',
          status: UserStatus.ACTIVE,
        }),
      ),
    ).rejects.toThrow();

    const organization = await organizations.save(
      organizations.create({
        name: 'Constraint Organization',
        slug: 'constraint-organization',
        status: OrganizationStatus.ACTIVE,
      }),
    );
    await expect(
      organizations.save(
        organizations.create({
          name: 'Duplicate Organization',
          slug: organization.slug,
          status: OrganizationStatus.ACTIVE,
        }),
      ),
    ).rejects.toThrow();

    const membership = memberships.create({
      userId: user.id,
      organizationId: organization.id,
      role: MembershipRole.MEMBER,
      status: MembershipStatus.ACTIVE,
    });
    await memberships.save(membership);
    await expect(
      memberships.save(
        memberships.create({
          userId: user.id,
          organizationId: organization.id,
          role: MembershipRole.ADMIN,
          status: MembershipStatus.ACTIVE,
        }),
      ),
    ).rejects.toThrow();

    await expect(users.delete(user.id)).rejects.toThrow();
    await expect(organizations.delete(organization.id)).rejects.toThrow();
  });

  it('seeds the initial tenant idempotently', async () => {
    const logger = { log: jest.fn() };
    const firstRun = await seedInitialTenant(connection, logger);
    const secondRun = await seedInitialTenant(connection, logger);

    expect(firstRun).toMatchObject({
      userCreated: true,
      organizationCreated: true,
      membershipCreated: true,
    });
    expect(secondRun).toMatchObject({
      userCreated: false,
      organizationCreated: false,
      membershipCreated: false,
    });

    const user = await connection.getRepository(User).findOneByOrFail({
      email: 'contato@agenciagenesismkt.com.br',
    });
    const organization = await connection
      .getRepository(Organization)
      .findOneByOrFail({ slug: 'agencia-genesis' });
    const memberships = await connection.getRepository(Membership).findBy({
      userId: user.id,
      organizationId: organization.id,
    });

    expect(user).toMatchObject({
      name: 'Arthur Porto',
      status: UserStatus.ACTIVE,
    });
    expect(organization).toMatchObject({
      name: 'Agência Gênesis',
      status: OrganizationStatus.ACTIVE,
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      role: MembershipRole.OWNER,
      status: MembershipStatus.ACTIVE,
    });
  });
});
