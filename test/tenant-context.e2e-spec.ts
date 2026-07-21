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
import { hashPassword } from '../src/modules/auth/services/password.service';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { CurrentTenant } from '../src/modules/tenant-context/decorators/current-tenant.decorator';
import { TenantContextGuard } from '../src/modules/tenant-context/guards/tenant-context.guard';
import { TenantContextModule } from '../src/modules/tenant-context/tenant-context.module';
import { TenantContext } from '../src/modules/tenant-context/types/tenant-context.type';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

@Controller('test/tenant-context')
@UseGuards(AccessTokenGuard, TenantContextGuard)
class TenantContextTestController {
  @Get()
  currentTenant(@CurrentTenant() tenantContext: TenantContext): TenantContext {
    return tenantContext;
  }
}

@Module({
  imports: [AuthModule, TenantContextModule],
  controllers: [TenantContextTestController],
})
class TenantContextConsumerTestModule {}

describe('Tenant context (e2e)', () => {
  let app: INestApplication;
  let connection: DataSource;
  let accessToken: string;
  let user: User;
  let secondUser: User;
  let primaryOrganization: Organization;
  let secondaryOrganization: Organization;
  let inactiveOrganization: Organization;
  let noMembershipOrganization: Organization;
  let inactiveMembershipOrganization: Organization;
  let primaryMembership: Membership;
  let secondaryMembership: Membership;
  const initialOwnerPassword = randomBytes(24).toString('base64url');
  const secondUserPassword = randomBytes(24).toString('base64url');
  const ownerEmail = 'contato@agenciagenesismkt.com.br';
  const secondUserEmail = 'tenant-second-e2e@example.com';

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
    await createTenantFixtures();

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TenantContextConsumerTestModule],
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

  it('requires valid authentication before resolving a tenant', async () => {
    await tenantRequest(primaryOrganization.id)
      .expect(401)
      .then((response) => {
        expect(response.body).toMatchObject({
          statusCode: 401,
          message: 'Invalid access token.',
        });
      });

    await tenantRequest(primaryOrganization.id, 'invalid-token')
      .expect(401)
      .then((response) => {
        expect(response.body).toMatchObject({
          statusCode: 401,
          message: 'Invalid access token.',
        });
      });
  });

  it('rejects a missing or malformed organization header before the database', async () => {
    const missing = await request(app.getHttpServer() as Server)
      .get('/api/v1/test/tenant-context')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
    const malformed = await tenantRequest('not-a-uuid', accessToken).expect(
      400,
    );

    expect(missing.body).toMatchObject({
      statusCode: 400,
      message: 'Invalid organization context.',
    });
    expect(malformed.body).toEqual(missing.body);
  });

  it('uses the same generic denial for unavailable organization access', async () => {
    const organizationIds = [
      randomUUID(),
      inactiveOrganization.id,
      noMembershipOrganization.id,
      inactiveMembershipOrganization.id,
    ];
    const responses = [];

    for (const organizationId of organizationIds) {
      const response = await tenantRequest(organizationId, accessToken).expect(
        403,
      );
      responses.push(response.body);
    }

    for (const responseBody of responses) {
      expect(responseBody).toEqual({
        statusCode: 403,
        message: 'Organization access denied.',
        error: 'Forbidden',
      });
      expect(JSON.stringify(responseBody)).not.toContain(
        inactiveOrganization.name,
      );
      expect(JSON.stringify(responseBody)).not.toContain(
        MembershipStatus.INACTIVE,
      );
    }
  });

  it("denies a second authenticated user access to the first user's organization", async () => {
    expect(
      await connection.getRepository(Membership).countBy({
        userId: secondUser.id,
        organizationId: primaryOrganization.id,
      }),
    ).toBe(0);
    const secondUserTokens = (await login(secondUserEmail, secondUserPassword))
      .body as AuthTokenResponse;

    const response = await tenantRequest(
      primaryOrganization.id,
      secondUserTokens.accessToken,
    ).expect(403);

    expect(response.body).toEqual({
      statusCode: 403,
      message: 'Organization access denied.',
      error: 'Forbidden',
    });
    const serializedBody = JSON.stringify(response.body);
    expect(serializedBody).not.toContain(primaryOrganization.name);
    expect(serializedBody).not.toContain(primaryOrganization.slug);
    expect(serializedBody).not.toContain(user.id);
    expect(serializedBody).not.toContain(user.email);
    expect(serializedBody).not.toContain('membership');
  });

  it('returns the validated context with database-owned identifiers and role', async () => {
    const response = await tenantRequest(
      primaryOrganization.id,
      accessToken,
    ).expect(200);

    expect(response.body).toEqual({
      userId: user.id,
      organizationId: primaryOrganization.id,
      membershipId: primaryMembership.id,
      role: MembershipRole.OWNER,
    });
  });

  it('selects two organizations with the same access token', async () => {
    const primary = await tenantRequest(
      primaryOrganization.id,
      accessToken,
    ).expect(200);
    const secondary = await tenantRequest(
      secondaryOrganization.id,
      accessToken,
    ).expect(200);

    expect(primary.body).toMatchObject({
      organizationId: primaryOrganization.id,
      membershipId: primaryMembership.id,
      role: MembershipRole.OWNER,
    });
    expect(secondary.body).toMatchObject({
      organizationId: secondaryOrganization.id,
      membershipId: secondaryMembership.id,
      role: MembershipRole.ADMIN,
    });
  });

  it('reflects a role change without issuing a new access token', async () => {
    await connection
      .getRepository(Membership)
      .update(secondaryMembership.id, { role: MembershipRole.MEMBER });

    const response = await tenantRequest(
      secondaryOrganization.id,
      accessToken,
    ).expect(200);
    expect(response.body).toMatchObject({ role: MembershipRole.MEMBER });

    await connection
      .getRepository(Membership)
      .update(secondaryMembership.id, { role: MembershipRole.ADMIN });
  });

  it('blocks the same token after a membership is deactivated', async () => {
    await connection
      .getRepository(Membership)
      .update(secondaryMembership.id, { status: MembershipStatus.INACTIVE });

    await tenantRequest(secondaryOrganization.id, accessToken).expect(403);

    await connection
      .getRepository(Membership)
      .update(secondaryMembership.id, { status: MembershipStatus.ACTIVE });
  });

  it('keeps authentication endpoints independent from tenant context', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const loginTokens = (await login()).body as AuthTokenResponse;
    const refreshed = (
      await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: loginTokens.refreshToken })
        .expect(200)
    ).body as AuthTokenResponse;
    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${refreshed.accessToken}`)
      .expect(204);
  });

  async function createTenantFixtures(): Promise<void> {
    const users = connection.getRepository(User);
    user = await users.findOneByOrFail({ email: ownerEmail });
    secondUser = await users.save(
      users.create({
        email: secondUserEmail,
        name: 'Tenant Second E2E',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(secondUserPassword),
        passwordChangedAt: new Date(),
      }),
    );
    const organizations = connection.getRepository(Organization);
    primaryOrganization = await organizations.findOneByOrFail({
      slug: 'agencia-genesis',
    });
    [
      secondaryOrganization,
      inactiveOrganization,
      noMembershipOrganization,
      inactiveMembershipOrganization,
    ] = await organizations.save([
      organizations.create({
        name: 'Secondary E2E Organization',
        slug: 'secondary-e2e-organization',
        status: OrganizationStatus.ACTIVE,
      }),
      organizations.create({
        name: 'Inactive E2E Organization',
        slug: 'inactive-e2e-organization',
        status: OrganizationStatus.INACTIVE,
      }),
      organizations.create({
        name: 'No Membership E2E Organization',
        slug: 'no-membership-e2e-organization',
        status: OrganizationStatus.ACTIVE,
      }),
      organizations.create({
        name: 'Inactive Membership E2E Organization',
        slug: 'inactive-membership-e2e-organization',
        status: OrganizationStatus.ACTIVE,
      }),
    ]);

    const memberships = connection.getRepository(Membership);
    primaryMembership = await memberships.findOneByOrFail({
      userId: user.id,
      organizationId: primaryOrganization.id,
    });
    [secondaryMembership] = await memberships.save([
      memberships.create({
        userId: user.id,
        organizationId: secondaryOrganization.id,
        role: MembershipRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
      memberships.create({
        userId: user.id,
        organizationId: inactiveOrganization.id,
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
      }),
      memberships.create({
        userId: user.id,
        organizationId: inactiveMembershipOrganization.id,
        role: MembershipRole.MEMBER,
        status: MembershipStatus.INACTIVE,
      }),
    ]);
  }

  function tenantRequest(organizationId: string, token?: string) {
    const testRequest = request(app.getHttpServer() as Server)
      .get('/api/v1/test/tenant-context')
      .set('X-Organization-Id', organizationId);
    if (token !== undefined) {
      testRequest.set('Authorization', `Bearer ${token}`);
    }
    return testRequest;
  }

  function login(email = ownerEmail, password = initialOwnerPassword) {
    return request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
  }
});
