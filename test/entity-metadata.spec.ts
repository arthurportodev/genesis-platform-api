import { getMetadataArgsStorage } from 'typeorm';
import { AuthAuditLog } from '../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthRefreshToken } from '../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthRefreshTokenStatus } from '../src/modules/auth-sessions/enums/auth-refresh-token-status.enum';
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
    expect(
      metadata.tables.find((table) => table.target === AuthSession)?.name,
    ).toBe('auth_sessions');
    expect(
      metadata.tables.find((table) => table.target === AuthRefreshToken)?.name,
    ).toBe('auth_refresh_tokens');
    expect(
      metadata.tables.find((table) => table.target === AuthAuditLog)?.name,
    ).toBe('auth_audit_logs');

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

  it('keeps password and refresh hashes out of default selections', () => {
    const passwordHash = metadata.columns.find(
      (column) =>
        column.target === User && column.propertyName === 'passwordHash',
    );
    const refreshTokenHash = metadata.columns.find(
      (column) =>
        column.target === AuthRefreshToken &&
        column.propertyName === 'tokenHash',
    );

    expect(passwordHash?.options).toMatchObject({
      name: 'password_hash',
      nullable: true,
      select: false,
    });
    expect(refreshTokenHash?.options).toMatchObject({
      name: 'token_hash',
      select: false,
    });
    expect(
      metadata.columns.find(
        (column) =>
          column.target === AuthSession &&
          column.propertyName === 'refreshTokenHash',
      ),
    ).toBeUndefined();
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
    const refreshTokenIndexes = metadata.indices.filter(
      (index) => index.target === AuthRefreshToken,
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
    expect(refreshTokenIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'UQ_auth_refresh_tokens_token_hash',
          unique: true,
        }),
        expect.objectContaining({ name: 'IDX_auth_refresh_tokens_session_id' }),
        expect.objectContaining({ name: 'IDX_auth_refresh_tokens_status' }),
        expect.objectContaining({ name: 'IDX_auth_refresh_tokens_expires_at' }),
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

  it('declares required, non-eager refresh-token relations', () => {
    const relations = metadata.relations.filter(
      (relation) => relation.target === AuthRefreshToken,
    );
    const sessionRelation = relations.find(
      (relation) => relation.propertyName === 'session',
    );
    const replacementRelation = relations.find(
      (relation) => relation.propertyName === 'replacedByToken',
    );

    expect(sessionRelation?.options).toMatchObject({
      nullable: false,
      eager: false,
      onDelete: 'RESTRICT',
    });
    expect(replacementRelation?.options).toMatchObject({
      nullable: true,
      eager: false,
      onDelete: 'SET NULL',
    });
  });

  it('exports the expected status and role values', () => {
    expect(Object.values(UserStatus)).toEqual(['active', 'inactive']);
    expect(Object.values(OrganizationStatus)).toEqual(['active', 'inactive']);
    expect(Object.values(MembershipStatus)).toEqual(['active', 'inactive']);
    expect(Object.values(MembershipRole)).toEqual(['owner', 'admin', 'member']);
    expect(Object.values(AuthRefreshTokenStatus)).toEqual([
      'active',
      'consumed',
      'revoked',
    ]);
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
