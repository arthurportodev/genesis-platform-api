import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LeadConfig } from '../../../config/lead.config';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class FormRateLimiter {
  private readonly config: LeadConfig;
  private readonly buckets = new Map<string, Bucket>();

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<LeadConfig>('lead');
  }

  consumeIp(ip: string): void {
    const now = Date.now();
    this.consumeBucket(`ip:${ip}`, this.config.formIpMaxAttempts, now);
  }

  consumeAuthenticatedKey(keyVersion: number): void {
    const now = Date.now();
    this.consumeBucket(
      `key:${keyVersion}`,
      this.config.formKeyMaxAttempts,
      now,
    );
  }

  private consumeBucket(key: string, limit: number, now: number): void {
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.buckets.size >= this.config.rateLimitMaxBuckets) {
        for (const [candidate, value] of this.buckets) {
          if (value.resetAt <= now) this.buckets.delete(candidate);
        }
      }
      if (this.buckets.size >= this.config.rateLimitMaxBuckets) {
        throw new HttpException('Lead intake rate limit exceeded.', 429);
      }
      bucket = {
        count: 0,
        resetAt: now + this.config.rateLimitWindowSeconds * 1000,
      };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      throw new HttpException('Lead intake rate limit exceeded.', 429);
    }
  }
}
