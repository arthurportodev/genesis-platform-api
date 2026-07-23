import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { LeadConfig } from '../../src/config/lead.config';
import { FormSignatureService } from '../../src/modules/leads/security/form-signature.service';

describe('Genesis form signature', () => {
  const key = Buffer.alloc(32, 3);
  const config: LeadConfig = {
    formReadiness: true,
    formOrganizationId: '8654c67c-b9e2-4b1a-8f5c-6c86b377cf4e',
    formCurrentKeyVersion: 2,
    formKeys: new Map([[2, key]]),
    idempotencyCurrentKeyVersion: 1,
    idempotencyKeys: new Map([[1, Buffer.alloc(32, 4)]]),
    publicReplicaCount: 1,
    rateLimitWindowSeconds: 900,
    formIpMaxAttempts: 30,
    formKeyMaxAttempts: 300,
    rateLimitMaxBuckets: 10_000,
  };
  const service = new FormSignatureService({
    getOrThrow: () => config,
  } as unknown as ConfigService);

  it('accepts the documented v1 raw-body signature', () => {
    const rawBody = Buffer.from('{"displayName":"Maria"}', 'utf8');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const idempotencyKey = 'eea5ce7a-0866-4fc6-a053-b0f5a93aa01e';
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    const signature = createHmac('sha256', key)
      .update(`v1\n${timestamp}\n${idempotencyKey}\n${bodyHash}`, 'utf8')
      .digest('hex');
    expect(
      service.verify({
        keyVersion: '2',
        timestamp,
        idempotencyKey,
        signature,
        rawBody,
      }),
    ).toBe(2);
  });

  it('matches the approved Gate 1 interoperability fixture exactly', () => {
    const timestamp = '1784750400';
    const idempotencyKey = '550e8400-e29b-41d4-a716-446655440000';
    const rawBody = Buffer.from(
      '{"displayName":"Maria Silva","primaryPhone":"+5562999999999","email":"maria@example.com","companyName":"Clínica Exemplo","source":"landing_page","utmSource":"google","utmMedium":"cpc","utmCampaign":"crm_mvp"}',
      'utf8',
    );
    const fixtureKey = Buffer.from(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex',
    );
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    expect(bodyHash).toBe(
      '428cfecf7e8c5f59b4a633d6dc05d7a867d37c1a2d8f196409c6aa632a46f946',
    );
    expect(
      createHmac('sha256', fixtureKey)
        .update(`v1\n${timestamp}\n${idempotencyKey}\n${bodyHash}`, 'utf8')
        .digest('hex'),
    ).toBe('e76bee7e9554a4c12064896dc326023491765d0f80b1ae662120dae5fe256268');
  });

  it('rejects tampering, unknown versions, and expired timestamps', () => {
    const base = {
      keyVersion: '2',
      timestamp: Math.floor(Date.now() / 1000 - 301).toString(),
      idempotencyKey: 'eea5ce7a-0866-4fc6-a053-b0f5a93aa01e',
      signature: '0'.repeat(64),
      rawBody: Buffer.from('{}'),
    };
    expect(() => service.verify(base)).toThrow(UnauthorizedException);
    expect(() => service.verify({ ...base, keyVersion: '999' })).toThrow(
      UnauthorizedException,
    );
  });
});
