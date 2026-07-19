import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { AuthConfig } from '../src/config/auth.config';
import { InMemoryLoginRateLimiter } from '../src/modules/auth/services/in-memory-login-rate-limiter.service';

describe('InMemoryLoginRateLimiter', () => {
  const config: AuthConfig = {
    accessTokenSecret: 'x'.repeat(32),
    accessTokenExpiresInSeconds: 900,
    refreshTokenExpiresInDays: 30,
    refreshTokenPepper: 'y'.repeat(32),
    loginMaxAttempts: 2,
    loginWindowSeconds: 60,
  };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(config),
  } as unknown as ConfigService;

  it('blocks a key after the configured number of failures', () => {
    const limiter = new InMemoryLoginRateLimiter(configService);
    limiter.recordFailure('ip:email');
    limiter.recordFailure('ip:email');

    try {
      limiter.assertAllowed('ip:email');
      throw new Error('Expected the limiter to reject the request.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });

  it('isolates keys and resets a successful key', () => {
    const limiter = new InMemoryLoginRateLimiter(configService);
    limiter.recordFailure('first');
    limiter.recordFailure('first');
    expect(() => limiter.assertAllowed('second')).not.toThrow();

    limiter.reset('first');
    expect(() => limiter.assertAllowed('first')).not.toThrow();
  });
});
