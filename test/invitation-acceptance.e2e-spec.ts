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
import { INVITATION_ACTIVATION_READINESS } from '../src/modules/invitations/ports/invitation-activation-readiness.port';
import { INVITATION_TOKEN_KEYRING } from '../src/modules/invitations/ports/invitation-token-keyring.port';
import { InvitationTokenCodec } from '../src/modules/invitations/services/invitation-token-codec.service';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
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
  let issuer: Membership;
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
    process.env.INVITATION_ACTIVATION_READINESS = 'true';
    process.env.INVITATION_ACTIVATION_IP_MAX_ATTEMPTS = '100';
    process.env.INVITATION_ACTIVATION_INVITATION_IP_MAX_ATTEMPTS = '100';
    process.env.INVITATION_ACTIVATION_HASH_CONCURRENCY = '2';
    process.env.INVITATION_PUBLIC_REPLICA_COUNT = '1';

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
    issuer = await connection.getRepository(Membership).findOneByOrFail({
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
      .overrideProvider(INVITATION_ACTIVATION_READINESS)
      .useValue({ assertReady: () => Promise.resolve() })
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

  it('activates a new user publicly and returns only organization and membership IDs', async () => {
    const email = `new-activation-${Date.now()}@example.com`;
    const activationInvitation = await createActivationInvitation(email);
    const activationToken = new InvitationTokenCodec(keyring).issue(
      tokenFieldsFor(activationInvitation),
    );
    const password = '  Strong activation password 1!  ';

    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/activate')
      .send({
        token: activationToken,
        name: '  New Activation User  ',
        password,
      })
      .expect('Cache-Control', 'no-store')
      .expect(201);
    expect(Object.keys(response.body as object).sort()).toEqual([
      'membershipId',
      'organizationId',
    ]);
    expect(response.body).toMatchObject({ organizationId: organization.id });

    const [state] = await connection.query<
      Array<{
        userId: string;
        name: string;
        status: string;
        passwordHash: string;
        timestampsEqual: boolean;
        membershipId: string;
        invitationStatus: string;
        outboxStatus: string;
        auditCount: number;
        sessionCount: number;
      }>
    >(
      `SELECT application_user.id AS "userId", application_user.name,
              application_user.status,
              application_user.password_hash AS "passwordHash",
              application_user.email_verified_at = application_user.password_changed_at
                AS "timestampsEqual",
              membership.id AS "membershipId",
              invitation.status AS "invitationStatus",
              outbox.status AS "outboxStatus",
              (SELECT count(*)::int FROM organization_audit_logs AS audit
               WHERE audit.invitation_id = invitation.id
                 AND audit.event_type = 'organization.invitation.activated'
                 AND audit.actor_user_id = application_user.id
                 AND audit.actor_membership_id = membership.id) AS "auditCount",
              (SELECT count(*)::int FROM auth_sessions AS session
               WHERE session.user_id = application_user.id) AS "sessionCount"
       FROM users AS application_user
       JOIN memberships AS membership ON membership.user_id = application_user.id
       JOIN organization_invitations AS invitation
         ON invitation.accepted_by_user_id = application_user.id
       JOIN invitation_delivery_outbox AS outbox
         ON outbox.invitation_id = invitation.id
       WHERE application_user.email = $1 AND invitation.id = $2`,
      [email, activationInvitation.id],
    );
    const activationResponse = response.body as {
      organizationId: string;
      membershipId: string;
    };
    expect(state).toMatchObject({
      name: 'New Activation User',
      status: 'active',
      timestampsEqual: true,
      membershipId: activationResponse.membershipId,
      invitationStatus: 'accepted',
      outboxStatus: 'cancelled',
      auditCount: 1,
      sessionCount: 0,
    });
    expect(state?.passwordHash).toMatch(
      /^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$/u,
    );

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
  });

  it('uses generic 400/404 responses and keeps failed invitations pending', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/activate')
      .send({ token, name: 'User', password: 'Password 123!', role: 'owner' })
      .expect('Cache-Control', 'no-store')
      .expect(400, {
        message: 'Invalid activation request.',
        error: 'Bad Request',
        statusCode: 400,
      });

    const existingInvitation = await createActivationInvitation(
      recipient.email,
    );
    const existingToken = new InvitationTokenCodec(keyring).issue(
      tokenFieldsFor(existingInvitation),
    );
    await request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/activate')
      .send({
        token: existingToken,
        name: 'Existing User',
        password: 'Password 123!',
      })
      .expect('Cache-Control', 'no-store')
      .expect(404, {
        message: 'Invitation unavailable.',
        error: 'Not Found',
        statusCode: 404,
      });
    await expect(
      connection.getRepository(OrganizationInvitation).findOneByOrFail({
        id: existingInvitation.id,
      }),
    ).resolves.toMatchObject({ status: InvitationStatus.PENDING });
  });

  it('converges cryptographic, terminal, expired, and inactive-tenant states to 404', async () => {
    const revoked = await createActivationInvitation(
      `revoked-${Date.now()}@example.com`,
    );
    const revokedToken = new InvitationTokenCodec(keyring).issue(
      tokenFieldsFor(revoked),
    );
    await connection.query(
      `UPDATE organization_invitations
       SET status = 'revoked', revoked_at = transaction_timestamp(),
           revocation_reason = 'manual' WHERE id = $1`,
      [revoked.id],
    );

    const expired = await createActivationInvitation(
      `expired-${Date.now()}@example.com`,
    );
    await connection.query(
      `UPDATE organization_invitations
       SET created_at = transaction_timestamp() - interval '8 days',
           expires_at = transaction_timestamp() - interval '1 day'
       WHERE id = $1`,
      [expired.id],
    );
    const expiredState = await connection
      .getRepository(OrganizationInvitation)
      .findOneByOrFail({ id: expired.id });
    expired.expiresAt = expiredState.expiresAt;
    const expiredToken = new InvitationTokenCodec(keyring).issue(
      tokenFieldsFor(expired),
    );

    for (const unavailableToken of [token, revokedToken, expiredToken]) {
      await request(app.getHttpServer() as Server)
        .post('/api/v1/invitation-acceptance/activate')
        .send({
          token: unavailableToken,
          name: 'Unavailable User',
          password: 'Password 123!',
        })
        .expect(404, {
          message: 'Invitation unavailable.',
          error: 'Not Found',
          statusCode: 404,
        });
    }

    const missingKey = await createActivationInvitation(
      `missing-key-${Date.now()}@example.com`,
    );
    const missingKeyToken = new InvitationTokenCodec(keyring).issue(
      tokenFieldsFor(missingKey),
    );
    invitationKeys.delete(2);
    try {
      await request(app.getHttpServer() as Server)
        .post('/api/v1/invitation-acceptance/activate')
        .send({
          token: missingKeyToken,
          name: 'Unavailable Key',
          password: 'Password 123!',
        })
        .expect(404, {
          message: 'Invitation unavailable.',
          error: 'Not Found',
          statusCode: 404,
        });
    } finally {
      invitationKeys.set(2, Buffer.alloc(32, 0x32));
    }

    const inactiveOrganization = await createActivationInvitation(
      `inactive-org-${Date.now()}@example.com`,
    );
    const inactiveOrganizationToken = new InvitationTokenCodec(keyring).issue(
      tokenFieldsFor(inactiveOrganization),
    );
    await connection.getRepository(Organization).update(organization.id, {
      status: OrganizationStatus.INACTIVE,
    });
    try {
      await request(app.getHttpServer() as Server)
        .post('/api/v1/invitation-acceptance/activate')
        .send({
          token: inactiveOrganizationToken,
          name: 'Inactive Organization',
          password: 'Password 123!',
        })
        .expect(404, {
          message: 'Invitation unavailable.',
          error: 'Not Found',
          statusCode: 404,
        });
    } finally {
      await connection.getRepository(Organization).update(organization.id, {
        status: OrganizationStatus.ACTIVE,
      });
    }
  });

  it('fails closed with the public 429 contract when the IP bucket is exhausted', async () => {
    let response: request.Response | undefined;
    for (let attempt = 0; attempt < 101; attempt += 1) {
      response = await request(app.getHttpServer() as Server)
        .post('/api/v1/invitation-acceptance/activate')
        .send({});
      if (response.status === 429) break;
    }
    expect(response?.status).toBe(429);
    expect(response?.headers['cache-control']).toBe('no-store');
    expect(response?.body).toMatchObject({
      message: 'Too many requests.',
      statusCode: 429,
      path: '/api/v1/invitation-acceptance/activate',
    });
  });

  function accept(presentedToken: string, bearer: string) {
    return request(app.getHttpServer() as Server)
      .post('/api/v1/invitation-acceptance/accept')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ token: presentedToken });
  }

  async function createActivationInvitation(
    email: string,
  ): Promise<OrganizationInvitation> {
    const created = await connection.getRepository(OrganizationInvitation).save(
      connection.getRepository(OrganizationInvitation).create({
        organizationId: organization.id,
        emailNormalized: email,
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
    await connection.getRepository(InvitationDeliveryOutbox).save(
      connection.getRepository(InvitationDeliveryOutbox).create({
        organizationId: organization.id,
        invitationId: created.id,
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
    return created;
  }

  function tokenFieldsFor(created: OrganizationInvitation) {
    return {
      invitationId: created.id,
      keyVersion: created.tokenKeyVersion,
      tokenVersion: created.tokenVersion,
      organizationId: created.organizationId,
      emailNormalized: created.emailNormalized,
      role: created.role,
      expiresAt: created.expiresAt,
      nonce: created.tokenNonce,
    };
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
