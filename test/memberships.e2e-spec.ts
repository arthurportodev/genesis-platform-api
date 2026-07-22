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

describe('Membership management (e2e)', () => {
  let app: INestApplication;
  let connection: DataSource;
  let organization: Organization;
  let owner: Membership;
  let member: Membership;
  let isolatedOwner: Membership;
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
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
    process.env.API_PUBLIC_REPLICA_COUNT = '1';
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
    process.env.MEMBERSHIP_READ_MAX_ATTEMPTS = '20';
    process.env.MEMBERSHIP_COMMAND_MAX_ATTEMPTS = '15';
    process.env.MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS = '60';
    process.env.MEMBERSHIP_RATE_LIMIT_MAX_BUCKETS = '200';

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
    owner = await connection.getRepository(Membership).findOneByOrFail({
      organizationId: organization.id,
      role: MembershipRole.OWNER,
    });
    await createMember(
      'membership-admin@example.com',
      adminPassword,
      MembershipRole.ADMIN,
    );
    member = await createMember(
      'membership-member@example.com',
      memberPassword,
      MembershipRole.MEMBER,
    );
    isolatedOwner = await createIsolatedOwner();

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

    ownerToken = await login('contato@agenciagenesismkt.com.br', ownerPassword);
    adminToken = await login('membership-admin@example.com', adminPassword);
    memberToken = await login('membership-member@example.com', memberPassword);
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (connection?.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('enforces owner and admin visibility with canonical pagination errors', async () => {
    const ownerList = await members('get', '', ownerToken).expect(200);
    expect(ownerList.headers['cache-control']).toBe('no-store');
    expect((ownerList.body as { items: unknown[] }).items).toHaveLength(3);

    const adminList = await members('get', '', adminToken).expect(200);
    expect(
      (adminList.body as { items: Array<{ id: string }> }).items.map(
        ({ id }) => id,
      ),
    ).toEqual([member.id]);
    await members('get', `/${owner.id}`, adminToken).expect(404);
    await members('get', `/${isolatedOwner.id}`, ownerToken).expect(404);
    await members('get', '', memberToken).expect(403);
    await members('get', '?cursor=e30%3D', ownerToken).expect(400);

    const firstPage = await members('get', '?limit=1', ownerToken).expect(200);
    const firstItem = (
      firstPage.body as { items: Array<Record<string, unknown>> }
    ).items[0];
    expect(Object.keys(firstItem).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'role',
      'status',
      'updatedAt',
    ]);
    const nextCursor = (
      firstPage.body as { page: { nextCursor: string | null } }
    ).page.nextCursor;
    expect(nextCursor).toEqual(expect.any(String));
    const secondPage = await members(
      'get',
      `?limit=1&cursor=${encodeURIComponent(nextCursor ?? '')}`,
      ownerToken,
    ).expect(200);
    expect(
      (secondPage.body as { items: Array<{ id: string }> }).items[0]?.id,
    ).not.toBe((firstItem as { id: string }).id);
    const filtered = await members(
      'get',
      '?role=member&status=active',
      ownerToken,
    ).expect(200);
    expect(
      (filtered.body as { items: Array<{ role: string; status: string }> })
        .items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'member', status: 'active' }),
      ]),
    );
  });

  it('returns readiness 503 before role denial when the protected topology drifts', async () => {
    await connection.query(
      `ALTER TABLE public.memberships DISABLE TRIGGER TRG_memberships_effective_owner`,
    );
    try {
      await members('get', '', memberToken).expect(503);
    } finally {
      await connection.query(
        `ALTER TABLE public.memberships ENABLE TRIGGER TRG_memberships_effective_owner`,
      );
    }
  });

  it('executes the owner role and lifecycle commands through the HTTP boundary', async () => {
    const roleChanged = await members('patch', `/${member.id}/role`, ownerToken)
      .send({ role: 'admin' })
      .expect(200);
    expect((roleChanged.body as { role: string }).role).toBe('admin');
    const promoted = await members(
      'post',
      `/${member.id}/promote-owner`,
      ownerToken,
    )
      .send({})
      .expect(200);
    expect((promoted.body as { role: string }).role).toBe('owner');
    await members('post', `/${member.id}/deactivate`, ownerToken)
      .send({})
      .expect(204);
    await members('post', `/${member.id}/reactivate`, ownerToken)
      .send({})
      .expect(204);
    await members('patch', `/${member.id}/role`, ownerToken)
      .send({ role: 'member' })
      .expect(200);
    await members('post', `/${member.id}/deactivate`, adminToken)
      .send({})
      .expect(204);
    await members('post', `/${member.id}/reactivate`, adminToken)
      .send({})
      .expect(204);
  });

  it.each([
    ['patch', 'role', { role: 'member', extra: true }],
    ['post', 'promote-owner', { extra: true }],
    ['post', 'deactivate', { extra: true }],
    ['post', 'reactivate', { extra: true }],
    ['post', 'leave', { extra: true }],
  ] as const)('rejects body extras for %s %s', async (method, route, body) => {
    const path = route === 'leave' ? '/me/leave' : `/${member.id}/${route}`;
    await members(method, path, ownerToken).send(body).expect(400);
  });

  it('returns 204 to both eligible concurrent leave requests, then 403 to a new request', async () => {
    const password = randomBytes(24).toString('base64url');
    const membership = await createMember(
      `concurrent-leave-${randomUUID()}@example.com`,
      password,
      MembershipRole.MEMBER,
    );
    const user = await connection
      .getRepository(User)
      .findOneByOrFail({ id: membership.userId });
    const token = await login(user.email, password);
    const blocker = connection.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    try {
      await blocker.query(
        `SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE`,
        [organization.id],
      );
      const first = members('post', '/me/leave', token).send({});
      const second = members('post', '/me/leave', token).send({});
      const responses = Promise.all([first, second]);
      await waitForMembershipCommandWaiters(2);
      await blocker.commitTransaction();
      expect((await responses).map(({ status }) => status)).toEqual([204, 204]);
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
    }
    await members('post', '/me/leave', token).send({}).expect(403);
  });

  it('applies read and command rate limits as 429 at the HTTP boundary', async () => {
    let readStatus = 200;
    for (let attempt = 0; attempt < 21 && readStatus !== 429; attempt += 1) {
      readStatus = (await members('get', '', ownerToken)).status;
    }
    expect(readStatus).toBe(429);

    let commandStatus = 204;
    for (let attempt = 0; attempt < 16 && commandStatus !== 429; attempt += 1) {
      commandStatus = (
        await members('post', `/${member.id}/reactivate`, ownerToken).send({})
      ).status;
    }
    expect(commandStatus).toBe(429);
  });

  it('blocks the last owner and lets a member leave through the dedicated route', async () => {
    await members('post', '/me/leave', ownerToken, isolatedOwner.organizationId)
      .send({})
      .expect(409);
    await members('post', '/me/leave', memberToken).send({}).expect(204);
    await members('get', '', memberToken).expect(403);
  });

  async function createMember(
    email: string,
    password: string,
    role: MembershipRole,
  ): Promise<Membership> {
    const user = await connection.getRepository(User).save({
      email,
      name: email,
      status: UserStatus.ACTIVE,
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
    });
    return connection.getRepository(Membership).save({
      userId: user.id,
      organizationId: organization.id,
      role,
      status: MembershipStatus.ACTIVE,
    });
  }

  async function createIsolatedOwner(): Promise<Membership> {
    return connection.transaction(async (manager) => {
      const isolatedOrganization = await manager
        .getRepository(Organization)
        .save({
          name: 'Isolated owner organization',
          slug: `isolated-owner-${randomUUID()}`,
          status: OrganizationStatus.ACTIVE,
        });
      return manager.getRepository(Membership).save({
        userId: owner.userId,
        organizationId: isolatedOrganization.id,
        role: MembershipRole.OWNER,
        status: MembershipStatus.ACTIVE,
      });
    });
  }

  async function login(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return (response.body as AuthTokenResponse).accessToken;
  }

  async function waitForMembershipCommandWaiters(expected: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row] = await connection.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count
         FROM pg_catalog.pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query LIKE '%execute_membership_command%'`,
      );
      if ((row?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${expected} membership commands.`);
  }

  function members(
    method: 'get' | 'patch' | 'post',
    path: string,
    token: string,
    organizationId = organization.id,
  ) {
    const client = request(app.getHttpServer() as Server);
    const operation =
      method === 'get'
        ? client.get(`/api/v1/members${path}`)
        : method === 'patch'
          ? client.patch(`/api/v1/members${path}`)
          : client.post(`/api/v1/members${path}`);
    return operation
      .set('Authorization', `Bearer ${token}`)
      .set('x-organization-id', organizationId);
  }
});
