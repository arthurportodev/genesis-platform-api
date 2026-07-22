import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationConfig } from '../../../config/invitation.config';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class InvitationAcceptanceRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: ConfigService) {}

  consume(
    scope: 'inspect-ip' | 'accept-ip' | 'accept-user-ip',
    key: string,
  ): void {
    const settings = this.config.getOrThrow<InvitationConfig>('invitation');
    const now = Date.now();
    this.prune(now);
    const bucketKey = `${scope}:${key}`;
    const limit =
      scope === 'inspect-ip'
        ? settings.inspectIpMaxAttempts
        : scope === 'accept-ip'
          ? settings.acceptIpMaxAttempts
          : settings.acceptUserIpMaxAttempts;
    let bucket = this.buckets.get(bucketKey);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.buckets.size >= settings.rateLimitMaxBuckets) this.reject();
      bucket = {
        count: 0,
        resetAt: now + settings.rateLimitWindowSeconds * 1000,
      };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) this.reject();
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private reject(): never {
    throw new HttpException('Too many requests.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
