import { randomUUID } from 'node:crypto';
import { OrganizationCreationRateLimiter } from '../src/modules/organizations/services/organization-creation-rate-limiter.service';

describe('Organization creation rate limiter', () => {
  let limiter: OrganizationCreationRateLimiter;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    limiter = new OrganizationCreationRateLimiter();
  });

  afterEach(() => {
    limiter.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('does not consume another unit for the same idempotent intention', () => {
    const actor = randomUUID();
    const key = randomUUID();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(limiter.reserve(actor, '127.0.0.1', key)).toMatchObject({
        creationPermitted: true,
      });
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.reserve(actor, '127.0.0.1', randomUUID());
    }
    expect(limiter.reserve(actor, '127.0.0.1', randomUUID())).toEqual({
      creationPermitted: false,
      newlyReserved: false,
      retryAfterSeconds: 3600,
    });
  });

  it('enforces the per-IP limit across distinct users and exposes Retry-After', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      limiter.reserve(randomUUID(), '127.0.0.1', randomUUID());
    }
    expect(limiter.reserve(randomUUID(), '127.0.0.1', randomUUID())).toEqual({
      creationPermitted: false,
      newlyReserved: false,
      retryAfterSeconds: 3600,
    });
  });

  it('cleans expired buckets and intentions', () => {
    const actor = randomUUID();
    const key = randomUUID();
    limiter.reserve(actor, '127.0.0.1', key);
    jest.spyOn(Date, 'now').mockReturnValue(4_600_001);
    limiter.reserve(actor, '127.0.0.1', key);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.reserve(actor, '127.0.0.1', randomUUID());
    }
    expect(
      limiter.reserve(actor, '127.0.0.1', randomUUID()).creationPermitted,
    ).toBe(false);
  });

  it('releases a reservation when PostgreSQL proves replay or conflict', () => {
    const actor = randomUUID();
    const key = randomUUID();
    expect(limiter.reserve(actor, '127.0.0.1', key).newlyReserved).toBe(true);
    limiter.release(actor, key);
    expect(limiter.reserve(actor, '127.0.0.1', key).newlyReserved).toBe(true);
  });
});
