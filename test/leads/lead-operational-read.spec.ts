import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import {
  LeadListSort,
  LeadStage,
  LeadStatus,
} from '../../src/modules/leads/enums/lead.enums';
import { LeadReadiness } from '../../src/modules/leads/ports/lead-readiness.port';
import { LeadOperationalReadService } from '../../src/modules/leads/services/lead-operational-read.service';
import { LeadReadRateLimiter } from '../../src/modules/leads/services/lead-read-rate-limiter.service';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';

describe('Lead operational reads', () => {
  const config: LeadConfig = {
    formReadiness: false,
    formOrganizationId: null,
    formCurrentKeyVersion: null,
    formKeys: new Map(),
    idempotencyCurrentKeyVersion: 1,
    idempotencyKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    publicReplicaCount: 1,
    rateLimitWindowSeconds: 900,
    formIpMaxAttempts: 30,
    formKeyMaxAttempts: 300,
    rateLimitMaxBuckets: 10_000,
    readRateLimitWindowSeconds: 60,
    readMembershipMaxAttempts: 2,
    readIpMaxAttempts: 4,
    metricsMembershipMaxAttempts: 1,
    readRateLimitMaxBuckets: 100,
    readStatementTimeoutMs: 3_000,
  };
  const tenant = {
    userId: randomUUID(),
    membershipId: randomUUID(),
    organizationId: randomUUID(),
    role: MembershipRole.OWNER,
  };
  const readiness: LeadReadiness = {
    assertManualReady: jest.fn(),
    assertFormReady: jest.fn(),
    assertOperationalReadReady: jest.fn(),
  };

  it('emits a filter-bound opaque cursor without PII and rejects reuse', async () => {
    const leadId = randomUUID();
    const { service, query } = createService([
      {
        actorRole: MembershipRole.OWNER,
        targetExists: true,
        asOf: '2026-07-27T12:00:00.000Z',
        total: '2',
        id: leadId,
        displayName: 'Ágata',
        primaryPhone: '+5562999999999',
        email: 'agata@example.com',
        companyName: null,
        responsibleMembershipId: null,
        status: LeadStatus.ACTIVE,
        stage: LeadStage.NEW,
        source: 'manual',
        lastEntryAt: '2026-07-27T11:00:00.000Z',
        nextAction: null,
        temporalState: 'none',
        returnPending: false,
        revision: '1',
        createdAt: '2026-07-27T10:00:00.000Z',
        cursorCreatedAt: '2026-07-27T10:00:00.000123Z',
        updatedAt: '2026-07-27T10:00:00.000Z',
      },
      {
        actorRole: MembershipRole.OWNER,
        targetExists: true,
        asOf: '2026-07-27T12:00:00.000Z',
        total: '2',
        id: randomUUID(),
        displayName: 'Beatriz',
        primaryPhone: '+5562888888888',
        email: null,
        companyName: null,
        responsibleMembershipId: null,
        status: LeadStatus.ACTIVE,
        stage: LeadStage.NEW,
        source: 'campaign',
        lastEntryAt: '2026-07-27T10:30:00.000Z',
        nextAction: null,
        temporalState: 'none',
        returnPending: false,
        revision: '1',
        createdAt: '2026-07-27T09:00:00.000Z',
        cursorCreatedAt: '2026-07-27T09:00:00.999999Z',
        updatedAt: '2026-07-27T09:00:00.000Z',
      },
    ]);

    const first = await service.list(tenant, {
      q: 'Ága',
      limit: 1,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(first.page).toMatchObject({ total: 2, limit: 1 });
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(first.page.nextCursor).not.toContain('Ága');
    expect(first.page.nextCursor).not.toContain('+5562');
    expect(
      JSON.parse(
        Buffer.from(first.page.nextCursor as string, 'base64url').toString(
          'utf8',
        ),
      ),
    ).toMatchObject({ key: '2026-07-27T10:00:00.000123Z', id: leadId });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM authorized_actor actor CROSS JOIN counted'),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('filtered AS NOT MATERIALIZED'),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'LEFT JOIN public.lead_next_actions pending_action',
      ),
      expect.any(Array),
    );

    const tampered = JSON.parse(
      Buffer.from(first.page.nextCursor as string, 'base64url').toString(
        'utf8',
      ),
    ) as { key: string };
    tampered.key = '2026-07-27T10:00:00.000124Z';
    await expect(
      service.list(tenant, {
        q: 'Ága',
        limit: 1,
        sort: LeadListSort.CREATED_AT_DESC,
        cursor: Buffer.from(JSON.stringify(tampered), 'utf8').toString(
          'base64url',
        ),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.list(tenant, {
        q: 'Outra',
        limit: 1,
        sort: LeadListSort.CREATED_AT_DESC,
        cursor: first.page.nextCursor as string,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects one-sided operational date ranges', async () => {
    const { service } = createService([]);

    await expect(
      service.list(tenant, {
        createdFrom: '2026-01-01',
        limit: 25,
        sort: LeadListSort.CREATED_AT_DESC,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.list(tenant, {
        lastEntryTo: '2026-12-31',
        limit: 25,
        sort: LeadListSort.CREATED_AT_DESC,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts at most 366 operational days and keeps DST conversion in SQL', async () => {
    const { service, query } = createService([
      {
        actorRole: MembershipRole.OWNER,
        targetExists: true,
        asOf: '2026-07-27T12:00:00.000Z',
        total: '0',
      },
    ]);

    await expect(
      service.list(tenant, {
        createdFrom: '2025-01-01',
        createdTo: '2026-01-02',
        lastEntryFrom: '2026-03-07',
        lastEntryTo: '2026-03-09',
        limit: 25,
        sort: LeadListSort.CREATED_AT_DESC,
      }),
    ).resolves.toMatchObject({ items: [], page: { total: 0 } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AT TIME ZONE actor.crm_time_zone'),
      expect.any(Array),
    );

    const { service: excessive } = createService([]);
    await expect(
      excessive.list(tenant, {
        createdFrom: '2025-01-01',
        createdTo: '2026-01-03',
        limit: 25,
        sort: LeadListSort.CREATED_AT_DESC,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses the current database role and rejects member metrics', async () => {
    const { service } = createService([
      {
        actorRole: MembershipRole.MEMBER,
        asOf: '2026-07-27T12:00:00.000Z',
        timeZone: 'America/Belem',
        fromDate: '2026-07-27',
        toDate: '2026-07-27',
        active: '0',
        unassigned: '0',
        overdue: '0',
        withoutNextAction: '0',
        pendingReturns: '0',
        created: '0',
        won: '0',
        lost: '0',
        createdBySource: [],
      },
    ]);
    await expect(
      service.metrics(tenant, { from: '2026-07-27', to: '2026-07-27' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('drives my-actions through the pending-action responsible index key', async () => {
    const { service, query } = createService([
      {
        actorRole: MembershipRole.OWNER,
        targetExists: true,
        asOf: '2026-07-27T12:00:00.000Z',
        total: '0',
      },
    ]);

    await service.myActions(tenant, { limit: 25 });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'pending_action.responsible_membership_id = actor.id',
      ),
      expect.any(Array),
    );
  });

  it('enforces a separate stricter membership bucket for metrics', () => {
    const limiter = new LeadReadRateLimiter(config);
    try {
      limiter.consume('metrics', '127.0.0.1', tenant.membershipId);
      expect(() =>
        limiter.consume('metrics', '127.0.0.2', tenant.membershipId),
      ).toThrow(HttpException);
    } finally {
      limiter.onModuleDestroy();
    }
  });

  function createService(resultRows: unknown[]) {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(resultRows);
    const runner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      query,
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
    } as unknown as QueryRunner;
    const dataSource = {
      createQueryRunner: () => runner,
    } as unknown as DataSource;
    return {
      query,
      service: new LeadOperationalReadService(
        dataSource,
        { getOrThrow: () => config } as unknown as ConfigService,
        readiness,
      ),
    };
  }
});
