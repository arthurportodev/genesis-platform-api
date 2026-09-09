import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthOtpConfig } from '../src/config/auth-otp.config';
import { AuthEmailChallengesService } from '../src/modules/auth-email-challenges/auth-email-challenges.service';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { InMemoryPasswordResetRateLimiter } from '../src/modules/auth/services/in-memory-password-reset-rate-limiter.service';
import {
  PASSWORD_RESET_PUBLIC_RESPONSE_FLOOR_MS,
  PasswordResetService,
} from '../src/modules/auth/services/password-reset.service';
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
  passwordResetPublicFlowEnabled: true,
  passwordResetRateLimitWindowSeconds: 900,
  passwordResetIpMaxAttempts: 20,
  passwordResetEmailIpMaxAttempts: 5,
};

describe('PasswordResetService', () => {
  const userId = randomUUID();
  const challengeId = randomUUID();
  const query = jest.fn();
  const transaction = jest.fn();
  const dataSource = { query, transaction } as unknown as DataSource;
  const hash = jest.fn().mockResolvedValue('$argon2id$test');
  const passwordHasher = { hash } as PasswordHasher;
  const hashRun = jest.fn((operation: () => Promise<unknown>) => operation());
  const capacity = { run: hashRun } as unknown as PasswordHashCapacity;
  const consumeRequest = jest.fn();
  const consumeComplete = jest.fn();
  const limiter = {
    consumeRequest,
    consumeComplete,
  } as unknown as InMemoryPasswordResetRateLimiter;
  const issuePasswordReset = jest.fn();
  const consumeCurrentPasswordResetInTransaction = jest.fn();
  const challenges = {
    issuePasswordReset,
    consumeCurrentPasswordResetInTransaction,
  } as unknown as AuthEmailChallengesService;
  const record = jest.fn().mockResolvedValue(undefined);
  const audit = { record } as unknown as AuthAuditService;
  const context = { ipAddress: '127.0.0.1', userAgent: 'test' };

  function service(enabled = true): PasswordResetService {
    return new PasswordResetService(
      dataSource,
      new ConfigService({
        authOtp: { ...config, passwordResetPublicFlowEnabled: enabled },
      }),
      passwordHasher,
      capacity,
      limiter,
      challenges,
      audit,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z') });
  });

  afterEach(() => jest.useRealTimers());

  async function finishFloor<T>(promise: Promise<T>): Promise<T> {
    await jest.advanceTimersByTimeAsync(
      PASSWORD_RESET_PUBLIC_RESPONSE_FLOOR_MS,
    );
    return promise;
  }

  it('fails before limiter or persistence when the dedicated flag is disabled', async () => {
    await expect(
      service(false).request('user@example.test', context),
    ).rejects.toMatchObject({
      response: { code: 'AUTH_PASSWORD_RESET_PUBLIC_FLOW_DISABLED' },
    });
    expect(consumeRequest).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the same opaque response for existing and missing accounts', async () => {
    query.mockResolvedValueOnce([{ id: userId }]);
    issuePasswordReset.mockResolvedValueOnce({ status: 'accepted' });
    const existing = service().request(' User@Example.Test ', context);
    await Promise.resolve();
    await expect(finishFloor(existing)).resolves.toEqual({
      status: 'accepted',
      expiresAt: new Date('2030-01-01T00:10:00.000Z'),
      resendAvailableAt: new Date('2030-01-01T00:01:00.000Z'),
    });
    expect(consumeRequest).toHaveBeenCalledWith(
      context.ipAddress,
      'user@example.test',
    );
    expect(issuePasswordReset).toHaveBeenCalledWith(userId, 'detached');

    jest.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    query.mockResolvedValueOnce([]);
    const missing = service().request('user@example.test', context);
    await Promise.resolve();
    await expect(finishFloor(missing)).resolves.toEqual({
      status: 'accepted',
      expiresAt: new Date('2030-01-01T00:10:00.000Z'),
      resendAvailableAt: new Date('2030-01-01T00:01:00.000Z'),
    });
  });

  it('hashes before account resolution and completes inside one transaction', async () => {
    query.mockResolvedValueOnce([{ id: userId }]);
    const managerQuery = jest.fn().mockResolvedValueOnce([
      {
        completed: true,
        revokedSessionCount: '2',
        revokedRefreshTokenCount: '3',
      },
    ]);
    const manager = {
      query: managerQuery,
    } as unknown as EntityManager;
    transaction.mockImplementationOnce(
      (operation: (target: EntityManager) => Promise<unknown>) =>
        operation(manager),
    );
    consumeCurrentPasswordResetInTransaction.mockResolvedValueOnce({
      accepted: true,
      challengeId,
    });

    await expect(
      service().complete(
        {
          email: 'user@example.test',
          code: '123456',
          password: 'new-password-value',
        },
        context,
      ),
    ).resolves.toEqual({ status: 'password_reset' });
    expect(hashRun).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledWith('new-password-value');
    expect(hash.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[0],
    );
    expect(consumeCurrentPasswordResetInTransaction).toHaveBeenCalledWith(
      manager,
      userId,
      '123456',
    );
    expect(managerQuery).toHaveBeenCalledWith(
      expect.stringContaining('app_private.complete_password_reset'),
      [userId, challengeId, '$argon2id$test'],
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'auth.password_reset.succeeded',
        userId,
        metadata: {
          revokedSessions: 2,
          revokedRefreshCredentials: 3,
        },
      }),
      manager,
    );
  });

  it('uses one invalid outcome without mutating credentials', async () => {
    query.mockResolvedValueOnce([{ id: userId }]);
    const manager = {} as EntityManager;
    transaction.mockImplementationOnce(
      (operation: (target: EntityManager) => Promise<unknown>) =>
        operation(manager),
    );
    consumeCurrentPasswordResetInTransaction.mockResolvedValueOnce({
      accepted: false,
      challengeId,
    });
    await expect(
      service().complete(
        {
          email: 'user@example.test',
          code: '000000',
          password: 'new-password-value',
        },
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'AUTH_PASSWORD_RESET_INVALID' },
    });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('InMemoryPasswordResetRateLimiter', () => {
  it('uses independent operation namespaces and never depends on account state', () => {
    const limiter = new InMemoryPasswordResetRateLimiter(
      new ConfigService({
        authOtp: {
          ...config,
          passwordResetIpMaxAttempts: 2,
          passwordResetEmailIpMaxAttempts: 1,
        },
      }),
    );
    try {
      limiter.consumeRequest('127.0.0.1', 'one@example.test');
      expect(() =>
        limiter.consumeRequest('127.0.0.1', 'one@example.test'),
      ).toThrow();
      expect(() =>
        limiter.consumeComplete('127.0.0.1', 'one@example.test'),
      ).not.toThrow();
    } finally {
      limiter.onModuleDestroy();
    }
  });
});
