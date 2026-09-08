import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  EmailMessage,
  EmailTransport,
} from '../src/common/email/email-transport';
import { AUTH_OTP_EMAIL_TRANSPORT } from '../src/modules/auth-email-challenges/auth-email-challenges.service';
import { AuthRefreshToken } from '../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthRefreshTokenStatus } from '../src/modules/auth-sessions/enums/auth-refresh-token-status.enum';
import { AuthSessionStatus } from '../src/modules/auth-sessions/enums/auth-session-status.enum';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { User } from '../src/modules/users/entities/user.entity';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('Public registration and email verification', () => {
  type RegistrationResponse = {
    status: 'verification_required';
    delivery: 'sent' | 'delivery_unavailable';
    challengeId: string;
    expiresAt: string;
    resendAvailableAt: string;
  };

  let app: INestApplication;
  let connection: DataSource;
  const messages: EmailMessage[] = [];
  const transport: EmailTransport = {
    send: (message) => {
      messages.push(message);
      return Promise.resolve({
        kind: 'sent' as const,
        providerMessageId: randomUUID(),
      });
    },
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_NAME = 'Genesis Platform API';
    process.env.APP_VERSION = '0.1.0';
    process.env.DATABASE_HOST = process.env.TEST_DATABASE_HOST ?? 'localhost';
    process.env.DATABASE_PORT = process.env.TEST_DATABASE_PORT ?? '5433';
    process.env.DATABASE_NAME =
      process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
    configureIntegrationRuntimeEnvironment();
    process.env.FRONTEND_URL = 'http://localhost:5173';
    process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64url');
    process.env.REFRESH_TOKEN_PEPPER = randomBytes(48).toString('base64url');
    process.env.AUTH_OTP_PUBLIC_FLOWS_ENABLED = 'true';
    process.env.AUTH_OTP_PEPPER = randomBytes(32).toString('base64');
    process.env.AUTH_EMAIL_FROM = 'Genesis <auth@example.test>';
    process.env.RESEND_API_KEY = 'synthetic-resend-key';
    process.env.API_PUBLIC_REPLICA_COUNT = '1';

    const { AppModule } = await import('../src/app.module');
    connection = createIntegrationDataSource();
    await connection.initialize();
    await prepareIntegrationRuntimeRole(connection);
    await connection.dropDatabase();
    await connection.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AUTH_OTP_EMAIL_TRANSPORT)
      .useValue(transport)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (connection?.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('registers, blocks login, verifies without auto-login, then permits normal login', async () => {
    const server = app.getHttpServer() as Server;
    const csrfResponse = await request(server)
      .get('/api/v1/auth/csrf')
      .expect(200);
    const csrfToken = (csrfResponse.body as { csrfToken: string }).csrfToken;
    const csrfCookie = (
      csrfResponse.headers['set-cookie'] as unknown as string[]
    )
      .find((value) => value.startsWith('genesis_csrf_dev='))!
      .split(';', 1)[0];
    const email = `registration-${randomUUID()}@example.test`;
    const password = 'synthetic-password-only';
    const mutation = () =>
      request(server)
        .post('/api/v1/auth/register')
        .set('Cookie', csrfCookie)
        .set('X-CSRF-Token', csrfToken);
    const registration = await mutation()
      .send({
        firstName: ' Pessoa ',
        lastName: ' Teste ',
        email: ` ${email.toUpperCase()} `,
        password,
      })
      .expect('Cache-Control', 'no-store')
      .expect(201);
    const registrationBody = registration.body as RegistrationResponse;
    expect(registration.body).toMatchObject({
      status: 'verification_required',
      delivery: 'sent',
    });
    expect(typeof registrationBody.challengeId).toBe('string');
    expect(typeof registrationBody.expiresAt).toBe('string');
    expect(typeof registrationBody.resendAvailableAt).toBe('string');
    expect(registration.headers['set-cookie']).toBeUndefined();

    const created = await connection.getRepository(User).findOneByOrFail({
      email,
    });
    expect(created).toMatchObject({
      name: 'Pessoa Teste',
      status: 'active',
      emailVerifiedAt: null,
    });
    expect(
      await connection
        .getRepository(Membership)
        .countBy({ userId: created.id }),
    ).toBe(0);
    expect(
      await connection
        .getRepository(AuthSession)
        .countBy({ userId: created.id }),
    ).toBe(0);

    const blockedLogin = await request(server)
      .post('/api/v1/auth/login')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ email, password })
      .expect(403);
    expect(blockedLogin.body).toMatchObject({
      code: 'EMAIL_VERIFICATION_REQUIRED',
      continuation: {
        challengeId: registrationBody.challengeId,
      },
    });
    expect(await connection.getRepository(AuthSession).count()).toBe(0);
    expect(messages).toHaveLength(1);

    const firstCode = messages[0]?.text.match(/\b\d{6}\b/u)?.[0];
    await connection.query(
      `UPDATE public.auth_email_challenges
       SET created_at = transaction_timestamp() - interval '61 seconds',
           send_window_started_at = transaction_timestamp() - interval '61 seconds',
           last_sent_at = transaction_timestamp() - interval '61 seconds'
       WHERE id = $1`,
      [registrationBody.challengeId],
    );
    const resent = await request(server)
      .post('/api/v1/auth/email-verification/resend')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ challengeId: registrationBody.challengeId })
      .expect(200);
    const resentBody = resent.body as RegistrationResponse;
    expect(resentBody.challengeId).not.toBe(registrationBody.challengeId);
    expect(messages).toHaveLength(2);
    await request(server)
      .post('/api/v1/auth/email-verification/verify')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ challengeId: registrationBody.challengeId, code: firstCode })
      .expect(404);

    const historicalSession = await connection.getRepository(AuthSession).save({
      userId: created.id,
      status: AuthSessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 600_000),
      lastUsedAt: null,
      revokedAt: null,
      revokeReason: null,
      ipAddress: '127.0.0.1',
      userAgent: 'historical-test-session',
    });
    const historicalRefresh = await connection
      .getRepository(AuthRefreshToken)
      .save({
        sessionId: historicalSession.id,
        tokenHash: 'a'.repeat(64),
        status: AuthRefreshTokenStatus.ACTIVE,
        expiresAt: historicalSession.expiresAt,
        consumedAt: null,
        revokedAt: null,
        replacedByTokenId: null,
      });

    const code = messages[1]?.text.match(/\b\d{6}\b/u)?.[0];
    expect(code).toMatch(/^\d{6}$/u);
    const verified = await request(server)
      .post('/api/v1/auth/email-verification/verify')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ challengeId: resentBody.challengeId, code })
      .expect(200);
    expect(verified.body).toEqual({ status: 'email_verified' });
    expect(verified.headers['set-cookie']).toBeUndefined();
    expect(
      (await connection.getRepository(User).findOneByOrFail({ id: created.id }))
        .emailVerifiedAt,
    ).toBeInstanceOf(Date);
    const revokedSession = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: historicalSession.id });
    expect(revokedSession).toMatchObject({
      status: AuthSessionStatus.REVOKED,
      revokeReason: 'email_verified',
    });
    expect(revokedSession.revokedAt).toBeInstanceOf(Date);
    const revokedRefresh = await connection
      .getRepository(AuthRefreshToken)
      .findOneByOrFail({ id: historicalRefresh.id });
    expect(revokedRefresh).toMatchObject({
      status: AuthRefreshTokenStatus.REVOKED,
    });
    expect(revokedRefresh.revokedAt).toBeInstanceOf(Date);

    await request(server)
      .post('/api/v1/auth/email-verification/verify')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ challengeId: resentBody.challengeId, code })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({
          code: 'AUTH_EMAIL_VERIFICATION_INVALID',
        });
      });

    const login = await request(server)
      .post('/api/v1/auth/login')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ email, password })
      .expect(200);
    expect(login.body).toMatchObject({
      tokenType: 'Bearer',
      user: { email, name: 'Pessoa Teste' },
    });
    expect(login.headers['set-cookie']).toBeDefined();
  }, 30_000);
});
