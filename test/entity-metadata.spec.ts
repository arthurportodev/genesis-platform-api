import { getMetadataArgsStorage } from 'typeorm';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';

describe('Multi-tenant entity metadata', () => {
  const metadata = getMetadataArgsStorage();

  it('maps entities to the expected tables and columns', () => {
    expect(metadata.tables.find((table) => table.target === User)?.name).toBe(
      'users',
    );
    expect(
      metadata.tables.find((table) => table.target === Organization)?.name,
    ).toBe('organizations');
    expect(
      metadata.tables.find((table) => table.target === Membership)?.name,
    ).toBe('memberships');

    const membershipColumns = metadata.columns
      .filter((column) => column.target === Membership)
      .map((column) => column.options.name);
    expect(membershipColumns).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'organization_id',
        'role',
        'status',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('declares unique and query indexes', () => {
    const userIndexes = metadata.indices.filter(
      (index) => index.target === User,
    );
    const organizationIndexes = metadata.indices.filter(
      (index) => index.target === Organization,
    );
    const membershipIndexes = metadata.indices.filter(
      (index) => index.target === Membership,
    );

    expect(userIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'UQ_users_email', unique: true }),
      ]),
    );
    expect(organizationIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'UQ_organizations_slug',
          unique: true,
        }),
      ]),
    );
    expect(membershipIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'UQ_memberships_user_organization',
        'IDX_memberships_user_id',
        'IDX_memberships_organization_id',
        'IDX_memberships_organization_status',
      ]),
    );
  });

  it('declares required, non-eager membership relations', () => {
    const relations = metadata.relations.filter(
      (relation) => relation.target === Membership,
    );

    expect(relations).toHaveLength(2);
    const userRelation = relations.find(
      (relation) => relation.propertyName === 'user',
    );
    const organizationRelation = relations.find(
      (relation) => relation.propertyName === 'organization',
    );

    expect(userRelation?.options).toMatchObject({
      nullable: false,
      eager: false,
      onDelete: 'RESTRICT',
    });
    expect(organizationRelation?.options).toMatchObject({
      nullable: false,
      eager: false,
      onDelete: 'RESTRICT',
    });
  });

  it('exports the expected status and role values', () => {
    expect(Object.values(UserStatus)).toEqual(['active', 'inactive']);
    expect(Object.values(OrganizationStatus)).toEqual(['active', 'inactive']);
    expect(Object.values(MembershipStatus)).toEqual(['active', 'inactive']);
    expect(Object.values(MembershipRole)).toEqual(['owner', 'admin', 'member']);
  });

  it('normalizes user and organization identifiers', () => {
    const user = new User();
    user.email = '  Arthur@Example.COM  ';
    user.name = '  Arthur Porto  ';
    user.normalize();

    const organization = new Organization();
    organization.name = '  Agência Gênesis  ';
    organization.slug = '  Agencia-Genesis  ';
    organization.normalize();

    expect(user.email).toBe('arthur@example.com');
    expect(user.name).toBe('Arthur Porto');
    expect(organization.name).toBe('Agência Gênesis');
    expect(organization.slug).toBe('agencia-genesis');
  });
});
