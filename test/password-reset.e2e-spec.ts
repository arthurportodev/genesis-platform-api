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
import { hashPassword } from '../src/modules/credentials/password-policy';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('Public password reset', () => {
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
    process.env.AUTH_PASSWORD_RESET_PUBLIC_FLOW_ENABLED = 'true';
    process.env.AUTH_OTP_PEPPER = randomBytes(32).toString('base64');
    process.env.AUTH_EMAIL_FROM = 'Genesis <auth@example.test>';
    process.env.RESEND_API_KEY = 'synthetic-resend-key';
    process.env.API_PUBLIC_REPLICA_COUNT = '1';

    const { AppModule } = await import('../src/app.module');
    connection = createIntegrationDataSource({ includePasswordReset: true });
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

  it('keeps request opaque and completes without auto-login while revoking old credentials', async () => {
    const server = app.getHttpServer() as Server;
    const csrfResponse = await request(server)
      .get('/api/v1/auth/csrf')
      .expect(200);
    const csrfToken = (csrfResponse.body as { csrfToken: string }).csrfToken;
    const csrfCookie = cookiePair(
      (csrfResponse.headers['set-cookie'] as unknown as string[]).find(
        (value) => value.startsWith('genesis_csrf_dev='),
      )!,
    );
    const email = `password-reset-${randomUUID()}@example.test`;
    const oldPassword = 'old-password-value';
    const newPassword = 'new-password-value';
    await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email,
        name: 'Password Reset E2E',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(oldPassword),
        passwordChangedAt: new Date('2020-01-01T00:00:00.000Z'),
        emailVerifiedAt: new Date(),
      }),
    );

    const login = await mutate(server, csrfCookie, csrfToken, 'login')
      .send({ email, password: oldPassword })
      .expect(200);
    const oldAccessToken = (login.body as { accessToken: string }).accessToken;
    const oldRefreshCookie = cookiePair(
      (login.headers['set-cookie'] as unknown as string[]).find((value) =>
        value.startsWith('genesis_refresh_dev='),
      )!,
    );

    const accepted = await mutate(
      server,
      csrfCookie,
      csrfToken,
      'password-reset/request',
    )
      .send({ email: ` ${email.toUpperCase()} ` })
      .expect('Cache-Control', 'no-store')
      .expect(202);
    const unknown = await mutate(
      server,
      csrfCookie,
      csrfToken,
      'password-reset/request',
    )
      .send({ email: `${randomUUID()}@example.test` })
      .expect(202);
    expect(Object.keys(accepted.body as object).sort()).toEqual([
      'expiresAt',
      'resendAvailableAt',
      'status',
    ]);
    expect(Object.keys(unknown.body as object).sort()).toEqual(
      Object.keys(accepted.body as object).sort(),
    );
    expect(accepted.body).toMatchObject({ status: 'accepted' });
    expect(accepted.body).not.toHaveProperty('challengeId');
    expect(accepted.body).not.toHaveProperty('delivery');

    const code = messages.at(-1)?.text.match(/\b\d{6}\b/u)?.[0];
    expect(code).toMatch(/^\d{6}$/u);
    const completed = await mutate(
      server,
      [csrfCookie, oldRefreshCookie],
      csrfToken,
      'password-reset/complete',
    )
      .send({ email, code, password: newPassword })
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(completed.body).toEqual({ status: 'password_reset' });
    expect(completed.body).not.toHaveProperty('accessToken');
    const clearedCookies = completed.headers[
      'set-cookie'
    ] as unknown as string[];
    expect(clearedCookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^genesis_refresh_dev=;/u),
        expect.stringMatching(/^genesis_csrf_dev=;/u),
      ]),
    );

    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${oldAccessToken}`)
      .expect(401);
    await mutate(
      server,
      [csrfCookie, oldRefreshCookie],
      csrfToken,
      'refresh',
    ).expect(401);
    await mutate(server, csrfCookie, csrfToken, 'login')
      .send({ email, password: oldPassword })
      .expect(401);
    const newLogin = await mutate(server, csrfCookie, csrfToken, 'login')
      .send({ email, password: newPassword })
      .expect(200);
    expect(newLogin.body).toMatchObject({
      tokenType: 'Bearer',
      user: { email },
    });

    await mutate(server, csrfCookie, csrfToken, 'password-reset/complete')
      .send({ email, code, password: 'another-password-value' })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({
          code: 'AUTH_PASSWORD_RESET_INVALID',
        });
      });
  }, 30_000);
});

function mutate(
  server: Server,
  cookie: string | string[],
  csrfToken: string,
  path: string,
) {
  return request(server)
    .post(`/api/v1/auth/${path}`)
    .set('Cookie', Array.isArray(cookie) ? cookie : [cookie])
    .set('X-CSRF-Token', csrfToken);
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0];
}
