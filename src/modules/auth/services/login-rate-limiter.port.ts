export abstract class LoginRateLimiter {
  abstract assertAllowed(
    ipAddress: string | null,
    normalizedEmail: string,
  ): void;
  abstract recordFailure(
    ipAddress: string | null,
    normalizedEmail: string,
  ): void;
  abstract resetCredential(
    ipAddress: string | null,
    normalizedEmail: string,
  ): void;
}
