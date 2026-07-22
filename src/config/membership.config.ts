import { registerAs } from '@nestjs/config';

export interface MembershipConfig {
  rateLimitWindowSeconds: number;
  readMaxAttempts: number;
  commandMaxAttempts: number;
  rateLimitMaxBuckets: number;
}

export default registerAs('membership', (): MembershipConfig => ({
  rateLimitWindowSeconds: Number(
    process.env.MEMBERSHIP_RATE_LIMIT_WINDOW_SECONDS ?? 60,
  ),
  readMaxAttempts: Number(process.env.MEMBERSHIP_READ_MAX_ATTEMPTS ?? 120),
  commandMaxAttempts: Number(process.env.MEMBERSHIP_COMMAND_MAX_ATTEMPTS ?? 30),
  rateLimitMaxBuckets: Number(
    process.env.MEMBERSHIP_RATE_LIMIT_MAX_BUCKETS ?? 10_000,
  ),
}));
