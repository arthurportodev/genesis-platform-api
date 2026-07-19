import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthConfig } from '../../../config/auth.config';
import { LoginRateLimiter } from './login-rate-limiter.port';

interface AttemptBucket {
  failures: number;
  windowStartedAt: number;
}

@Injectable()
export class InMemoryLoginRateLimiter implements LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptBucket>();
  private readonly maxAttempts: number;
  private readonly windowMilliseconds: number;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<AuthConfig>('auth');
    this.maxAttempts = config.loginMaxAttempts;
    this.windowMilliseconds = config.loginWindowSeconds * 1_000;
  }

  assertAllowed(key: string): void {
    const bucket = this.getCurrentBucket(key);
    if (bucket !== null && bucket.failures >= this.maxAttempts) {
      throw new HttpException(
        'Too many login attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(key: string): void {
    const bucket = this.getCurrentBucket(key);
    if (bucket === null) {
      this.attempts.set(key, { failures: 1, windowStartedAt: Date.now() });
      return;
    }
    bucket.failures += 1;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private getCurrentBucket(key: string): AttemptBucket | null {
    const bucket = this.attempts.get(key);
    if (bucket === undefined) {
      return null;
    }
    if (Date.now() - bucket.windowStartedAt >= this.windowMilliseconds) {
      this.attempts.delete(key);
      return null;
    }
    return bucket;
  }
}
