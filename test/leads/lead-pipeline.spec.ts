import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import {
  LeadArchiveReason,
  LeadCommand,
  LeadLostReason,
  LeadStage,
} from '../../src/modules/leads/enums/lead.enums';
import {
  leadCommandFingerprint,
  LeadCommandFingerprintInput,
} from '../../src/modules/leads/security/lead-fingerprint';
import { LeadsService } from '../../src/modules/leads/services/leads.service';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';

describe('Lead commercial pipeline', () => {
  type QueryStub = (sql: string, parameters?: unknown[]) => Promise<unknown[]>;
  const key = Buffer.alloc(32, 7);
  const config: LeadConfig = {
    formReadiness: false,
    formOrganizationId: null,
    formCurrentKeyVersion: null,
    formKeys: new Map(),
    idempotencyCurrentKeyVersion: 1,
    idempotencyKeys: new Map([[1, key]]),
    publicReplicaCount: 1,
    rateLimitWindowSeconds: 900,
    formIpMaxAttempts: 30,
    formKeyMaxAttempts: 300,
    rateLimitMaxBuckets: 10_000,
  };
  const tenant = {
    userId: randomUUID(),
    membershipId: randomUUID(),
    organizationId: randomUUID(),
    role: MembershipRole.OWNER,
  };
  const leadId = randomUUID();

  it('fingerprints the complete normalized command contract deterministically', () => {
    const input: LeadCommandFingerprintInput = {
      organizationId: tenant.organizationId,
      actorMembershipId: tenant.membershipId,
      leadId,
      command: LeadCommand.LOSE,
      expectedRevision: '12',
      stage: null,
      lostReason: LeadLostReason.OTHER,
      archiveReason: null,
      reasonNote: 'Cliente adiou',
    };
    const fingerprint = leadCommandFingerprint(input, key);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(leadCommandFingerprint(input, key)).toBe(fingerprint);
    expect(
      leadCommandFingerprint({ ...input, expectedRevision: '13' }, key),
    ).not.toBe(fingerprint);
    expect(
      leadCommandFingerprint({ ...input, reasonNote: 'Outro motivo' }, key),
    ).not.toBe(fingerprint);
  });

  it('requires other notes and rejects controls or malformed Unicode before SQL', () => {
    let called = false;
    const query: QueryStub = () => {
      called = true;
      return Promise.reject(new Error('unexpected SQL'));
    };
    const service = serviceWith(query);
    expect(() =>
      service.lose(tenant, leadId, '1', randomUUID(), {
        lostReason: LeadLostReason.OTHER,
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.archive(tenant, leadId, '1', randomUUID(), {
        archiveReason: LeadArchiveReason.OTHER,
        reasonNote: 'linha\nseguinte',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.lose(tenant, leadId, '1', randomUUID(), {
        lostReason: LeadLostReason.NO_RESPONSE,
        reasonNote: '\ud800',
      }),
    ).toThrow(BadRequestException);
    for (const separator of ['\u2028', '\u2029']) {
      expect(() =>
        service.archive(tenant, leadId, '1', randomUUID(), {
          archiveReason: LeadArchiveReason.OTHER,
          reasonNote: `linha${separator}seguinte`,
        }),
      ).toThrow(BadRequestException);
    }
    expect(called).toBe(false);
  });

  it('trims notes, accepts 500 Unicode code points, and sends the exact command shape', async () => {
    let parameters: unknown[] | undefined;
    const query: QueryStub = (_sql, values) => {
      parameters = values;
      return Promise.resolve([
        { revision: '2', replayed: false, responseStatus: 204 },
      ]);
    };
    const service = serviceWith(query);
    const note = '😀'.repeat(500);
    await expect(
      service.lose(tenant, leadId, '1', randomUUID(), {
        lostReason: LeadLostReason.NOT_NOW,
        reasonNote: `  ${note}  `,
      }),
    ).resolves.toEqual({ revision: '2', replayed: false, responseStatus: 204 });
    expect(parameters).toEqual([
      tenant.userId,
      tenant.membershipId,
      tenant.organizationId,
      leadId,
      'lose',
      '1',
      expect.any(String),
      1,
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.any(String),
      null,
      LeadLostReason.NOT_NOW,
      null,
      note,
    ]);
  });

  it('uses the five-stage command payload and preserves no-payload commands', async () => {
    const calls: unknown[][] = [];
    const query: QueryStub = (_sql, values) => {
      calls.push(values ?? []);
      return Promise.resolve([
        {
          revision: String(4 + calls.length - 1),
          replayed: false,
          responseStatus: 204,
        },
      ]);
    };
    const service = serviceWith(query);
    await service.move(
      tenant,
      leadId,
      '3',
      randomUUID(),
      LeadStage.NEGOTIATION,
    );
    expect(calls[0]?.[10]).toBe(LeadStage.NEGOTIATION);
    await service.win(tenant, leadId, '4', randomUUID());
    expect(calls[1]?.slice(10)).toEqual([null, null, null, null]);
  });

  function serviceWith(query: QueryStub): LeadsService {
    return new LeadsService(
      { query } as unknown as DataSource,
      { getOrThrow: () => config } as unknown as ConfigService,
      { assertManualReady: jest.fn(), assertFormReady: jest.fn() },
    );
  }
});
