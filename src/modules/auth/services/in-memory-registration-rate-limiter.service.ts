import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthOtpConfig } from '../../../config/auth-otp.config';

interface Bucket {
  attempts: number;
  startedAt: number;
}

@Injectable()
export class InMemoryRegistrationRateLimiter implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: AuthOtpConfig;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<AuthOtpConfig>('authOtp');
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      Math.min(this.config.registrationRateLimitWindowSeconds * 1_000, 60_000),
    );
    this.cleanupTimer.unref();
  }

  consume(ipAddress: string | null, normalizedEmail: string): void {
    const now = Date.now();
    this.cleanup(now);
    const ip = ipAddress?.trim() || 'unknown';
    const keys: ReadonlyArray<[string, number]> = [
      [`ip:${ip}`, this.config.registrationIpMaxAttempts],
      [
        `email-ip:${JSON.stringify([ip, normalizedEmail])}`,
        this.config.registrationEmailIpMaxAttempts,
      ],
    ];
    if (
      keys.some(
        ([key, limit]) => (this.buckets.get(key)?.attempts ?? 0) >= limit,
      )
    ) {
      this.reject();
    }
    const newBuckets = keys.filter(([key]) => !this.buckets.has(key)).length;
    if (
      this.buckets.size + newBuckets >
      this.config.registrationRateLimitMaxBuckets
    )
      this.reject();
    for (const [key] of keys) {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.attempts += 1;
      else this.buckets.set(key, { attempts: 1, startedAt: now });
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanup(now = Date.now()): void {
    const windowMs = this.config.registrationRateLimitWindowSeconds * 1_000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= windowMs) this.buckets.delete(key);
    }
  }

  private reject(): never {
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'AUTH_REGISTRATION_RATE_LIMITED',
        message: 'Too many requests.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
