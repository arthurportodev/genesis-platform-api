/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { configureTrustProxy } from '../src/config/trust-proxy';
import { AuthTokenResponse } from '../src/modules/auth/auth.service';
import { hashPassword } from '../src/modules/auth/services/password.service';
import { InvitationDeliveryOutbox } from '../src/modules/invitations/entities/invitation-delivery-outbox.entity';
import { OrganizationInvitation } from '../src/modules/invitations/entities/organization-invitation.entity';
import {
  InvitationDeliveryEventType,
  InvitationDeliveryStatus,
  InvitationRole,
  InvitationStatus,
} from '../src/modules/invitations/enums/invitation.enums';
import {
  ConfiguredInvitationAcceptanceReadiness,
  INVITATION_ACCEPTANCE_READINESS,
} from '../src/modules/invitations/ports/invitation-acceptance-readiness.port';
import { INVITATION_TOKEN_KEYRING } from '../src/modules/invitations/ports/invitation-token-keyring.port';
import { InvitationTokenCodec } from '../src/modules/invitations/services/invitation-token-codec.service';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('Invitation acceptance (e2e)', () => {
  let app: INestApplication;
  let connection: DataSource;
  let recipient: User;
  let otherUser: User;
  let organization: Organization;
  let invitation: OrganizationInvitation;
  let outboxId: string;
  let token: string;
  let accessToken: string;
  let otherAccessToken: string;
  const recipientPassword = randomBytes(24).toString('base64url');
  const otherUserPassword = randomBytes(24).toString('base64url');
  const ownerPassword = randomBytes(24).toString('base64url');
  const invitationKeys = new Map([[2, Buffer.alloc(32, 0x32)]]);
  const keyring = {
    currentVersion: () => 2,
    keyFor: (version: number) => {
      const key = invitationKeys.get(version);
      if (key === undefined) throw new Error('missing test key');
      return key;
    },
  };

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
    process.env.DATABASE_MIGRATION_USER =
      process.env.TEST_DATABASE_USER ?? 'genesis_test';
    process.env.DATABASE_MIGRATION_PASSWORD =
      process.env.TEST_DATABASE_PASSWORD ?? 'test-only';
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
    process.env.INVITATION_INSPECT_IP_MAX_ATTEMPTS = '100';
    process.env.INVITATION_ACCEPT_IP_MAX_ATTEMPTS = '100';
    process.env.INVITATION_ACCEPT_USER_IP_MAX_ATTEMPTS = '100';

    connection = createIntegrationDataSource();
    await connection.initialize();
    await prepareIntegrationRuntimeRole(connection);
    await connection.dropDatabase();
    await connection.runMigrations();
    const { seedInitialTenant } =
      await import('../src/database/seeds/initial-tenant.seed');
    await seedInitialTenant(
      connection,
      { log: jest.fn() },
      { initialOwnerPassword: ownerPassword },
    );
    organization = await connection
      .getRepository(Organization)
      .findOneByOrFail({
        slug: 'agencia-genesis',
      });
    const issuer = await connection.getRepository(Membership).findOneByOrFail({
      organizationId: organization.id,
    });
    recipient = await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email: 'existing-recipient@example.com',
        name: 'Existing Recipient',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(recipientPassword),
        passwordChangedAt: new Date(),
      }),
    );
    otherUser = await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email: 'other-existing-user@example.com',
        name: 'Other Existing User',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(otherUserPassword),
        passwordChangedAt: new Date(),
      }),
    );
    invitation = await connection.getRepository(OrganizationInvitation).save(
      connection.getRepository(OrganizationInvitation).create({
        organizationId: organization.id,
        emailNormalized: recipient.email,
        role: InvitationRole.MEMBER,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedByMembershipId: issuer.id,
        acceptedByUserId: null,
        resultingMembershipId: null,
        acceptedAt: null,
        revokedByMembershipId: null,
        revokedAt: null,
        revocationReason: null,
        supersededByInvitationId: null,
        tokenKeyVersion: 2,
        tokenVersion: 1,
        tokenNonce: randomBytes(32).toString('base64url'),
      }),
    );
    const outbox = await connection
      .getRepository(InvitationDeliveryOutbox)
      .save(
        connection.getRepository(InvitationDeliveryOutbox).create({
          organizationId: organization.id,
          invitationId: invitation.id,
          eventType: InvitationDeliveryEventType.REQUESTED,
          tokenVersion: 1,
          status: InvitationDeliveryStatus.QUEUED,
          attempts: 0,
          nextAttemptAt: null,
          lockedBy: null,
          lockedAt: null,
          leaseUntil: null,
          providerMessageId: null,
          lastErrorCode: null,
          sentAt: null,
          cancelledAt: null,
        }),
      );
    outboxId = outbox.id;
    token = new InvitationTokenCodec(keyring).issue(tokenFields());

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(INVITATION_ACCEPTANCE_READINESS)
      .useValue(new ConfiguredInvitationAcceptanceReadiness(true))
      .overrideProvider(INVITATION_TOKEN_KEYRING)
      .useValue(keyring)
      .compile();
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
    const login = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email: recipient.email, password: recipientPassword })
      .expect(200);
    accessToken = (login.body as AuthTokenResponse).accessToken;
    const otherLogin = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email: otherUser.email, password: otherUserPassword })
      .expect(200);
    otherAccessToken = (otherLogin.body as AuthTokenResponse).accessToken;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (connection?.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('inspects with only the allowlisted response and no-store', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/inspect')
      .send({ token })
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(response.body).toEqual({
      organization: { name: organization.name },
      emailMasked: 'e***t@e***.com',
      role: 'member',
      expiresAt: expect.any(String),
    });
  });

  it('sets no-store on DTO and authentication errors', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/inspect')
      .send({ token: 'invalid' })
      .expect('Cache-Control', 'no-store')
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/accept')
      .send({ token })
      .expect('Cache-Control', 'no-store')
      .expect(401);
  });

  it('accepts with AccessTokenGuard only and ignores a forged tenant header', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/accept')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Organization-Id', randomBytes(16).toString('hex'))
      .send({ token })
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(Object.keys(response.body as object).sort()).toEqual([
      'membershipId',
      'organizationId',
    ]);
    expect(response.body).toMatchObject({ organizationId: organization.id });
  });

  it('validates HMAC before replay and returns one write-free 404 contract', async () => {
    const validReplay = await accept(token, accessToken).expect(200);
    expect(validReplay.body).toMatchObject({ organizationId: organization.id });
    const baseline = await acceptanceState();
    const [, , , mac] = token.split('.');
    const invalidTokens = [
      `${invitation.id}.2.1.${tamperMac(mac)}`,
      `${invitation.id}.3.1.${mac}`,
      `${invitation.id}.2.2.${mac}`,
      new InvitationTokenCodec({
        currentVersion: () => 2,
        keyFor: () => Buffer.alloc(32, 0x73),
      }).issue(tokenFields()),
    ];

    for (const invalidToken of invalidTokens) {
      await expectUnavailableWithoutWrites(invalidToken, accessToken, baseline);
    }

    invitationKeys.delete(2);
    try {
      await expectUnavailableWithoutWrites(token, accessToken, baseline);
    } finally {
      invitationKeys.set(2, Buffer.alloc(32, 0x32));
    }

    for (const invalidToken of [token, ...invalidTokens.slice(0, 3)]) {
      await expectUnavailableWithoutWrites(
        invalidToken,
        otherAccessToken,
        baseline,
      );
    }
  });

  function accept(presentedToken: string, bearer: string) {
    return request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/accept')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ token: presentedToken });
  }

  async function expectUnavailableWithoutWrites(
    presentedToken: string,
    bearer: string,
    baseline: Awaited<ReturnType<typeof acceptanceState>>,
  ): Promise<void> {
    const response = await accept(presentedToken, bearer)
      .expect('Cache-Control', 'no-store')
      .expect(404);
    expect(response.body).toEqual({
      message: 'Invitation unavailable.',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(JSON.stringify(response.body)).not.toContain(organization.id);
    expect(JSON.stringify(response.body)).not.toContain(
      baseline.resultingMembershipId,
    );
    await expect(acceptanceState()).resolves.toEqual(baseline);
  }

  async function acceptanceState(): Promise<{
    invitation: string;
    memberships: string;
    audits: string;
    outbox: string;
    resultingMembershipId: string;
  }> {
    const [row] = await connection.query<
      Array<{
        invitation: string;
        memberships: string;
        audits: string;
        outbox: string;
        resultingMembershipId: string;
      }>
    >(
      `SELECT to_jsonb(invitation)::text AS invitation,
              invitation.resulting_membership_id AS "resultingMembershipId",
              COALESCE((
                SELECT jsonb_agg(to_jsonb(membership) ORDER BY membership.id)::text
                FROM memberships AS membership
                WHERE membership.organization_id = invitation.organization_id
                  AND membership.user_id = ANY($2::uuid[])
              ), '[]') AS memberships,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)::text
                FROM organization_audit_logs AS audit
                WHERE audit.organization_id = invitation.organization_id
                  AND audit.invitation_id = invitation.id
              ), '[]') AS audits,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(outbox) ORDER BY outbox.id)::text
                FROM invitation_delivery_outbox AS outbox
                WHERE outbox.organization_id = invitation.organization_id
                  AND outbox.invitation_id = invitation.id
                  AND outbox.id = $3
              ), '[]') AS outbox
       FROM organization_invitations AS invitation
       WHERE invitation.id = $1 AND invitation.organization_id = $4`,
      [invitation.id, [recipient.id, otherUser.id], outboxId, organization.id],
    );
    if (row === undefined || row.resultingMembershipId === null) {
      throw new Error('missing accepted invitation E2E state');
    }
    return row;
  }

  function tamperMac(mac: string): string {
    return `${mac.slice(0, -1)}${mac.at(-1) === 'A' ? 'B' : 'A'}`;
  }

  function tokenFields() {
    return {
      invitationId: invitation.id,
      keyVersion: invitation.tokenKeyVersion,
      tokenVersion: invitation.tokenVersion,
      organizationId: invitation.organizationId,
      emailNormalized: invitation.emailNormalized,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      nonce: invitation.tokenNonce,
    };
  }
});
