import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { Repository } from 'typeorm';
import { AuthRefreshToken } from '../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import authGoogleConfig, {
  AuthGoogleConfig,
} from '../src/config/auth-google.config';
import { AuthGoogleChallenge } from '../src/modules/auth/entities/auth-google-challenge.entity';
import { GoogleChallengeService } from '../src/modules/auth/services/google-challenge.service';
import { GoogleAuthService } from '../src/modules/auth/services/google-auth.service';
import { GoogleIdentityVerifierService } from '../src/modules/auth/services/google-identity-verifier.service';
import { InMemoryGoogleAuthRateLimiter } from '../src/modules/auth/services/in-memory-google-auth-rate-limiter.service';
import { GenesisSessionIssuer } from '../src/modules/auth/services/genesis-session-issuer.service';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import { User } from '../src/modules/users/entities/user.entity';

const config: AuthGoogleConfig = {
  publicFlowEnabled: true,
  clientId: 'public-client.apps.googleusercontent.com',
  challengeTtlSeconds: 300,
  maxAttempts: 5,
  rateLimitWindowSeconds: 900,
  challengeIpMaxAttempts: 30,
  verificationIpMaxAttempts: 20,
  maxBuckets: 10_000,
};

const CONTROLLED_NOW_SECONDS = 1_900_000_000;

describe('Google authentication foundation', () => {
  const originalFlag = process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  const originalOtpFlag = process.env.AUTH_OTP_PUBLIC_FLOWS_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined)
      delete process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED;
    else process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED = originalFlag;
    if (originalClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
    if (originalOtpFlag === undefined)
      delete process.env.AUTH_OTP_PUBLIC_FLOWS_ENABLED;
    else process.env.AUTH_OTP_PUBLIC_FLOWS_ENABLED = originalOtpFlag;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('is disabled by default and fails closed without the public client ID', () => {
    delete process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED;
    delete process.env.GOOGLE_CLIENT_ID;
    expect(authGoogleConfig()).toMatchObject({
      publicFlowEnabled: false,
      clientId: null,
    });
    process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED = 'true';
    expect(() => authGoogleConfig()).toThrow('requires GOOGLE_CLIENT_ID');
    process.env.GOOGLE_CLIENT_ID = 'public-client.apps.googleusercontent.com';
    expect(() => authGoogleConfig()).toThrow(
      'requires the public OTP foundation',
    );
  });

  it('verifies a signed Google token with controlled certificates and clock', async () => {
    const harness = realVerifierHarness();
    const verified = await harness.service.verify(
      harness.token({
        email: ' Person@Gmail.com ',
        hd: 'Example.COM',
      }),
    );
    expect(verified).toMatchObject({
      subject: 'google-subject',
      email: 'person@gmail.com',
      emailVerified: true,
      nonce: 'challenge-nonce',
      hostedDomain: 'example.com',
    });
  });

  it.each([
    ['issuer', { iss: 'https://issuer.example.test' }],
    ['audience', { aud: 'other-client.apps.googleusercontent.com' }],
    ['expiration', { exp: CONTROLLED_NOW_SECONDS - 600 }],
    ['subject', { sub: ' ' }],
    ['email', { email: 'not-an-email' }],
    ['verified email', { email_verified: false }],
    ['nonce', { nonce: '' }],
  ])(
    'rejects an invalid %s claim in the real adapter',
    async (_label, claim) => {
      const harness = realVerifierHarness();
      await expect(
        harness.service.verify(harness.token(claim)),
      ).rejects.toThrow();
    },
  );

  it('enforces separate bounded challenge and verification rate limits', () => {
    const limiter = new InMemoryGoogleAuthRateLimiter(
      new ConfigService({
        authGoogle: {
          ...config,
          challengeIpMaxAttempts: 2,
          verificationIpMaxAttempts: 1,
        },
      }),
    );
    limiter.assertAllowed('challenge', '203.0.113.1');
    limiter.assertAllowed('challenge', '203.0.113.1');
    expect(() => limiter.assertAllowed('challenge', '203.0.113.1')).toThrow();
    limiter.assertAllowed('verify', '203.0.113.1');
    expect(() => limiter.assertAllowed('verify', '203.0.113.1')).toThrow();
  });

  it('issues the same Genesis session contract for a Google method', async () => {
    const sessionRows: unknown[] = [];
    const refreshRows: unknown[] = [];
    const repository = (rows: unknown[]) => ({
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: unknown) => {
        rows.push(value);
        return Promise.resolve(value);
      }),
    });
    const sessions = repository(sessionRows);
    const refreshTokens = repository(refreshRows);
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === AuthSession ? sessions : refreshTokens,
      ),
    };
    const expiration = new Date('2030-01-01T00:00:00.000Z');
    const tokens = {
      generateRefreshToken: jest.fn(() => 'refresh-secret'),
      issueAccessToken: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        expiresIn: 900,
      }),
      getRefreshExpiration: jest.fn(() => expiration),
      hashRefreshToken: jest.fn(() => 'refresh-hash'),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const issuer = new GenesisSessionIssuer(tokens as never, audit as never);
    const result = await issuer.issue(
      manager as never,
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Google Person',
        email: 'person@gmail.com',
        status: UserStatus.ACTIVE,
      } as never,
      { ipAddress: '203.0.113.5', userAgent: 'controlled-agent' },
      'google',
    );
    expect(result).toMatchObject({
      response: {
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresIn: 900,
        user: { email: 'person@gmail.com' },
      },
      refreshToken: 'refresh-secret',
      refreshExpiresAt: expiration,
    });
    expect(sessionRows).toHaveLength(1);
    expect(refreshRows).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { method: 'google' } }),
      manager,
    );
    expect(manager.getRepository).toHaveBeenCalledWith(AuthRefreshToken);
  });

  it('persists only hashes of 256-bit challenge material', async () => {
    const saved: Partial<AuthGoogleChallenge>[] = [];
    const deleteBuilder = {
      delete: jest.fn(),
      where: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    deleteBuilder.delete.mockReturnValue(deleteBuilder);
    deleteBuilder.where.mockReturnValue(deleteBuilder);
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(deleteBuilder),
      countBy: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Partial<AuthGoogleChallenge>) => value),
      save: jest.fn((value: Partial<AuthGoogleChallenge>) => {
        saved.push(value);
        return Promise.resolve(value);
      }),
    } as unknown as Repository<AuthGoogleChallenge>;
    const service = new GoogleChallengeService(
      repository,
      new ConfigService({ authGoogle: config }),
    );
    const issued = await service.issue();
    expect(issued.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(saved[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(saved[0]?.nonceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(saved[0])).not.toContain(issued.challengeToken);
    expect(JSON.stringify(saved[0])).not.toContain(issued.nonce);
  });

  it('rejects linking when the password hash changes after password proof', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const email = 'person@example.com';
    const challenge = {
      userId,
      providerEmail: email,
      providerSubject: 'google-subject',
    };
    const userQuery = (user: Partial<User>) => {
      const builder = {
        addSelect: jest.fn(),
        where: jest.fn(),
        getOne: jest.fn().mockResolvedValue(user),
      };
      builder.addSelect.mockReturnValue(builder);
      builder.where.mockReturnValue(builder);
      return { createQueryBuilder: jest.fn().mockReturnValue(builder) };
    };
    const snapshotManager = {
      getRepository: jest.fn((entity: unknown) => {
        expect(entity).toBe(User);
        return userQuery({ id: userId, passwordHash: 'hash-before' });
      }),
    };
    const lockedQuery = jest.fn().mockResolvedValue([]);
    const lockedManager = {
      query: lockedQuery,
      getRepository: jest.fn((entity: unknown) => {
        expect(entity).toBe(User);
        return userQuery({
          id: userId,
          email,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date('2030-01-01T00:00:00.000Z'),
          passwordHash: 'hash-after',
        });
      }),
    };
    const managers = [snapshotManager, lockedManager];
    const dataSource = {
      transaction: jest.fn((work: (manager: unknown) => Promise<unknown>) =>
        work(managers.shift() as unknown),
      ),
    };
    const passwords = {
      verifyForLogin: jest.fn().mockResolvedValue(true),
    };
    const hashCapacity = {
      run: jest.fn((work: () => Promise<boolean>) => work()),
    };
    const challenges = {
      resolve: jest.fn().mockResolvedValue(challenge),
      consume: jest.fn(),
    };
    const sessions = { issue: jest.fn() };
    const limiter = { assertAllowed: jest.fn() };
    const service = new GoogleAuthService(
      dataSource as never,
      new ConfigService({ authGoogle: config }),
      {} as never,
      passwords,
      hashCapacity as never,
      challenges as never,
      sessions as never,
      limiter as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.link(
        { challengeToken: 'challenge-token', password: 'current-password' },
        { ipAddress: '203.0.113.10', userAgent: 'controlled-agent' },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwords.verifyForLogin).toHaveBeenCalledWith(
      'hash-before',
      'current-password',
    );
    expect(lockedQuery).toHaveBeenCalledWith(
      'SELECT app_private.lock_auth_refresh_user($1::uuid)',
      [userId],
    );
    expect(challenges.consume).not.toHaveBeenCalled();
    expect(sessions.issue).not.toHaveBeenCalled();
  });
});

function realVerifierHarness() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const certificate = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  jest.useFakeTimers({ now: CONTROLLED_NOW_SECONDS * 1_000 });
  jest
    .spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync')
    .mockResolvedValue({
      certs: { controlled: certificate },
      format: 'PEM' as never,
      res: null,
    });
  const service = new GoogleIdentityVerifierService(
    new ConfigService({ authGoogle: config }),
  );
  return {
    service,
    token: (overrides: Record<string, unknown> = {}) => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'controlled' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'https://accounts.google.com',
          aud: config.clientId,
          iat: CONTROLLED_NOW_SECONDS - 60,
          exp: CONTROLLED_NOW_SECONDS + 600,
          sub: 'google-subject',
          email: 'person@gmail.com',
          email_verified: true,
          nonce: 'challenge-nonce',
          name: 'Google Person',
          ...overrides,
        }),
      ).toString('base64url');
      const signed = `${header}.${payload}`;
      const signature = createSign('RSA-SHA256')
        .update(signed)
        .end()
        .sign(privateKey)
        .toString('base64url');
      return `${signed}.${signature}`;
    },
  };
}
