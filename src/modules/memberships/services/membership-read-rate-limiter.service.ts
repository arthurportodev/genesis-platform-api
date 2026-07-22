import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { MembershipConfig } from '../../../config/membership.config';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class MembershipReadRateLimiter implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly config: MembershipConfig) {
    this.timer = setInterval(() => this.cleanup(Date.now()), 60_000);
    this.timer.unref();
  }

  consume(
    kind: 'read' | 'command',
    ipAddress: string,
    actorMembershipId: string,
  ): void {
    const now = Date.now();
    const maximum =
      kind === 'read'
        ? this.config.readMaxAttempts
        : this.config.commandMaxAttempts;
    this.consumeBucket(
      `${kind}:${actorMembershipId}:${ipAddress}`,
      maximum,
      now,
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private consumeBucket(key: string, maximum: number, now: number): void {
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.buckets.size >= this.config.rateLimitMaxBuckets) {
        this.cleanup(now);
      }
      if (this.buckets.size >= this.config.rateLimitMaxBuckets) {
        throw new HttpException(
          'Membership rate limit exceeded.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      bucket = {
        count: 0,
        resetAt: now + this.config.rateLimitWindowSeconds * 1_000,
      };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maximum) {
      throw new HttpException(
        'Membership rate limit exceeded.',
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
