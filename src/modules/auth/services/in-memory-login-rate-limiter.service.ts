import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthConfig } from '../../../config/auth.config';
import { LoginRateLimiter } from './login-rate-limiter.port';

interface AttemptBucket {
  failures: number;
  windowStartedAt: number;
}

@Injectable()
export class InMemoryLoginRateLimiter
  implements LoginRateLimiter, OnModuleDestroy
{
  private readonly credentialAttempts = new Map<string, AttemptBucket>();
  private readonly ipAttempts = new Map<string, AttemptBucket>();
  private readonly credentialMaxAttempts: number;
  private readonly ipMaxAttempts: number;
  private readonly maxBuckets: number;
  private readonly windowMilliseconds: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<AuthConfig>('auth');
    this.credentialMaxAttempts = config.loginMaxAttempts;
    this.ipMaxAttempts = config.loginIpMaxAttempts;
    this.maxBuckets = config.loginMaxBuckets;
    this.windowMilliseconds = config.loginWindowSeconds * 1_000;
    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredBuckets(),
      Math.min(this.windowMilliseconds, 60_000),
    );
    this.cleanupTimer.unref();
  }

  assertAllowed(ipAddress: string | null, normalizedEmail: string): void {
    const now = Date.now();
    this.cleanupExpiredBuckets(now);

    const ipKey = this.normalizeIpAddress(ipAddress);
    const credentialKey = this.createCredentialKey(ipKey, normalizedEmail);
    this.assertBucketAllowed(
      this.credentialAttempts.get(credentialKey),
      this.credentialMaxAttempts,
    );
    this.assertBucketAllowed(this.ipAttempts.get(ipKey), this.ipMaxAttempts);

    const requiredBuckets =
      Number(!this.credentialAttempts.has(credentialKey)) +
      Number(!this.ipAttempts.has(ipKey));
    this.assertCapacity(requiredBuckets);
  }

  recordFailure(ipAddress: string | null, normalizedEmail: string): void {
    const now = Date.now();
    this.cleanupExpiredBuckets(now);

    const ipKey = this.normalizeIpAddress(ipAddress);
    const credentialKey = this.createCredentialKey(ipKey, normalizedEmail);
    const requiredBuckets =
      Number(!this.credentialAttempts.has(credentialKey)) +
      Number(!this.ipAttempts.has(ipKey));
    this.assertCapacity(requiredBuckets);

    this.incrementBucket(this.credentialAttempts, credentialKey, now);
    this.incrementBucket(this.ipAttempts, ipKey, now);
  }

  resetCredential(ipAddress: string | null, normalizedEmail: string): void {
    const ipKey = this.normalizeIpAddress(ipAddress);
    this.credentialAttempts.delete(
      this.createCredentialKey(ipKey, normalizedEmail),
    );
  }

  cleanupExpiredBuckets(now = Date.now()): void {
    this.removeExpiredBuckets(this.credentialAttempts, now);
    this.removeExpiredBuckets(this.ipAttempts, now);
  }

  getBucketCount(): number {
    return this.credentialAttempts.size + this.ipAttempts.size;
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private assertBucketAllowed(
    bucket: AttemptBucket | undefined,
    maxAttempts: number,
  ): void {
    if (bucket !== undefined && bucket.failures >= maxAttempts) {
      this.rejectRequest();
    }
  }

  private assertCapacity(requiredBuckets: number): void {
    if (this.getBucketCount() + requiredBuckets > this.maxBuckets) {
      this.rejectRequest();
    }
  }

  private incrementBucket(
    buckets: Map<string, AttemptBucket>,
    key: string,
    now: number,
  ): void {
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { failures: 1, windowStartedAt: now });
      return;
    }
    bucket.failures += 1;
  }

  private removeExpiredBuckets(
    buckets: Map<string, AttemptBucket>,
    now: number,
  ): void {
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStartedAt >= this.windowMilliseconds) {
        buckets.delete(key);
      }
    }
  }

  private normalizeIpAddress(ipAddress: string | null): string {
    return ipAddress?.trim() || 'unknown';
  }

  private createCredentialKey(
    ipAddress: string,
    normalizedEmail: string,
  ): string {
    return JSON.stringify([ipAddress, normalizedEmail]);
  }

  private rejectRequest(): never {
    throw new HttpException(
      'Too many login attempts. Try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
