import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthConfig } from '../src/config/auth.config';
import { InMemoryLoginRateLimiter } from '../src/modules/auth/services/in-memory-login-rate-limiter.service';

describe('InMemoryLoginRateLimiter', () => {
  const limiters: InMemoryLoginRateLimiter[] = [];

  afterEach(() => {
    for (const limiter of limiters) {
      limiter.onModuleDestroy();
    }
    limiters.length = 0;
    jest.useRealTimers();
  });

  it('limits each normalized IP and email pair while isolating emails', () => {
    const limiter = createLimiter();
    limiter.recordFailure('192.0.2.10', 'first@example.com');
    limiter.recordFailure('192.0.2.10', 'first@example.com');

    expectRateLimited(() =>
      limiter.assertAllowed('192.0.2.10', 'first@example.com'),
    );
    expect(() =>
      limiter.assertAllowed('192.0.2.10', 'second@example.com'),
    ).not.toThrow();
    expect(() =>
      limiter.assertAllowed('192.0.2.11', 'first@example.com'),
    ).not.toThrow();
  });

  it('enforces the aggregate IP limit across alternating emails', () => {
    const limiter = createLimiter({
      loginMaxAttempts: 10,
      loginIpMaxAttempts: 3,
    });
    for (let index = 0; index < 3; index += 1) {
      const email = `user-${index}@example.com`;
      limiter.assertAllowed('192.0.2.20', email);
      limiter.recordFailure('192.0.2.20', email);
    }

    expectRateLimited(() =>
      limiter.assertAllowed('192.0.2.20', 'another@example.com'),
    );
    expect(() =>
      limiter.assertAllowed('192.0.2.21', 'another@example.com'),
    ).not.toThrow();
  });

  it('periodically removes expired buckets instead of retaining them forever', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const limiter = createLimiter({ loginWindowSeconds: 60 });
    limiter.recordFailure('192.0.2.30', 'user@example.com');
    expect(limiter.getBucketCount()).toBe(2);

    jest.advanceTimersByTime(60_000);

    expect(limiter.getBucketCount()).toBe(0);
    expect(() =>
      limiter.assertAllowed('192.0.2.30', 'user@example.com'),
    ).not.toThrow();
  });

  it('caps buckets and fails closed without growing past the limit', () => {
    const limiter = createLimiter({ loginMaxBuckets: 3 });
    limiter.recordFailure('192.0.2.40', 'first@example.com');
    limiter.recordFailure('192.0.2.40', 'second@example.com');
    expect(limiter.getBucketCount()).toBe(3);

    expectRateLimited(() =>
      limiter.assertAllowed('192.0.2.41', 'third@example.com'),
    );
    expect(limiter.getBucketCount()).toBe(3);
  });

  it('resets only the credential bucket and preserves aggregate IP failures', () => {
    const limiter = createLimiter({
      loginMaxAttempts: 1,
      loginIpMaxAttempts: 2,
    });
    limiter.recordFailure('192.0.2.50', 'first@example.com');
    limiter.resetCredential('192.0.2.50', 'first@example.com');
    expect(limiter.getBucketCount()).toBe(1);
    expect(() =>
      limiter.assertAllowed('192.0.2.50', 'first@example.com'),
    ).not.toThrow();

    limiter.recordFailure('192.0.2.50', 'second@example.com');
    expectRateLimited(() =>
      limiter.assertAllowed('192.0.2.50', 'third@example.com'),
    );
  });

  it('stores only IP and normalized email identifiers, never passwords', () => {
    const limiter = createLimiter();
    limiter.recordFailure('192.0.2.60', 'user@example.com');

    const state = limiter as unknown as {
      credentialAttempts: Map<string, unknown>;
      ipAttempts: Map<string, unknown>;
    };
    const storedKeys = [
      ...state.credentialAttempts.keys(),
      ...state.ipAttempts.keys(),
    ].join(' ');
    expect(storedKeys).toContain('192.0.2.60');
    expect(storedKeys).toContain('user@example.com');
    expect(storedKeys).not.toContain('raw-password-value');
    expect(storedKeys).not.toContain('password');
  });

  function createLimiter(
    overrides: Partial<AuthConfig> = {},
  ): InMemoryLoginRateLimiter {
    const config: AuthConfig = {
      accessTokenSecret: 'x'.repeat(32),
      accessTokenExpiresInSeconds: 900,
      refreshTokenExpiresInDays: 30,
      refreshTokenPepper: 'y'.repeat(32),
      loginMaxAttempts: 2,
      loginIpMaxAttempts: 10,
      loginMaxBuckets: 100,
      loginWindowSeconds: 60,
      ...overrides,
    };
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(config),
    } as unknown as ConfigService;
    const limiter = new InMemoryLoginRateLimiter(configService);
    limiters.push(limiter);
    return limiter;
  }

  function expectRateLimited(callback: () => void): void {
    try {
      callback();
      throw new Error('Expected the limiter to reject the request.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  }
});
