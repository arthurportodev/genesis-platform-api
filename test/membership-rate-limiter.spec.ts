import { HttpException } from '@nestjs/common';
import { MembershipConfig } from '../src/config/membership.config';
import { MembershipReadRateLimiter } from '../src/modules/memberships/services/membership-read-rate-limiter.service';

describe('Membership rate limiter', () => {
  const config: MembershipConfig = {
    rateLimitWindowSeconds: 60,
    readMaxAttempts: 2,
    commandMaxAttempts: 1,
    rateLimitMaxBuckets: 3,
  };

  it('uses combined actor-membership and IP buckets with separate read and command limits', () => {
    const limiter = new MembershipReadRateLimiter(config);
    try {
      limiter.consume('read', '127.0.0.1', 'membership-a');
      limiter.consume('read', '127.0.0.1', 'membership-a');
      expect(() =>
        limiter.consume('read', '127.0.0.1', 'membership-a'),
      ).toThrow(HttpException);

      limiter.consume('command', '127.0.0.1', 'membership-a');
      expect(() =>
        limiter.consume('command', '127.0.0.1', 'membership-a'),
      ).toThrow(HttpException);

      expect(() =>
        limiter.consume('read', '127.0.0.2', 'membership-a'),
      ).not.toThrow();
    } finally {
      limiter.onModuleDestroy();
    }
  });

  it('fails closed when the shared bucket cap is exhausted', () => {
    const limiter = new MembershipReadRateLimiter({
      ...config,
      rateLimitMaxBuckets: 1,
    });
    try {
      limiter.consume('read', '127.0.0.1', 'membership-a');
      let thrown: unknown;
      try {
        limiter.consume('command', '127.0.0.1', 'membership-a');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(429);
      expect((thrown as HttpException).message).toBe(
        'Membership rate limit exceeded.',
      );
    } finally {
      limiter.onModuleDestroy();
    }
  });
});
