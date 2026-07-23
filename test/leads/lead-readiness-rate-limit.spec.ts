import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../../src/database/runtime-executable-functions';
import { OperationalLeadReadiness } from '../../src/modules/leads/ports/lead-readiness.port';
import { FormRateLimiter } from '../../src/modules/leads/services/form-rate-limiter.service';

describe('Lead readiness and rate limiting', () => {
  const baseConfig: LeadConfig = {
    formReadiness: true,
    formOrganizationId: '8654c67c-b9e2-4b1a-8f5c-6c86b377cf4e',
    formCurrentKeyVersion: 2,
    formKeys: new Map([[2, Buffer.alloc(32, 2)]]),
    idempotencyCurrentKeyVersion: 1,
    idempotencyKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    publicReplicaCount: 1,
    rateLimitWindowSeconds: 900,
    formIpMaxAttempts: 1,
    formKeyMaxAttempts: 1,
    rateLimitMaxBuckets: 10,
  };
  const healthyBoundary = {
    tablesReady: true,
    functionsReady: true,
    triggersReady: true,
    aclReady: true,
    fingerprintKeyVersions: [1],
    executableFunctions: CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS,
    catalogSafe: true,
  };

  it('opens only with the exact catalog and every persisted fingerprint key', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([healthyBoundary]),
    } as unknown as DataSource;
    await expect(
      new OperationalLeadReadiness(baseConfig, dataSource).assertFormReady(),
    ).resolves.toBeUndefined();

    const missingHistoricalKey = {
      ...baseConfig,
      idempotencyKeys: new Map([[2, Buffer.alloc(32, 2)]]),
    };
    await expect(
      new OperationalLeadReadiness(
        missingHistoricalKey,
        dataSource,
      ).assertManualReady(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const drift = {
      query: jest.fn().mockResolvedValue([
        {
          ...healthyBoundary,
          executableFunctions: [
            ...CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS,
            'app_private.unexpected()',
          ],
        },
      ]),
    } as unknown as DataSource;
    await expect(
      new OperationalLeadReadiness(baseConfig, drift).assertManualReady(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('keeps IP and authenticated-key buckets separate and bounded', () => {
    const limiter = new FormRateLimiter({
      getOrThrow: () => baseConfig,
    } as unknown as ConfigService);
    limiter.consumeIp('127.0.0.1');
    expect(() => limiter.consumeIp('127.0.0.1')).toThrow('rate limit');
    limiter.consumeAuthenticatedKey(2);
    expect(() => limiter.consumeAuthenticatedKey(2)).toThrow('rate limit');
  });
});
