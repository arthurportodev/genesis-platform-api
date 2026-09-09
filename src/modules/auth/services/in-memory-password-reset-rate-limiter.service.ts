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

type PasswordResetOperation = 'request' | 'complete';
const MAX_BUCKETS = 10_000;

@Injectable()
export class InMemoryPasswordResetRateLimiter implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: AuthOtpConfig;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<AuthOtpConfig>('authOtp');
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      Math.min(this.config.passwordResetRateLimitWindowSeconds * 1_000, 60_000),
    );
    this.cleanupTimer.unref();
  }

  consumeRequest(ipAddress: string | null, normalizedEmail: string): void {
    this.consume('request', ipAddress, normalizedEmail);
  }

  consumeComplete(ipAddress: string | null, normalizedEmail: string): void {
    this.consume('complete', ipAddress, normalizedEmail);
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private consume(
    operation: PasswordResetOperation,
    ipAddress: string | null,
    normalizedEmail: string,
  ): void {
    const now = Date.now();
    this.cleanup(now);
    const ip = ipAddress?.trim() || 'unknown';
    const keys: ReadonlyArray<[string, number]> = [
      [`${operation}:ip:${ip}`, this.config.passwordResetIpMaxAttempts],
      [
        `${operation}:email-ip:${JSON.stringify([ip, normalizedEmail])}`,
        this.config.passwordResetEmailIpMaxAttempts,
      ],
    ];
    if (
      keys.some(
        ([key, limit]) => (this.buckets.get(key)?.attempts ?? 0) >= limit,
      )
    )
      this.reject();
    const newBuckets = keys.filter(([key]) => !this.buckets.has(key)).length;
    if (this.buckets.size + newBuckets > MAX_BUCKETS) this.reject();
    for (const [key] of keys) {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.attempts += 1;
      else this.buckets.set(key, { attempts: 1, startedAt: now });
    }
  }

  private cleanup(now = Date.now()): void {
    const windowMs = this.config.passwordResetRateLimitWindowSeconds * 1_000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= windowMs) this.buckets.delete(key);
    }
  }

  private reject(): never {
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'AUTH_PASSWORD_RESET_RATE_LIMITED',
        message: 'Too many requests.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
