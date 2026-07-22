import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { configureTrustProxy } from '../src/config/trust-proxy';
import { seedInitialTenant } from '../src/database/seeds/initial-tenant.seed';
import { AuthTokenResponse } from '../src/modules/auth/auth.service';
import { hashPassword } from '../src/modules/auth/services/password.service';
import { InvitationRole } from '../src/modules/invitations/enums/invitation.enums';
import {
  EnabledInvitationIssuanceReadiness,
  INVITATION_ISSUANCE_READINESS,
} from '../src/modules/invitations/ports/invitation-issuance-readiness.port';
import { INVITATION_TOKEN_KEYRING } from '../src/modules/invitations/ports/invitation-token-keyring.port';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('Invitation administration (e2e)', () => {
  let app: INestApplication;
  let enabledApp: INestApplication;
  let connection: DataSource;
  let organization: Organization;
  let enabledOrganization: Organization;
  let enabledOwnerMembership: Membership;
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
  let adminMembership: Membership;
  const ownerPassword = randomBytes(24).toString('base64url');
  const adminPassword = randomBytes(24).toString('base64url');
  const memberPassword = randomBytes(24).toString('base64url');

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
    process.env.AUTH_LOGIN_MAX_ATTEMPTS = '20';
    process.env.AUTH_LOGIN_IP_MAX_ATTEMPTS = '100';
    process.env.AUTH_LOGIN_MAX_BUCKETS = '200';
    process.env.AUTH_LOGIN_WINDOW_SECONDS = '900';

    connection = createIntegrationDataSource();
    await connection.initialize();
    await prepareIntegrationRuntimeRole(connection);
    await connection.dropDatabase();
    await connection.runMigrations();
    await seedInitialTenant(
      connection,
      { log: jest.fn() },
      { initialOwnerPassword: ownerPassword },
    );
    organization = await connection
      .getRepository(Organization)
      .findOneByOrFail({ slug: 'agencia-genesis' });
    await createAdmin();
    await createMember();
    await createEnabledTenant();

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
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

    const enabledModuleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(INVITATION_ISSUANCE_READINESS)
      .useValue(new EnabledInvitationIssuanceReadiness())
      .overrideProvider(INVITATION_TOKEN_KEYRING)
      .useValue({
        currentVersion: () => 2,
        keyFor: () => Buffer.alloc(32, 9),
      })
      .compile();
    const enabledExpressApp =
      enabledModuleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(enabledExpressApp, 0);
    enabledApp = enabledExpressApp;
    enabledApp.setGlobalPrefix('api/v1');
    enabledApp.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    enabledApp.useGlobalFilters(new HttpExceptionFilter());
    await enabledApp.init();

    ownerToken = await login('contato@agenciagenesismkt.com.br', ownerPassword);
    adminToken = await login('invitation-admin@example.com', adminPassword);
    memberToken = await login('invitation-member@example.com', memberPassword);
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (enabledApp !== undefined) await enabledApp.close();
    if (connection.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('runs authentication, tenant, role, DTO, then fixed disabled readiness', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/v1/invitations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Organization-Id', organization.id)
      .send({ email: 'member@example.com', role: 'owner' })
      .expect(400);

    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/invitations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Organization-Id', organization.id)
      .send({ email: 'member@example.com', role: InvitationRole.MEMBER })
      .expect(503);
    expect(response.body).toMatchObject({
      statusCode: 503,
      message: 'Invitation delivery is unavailable.',
    });
    const [{ count }] = await connection.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM organization_invitations`,
    );
    expect(count).toBe('0');
  });

  it('lets owner list/get/revoke member and admin invitations', async () => {
    const memberId = await insertInvitation(InvitationRole.MEMBER);
    const adminId = await insertInvitation(InvitationRole.ADMIN);

    const list = await invitationRequest('get', '', ownerToken).expect(200);
    const body = list.body as { items: Array<{ id: string }> };
    expect(body.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([memberId, adminId]),
    );
    await invitationRequest('get', `/${adminId}`, ownerToken).expect(200);
    await invitationRequest('post', `/${adminId}/revoke`, ownerToken).expect(
      204,
    );
  });

  it('hard-filters admin to member invitations and returns uniform 404', async () => {
    const memberId = await insertInvitation(InvitationRole.MEMBER);
    const adminId = await insertInvitation(InvitationRole.ADMIN);

    const list = await invitationRequest('get', '', adminToken).expect(200);
    const body = list.body as {
      items: Array<{ id: string; role: InvitationRole }>;
    };
    expect(
      body.items.every((item) => item.role === InvitationRole.MEMBER),
    ).toBe(true);
    await invitationRequest('get', `/${memberId}`, adminToken).expect(200);
    await invitationRequest('get', `/${adminId}`, adminToken).expect(404);
    await invitationRequest('post', `/${adminId}/revoke`, adminToken).expect(
      404,
    );
  });

  it('rejects member administration at the role guard', async () => {
    await invitationRequest('get', '', memberToken).expect(403);
  });

  it('creates only approved targets for owner and admin when readiness is enabled', async () => {
    await enabledInvitationRequest('post', '', ownerToken)
      .send({ email: 'enabled-owner-member@example.com', role: 'member' })
      .expect(201)
      .expect(({ body }: { body: { role: string; state: string } }) => {
        expect(body).toMatchObject({ role: 'member', state: 'pending' });
      });
    await enabledInvitationRequest('post', '', ownerToken)
      .send({ email: 'enabled-owner-admin@example.com', role: 'admin' })
      .expect(201);
    await enabledInvitationRequest('post', '', adminToken)
      .send({ email: 'enabled-admin-member@example.com', role: 'member' })
      .expect(201);
    await enabledInvitationRequest('post', '', adminToken)
      .send({ email: 'enabled-admin-admin@example.com', role: 'admin' })
      .expect(403);
    await enabledInvitationRequest('post', '', ownerToken)
      .send({ email: 'enabled-owner-owner@example.com', role: 'owner' })
      .expect(400);
    await enabledInvitationRequest('get', '', memberToken).expect(403);
  });

  it('paginates with a stable cursor and rejects a live duplicate', async () => {
    for (let index = 0; index < 3; index += 1) {
      await enabledInvitationRequest('post', '', ownerToken)
        .send({
          email: `enabled-cursor-${index}@example.com`,
          role: 'member',
        })
        .expect(201);
    }
    const first = await enabledInvitationRequest(
      'get',
      '?limit=2',
      ownerToken,
    ).expect(200);
    const firstBody = first.body as {
      items: Array<{ id: string }>;
      page: { nextCursor: string | null };
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.page.nextCursor).not.toBeNull();
    const second = await enabledInvitationRequest(
      'get',
      `?limit=2&cursor=${encodeURIComponent(firstBody.page.nextCursor!)}`,
      ownerToken,
    ).expect(200);
    const secondBody = second.body as { items: Array<{ id: string }> };
    expect(secondBody.items.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(firstBody.items.map(({ id }) => id)),
    );

    await enabledInvitationRequest('post', '', ownerToken)
      .send({ email: 'enabled-conflict@example.com', role: 'member' })
      .expect(201);
    await enabledInvitationRequest('post', '', ownerToken)
      .send({ email: 'enabled-conflict@example.com', role: 'member' })
      .expect(409);
  });

  it('returns the exact immutable replace result on replay and isolates tenants', async () => {
    const created = await enabledInvitationRequest('post', '', ownerToken)
      .send({ email: 'enabled-replace@example.com', role: 'member' })
      .expect(201);
    const invitation = created.body as { id: string };
    const key = randomUUID();
    const first = await enabledInvitationRequest(
      'post',
      `/${invitation.id}/replace`,
      ownerToken,
    )
      .set('Idempotency-Key', key)
      .send({})
      .expect(201);
    const firstBody = first.body as {
      previousInvitationId: string;
      invitationId: string;
      stateAtCreation: string;
      deliveryStatusAtCreation: string;
    };
    expect(Object.keys(firstBody).sort()).toEqual([
      'deliveryStatusAtCreation',
      'invitationId',
      'previousInvitationId',
      'stateAtCreation',
    ]);
    expect(firstBody.previousInvitationId).toBe(invitation.id);
    expect(firstBody.invitationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(firstBody.stateAtCreation).toBe('pending');
    expect(firstBody.deliveryStatusAtCreation).toBe('queued');
    expect(first.headers.location).toBe(
      `/api/v1/invitations/${firstBody.invitationId}`,
    );
    await connection.query(
      `UPDATE organization_invitations
       SET updated_at = transaction_timestamp() + interval '1 hour'
       WHERE id = $1`,
      [firstBody.invitationId],
    );
    await connection.query(
      `UPDATE invitation_delivery_outbox SET status = 'dead'
       WHERE invitation_id = $1 AND organization_id = $2`,
      [firstBody.invitationId, enabledOrganization.id],
    );
    const replay = await enabledInvitationRequest(
      'post',
      `/${invitation.id}/replace`,
      ownerToken,
    )
      .set('Idempotency-Key', key)
      .send({})
      .expect('Idempotency-Replayed', 'true')
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(Object.keys(replay.body as object).sort()).toEqual(
      Object.keys(firstBody).sort(),
    );
    expect(replay.headers.location).toBe(first.headers.location);
    await enabledInvitationRequest(
      'get',
      `/${firstBody.invitationId}`,
      ownerToken,
      organization.id,
    ).expect(404);
  });

  it('revalidates an admin-target replay after owner demotion', async () => {
    const created = await enabledInvitationRequest('post', '', ownerToken)
      .send({ email: 'enabled-demotion@example.com', role: 'admin' })
      .expect(201);
    const invitation = created.body as { id: string };
    const key = randomUUID();
    await enabledInvitationRequest(
      'post',
      `/${invitation.id}/replace`,
      ownerToken,
    )
      .set('Idempotency-Key', key)
      .send({})
      .expect(201);
    const guardianMembership = await connection
      .getRepository(Membership)
      .findOneByOrFail({
        userId: adminMembership.userId,
        organizationId: enabledOrganization.id,
      });
    await connection
      .getRepository(Membership)
      .update(guardianMembership.id, { role: MembershipRole.OWNER });
    await connection
      .getRepository(Membership)
      .update(enabledOwnerMembership.id, {
        role: MembershipRole.ADMIN,
      });
    try {
      await enabledInvitationRequest(
        'post',
        `/${invitation.id}/replace`,
        ownerToken,
      )
        .set('Idempotency-Key', key)
        .send({})
        .expect(404);
    } finally {
      await connection
        .getRepository(Membership)
        .update(enabledOwnerMembership.id, { role: MembershipRole.OWNER });
      await connection
        .getRepository(Membership)
        .update(guardianMembership.id, { role: MembershipRole.ADMIN });
    }
  });

  async function createAdmin(): Promise<void> {
    const user = await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email: 'invitation-admin@example.com',
        name: 'Invitation Admin',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(adminPassword),
        passwordChangedAt: new Date(),
      }),
    );
    adminMembership = await connection.getRepository(Membership).save(
      connection.getRepository(Membership).create({
        userId: user.id,
        organizationId: organization.id,
        role: MembershipRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
    );
  }

  async function createMember(): Promise<void> {
    const user = await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email: 'invitation-member@example.com',
        name: 'Invitation Member',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(memberPassword),
        passwordChangedAt: new Date(),
      }),
    );
    await connection.getRepository(Membership).save(
      connection.getRepository(Membership).create({
        userId: user.id,
        organizationId: organization.id,
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
      }),
    );
  }

  async function createEnabledTenant(): Promise<void> {
    const ownerUser = await connection.getRepository(User).findOneByOrFail({
      email: 'contato@agenciagenesismkt.com.br',
    });
    const memberUser = await connection.getRepository(User).findOneByOrFail({
      email: 'invitation-member@example.com',
    });
    ({ organization: enabledOrganization, membership: enabledOwnerMembership } =
      await connection.transaction(async (manager) => {
        const organization = await manager.getRepository(Organization).save({
          name: 'Enabled Invitation Tenant',
          slug: `enabled-invitations-${randomUUID()}`,
          status: OrganizationStatus.ACTIVE,
        });
        const membership = await manager.getRepository(Membership).save({
          userId: ownerUser.id,
          organizationId: organization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        });
        return { organization, membership };
      }));
    await connection.getRepository(Membership).save([
      connection.getRepository(Membership).create({
        userId: adminMembership.userId,
        organizationId: enabledOrganization.id,
        role: MembershipRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
      connection.getRepository(Membership).create({
        userId: memberUser.id,
        organizationId: enabledOrganization.id,
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
      }),
    ]);
  }

  async function login(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return (response.body as AuthTokenResponse).accessToken;
  }

  async function insertInvitation(role: InvitationRole): Promise<string> {
    const id = randomUUID();
    const issuer =
      role === InvitationRole.MEMBER
        ? adminMembership.id
        : (
            await connection.getRepository(Membership).findOneByOrFail({
              organizationId: organization.id,
              role: MembershipRole.OWNER,
            })
          ).id;
    await connection.query(
      `INSERT INTO organization_invitations (
        id, organization_id, email_normalized, role, expires_at,
        invited_by_membership_id, token_key_version, token_version, token_nonce
      ) VALUES ($1, $2, $3, $4,
        date_trunc('milliseconds', transaction_timestamp()) + interval '7 days',
        $5, 1, 1, $6)`,
      [
        id,
        organization.id,
        `${id}@example.com`,
        role,
        issuer,
        randomBytes(32).toString('base64url'),
      ],
    );
    await connection.query(
      `INSERT INTO invitation_delivery_outbox (
        organization_id, invitation_id, event_type, token_version, status
      ) VALUES ($1, $2, 'delivery.requested', 1, 'queued')`,
      [organization.id, id],
    );
    return id;
  }

  function invitationRequest(
    method: 'get' | 'post',
    path: string,
    token: string,
  ) {
    return request(app.getHttpServer() as Server)
      [method](`/api/v1/invitations${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', organization.id);
  }

  function enabledInvitationRequest(
    method: 'get' | 'post',
    path: string,
    token: string,
    organizationId = enabledOrganization.id,
  ) {
    return request(enabledApp.getHttpServer() as Server)
      [method](`/api/v1/invitations${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', organizationId);
  }
});
