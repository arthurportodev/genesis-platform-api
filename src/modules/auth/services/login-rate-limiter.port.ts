export abstract class LoginRateLimiter {
  abstract assertAllowed(key: string): void;
  abstract recordFailure(key: string): void;
  abstract reset(key: string): void;
}
