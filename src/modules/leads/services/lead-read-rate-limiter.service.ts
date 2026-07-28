import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { LeadConfig } from '../../../config/lead.config';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class LeadReadRateLimiter implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly config: LeadConfig) {
    this.timer = setInterval(() => this.cleanup(Date.now()), 60_000);
    this.timer.unref();
  }

  consume(
    kind: 'read' | 'metrics',
    ipAddress: string,
    actorMembershipId: string,
  ): void {
    const now = Date.now();
    this.consumeBucket(
      `membership:${actorMembershipId}`,
      this.config.readMembershipMaxAttempts,
      now,
    );
    if (kind === 'metrics') {
      this.consumeBucket(
        `metrics:${actorMembershipId}`,
        this.config.metricsMembershipMaxAttempts,
        now,
      );
    }
    this.consumeBucket(`ip:${ipAddress}`, this.config.readIpMaxAttempts, now);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private consumeBucket(key: string, maximum: number, now: number): void {
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.buckets.size >= this.config.readRateLimitMaxBuckets) {
        this.cleanup(now);
      }
      if (this.buckets.size >= this.config.readRateLimitMaxBuckets) {
        throw new HttpException(
          'Lead read rate limit exceeded.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      bucket = {
        count: 0,
        resetAt: now + this.config.readRateLimitWindowSeconds * 1_000,
      };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maximum) {
      throw new HttpException(
        'Lead read rate limit exceeded.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private cleanup(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
