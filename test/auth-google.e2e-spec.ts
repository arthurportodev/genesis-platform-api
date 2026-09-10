import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
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
import { AuthIdentity } from '../src/modules/auth/entities/auth-identity.entity';
import { AuthGoogleChallenge } from '../src/modules/auth/entities/auth-google-challenge.entity';
import { GoogleAuthService } from '../src/modules/auth/services/google-auth.service';
import {
  GOOGLE_IDENTITY_VERIFIER,
  VerifiedGoogleIdentity,
} from '../src/modules/auth/ports/google-identity-verifier.port';
import { hashPassword } from '../src/modules/credentials/password-policy';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import { configureTrustProxy } from '../src/config/trust-proxy';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

interface GoogleAuthBody {
  accessToken: string;
  user: { email: string };
}

let contextSequence = 1;

describe('Google identity public API', () => {
  let app: NestExpressApplication;
  let owner: DataSource;
  const assertions = new Map<string, VerifiedGoogleIdentity>();
  const messages: EmailMessage[] = [];
  const transport: EmailTransport = {
    send: (message) => {
      messages.push(message);
      return Promise.resolve({ kind: 'sent', providerMessageId: randomUUID() });
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
    process.env.TRUST_PROXY_HOPS = '1';
    process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'public.apps.googleusercontent.com';

    const { AppModule } = await import('../src/app.module');
    owner = createIntegrationDataSource({
      includePasswordReset: true,
      includeGoogleIdentity: true,
    });
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AUTH_OTP_EMAIL_TRANSPORT)
      .useValue(transport)
      .overrideProvider(GOOGLE_IDENTITY_VERIFIER)
      .useValue({
        verify: (credential: string) => {
          const claims = assertions.get(credential);
          return claims
            ? Promise.resolve(claims)
            : Promise.reject(new Error('invalid'));
        },
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureTrustProxy(app, 1);
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
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  it('creates a Google-first User without Organization and resolves later by subject', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    await request(server).post('/api/v1/auth/google/challenge').expect(403);
    const challenge = await issue(server, csrf);
    const subject = `subject-${randomUUID()}`;
    const email = `${randomUUID()}@gmail.com`;
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(subject, email, challenge.nonce, { name: 'Google Person' }),
    );
    const first = await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential })
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(first.body).toMatchObject({
      tokenType: 'Bearer',
      user: { email, name: 'Google Person' },
    });
    expect(first.headers['set-cookie']).toBeDefined();
    const user = await owner
      .getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email=:email', { email })
      .getOneOrFail();
    expect(user.passwordHash).toBeNull();
    expect(
      await owner.query(
        `SELECT count(*)::int AS count FROM memberships WHERE user_id=$1`,
        [user.id],
      ),
    ).toEqual([{ count: 0 }]);

    const secondChallenge = await issue(server, csrf);
    const changedProviderEmail = `${randomUUID()}@gmail.com`;
    const secondCredential = `credential-${randomUUID()}`;
    assertions.set(
      secondCredential,
      claims(subject, changedProviderEmail, secondChallenge.nonce, {
        name: 'Changed Name Ignored',
      }),
    );
    await mutate(server, csrf, 'google')
      .send({
        challengeToken: secondChallenge.challengeToken,
        credential: secondCredential,
      })
      .expect(200);
    const stable = await owner
      .getRepository(User)
      .findOneByOrFail({ id: user.id });
    const identity = await owner
      .getRepository(AuthIdentity)
      .findOneByOrFail({ userId: user.id });
    expect(stable.email).toBe(email);
    expect(stable.name).toBe('Google Person');
    expect(identity.providerEmail).toBe(changedProviderEmail);
  });

  it('requires Genesis OTP for a new external-email Google account', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const challenge = await issue(server, csrf);
    const email = `${randomUUID()}@example.test`;
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(`subject-${randomUUID()}`, email, challenge.nonce, {
        name: 'External Person',
      }),
    );
    const response = await mutate(server, csrf, 'google')
      .send({
        challengeToken: challenge.challengeToken,
        credential,
      })
      .expect(403);
    const body = response.body as {
      code?: unknown;
      continuation?: { challengeId?: unknown };
    };
    expect(body.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    expect(typeof body.continuation?.challengeId).toBe('string');
    expect(
      (await owner.getRepository(User).findOneByOrFail({ email }))
        .emailVerifiedAt,
    ).toBeNull();
    expect(messages.at(-1)?.to).toBe(email);
  });

  it('accepts Workspace authority and creates no tenant records', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const challenge = await issue(server, csrf);
    const email = `${randomUUID()}@workspace.example`;
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(`subject-${randomUUID()}`, email, challenge.nonce, {
        hostedDomain: 'workspace.example',
        name: 'Workspace Person',
      }),
    );
    const response = await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential })
      .expect(200);
    const user = await owner.getRepository(User).findOneByOrFail({ email });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((response.body as GoogleAuthBody).user.email).toBe(email);
    const [counts] = await owner.query<
      Array<{ organizations: number; memberships: number }>
    >(
      `SELECT
        (SELECT count(*)::int FROM organizations) AS organizations,
        (SELECT count(*)::int FROM memberships WHERE user_id=$1) AS memberships`,
      [user.id],
    );
    expect(counts).toEqual({ organizations: 0, memberships: 0 });
  });

  it('maps controlled assertion failures and exhausts the challenge budget', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    for (const reason of ['audience', 'issuer', 'expiration']) {
      const isolated = await issue(server, csrf);
      await mutate(server, csrf, 'google')
        .send({
          challengeToken: isolated.challengeToken,
          credential: `invalid-${reason}-${randomUUID()}`,
        })
        .expect(400);
    }

    const challenge = await issue(server, csrf);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await mutate(server, csrf, 'google')
        .send({
          challengeToken: challenge.challengeToken,
          credential: `invalid-${randomUUID()}`,
        })
        .expect(400);
    }
    const exhausted = await owner
      .getRepository(AuthGoogleChallenge)
      .createQueryBuilder('challenge')
      .addSelect('challenge.tokenHash')
      .orderBy('challenge.createdAt', 'DESC')
      .getOneOrFail();
    expect(exhausted.failedAttempts).toBe(5);
    const validCredential = `credential-${randomUUID()}`;
    assertions.set(
      validCredential,
      claims(
        `subject-${randomUUID()}`,
        `${randomUUID()}@gmail.com`,
        challenge.nonce,
        {
          name: 'Budget Exhausted',
        },
      ),
    );
    await mutate(server, csrf, 'google')
      .send({
        challengeToken: challenge.challengeToken,
        credential: validCredential,
      })
      .expect(400);
  });

  it('allows a corrected nonce once and rejects challenge replay', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const challenge = await issue(server, csrf);
    const subject = `subject-${randomUUID()}`;
    const email = `${randomUUID()}@gmail.com`;
    const wrong = `credential-${randomUUID()}`;
    assertions.set(
      wrong,
      claims(subject, email, 'wrong-nonce', { name: 'Nonce Person' }),
    );
    await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential: wrong })
      .expect(400);
    const correct = `credential-${randomUUID()}`;
    assertions.set(
      correct,
      claims(subject, email, challenge.nonce, { name: 'Nonce Person' }),
    );
    await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential: correct })
      .expect(200);
    await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential: correct })
      .expect(400);
  });

  it('rejects an expired challenge and serializes concurrent first login', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const expired = await issue(server, csrf);
    await owner.query(
      `UPDATE auth_google_challenges SET expires_at=now()-interval '1 second'
       WHERE created_at=(SELECT max(created_at) FROM auth_google_challenges)`,
    );
    const expiredCredential = `credential-${randomUUID()}`;
    assertions.set(
      expiredCredential,
      claims(
        `subject-${randomUUID()}`,
        `${randomUUID()}@gmail.com`,
        expired.nonce,
        {
          name: 'Expired Person',
        },
      ),
    );
    await mutate(server, csrf, 'google')
      .send({
        challengeToken: expired.challengeToken,
        credential: expiredCredential,
      })
      .expect(400);

    const challenge = await issue(server, csrf);
    const subject = `subject-${randomUUID()}`;
    const email = `${randomUUID()}@gmail.com`;
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(subject, email, challenge.nonce, { name: 'Concurrent Person' }),
    );
    const attempts = await Promise.all([
      mutate(server, csrf, 'google').send({
        challengeToken: challenge.challengeToken,
        credential,
      }),
      mutate(server, csrf, 'google').send({
        challengeToken: challenge.challengeToken,
        credential,
      }),
    ]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([200, 400]);
    expect(await owner.getRepository(User).countBy({ email })).toBe(1);
    expect(
      await owner
        .getRepository(AuthIdentity)
        .countBy({ providerSubject: subject }),
    ).toBe(1);
  });

  it('rejects an inactive linked User without moving the identity', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const email = `${randomUUID()}@gmail.com`;
    const subject = `subject-${randomUUID()}`;
    const user = await owner.getRepository(User).save({
      email,
      name: 'Inactive Google User',
      status: UserStatus.INACTIVE,
      passwordHash: null,
      passwordChangedAt: null,
      emailVerifiedAt: new Date(),
    });
    await owner.getRepository(AuthIdentity).save({
      userId: user.id,
      provider: 'google',
      providerSubject: subject,
      providerEmail: email,
      lastLoginAt: null,
    });
    const challenge = await issue(server, csrf);
    const credential = `credential-${randomUUID()}`;
    assertions.set(credential, claims(subject, email, challenge.nonce));
    await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential })
      .expect(400);
    expect(
      await owner.getRepository(AuthIdentity).countBy({ userId: user.id }),
    ).toBe(1);
  });

  it('requires the current password before linking an existing verified User', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const password = 'existing-password-value';
    const email = `${randomUUID()}@example.test`;
    const user = await owner.getRepository(User).save(
      owner.getRepository(User).create({
        email,
        name: 'Existing User',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
        emailVerifiedAt: new Date(),
      }),
    );
    const challenge = await issue(server, csrf);
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(`subject-${randomUUID()}`, email, challenge.nonce, {
        name: 'Ignored Google Name',
      }),
    );
    const pending = await mutate(server, csrf, 'google')
      .send({
        challengeToken: challenge.challengeToken,
        credential,
      })
      .expect(409);
    expect(pending.body).toMatchObject({ code: 'AUTH_GOOGLE_LINK_REQUIRED' });
    await mutate(server, csrf, 'google/link')
      .send({
        challengeToken: challenge.challengeToken,
        password: 'wrong-password-value',
      })
      .expect(401);
    await mutate(server, csrf, 'google/link')
      .send({
        challengeToken: challenge.challengeToken,
        password,
      })
      .expect(200);
    expect(await owner.getRepository(User).countBy({ email })).toBe(1);
    expect(
      await owner.getRepository(AuthIdentity).countBy({ userId: user.id }),
    ).toBe(1);
  });

  it('exhausts link proof attempts before a later correct password', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const password = 'existing-password-value';
    const email = `${randomUUID()}@example.test`;
    await owner.getRepository(User).save({
      email,
      name: 'Protected Link User',
      status: UserStatus.ACTIVE,
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
      emailVerifiedAt: new Date(),
    });
    const challenge = await issue(server, csrf);
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(`subject-${randomUUID()}`, email, challenge.nonce, {
        name: 'Protected Link User',
      }),
    );
    await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential })
      .expect(409);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await mutate(server, csrf, 'google/link')
        .send({
          challengeToken: challenge.challengeToken,
          password: 'wrong-password',
        })
        .expect(401);
    }
    await mutate(server, csrf, 'google/link')
      .send({ challengeToken: challenge.challengeToken, password })
      .expect(400);
  });

  it('continues missing Google profile data without retaining the assertion', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const challenge = await issue(server, csrf);
    const email = `${randomUUID()}@gmail.com`;
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(`subject-${randomUUID()}`, email, challenge.nonce),
    );
    await mutate(server, csrf, 'google')
      .send({
        challengeToken: challenge.challengeToken,
        credential,
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'AUTH_GOOGLE_PROFILE_REQUIRED' }),
      );
    assertions.delete(credential);
    await mutate(server, csrf, 'google/profile')
      .send({
        challengeToken: challenge.challengeToken,
        firstName: 'Profile',
        lastName: 'Person',
      })
      .expect(200);
    const user = await owner.getRepository(User).findOneByOrFail({ email });
    expect(user.name).toBe('Profile Person');
  });

  it('reuses the normal Genesis session for me, bootstrap, refresh and logout', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const challenge = await issue(server, csrf);
    const email = `${randomUUID()}@gmail.com`;
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(`subject-${randomUUID()}`, email, challenge.nonce, {
        name: 'Session Person',
      }),
    );
    const authenticated = await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential })
      .expect(200);
    const authenticatedBody = authenticated.body as GoogleAuthBody;
    const refreshCookie = (
      authenticated.headers['set-cookie'] as unknown as string[]
    )
      .find((value) => value.startsWith('genesis_refresh_dev='))!
      .split(';', 1)[0];
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${authenticatedBody.accessToken}`)
      .expect(200)
      .expect(({ body }: { body: { email: string } }) =>
        expect(body.email).toBe(email),
      );
    await request(server)
      .get('/api/v1/auth/bootstrap')
      .set('Authorization', `Bearer ${authenticatedBody.accessToken}`)
      .expect(200)
      .expect(({ body }: { body: { organizations: unknown[] } }) =>
        expect(body.organizations).toEqual([]),
      );
    const refreshed = await mutate(
      server,
      {
        cookie: `${csrf.cookie}; ${refreshCookie}`,
        token: csrf.token,
      },
      'refresh',
    )
      .send({})
      .expect(200);
    const refreshedBody = refreshed.body as GoogleAuthBody;
    const refreshedCookie = (
      refreshed.headers['set-cookie'] as unknown as string[]
    )
      .find((value) => value.startsWith('genesis_refresh_dev='))!
      .split(';', 1)[0];
    await mutate(
      server,
      {
        cookie: `${csrf.cookie}; ${refreshedCookie}`,
        token: csrf.token,
      },
      'logout',
    )
      .send({})
      .expect(204);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshedBody.accessToken}`)
      .expect(401);

    const secondChallenge = await issue(server, csrf);
    const secondCredential = `credential-${randomUUID()}`;
    const identity = await owner
      .getRepository(AuthIdentity)
      .findOneByOrFail({ providerEmail: email });
    assertions.set(
      secondCredential,
      claims(identity.providerSubject, email, secondChallenge.nonce, {
        name: 'Ignored Known Name',
      }),
    );
    const secondSession = await mutate(server, csrf, 'google')
      .send({
        challengeToken: secondChallenge.challengeToken,
        credential: secondCredential,
      })
      .expect(200);
    const secondSessionBody = secondSession.body as GoogleAuthBody;
    const secondRefreshCookie = (
      secondSession.headers['set-cookie'] as unknown as string[]
    )
      .find((value) => value.startsWith('genesis_refresh_dev='))!
      .split(';', 1)[0];
    await mutate(
      server,
      { cookie: `${csrf.cookie}; ${secondRefreshCookie}`, token: csrf.token },
      'logout-all',
    )
      .set('Authorization', `Bearer ${secondSessionBody.accessToken}`)
      .send({})
      .expect(204);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${secondSessionBody.accessToken}`)
      .expect(401);
  });

  it('lets a Google-first User set the first password through the existing reset flow', async () => {
    const server = app.getHttpServer();
    const csrf = await csrfContext(server);
    const challenge = await issue(server, csrf);
    const email = `${randomUUID()}@gmail.com`;
    const credential = `credential-${randomUUID()}`;
    assertions.set(
      credential,
      claims(`subject-${randomUUID()}`, email, challenge.nonce, {
        name: 'Google Reset Person',
      }),
    );
    await mutate(server, csrf, 'google')
      .send({ challengeToken: challenge.challengeToken, credential })
      .expect(200);
    await mutate(server, csrf, 'password-reset/request')
      .send({ email })
      .expect(202);
    const code = messages.at(-1)?.text.match(/\b\d{6}\b/u)?.[0];
    expect(code).toMatch(/^\d{6}$/u);
    const password = 'google-first-password-value';
    await mutate(server, csrf, 'password-reset/complete')
      .send({ email, code, password })
      .expect(200);
    await mutate(server, csrf, 'login')
      .send({ email, password })
      .expect(200)
      .expect(({ body }: { body: GoogleAuthBody }) =>
        expect(body.user.email).toBe(email),
      );
  });

  it('fails closed at every public Google endpoint when the feature is disabled', async () => {
    const service = app.get(GoogleAuthService);
    const mutableConfig = (
      service as unknown as { config: { publicFlowEnabled: boolean } }
    ).config;
    mutableConfig.publicFlowEnabled = false;
    try {
      const server = app.getHttpServer();
      const csrf = await csrfContext(server);
      await request(server)
        .get('/api/v1/auth/google/config')
        .expect(200)
        .expect({ enabled: false, clientId: null });
      await mutate(server, csrf, 'google/challenge').send({}).expect(503);
      await mutate(server, csrf, 'google')
        .send({ challengeToken: 'c'.repeat(43), credential: 'disabled' })
        .expect(503);
    } finally {
      mutableConfig.publicFlowEnabled = true;
    }
  });
});

function claims(
  subject: string,
  email: string,
  nonce: string,
  profile: Partial<VerifiedGoogleIdentity> = {},
): VerifiedGoogleIdentity {
  return {
    subject,
    email,
    emailVerified: true,
    nonce,
    hostedDomain: null,
    name: null,
    givenName: null,
    familyName: null,
    ...profile,
  };
}

async function csrfContext(
  server: Server,
): Promise<{ cookie: string; token: string; ip: string }> {
  const response = await request(server).get('/api/v1/auth/csrf').expect(200);
  const token = (response.body as { csrfToken: string }).csrfToken;
  const cookie = (response.headers['set-cookie'] as unknown as string[])
    .find((value) => value.startsWith('genesis_csrf_dev='))!
    .split(';', 1)[0];
  const ip = `192.0.2.${contextSequence}`;
  contextSequence += 1;
  return { cookie, token, ip };
}

async function issue(
  server: Server,
  csrf: { cookie: string; token: string; ip?: string },
) {
  const response = await mutate(server, csrf, 'google/challenge').expect(201);
  return response.body as {
    challengeToken: string;
    nonce: string;
    expiresAt: string;
  };
}

function mutate(
  server: Server,
  csrf: { cookie: string; token: string; ip?: string },
  path: string,
) {
  return request(server)
    .post(`/api/v1/auth/${path}`)
    .set('Origin', 'http://localhost:5173')
    .set('Cookie', csrf.cookie)
    .set('X-Forwarded-For', csrf.ip ?? '192.0.2.254')
    .set('x-csrf-token', csrf.token);
}
