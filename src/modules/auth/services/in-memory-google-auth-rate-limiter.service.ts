import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGoogleConfig } from '../../../config/auth-google.config';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class InMemoryGoogleAuthRateLimiter {
  private readonly config: AuthGoogleConfig;
  private readonly buckets = new Map<string, Bucket>();

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AuthGoogleConfig>('authGoogle');
  }

  assertAllowed(
    action: 'challenge' | 'verify' | 'profile' | 'link',
    ip: string | null,
  ): void {
    const now = Date.now();
    const key = `${action}:${ip ?? 'unknown'}`;
    const limit =
      action === 'challenge'
        ? this.config.challengeIpMaxAttempts
        : this.config.verificationIpMaxAttempts;
    const current = this.buckets.get(key);
    if (current === undefined || current.resetAt <= now) {
      if (this.buckets.size >= this.config.maxBuckets) this.prune(now);
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.config.rateLimitWindowSeconds * 1_000,
      });
      return;
    }
    if (current.count >= limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'AUTH_GOOGLE_RATE_LIMITED',
          message: 'Too many Google authentication requests.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    current.count += 1;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size < this.config.maxBuckets) return;
    const oldest = this.buckets.keys().next().value;
    if (oldest !== undefined) this.buckets.delete(oldest);
  }
}
