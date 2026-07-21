import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { seedInitialTenant } from '../src/database/seeds/initial-tenant.seed';
import { configureTrustProxy } from '../src/config/trust-proxy';
import { AuthAuditLog } from '../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthRefreshToken } from '../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthAuditEventType } from '../src/modules/auth-sessions/enums/auth-audit-event-type.enum';
import { AuthRefreshTokenStatus } from '../src/modules/auth-sessions/enums/auth-refresh-token-status.enum';
import { AuthSessionStatus } from '../src/modules/auth-sessions/enums/auth-session-status.enum';
import {
  AuthService,
  AuthTokenResponse,
} from '../src/modules/auth/auth.service';
import { LoginRateLimiter } from '../src/modules/auth/services/login-rate-limiter.port';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('Authentication endpoints (e2e)', () => {
  let app: INestApplication;
  let connection: DataSource;
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
    process.env.TRUST_PROXY_HOPS = '1';
    process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64url');
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS = '30';
    process.env.REFRESH_TOKEN_PEPPER = randomBytes(48).toString('base64url');
    process.env.AUTH_LOGIN_MAX_ATTEMPTS = '2';
    process.env.AUTH_LOGIN_IP_MAX_ATTEMPTS = '4';
    process.env.AUTH_LOGIN_MAX_BUCKETS = '100';
    process.env.AUTH_LOGIN_WINDOW_SECONDS = '900';

    const { AppModule } = await import('../src/app.module');

    connection = createIntegrationDataSource();
    await connection.initialize();
    await prepareIntegrationRuntimeRole(connection);
    await connection.dropDatabase();
    await connection.runMigrations();
    await seedInitialTenant(
      connection,
      { log: jest.fn() },
      {
        initialOwnerPassword,
      },
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp =
      moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(expressApp, 1);
    app = expressApp;
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (connection.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('creates an active session and stores only an active refresh-token hash', async () => {
    const tokens = (await login()).body as AuthTokenResponse;

    expect(tokens).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: {
        name: 'Arthur Porto',
        email: ownerEmail,
        status: UserStatus.ACTIVE,
      },
    });
    expect(tokens.user).not.toHaveProperty('passwordHash');
    expect(tokens.user).not.toHaveProperty('memberships');
    expect(tokens).not.toHaveProperty('tokenHash');
    expect(tokens).not.toHaveProperty('refreshTokenHash');

    const sessionId = getSessionId(tokens.refreshToken);
    const session = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: sessionId });
    expect(session.status).toBe(AuthSessionStatus.ACTIVE);
    expect(session).not.toHaveProperty('refreshTokenHash');

    const refreshToken = await findRefreshToken(sessionId);
    expect(refreshToken.status).toBe(AuthRefreshTokenStatus.ACTIVE);
    expect(refreshToken.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshToken.tokenHash).not.toBe(tokens.refreshToken);

    const rawTokenMatches = await connection.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count
       FROM auth_refresh_tokens
       WHERE token_hash = $1`,
      [tokens.refreshToken],
    );
    expect(rawTokenMatches[0]?.count).toBe('0');

    const meResponse = await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
    expect(meResponse.body).toEqual(tokens.user);
  });

  it('rotates an active token and records its replacement', async () => {
    const firstTokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(firstTokens.refreshToken);
    const firstRecord = await findRefreshToken(sessionId);

    const refreshResponse = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: firstTokens.refreshToken })
      .expect(200);
    const rotatedTokens = refreshResponse.body as AuthTokenResponse;
    expect(rotatedTokens.refreshToken).not.toBe(firstTokens.refreshToken);
    expect(rotatedTokens).not.toHaveProperty('tokenHash');

    const records = await connection.getRepository(AuthRefreshToken).find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    });
    expect(records).toHaveLength(2);
    const consumed = records.find((token) => token.id === firstRecord.id);
    const active = records.find(
      (token) => token.status === AuthRefreshTokenStatus.ACTIVE,
    );
    expect(consumed).toMatchObject({
      status: AuthRefreshTokenStatus.CONSUMED,
      replacedByTokenId: active?.id,
    });
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
    expect(active).toBeDefined();

    const session = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: sessionId });
    expect(session.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rolls back the refresh protocol atomically when rotation persistence fails', async () => {
    const tokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(tokens.refreshToken);
    const original = await findRefreshToken(sessionId);

    await connection.query(`
      CREATE FUNCTION public.reject_test_refresh_rotation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'forced refresh rotation failure';
      END;
      $function$
    `);
    await connection.query(`
      CREATE TRIGGER TRG_test_reject_refresh_rotation
      BEFORE INSERT ON public.auth_refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_refresh_rotation()
    `);
    try {
      await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(500);

      expect(
        await connection
          .getRepository(AuthRefreshToken)
          .findOneByOrFail({ id: original.id }),
      ).toMatchObject({
        status: AuthRefreshTokenStatus.ACTIVE,
        consumedAt: null,
        replacedByTokenId: null,
      });
      expect(
        await connection.getRepository(AuthRefreshToken).countBy({ sessionId }),
      ).toBe(1);
      expect(
        await connection.getRepository(AuthSession).findOneByOrFail({
          id: sessionId,
        }),
      ).toMatchObject({
        status: AuthSessionStatus.ACTIVE,
        lastUsedAt: null,
      });
      expect(
        await connection.getRepository(AuthAuditLog).countBy({
          sessionId,
          eventType: AuthAuditEventType.REFRESH_SUCCEEDED,
        }),
      ).toBe(0);
    } finally {
      await connection.query(
        `DROP TRIGGER IF EXISTS TRG_test_reject_refresh_rotation
         ON public.auth_refresh_tokens`,
      );
      await connection.query(
        `DROP FUNCTION IF EXISTS public.reject_test_refresh_rotation()`,
      );
    }

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);
  });

  it('treats a consumed token as proven reuse and revokes its family', async () => {
    const firstTokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(firstTokens.refreshToken);
    const rotatedTokens = (
      await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: firstTokens.refreshToken })
        .expect(200)
    ).body as AuthTokenResponse;

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: firstTokens.refreshToken })
      .expect(401);

    const session = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: sessionId });
    expect(session).toMatchObject({
      status: AuthSessionStatus.REVOKED,
      revokeReason: 'refresh_reuse_detected',
    });
    expect(
      await connection.getRepository(AuthRefreshToken).countBy({
        sessionId,
        status: AuthRefreshTokenStatus.ACTIVE,
      }),
    ).toBe(0);
    expect(
      await connection.getRepository(AuthAuditLog).countBy({
        sessionId,
        eventType: AuthAuditEventType.REFRESH_REUSE_DETECTED,
      }),
    ).toBe(1);
    await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${rotatedTokens.accessToken}`)
      .expect(401);
  });

  it('rejects a random secret without revoking the session or logging reuse', async () => {
    const tokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(tokens.refreshToken);
    const randomToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
    const reuseEventsBefore = await connection
      .getRepository(AuthAuditLog)
      .countBy({
        sessionId,
        eventType: AuthAuditEventType.REFRESH_REUSE_DETECTED,
      });

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: randomToken })
      .expect(401);

    const session = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: sessionId });
    expect(session.status).toBe(AuthSessionStatus.ACTIVE);
    expect(
      await connection.getRepository(AuthAuditLog).countBy({
        sessionId,
        eventType: AuthAuditEventType.REFRESH_REUSE_DETECTED,
      }),
    ).toBe(reuseEventsBefore);
    expect(
      await connection.getRepository(AuthAuditLog).countBy({
        eventType: AuthAuditEventType.REFRESH_FAILED,
      }),
    ).toBeGreaterThan(0);

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);
  });

  it('serializes two refreshes of the same token and revokes the family on proven reuse', async () => {
    for (let repetition = 0; repetition < 5; repetition += 1) {
      const tokens = (await login()).body as AuthTokenResponse;
      const sessionId = getSessionId(tokens.refreshToken);

      const [first, second] = await withTimeout(
        Promise.all([
          beginRefresh(tokens.refreshToken),
          beginRefresh(tokens.refreshToken),
        ]),
        5_000,
        `refresh versus refresh repetition ${repetition + 1}`,
      );

      expect([first.status, second.status].sort()).toEqual([200, 401]);
      expect(
        await connection.getRepository(AuthSession).findOneByOrFail({
          id: sessionId,
        }),
      ).toMatchObject({
        status: AuthSessionStatus.REVOKED,
        revokeReason: 'refresh_reuse_detected',
      });
      expect(
        await connection.getRepository(AuthRefreshToken).countBy({
          sessionId,
          status: AuthRefreshTokenStatus.ACTIVE,
        }),
      ).toBe(0);
      expect(
        await connection.getRepository(AuthAuditLog).countBy({
          sessionId,
          eventType: AuthAuditEventType.REFRESH_REUSE_DETECTED,
        }),
      ).toBe(1);
    }
  });

  it('lets a committed user inactivation win before refresh without emitting tokens', async () => {
    const tokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(tokens.refreshToken);
    const user = await connection
      .getRepository(User)
      .findOneByOrFail({ email: ownerEmail });
    const inactivator = connection.createQueryRunner();
    await inactivator.connect();
    await inactivator.startTransaction();
    try {
      await inactivator.query(
        `UPDATE public.users SET status = 'inactive' WHERE id = $1`,
        [user.id],
      );
      const refreshAttempt = beginRefresh(tokens.refreshToken);
      await waitForRuntimeLock('lock_auth_refresh_user');
      await inactivator.commitTransaction();

      expect((await refreshAttempt).status).toBe(401);
      expect(
        await connection.getRepository(AuthRefreshToken).countBy({ sessionId }),
      ).toBe(1);
      expect(
        await connection.getRepository(AuthRefreshToken).countBy({
          sessionId,
          status: AuthRefreshTokenStatus.ACTIVE,
        }),
      ).toBe(0);
    } finally {
      if (inactivator.isTransactionActive)
        await inactivator.rollbackTransaction();
      await inactivator.release();
      await connection
        .getRepository(User)
        .update(user.id, { status: UserStatus.ACTIVE });
    }
  });

  it('holds the user lock from refresh until commit before concurrent inactivation', async () => {
    const tokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(tokens.refreshToken);
    const user = await connection
      .getRepository(User)
      .findOneByOrFail({ email: ownerEmail });
    const sessionBlocker = connection.createQueryRunner();
    const inactivator = connection.createQueryRunner();
    await sessionBlocker.connect();
    await inactivator.connect();
    await sessionBlocker.startTransaction();
    await inactivator.startTransaction();
    try {
      await sessionBlocker.query(
        `SELECT id FROM public.auth_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const refreshAttempt = beginRefresh(tokens.refreshToken);
      await waitForRuntimeLock('FROM public.auth_sessions AS auth_session');

      const inactivation = inactivator.query(
        `UPDATE public.users SET status = 'inactive' WHERE id = $1`,
        [user.id],
      );
      await waitForDatabaseLock('UPDATE public.users SET status');
      await sessionBlocker.commitTransaction();

      const refreshResponse = await refreshAttempt;
      expect(refreshResponse.status).toBe(200);
      const rotated = refreshResponse.body as AuthTokenResponse;
      await inactivation;
      await inactivator.commitTransaction();

      await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated.refreshToken })
        .expect(401);
      expect(
        await connection.getRepository(AuthRefreshToken).countBy({ sessionId }),
      ).toBe(2);
      expect(
        await connection.getRepository(AuthRefreshToken).countBy({
          sessionId,
          status: AuthRefreshTokenStatus.ACTIVE,
        }),
      ).toBe(0);
    } finally {
      if (sessionBlocker.isTransactionActive)
        await sessionBlocker.rollbackTransaction();
      if (inactivator.isTransactionActive)
        await inactivator.rollbackTransaction();
      await sessionBlocker.release();
      await inactivator.release();
      await connection
        .getRepository(User)
        .update(user.id, { status: UserStatus.ACTIVE });
    }
  });

  it.each(['logout', 'logout-all'] as const)(
    'serializes refresh against %s without leaving an active token',
    async (operation) => {
      const authService = app.get(AuthService);
      for (let repetition = 0; repetition < 5; repetition += 1) {
        const tokens = (await login()).body as AuthTokenResponse;
        const sessionId = getSessionId(tokens.refreshToken);
        const currentUser = { userId: tokens.user.id, sessionId };
        const context = {
          ipAddress: '127.0.0.1',
          userAgent: `concurrent-${operation}-${repetition + 1}`,
        };
        const logoutOperation =
          operation === 'logout'
            ? authService.logout(currentUser, context)
            : authService.logoutAll(currentUser, context);

        const [refreshOutcome, logoutOutcome] = await withTimeout(
          Promise.allSettled([
            authService.refresh(tokens.refreshToken, context),
            logoutOperation,
          ]),
          5_000,
          `refresh versus ${operation} repetition ${repetition + 1}`,
        );
        assertNoDeadlock(refreshOutcome, operation, repetition);
        assertNoDeadlock(logoutOutcome, operation, repetition);
        expect(logoutOutcome.status).toBe('fulfilled');
        if (refreshOutcome.status === 'rejected') {
          expect(
            (
              refreshOutcome.reason as { getStatus?: () => number }
            ).getStatus?.(),
          ).toBe(401);
        }

        expect(
          await connection.getRepository(AuthSession).findOneByOrFail({
            id: sessionId,
          }),
        ).toMatchObject({ status: AuthSessionStatus.REVOKED });
        expect(
          await connection.getRepository(AuthRefreshToken).countBy({
            sessionId,
            status: AuthRefreshTokenStatus.ACTIVE,
          }),
        ).toBe(0);
      }
    },
  );

  it('revokes the current session and its active refresh tokens on logout', async () => {
    const tokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(tokens.refreshToken);

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(204);

    expect(
      await connection.getRepository(AuthSession).findOneByOrFail({
        id: sessionId,
      }),
    ).toMatchObject({ status: AuthSessionStatus.REVOKED });
    expect(
      await connection.getRepository(AuthRefreshToken).findOneByOrFail({
        sessionId,
      }),
    ).toMatchObject({ status: AuthRefreshTokenStatus.REVOKED });
    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
  });

  it('revokes all sessions and active refresh tokens on logout-all', async () => {
    const first = (await login()).body as AuthTokenResponse;
    const second = (await login()).body as AuthTokenResponse;
    const sessionIds = [
      getSessionId(first.refreshToken),
      getSessionId(second.refreshToken),
    ];

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .expect(204);

    expect(
      await connection.getRepository(AuthSession).countBy({
        id: sessionIds[0],
        status: AuthSessionStatus.REVOKED,
      }),
    ).toBe(1);
    expect(
      await connection.getRepository(AuthSession).countBy({
        id: sessionIds[1],
        status: AuthSessionStatus.REVOKED,
      }),
    ).toBe(1);
    expect(
      await connection.getRepository(AuthRefreshToken).countBy({
        sessionId: sessionIds[0],
        status: AuthRefreshTokenStatus.ACTIVE,
      }),
    ).toBe(0);
    expect(
      await connection.getRepository(AuthRefreshToken).countBy({
        sessionId: sessionIds[1],
        status: AuthRefreshTokenStatus.ACTIVE,
      }),
    ).toBe(0);
  });

  it('rejects expired and already revoked refresh tokens without rotation', async () => {
    const expired = (await login()).body as AuthTokenResponse;
    const expiredSessionId = getSessionId(expired.refreshToken);
    const expiredRecord = await findRefreshToken(expiredSessionId);
    await connection.getRepository(AuthRefreshToken).update(expiredRecord.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: expired.refreshToken })
      .expect(401);
    expect(
      await connection
        .getRepository(AuthRefreshToken)
        .findOneByOrFail({ id: expiredRecord.id }),
    ).toMatchObject({ status: AuthRefreshTokenStatus.REVOKED });
    expect(
      await connection.getRepository(AuthRefreshToken).countBy({
        sessionId: expiredSessionId,
      }),
    ).toBe(1);

    const revoked = (await login()).body as AuthTokenResponse;
    const revokedSessionId = getSessionId(revoked.refreshToken);
    const revokedRecord = await findRefreshToken(revokedSessionId);
    await connection.getRepository(AuthRefreshToken).update(revokedRecord.id, {
      status: AuthRefreshTokenStatus.REVOKED,
      revokedAt: new Date(),
    });
    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: revoked.refreshToken })
      .expect(401);
    expect(
      await connection.getRepository(AuthSession).findOneByOrFail({
        id: revokedSessionId,
      }),
    ).toMatchObject({ status: AuthSessionStatus.ACTIVE });
  });

  it('uses generic login errors and blocks inactive users', async () => {
    const unknownUser = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.101')
      .send({
        email: 'unknown@example.com',
        password: randomBytes(24).toString('base64url'),
      })
      .expect(401);
    const wrongPassword = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.102')
      .send({
        email: ownerEmail,
        password: randomBytes(24).toString('base64url'),
      })
      .expect(401);
    expect((unknownUser.body as { message: string }).message).toBe(
      'Invalid email or password.',
    );
    expect((wrongPassword.body as { message: string }).message).toBe(
      'Invalid email or password.',
    );

    await connection
      .getRepository(User)
      .update({ email: ownerEmail }, { status: UserStatus.INACTIVE });
    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.103')
      .send({ email: ownerEmail, password: initialOwnerPassword })
      .expect(401);
    await connection
      .getRepository(User)
      .update({ email: ownerEmail }, { status: UserStatus.ACTIVE });
  });

  it('returns 429 for the configured IP and email limit', async () => {
    const server = app.getHttpServer() as Server;
    const credentials = {
      email: 'rate-limited@example.com',
      password: randomBytes(24).toString('base64url'),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '198.51.100.110')
        .send(credentials)
        .expect(401);
    }

    await request(server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.110')
      .send(credentials)
      .expect(429);
  });

  it('cannot evade the aggregate IP limit by alternating emails', async () => {
    const server = app.getHttpServer() as Server;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request(server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '198.51.100.111')
        .send({
          email: `rotating-${attempt}@example.com`,
          password: randomBytes(24).toString('base64url'),
        })
        .expect(401);
    }

    await request(server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.111')
      .send({
        email: 'rotating-final@example.com',
        password: randomBytes(24).toString('base64url'),
      })
      .expect(429);
  });

  it('uses the same trusted proxy IP for rate limiting and audit logs', async () => {
    const limiter = app.get(LoginRateLimiter);
    const assertAllowed = jest.spyOn(limiter, 'assertAllowed');
    const email = 'proxy-audit@example.com';
    const ipAddress = '2001:db8::112';
    const userAgent = 'proxy-audit-e2e';

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', ipAddress)
      .set('User-Agent', userAgent)
      .send({
        email,
        password: randomBytes(24).toString('base64url'),
      })
      .expect(401);

    expect(assertAllowed).toHaveBeenLastCalledWith(ipAddress, email);
    const auditLog = await connection
      .getRepository(AuthAuditLog)
      .findOneByOrFail({
        eventType: AuthAuditEventType.LOGIN_FAILED,
        userAgent,
      });
    expect(auditLog.ipAddress).toBe(ipAddress);
    assertAllowed.mockRestore();
  });

  it('persists IPv4 and IPv6 client addresses in PostgreSQL', async () => {
    const ipv4Tokens = (await login('203.0.113.120')).body as AuthTokenResponse;
    const ipv6Tokens = (await login('2001:db8::120')).body as AuthTokenResponse;

    const ipv4Session = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: getSessionId(ipv4Tokens.refreshToken) });
    const ipv6Session = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: getSessionId(ipv6Tokens.refreshToken) });
    expect(ipv4Session.ipAddress).toBe('203.0.113.120');
    expect(ipv6Session.ipAddress).toBe('2001:db8::120');
  });

  it('rejects expired sessions for access and refresh', async () => {
    const tokens = (await login()).body as AuthTokenResponse;
    const sessionId = getSessionId(tokens.refreshToken);
    await connection.getRepository(AuthSession).update(sessionId, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(401);

    const session = await connection
      .getRepository(AuthSession)
      .findOneByOrFail({ id: sessionId });
    expect(session.status).toBe(AuthSessionStatus.REVOKED);
    expect(
      await connection.getRepository(AuthRefreshToken).countBy({
        sessionId,
        status: AuthRefreshTokenStatus.ACTIVE,
      }),
    ).toBe(0);
  });

  async function findRefreshToken(sessionId: string) {
    return connection
      .getRepository(AuthRefreshToken)
      .createQueryBuilder('refreshToken')
      .addSelect('refreshToken.tokenHash')
      .where('refreshToken.sessionId = :sessionId', { sessionId })
      .orderBy('refreshToken.createdAt', 'ASC')
      .getOneOrFail();
  }

  function beginRefresh(refreshToken: string) {
    return request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .then((response) => response);
  }

  function assertNoDeadlock(
    outcome: PromiseSettledResult<unknown>,
    operation: string,
    repetition: number,
  ): void {
    if (
      outcome.status === 'rejected' &&
      (outcome.reason as { code?: string }).code === '40P01'
    ) {
      throw new Error(
        `Forbidden SQLSTATE 40P01 during refresh versus ${operation} repetition ${repetition + 1}.`,
      );
    }
  }

  async function withTimeout<T>(
    operation: Promise<T>,
    timeoutMilliseconds: number,
    label: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}.`)),
            timeoutMilliseconds,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function waitForRuntimeLock(queryFragment: string): Promise<void> {
    await waitForDatabaseLock(
      queryFragment,
      process.env.DATABASE_RUNTIME_ROLE ?? 'genesis_runtime_test',
    );
  }

  async function waitForDatabaseLock(
    queryFragment: string,
    databaseUser = process.env.TEST_DATABASE_USER ?? 'genesis_test',
  ): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const [{ blocked }] = await connection.query<Array<{ blocked: number }>>(
        `SELECT count(*)::int AS blocked
         FROM pg_stat_activity
         WHERE usename = $1
           AND wait_event_type = 'Lock'
           AND position($2 in query) > 0`,
        [databaseUser, queryFragment],
      );
      if (blocked > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Database query did not block at: ${queryFragment}`);
  }

  function getSessionId(refreshToken: string): string {
    return refreshToken.split('.')[0];
  }

  async function login(ipAddress?: string) {
    const loginRequest = request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password: initialOwnerPassword });
    if (ipAddress !== undefined) {
      loginRequest.set('X-Forwarded-For', ipAddress);
    }
    return loginRequest.expect(200);
  }
});
