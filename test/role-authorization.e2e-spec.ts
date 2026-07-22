import {
  Controller,
  Get,
  INestApplication,
  Module,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { configureTrustProxy } from '../src/config/trust-proxy';
import { seedInitialTenant } from '../src/database/seeds/initial-tenant.seed';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AuthTokenResponse } from '../src/modules/auth/auth.service';
import { AccessTokenGuard } from '../src/modules/auth/guards/access-token.guard';
import { AuthorizationModule } from '../src/modules/authorization/authorization.module';
import { Roles } from '../src/modules/authorization/decorators/roles.decorator';
import { RoleGuard } from '../src/modules/authorization/guards/role.guard';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { TenantContextGuard } from '../src/modules/tenant-context/guards/tenant-context.guard';
import { TenantContextModule } from '../src/modules/tenant-context/tenant-context.module';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

@Controller('test/role-authorization')
@UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
@Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
class RoleAuthorizationTestController {
  @Get('owner-only')
  @Roles(MembershipRole.OWNER)
  ownerOnly(): { authorized: true } {
    return { authorized: true };
  }

  @Get('owner-admin')
  ownerOrAdmin(): { authorized: true } {
    return { authorized: true };
  }

  @Get('member')
  @Roles(MembershipRole.MEMBER)
  member(): { authorized: true } {
    return { authorized: true };
  }
}

@Module({
  imports: [AuthModule, TenantContextModule, AuthorizationModule],
  controllers: [RoleAuthorizationTestController],
})
class RoleAuthorizationConsumerTestModule {}

describe('Role authorization (e2e)', () => {
  let app: INestApplication;
  let connection: DataSource;
  let accessToken: string;
  let user: User;
  let ownerOrganization: Organization;
  let adminOrganization: Organization;
  let memberOrganization: Organization;
  let inactiveOrganization: Organization;
  let noMembershipOrganization: Organization;
  let inactiveMembershipOrganization: Organization;
  let adminMembership: Membership;
  let memberMembership: Membership;
  const initialOwnerPassword = randomBytes(24).toString('base64url');
  const ownerEmail = 'contato@agenciagenesismkt.com.br';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.APP_NAME = 'Genesis Platform API';
    process.env.APP_VERSION = '0.1.0';
    process.env.DATABASE_HOST = process.env.TEST_DATABASE_HOST ?? 'localhost';
    process.env.DATABASE_PORT = process.env.TEST_DATABASE_PORT ?? '5433';
    process.env.DATABASE_NAME =
      process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
    configureIntegrationRuntimeEnvironment();
    process.env.FRONTEND_URL = 'http://localhost:5173';
    process.env.TRUST_PROXY_HOPS = '0';
    process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64url');
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS = '30';
    process.env.REFRESH_TOKEN_PEPPER = randomBytes(48).toString('base64url');
    process.env.AUTH_LOGIN_MAX_ATTEMPTS = '10';
    process.env.AUTH_LOGIN_IP_MAX_ATTEMPTS = '50';
    process.env.AUTH_LOGIN_MAX_BUCKETS = '100';
    process.env.AUTH_LOGIN_WINDOW_SECONDS = '900';

    connection = createIntegrationDataSource();
    await connection.initialize();
    await prepareIntegrationRuntimeRole(connection);
    await connection.dropDatabase();
    await connection.runMigrations();
    await seedInitialTenant(
      connection,
      { log: jest.fn() },
      { initialOwnerPassword },
    );
    await createRoleFixtures();

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, RoleAuthorizationConsumerTestModule],
    }).compile();
    const expressApp =
      moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(expressApp, 0);
    app = expressApp;
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    accessToken = ((await login()).body as AuthTokenResponse).accessToken;
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    if (connection.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('requires valid authentication before tenant and role resolution', async () => {
    const missing = await roleRequest(
      'owner-only',
      ownerOrganization.id,
    ).expect(401);
    const invalid = await roleRequest(
      'owner-only',
      ownerOrganization.id,
      'invalid-token',
    ).expect(401);

    expect(missing.body).toMatchObject({
      statusCode: 401,
      message: 'Invalid access token.',
    });
    expect(invalid.body).toEqual(missing.body);
  });

  it('validates the organization header before role authorization', async () => {
    const missing = await request(app.getHttpServer() as Server)
      .get('/api/v1/test/role-authorization/owner-only')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
    const malformed = await roleRequest(
      'owner-only',
      'not-a-uuid',
      accessToken,
    ).expect(400);

    expect(missing.body).toMatchObject({
      statusCode: 400,
      message: 'Invalid organization context.',
    });
    expect(malformed.body).toEqual(missing.body);
  });

  it('denies unavailable organizations and memberships before role authorization', async () => {
    for (const organizationId of [
      randomUUID(),
      inactiveOrganization.id,
      noMembershipOrganization.id,
      inactiveMembershipOrganization.id,
    ]) {
      const response = await roleRequest(
        'owner-only',
        organizationId,
        accessToken,
      ).expect(403);
      expectGenericDenial(response.body);
    }
  });

  it('allows an owner on an owner-only route', async () => {
    await roleRequest('owner-only', ownerOrganization.id, accessToken)
      .expect(200)
      .expect({ authorized: true });
  });

  it('denies an admin on owner-only and allows it on owner/admin', async () => {
    const denied = await roleRequest(
      'owner-only',
      adminOrganization.id,
      accessToken,
    ).expect(403);
    expectGenericDenial(denied.body);

    await roleRequest('owner-admin', adminOrganization.id, accessToken)
      .expect(200)
      .expect({ authorized: true });
  });

  it('denies a member on owner/admin and allows it when explicitly listed', async () => {
    const denied = await roleRequest(
      'owner-admin',
      memberOrganization.id,
      accessToken,
    ).expect(403);
    expectGenericDenial(denied.body);

    await roleRequest('member', memberOrganization.id, accessToken)
      .expect(200)
      .expect({ authorized: true });
  });

  it('lets handler metadata override controller metadata', async () => {
    await roleRequest('member', memberOrganization.id, accessToken).expect(200);
    const ownerDenied = await roleRequest(
      'member',
      ownerOrganization.id,
      accessToken,
    ).expect(403);
    expectGenericDenial(ownerDenied.body);
  });

  it('uses owner, admin, and member roles from three organizations with one token', async () => {
    await roleRequest('owner-only', ownerOrganization.id, accessToken).expect(
      200,
    );
    await roleRequest('owner-admin', adminOrganization.id, accessToken).expect(
      200,
    );
    await roleRequest('member', memberOrganization.id, accessToken).expect(200);
  });

  it('reflects a database role change without issuing a new token', async () => {
    await connection
      .getRepository(Membership)
      .update(adminMembership.id, { role: MembershipRole.MEMBER });

    await roleRequest('owner-admin', adminOrganization.id, accessToken).expect(
      403,
    );
    await roleRequest('member', adminOrganization.id, accessToken).expect(200);

    await connection
      .getRepository(Membership)
      .update(adminMembership.id, { role: MembershipRole.ADMIN });
  });

  it('blocks a deactivated membership before role authorization', async () => {
    await connection
      .getRepository(Membership)
      .update(memberMembership.id, { status: MembershipStatus.INACTIVE });

    const response = await roleRequest(
      'member',
      memberOrganization.id,
      accessToken,
    ).expect(403);
    expectGenericDenial(response.body);

    await connection
      .getRepository(Membership)
      .update(memberMembership.id, { status: MembershipStatus.ACTIVE });
  });

  it('keeps authentication endpoints independent from tenant and role', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await login();
  });

  it('does not expose roles, organization, membership, or policy in a denial', async () => {
    const response = await roleRequest(
      'owner-only',
      adminOrganization.id,
      accessToken,
    ).expect(403);
    const serialized = JSON.stringify(response.body);

    expect(response.body).toEqual({
      statusCode: 403,
      message: 'Organization access denied.',
      error: 'Forbidden',
    });
    for (const sensitiveValue of [
      MembershipRole.OWNER,
      MembershipRole.ADMIN,
      MembershipRole.MEMBER,
      adminOrganization.id,
      adminOrganization.name,
      adminMembership.id,
      'authorization:roles',
      'permissions',
    ]) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });

  async function createRoleFixtures(): Promise<void> {
    user = await connection.getRepository(User).findOneByOrFail({
      email: ownerEmail,
    });
    const organizations = connection.getRepository(Organization);
    ownerOrganization = await organizations.findOneByOrFail({
      slug: 'agencia-genesis',
    });
    adminOrganization = await createActiveOrganization(
      'Role Admin Organization',
      'role-admin-organization',
    );
    memberOrganization = await createActiveOrganization(
      'Role Member Organization',
      'role-member-organization',
    );
    noMembershipOrganization = await createActiveOrganization(
      'Role No Membership Organization',
      'role-no-membership-organization',
    );
    inactiveMembershipOrganization = await createActiveOrganization(
      'Role Inactive Membership Organization',
      'role-inactive-membership-organization',
    );
    inactiveOrganization = await organizations.save(
      organizations.create({
        name: 'Role Inactive Organization',
        slug: 'role-inactive-organization',
        status: OrganizationStatus.INACTIVE,
      }),
    );

    const memberships = connection.getRepository(Membership);
    await memberships.findOneByOrFail({
      userId: user.id,
      organizationId: ownerOrganization.id,
    });
    [adminMembership, memberMembership] = await memberships.save([
      memberships.create({
        userId: user.id,
        organizationId: adminOrganization.id,
        role: MembershipRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
      memberships.create({
        userId: user.id,
        organizationId: memberOrganization.id,
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
      }),
      memberships.create({
        userId: user.id,
        organizationId: inactiveOrganization.id,
        role: MembershipRole.OWNER,
        status: MembershipStatus.ACTIVE,
      }),
      memberships.create({
        userId: user.id,
        organizationId: inactiveMembershipOrganization.id,
        role: MembershipRole.OWNER,
        status: MembershipStatus.INACTIVE,
      }),
    ]);
  }

  async function createActiveOrganization(
    name: string,
    slug: string,
  ): Promise<Organization> {
    return connection.transaction(async (manager) => {
      const guardian = await manager.getRepository(User).save({
        email: `guardian-${slug}-${randomUUID()}@example.com`,
        name: `Guardian ${name}`,
        status: UserStatus.ACTIVE,
      });
      const organization = await manager.getRepository(Organization).save({
        name,
        slug,
        status: OrganizationStatus.ACTIVE,
      });
      await manager.getRepository(Membership).save({
        userId: guardian.id,
        organizationId: organization.id,
        role: MembershipRole.OWNER,
        status: MembershipStatus.ACTIVE,
      });
      return organization;
    });
  }

  function roleRequest(route: string, organizationId: string, token?: string) {
    const testRequest = request(app.getHttpServer() as Server)
      .get(`/api/v1/test/role-authorization/${route}`)
      .set('X-Organization-Id', organizationId);
    if (token !== undefined) {
      testRequest.set('Authorization', `Bearer ${token}`);
    }
    return testRequest;
  }

  function login() {
    return request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password: initialOwnerPassword })
      .expect(200);
  }

  function expectGenericDenial(responseBody: unknown): void {
    expect(responseBody).toEqual({
      statusCode: 403,
      message: 'Organization access denied.',
      error: 'Forbidden',
    });
  }
});
