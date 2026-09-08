import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthOtpConfig } from '../src/config/auth-otp.config';
import { AuthEmailChallengesService } from '../src/modules/auth-email-challenges/auth-email-challenges.service';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { InMemoryRegistrationRateLimiter } from '../src/modules/auth/services/in-memory-registration-rate-limiter.service';
import { PublicAuthService } from '../src/modules/auth/services/public-auth.service';
import { PasswordHasher } from '../src/modules/credentials/ports/password-hasher.port';
import { PasswordHashCapacity } from '../src/modules/credentials/services/password-hash-capacity.service';

const config: AuthOtpConfig = {
  publicFlowsEnabled: true,
  pepper: Buffer.alloc(32, 7),
  ttlSeconds: 600,
  maxAttempts: 5,
  cooldownSeconds: 60,
  sendWindowSeconds: 3600,
  maxSends: 5,
  emailFrom: 'Genesis <auth@example.test>',
  registrationRateLimitWindowSeconds: 900,
  registrationEmailIpMaxAttempts: 5,
  registrationIpMaxAttempts: 20,
  registrationRateLimitMaxBuckets: 10_000,
};

describe('PublicAuthService', () => {
  const userId = randomUUID();
  const challengeId = randomUUID();
  const now = new Date('2030-01-01T00:00:00.000Z');
  const query = jest.fn();
  const transaction = jest.fn();
  const dataSource = { query, transaction } as unknown as DataSource;
  const hash = jest.fn().mockResolvedValue('$argon2id$test');
  const passwordHasher = { hash } as PasswordHasher;
  const hashRun = jest.fn((operation: () => Promise<unknown>) => operation());
  const capacity = { run: hashRun } as unknown as PasswordHashCapacity;
  const consumeRate = jest.fn();
  const limiter = {
    consume: consumeRate,
  } as unknown as InMemoryRegistrationRateLimiter;
  const issueEmailVerification = jest.fn();
  const resolveEmailVerificationChallenge = jest.fn();
  const consumeEmailVerification = jest.fn();
  const challenges = {
    issueEmailVerification,
    resolveEmailVerificationChallenge,
    consumeEmailVerification,
  } as unknown as AuthEmailChallengesService;
  const record = jest.fn().mockResolvedValue(undefined);
  const audit = { record } as unknown as AuthAuditService;
  const context = { ipAddress: '127.0.0.1', userAgent: 'test' };

  function service(enabled = true): PublicAuthService {
    return new PublicAuthService(
      dataSource,
      new ConfigService({
        authOtp: { ...config, publicFlowsEnabled: enabled },
      }),
      passwordHasher,
      capacity,
      limiter,
      challenges,
      audit,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('fails before rate limit, hash, database, or email when disabled', async () => {
    await expect(
      service(false).register(
        {
          firstName: 'Pessoa',
          lastName: 'Teste',
          email: 'pessoa@example.test',
          password: 'senha-segura-local',
        },
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'AUTH_OTP_PUBLIC_FLOWS_DISABLED' },
    });
    expect(consumeRate).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(issueEmailVerification).not.toHaveBeenCalled();
  });

  it('normalizes, hashes within capacity, creates no session itself, and issues OTP', async () => {
    query.mockResolvedValueOnce([{ exists: false }]);
    const managerQuery = jest.fn().mockResolvedValueOnce([{ user_id: userId }]);
    const manager = { query: managerQuery } as unknown as EntityManager;
    transaction.mockImplementationOnce(
      (operation: (target: EntityManager) => Promise<unknown>) =>
        operation(manager),
    );
    issueEmailVerification.mockResolvedValueOnce({
      status: 'sent',
      challengeId,
      expiresAt: new Date(now.getTime() + 600_000),
      resendAvailableAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      service().register(
        {
          firstName: ' Pessoa ',
          lastName: ' Teste ',
          email: ' Pessoa@Example.Test ',
          password: 'senha-segura-local',
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: 'verification_required',
      delivery: 'sent',
      challengeId,
    });
    expect(consumeRate).toHaveBeenCalledWith(
      context.ipAddress,
      'pessoa@example.test',
    );
    expect(hashRun).toHaveBeenCalledTimes(1);
    expect(managerQuery).toHaveBeenCalledWith(
      expect.stringContaining('app_private.register_unverified_user'),
      ['pessoa@example.test', 'Pessoa Teste', '$argon2id$test'],
    );
    expect(issueEmailVerification).toHaveBeenCalledWith(userId);
  });

  it('preserves the pending account when email delivery is unavailable', async () => {
    query.mockResolvedValueOnce([{ exists: false }]);
    const managerQuery = jest.fn().mockResolvedValueOnce([{ user_id: userId }]);
    const manager = { query: managerQuery } as unknown as EntityManager;
    transaction.mockImplementationOnce(
      (operation: (target: EntityManager) => Promise<unknown>) =>
        operation(manager),
    );
    issueEmailVerification.mockResolvedValueOnce({
      status: 'delivery_unavailable',
      challengeId,
      expiresAt: new Date(now.getTime() + 600_000),
      resendAvailableAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      service().register(
        {
          firstName: 'Pessoa',
          lastName: 'Pendente',
          email: 'pendente@example.test',
          password: 'senha-segura-local',
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: 'verification_required',
      delivery: 'delivery_unavailable',
      challengeId,
    });
    expect(managerQuery).toHaveBeenCalledWith(
      expect.stringContaining('app_private.register_unverified_user'),
      expect.any(Array),
    );
  });

  it('resends only for the user resolved from the challenge and returns the replacement handle', async () => {
    const replacementChallengeId = randomUUID();
    resolveEmailVerificationChallenge.mockResolvedValueOnce({
      challengeId,
      userId,
      expiresAt: new Date(now.getTime() + 600_000),
      resendAvailableAt: now,
      stage: 'otp',
      emailVerifiedAt: null,
    });
    issueEmailVerification.mockResolvedValueOnce({
      status: 'sent',
      challengeId: replacementChallengeId,
      expiresAt: new Date(now.getTime() + 600_000),
      resendAvailableAt: new Date(now.getTime() + 60_000),
    });

    await expect(service().resend(challengeId)).resolves.toMatchObject({
      status: 'verification_required',
      delivery: 'sent',
      challengeId: replacementChallengeId,
    });
    expect(issueEmailVerification).toHaveBeenCalledWith(userId);
  });

  it('binds verification to the internally resolved challenge and revokes sessions', async () => {
    resolveEmailVerificationChallenge.mockResolvedValueOnce({
      challengeId,
      userId,
      expiresAt: new Date(now.getTime() + 600_000),
      resendAvailableAt: new Date(now.getTime() + 60_000),
      stage: 'otp',
      emailVerifiedAt: null,
    });
    consumeEmailVerification.mockResolvedValueOnce(true);
    const managerQuery = jest
      .fn()
      .mockResolvedValueOnce([{ verified: true }])
      .mockResolvedValueOnce([{ id: randomUUID() }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const manager = { query: managerQuery } as unknown as EntityManager;
    transaction.mockImplementationOnce(
      (operation: (target: EntityManager) => Promise<unknown>) =>
        operation(manager),
    );

    await expect(
      service().verify(challengeId, '123456', context),
    ).resolves.toEqual({ status: 'email_verified' });
    expect(consumeEmailVerification).toHaveBeenCalledWith(
      userId,
      challengeId,
      '123456',
    );
    expect(managerQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('app_private.verify_user_email'),
      [userId, challengeId],
    );
    expect(managerQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT id FROM public.auth_sessions'),
      [userId],
    );
    expect(managerQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE public.auth_sessions'),
      expect.any(Array),
    );
    expect(managerQuery).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('UPDATE public.auth_refresh_tokens'),
      expect.any(Array),
    );
  });

  it('rejects replay after a challenge was consumed and the user was verified', async () => {
    resolveEmailVerificationChallenge.mockResolvedValueOnce({
      challengeId,
      userId,
      expiresAt: new Date(now.getTime() + 600_000),
      resendAvailableAt: new Date(now.getTime() + 60_000),
      stage: 'consumed',
      emailVerifiedAt: now,
    });
    consumeEmailVerification.mockResolvedValueOnce(false);

    await expect(
      service().verify(challengeId, '123456', context),
    ).rejects.toMatchObject({
      response: { code: 'AUTH_EMAIL_VERIFICATION_INVALID' },
    });
    expect(consumeEmailVerification).toHaveBeenCalledWith(
      userId,
      challengeId,
      '123456',
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fails closed when persistence fails after OTP consumption', async () => {
    resolveEmailVerificationChallenge.mockResolvedValueOnce({
      challengeId,
      userId,
      expiresAt: new Date(now.getTime() + 600_000),
      resendAvailableAt: new Date(now.getTime() + 60_000),
      stage: 'otp',
      emailVerifiedAt: null,
    });
    consumeEmailVerification.mockResolvedValueOnce(true);
    transaction.mockRejectedValueOnce(
      new Error('synthetic transaction failure'),
    );

    await expect(
      service().verify(challengeId, '123456', context),
    ).rejects.toThrow('synthetic transaction failure');
    expect(consumeEmailVerification).toHaveBeenCalledTimes(1);
  });
});
