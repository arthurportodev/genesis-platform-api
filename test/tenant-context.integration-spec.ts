import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { TenantContextService } from '../src/modules/tenant-context/services/tenant-context.service';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('TenantContextService integration', () => {
  let connection: DataSource;
  let service: TenantContextService;
  let firstUser: User;
  let secondUser: User;
  let guardianUser: User;
  let primaryOrganization: Organization;
  let secondaryOrganization: Organization;
  let inactiveOrganization: Organization;
  let inactiveMembershipOrganization: Organization;
  let noMembershipOrganization: Organization;
  let otherUserOrganization: Organization;
  let primaryMembership: Membership;
  let secondaryMembership: Membership;

  beforeAll(async () => {
    connection = createIntegrationDataSource();
    await connection.initialize();
    await prepareIntegrationRuntimeRole(connection);
    await connection.dropDatabase();
    await connection.runMigrations();

    const users = connection.getRepository(User);
    [firstUser, secondUser, guardianUser] = await users.save([
      users.create({
        email: 'tenant-first@example.com',
        name: 'Tenant First',
        status: UserStatus.ACTIVE,
      }),
      users.create({
        email: 'tenant-second@example.com',
        name: 'Tenant Second',
        status: UserStatus.ACTIVE,
      }),
      users.create({
        email: 'tenant-guardian@example.com',
        name: 'Tenant Guardian',
        status: UserStatus.ACTIVE,
      }),
    ]);

    await connection.transaction(async (manager) => {
      const organizations = manager.getRepository(Organization);
      [
        primaryOrganization,
        secondaryOrganization,
        inactiveOrganization,
        inactiveMembershipOrganization,
        noMembershipOrganization,
        otherUserOrganization,
      ] = await organizations.save([
        organizations.create({
          name: 'Primary Organization',
          slug: 'tenant-primary',
          status: OrganizationStatus.ACTIVE,
        }),
        organizations.create({
          name: 'Secondary Organization',
          slug: 'tenant-secondary',
          status: OrganizationStatus.ACTIVE,
        }),
        organizations.create({
          name: 'Inactive Organization',
          slug: 'tenant-inactive-organization',
          status: OrganizationStatus.INACTIVE,
        }),
        organizations.create({
          name: 'Inactive Membership Organization',
          slug: 'tenant-inactive-membership',
          status: OrganizationStatus.ACTIVE,
        }),
        organizations.create({
          name: 'No Membership Organization',
          slug: 'tenant-no-membership',
          status: OrganizationStatus.ACTIVE,
        }),
        organizations.create({
          name: 'Other User Organization',
          slug: 'tenant-other-user',
          status: OrganizationStatus.ACTIVE,
        }),
      ]);

      const memberships = manager.getRepository(Membership);
      [primaryMembership, secondaryMembership] = await memberships.save([
        memberships.create({
          userId: firstUser.id,
          organizationId: primaryOrganization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        }),
        memberships.create({
          userId: firstUser.id,
          organizationId: secondaryOrganization.id,
          role: MembershipRole.MEMBER,
          status: MembershipStatus.ACTIVE,
        }),
        memberships.create({
          userId: firstUser.id,
          organizationId: inactiveOrganization.id,
          role: MembershipRole.ADMIN,
          status: MembershipStatus.ACTIVE,
        }),
        memberships.create({
          userId: firstUser.id,
          organizationId: inactiveMembershipOrganization.id,
          role: MembershipRole.ADMIN,
          status: MembershipStatus.INACTIVE,
        }),
        memberships.create({
          userId: secondUser.id,
          organizationId: otherUserOrganization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        }),
        memberships.create({
          userId: guardianUser.id,
          organizationId: primaryOrganization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        }),
        memberships.create({
          userId: guardianUser.id,
          organizationId: secondaryOrganization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        }),
        memberships.create({
          userId: guardianUser.id,
          organizationId: inactiveMembershipOrganization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        }),
        memberships.create({
          userId: guardianUser.id,
          organizationId: noMembershipOrganization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        }),
      ]);
    });
    const memberships = connection.getRepository(Membership);
    service = new TenantContextService(memberships);
  });

  afterAll(async () => {
    if (connection.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('resolves active membership and organization with persisted identifiers', async () => {
    await expect(
      service.resolve(firstUser.id, primaryOrganization.id),
    ).resolves.toEqual({
      userId: firstUser.id,
      organizationId: primaryOrganization.id,
      membershipId: primaryMembership.id,
      role: MembershipRole.OWNER,
    });
  });

  it('rejects inactive membership and inactive organization', async () => {
    await expect(
      service.resolve(firstUser.id, inactiveMembershipOrganization.id),
    ).resolves.toBeNull();
    await expect(
      service.resolve(firstUser.id, inactiveOrganization.id),
    ).resolves.toBeNull();
  });

  it('does not grant access without the exact user and organization membership', async () => {
    await expect(
      service.resolve(firstUser.id, noMembershipOrganization.id),
    ).resolves.toBeNull();
    await expect(
      service.resolve(firstUser.id, otherUserOrganization.id),
    ).resolves.toBeNull();
    await expect(
      service.resolve(secondUser.id, primaryOrganization.id),
    ).resolves.toBeNull();
    await expect(
      service.resolve(firstUser.id, randomUUID()),
    ).resolves.toBeNull();
  });

  it('resolves different organizations for the same user', async () => {
    const primary = await service.resolve(firstUser.id, primaryOrganization.id);
    const secondary = await service.resolve(
      firstUser.id,
      secondaryOrganization.id,
    );

    expect(primary).toMatchObject({
      membershipId: primaryMembership.id,
      role: MembershipRole.OWNER,
    });
    expect(secondary).toMatchObject({
      membershipId: secondaryMembership.id,
      role: MembershipRole.MEMBER,
    });
  });

  it('uses the current role from the database on every resolution', async () => {
    await connection
      .getRepository(Membership)
      .update(primaryMembership.id, { role: MembershipRole.ADMIN });

    await expect(
      service.resolve(firstUser.id, primaryOrganization.id),
    ).resolves.toMatchObject({ role: MembershipRole.ADMIN });

    await connection
      .getRepository(Membership)
      .update(primaryMembership.id, { role: MembershipRole.OWNER });
  });

  it('blocks the next resolution after membership deactivation', async () => {
    await connection
      .getRepository(Membership)
      .update(secondaryMembership.id, { status: MembershipStatus.INACTIVE });

    await expect(
      service.resolve(firstUser.id, secondaryOrganization.id),
    ).resolves.toBeNull();

    await connection
      .getRepository(Membership)
      .update(secondaryMembership.id, { status: MembershipStatus.ACTIVE });
  });

  it('blocks the next resolution after organization deactivation', async () => {
    await connection
      .getRepository(Organization)
      .update(primaryOrganization.id, { status: OrganizationStatus.INACTIVE });

    await expect(
      service.resolve(firstUser.id, primaryOrganization.id),
    ).resolves.toBeNull();

    await connection
      .getRepository(Organization)
      .update(primaryOrganization.id, { status: OrganizationStatus.ACTIVE });
  });
});
