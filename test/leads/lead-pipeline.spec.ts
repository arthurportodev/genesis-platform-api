import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import {
  LeadArchiveReason,
  LeadActivityType,
  LeadCommand,
  LeadFollowUpCommand,
  LeadLostReason,
  LeadNextActionType,
  LeadStage,
} from '../../src/modules/leads/enums/lead.enums';
import {
  leadCommandFingerprint,
  leadFollowUpFingerprint,
  LeadCommandFingerprintInput,
  LeadFollowUpFingerprintInput,
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
    readRateLimitWindowSeconds: 60,
    readMembershipMaxAttempts: 120,
    readIpMaxAttempts: 300,
    metricsMembershipMaxAttempts: 30,
    readRateLimitMaxBuckets: 10_000,
    readStatementTimeoutMs: 3_000,
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

  it('fingerprints every normalized follow-up field and revision', () => {
    const input: LeadFollowUpFingerprintInput = {
      organizationId: tenant.organizationId,
      actorMembershipId: tenant.membershipId,
      leadId,
      command: LeadFollowUpCommand.CREATE_NEXT_ACTION,
      expectedRevision: '8',
      activityType: null,
      performedAt: null,
      activityOutcome: null,
      noteContent: null,
      nextActionType: LeadNextActionType.CALL,
      nextActionDescription: 'Ligar para cliente',
      dueAt: '2026-07-30T12:00:00.000Z',
      cancellationNote: null,
    };
    const fingerprint = leadFollowUpFingerprint(input, key);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(leadFollowUpFingerprint(input, key)).toBe(fingerprint);
    expect(
      leadFollowUpFingerprint({ ...input, expectedRevision: '9' }, key),
    ).not.toBe(fingerprint);
    expect(
      leadFollowUpFingerprint(
        { ...input, nextActionDescription: 'Outro compromisso' },
        key,
      ),
    ).not.toBe(fingerprint);
  });

  it('normalizes multiline text and sends only the typed follow-up payload', async () => {
    let parameters: unknown[] | undefined;
    const query: QueryStub = (_sql, values) => {
      parameters = values;
      return Promise.resolve([
        {
          revision: '2',
          replayed: false,
          responseStatus: 201,
          activityId: randomUUID(),
          noteId: null,
          nextActionId: null,
        },
      ]);
    };
    const service = serviceWith(query);
    await service.createActivity(tenant, leadId, '1', randomUUID(), {
      type: LeadActivityType.INTERNAL_TASK,
      performedAt: '2026-07-27T15:00:00.123456-03:00',
      outcome: '  Linha 1\r\nLinha 2  ',
    });
    expect(parameters?.slice(0, 7)).toEqual([
      tenant.userId,
      tenant.membershipId,
      tenant.organizationId,
      leadId,
      LeadFollowUpCommand.CREATE_ACTIVITY,
      '1',
      expect.any(String),
    ]);
    expect(parameters?.slice(10)).toEqual([
      LeadActivityType.INTERNAL_TASK,
      '2026-07-27T18:00:00.123456Z',
      'Linha 1\nLinha 2',
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('rejects offsetless dates, malformed Unicode and forbidden controls before SQL', () => {
    let called = false;
    const service = serviceWith(() => {
      called = true;
      return Promise.resolve([]);
    });
    expect(() =>
      service.createNextAction(tenant, leadId, '1', randomUUID(), {
        type: LeadNextActionType.CALL,
        description: 'Ligar',
        dueAt: '2026-07-30T12:00:00',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.createNextAction(tenant, leadId, '1', randomUUID(), {
        type: LeadNextActionType.CALL,
        description: 'Calendário inválido',
        dueAt: '2026-02-30T09:00:00-03:00',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.createNextAction(tenant, leadId, '1', randomUUID(), {
        type: LeadNextActionType.CALL,
        description: 'Precisão excessiva',
        dueAt: '2026-07-27T09:00:00.1234567-03:00',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.createNote(tenant, leadId, '1', randomUUID(), {
        content: 'Texto\u2028inválido',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.createActivity(tenant, leadId, '1', randomUUID(), {
        type: LeadActivityType.CALL,
        performedAt: '2026-07-30T12:00:00Z',
        outcome: '\ud800',
      }),
    ).toThrow(BadRequestException);
    expect(called).toBe(false);
  });

  function serviceWith(query: QueryStub): LeadsService {
    return new LeadsService(
      { query } as unknown as DataSource,
      { getOrThrow: () => config } as unknown as ConfigService,
      {
        assertManualReady: jest.fn(),
        assertFormReady: jest.fn(),
        assertOperationalReadReady: jest.fn(),
      },
    );
  }
});
