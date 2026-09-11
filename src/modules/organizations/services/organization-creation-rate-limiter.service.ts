import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

interface Bucket {
  count: number;
  resetAt: number;
}

interface Intention {
  resetAt: number;
  bucketKeys: string[];
}

export interface OrganizationCreationRateLimitDecision {
  creationPermitted: boolean;
  newlyReserved: boolean;
  retryAfterSeconds: number | null;
}

export class OrganizationCreationRateLimitException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'ORGANIZATION_CREATION_RATE_LIMITED',
        message: 'Too many requests.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class OrganizationCreationRateLimiter implements OnModuleDestroy {
  private static readonly WINDOW_MS = 60 * 60 * 1_000;
  private static readonly USER_LIMIT = 5;
  private static readonly IP_LIMIT = 20;
  private static readonly MAX_BUCKETS = 10_000;
  private static readonly MAX_INTENTIONS = 10_000;

  private readonly buckets = new Map<string, Bucket>();
  private readonly intentions = new Map<string, Intention>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  reserve(
    actorUserId: string,
    ipAddress: string | null,
    idempotencyKey: string,
  ): OrganizationCreationRateLimitDecision {
    const now = Date.now();
    this.cleanup(now);
    const intentionKey = JSON.stringify([actorUserId, idempotencyKey]);
    if (this.intentions.has(intentionKey)) {
      return {
        creationPermitted: true,
        newlyReserved: false,
        retryAfterSeconds: null,
      };
    }

    const ip = ipAddress?.trim() || 'unknown';
    const targets: ReadonlyArray<[string, number]> = [
      [`user:${actorUserId}`, OrganizationCreationRateLimiter.USER_LIMIT],
      [`ip:${ip}`, OrganizationCreationRateLimiter.IP_LIMIT],
    ];
    const blocked = targets
      .map(([key, limit]) => ({ bucket: this.buckets.get(key), limit }))
      .filter(
        (candidate): candidate is { bucket: Bucket; limit: number } =>
          candidate.bucket !== undefined &&
          candidate.bucket.count >= candidate.limit,
      );
    if (blocked.length > 0) {
      const retryAt = Math.max(
        ...blocked.map((candidate) => candidate.bucket.resetAt),
      );
      return {
        creationPermitted: false,
        newlyReserved: false,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000)),
      };
    }

    const newBuckets = targets.filter(([key]) => !this.buckets.has(key)).length;
    if (
      this.buckets.size + newBuckets >
        OrganizationCreationRateLimiter.MAX_BUCKETS ||
      this.intentions.size >= OrganizationCreationRateLimiter.MAX_INTENTIONS
    ) {
      return {
        creationPermitted: false,
        newlyReserved: false,
        retryAfterSeconds: Math.ceil(
          OrganizationCreationRateLimiter.WINDOW_MS / 1_000,
        ),
      };
    }

    const resetAt = now + OrganizationCreationRateLimiter.WINDOW_MS;
    for (const [key] of targets) {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.count += 1;
      else this.buckets.set(key, { count: 1, resetAt });
    }
    this.intentions.set(intentionKey, {
      resetAt,
      bucketKeys: targets.map(([key]) => key),
    });
    return {
      creationPermitted: true,
      newlyReserved: true,
      retryAfterSeconds: null,
    };
  }

  release(actorUserId: string, idempotencyKey: string): void {
    const intentionKey = JSON.stringify([actorUserId, idempotencyKey]);
    const intention = this.intentions.get(intentionKey);
    if (!intention) return;
    this.intentions.delete(intentionKey);
    for (const bucketKey of intention.bucketKeys) {
      const bucket = this.buckets.get(bucketKey);
      if (!bucket) continue;
      bucket.count -= 1;
      if (bucket.count <= 0) this.buckets.delete(bucketKey);
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanup(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    for (const [key, intention] of this.intentions) {
      if (intention.resetAt <= now) this.intentions.delete(key);
    }
  }
}
