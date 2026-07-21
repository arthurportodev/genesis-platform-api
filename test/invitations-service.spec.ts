import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { OrganizationAuditService } from '../src/modules/organization-audit/services/organization-audit.service';
import {
  InvitationDeliveryStatus,
  InvitationRole,
  InvitationStatus,
} from '../src/modules/invitations/enums/invitation.enums';
import { EnabledInvitationIssuanceReadiness } from '../src/modules/invitations/ports/invitation-issuance-readiness.port';
import { InvitationsService } from '../src/modules/invitations/services/invitations.service';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';

describe('InvitationsService command invariants', () => {
  const tenant = {
    userId: randomUUID(),
    organizationId: randomUUID(),
    membershipId: randomUUID(),
    role: MembershipRole.OWNER,
  };

  it('uses the private lock boundary before reloading central rows and persists current key v2', async () => {
    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    const record = jest.fn();
    const audit = { record } as unknown as OrganizationAuditService;
    const manager = commandManager(queries);
    const dataSource = {
      transaction: jest.fn(
        async (callback: (entityManager: EntityManager) => Promise<unknown>) =>
          callback(manager),
      ),
    } as unknown as DataSource;
    const service = new InvitationsService(
      dataSource,
      audit,
      new EnabledInvitationIssuanceReadiness(),
      { currentVersion: () => 2, keyFor: () => Buffer.alloc(32, 2) },
    );

    await service.create(
      tenant,
      { email: 'member@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );

    const privateLock = queries.findIndex(({ sql }) =>
      sql.includes('app_private.lock_invitation_context'),
    );
    const organizationReload = queries.findIndex(({ sql }) =>
      sql.includes('SELECT id, status FROM organizations'),
    );
    const userReload = queries.findIndex(({ sql }) =>
      sql.includes('SELECT id, status, email FROM users'),
    );
    const membershipReload = queries.findIndex(({ sql }) =>
      sql.includes('role, status FROM memberships'),
    );
    expect(privateLock).toBeGreaterThanOrEqual(0);
    expect(organizationReload).toBeGreaterThan(privateLock);
    expect(userReload).toBeGreaterThan(organizationReload);
    expect(membershipReload).toBeGreaterThan(userReload);
    expect(queries[privateLock]?.parameters).toEqual([
      [tenant.organizationId],
      [tenant.userId],
      [tenant.membershipId],
    ]);
    expect(
      queries.some(({ sql }) =>
        /FROM\s+(organizations|users|memberships)\b[\s\S]*FOR UPDATE/iu.test(
          sql,
        ),
      ),
    ).toBe(false);
    const insert = queries.find(({ sql }) =>
      sql.includes('INSERT INTO organization_invitations'),
    );
    expect(insert?.parameters[5]).toBe(2);
  });

  it('aborts before any write when currentVersion fails', async () => {
    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    const manager = commandManager(queries);
    const dataSource = {
      transaction: jest.fn(
        async (callback: (entityManager: EntityManager) => Promise<unknown>) =>
          callback(manager),
      ),
    } as unknown as DataSource;
    const record = jest.fn();
    const audit = { record } as unknown as OrganizationAuditService;
    const service = new InvitationsService(
      dataSource,
      audit,
      new EnabledInvitationIssuanceReadiness(),
      {
        currentVersion: () => {
          throw new Error('keyring unavailable');
        },
        keyFor: () => Buffer.alloc(32),
      },
    );

    await expect(
      service.create(
        tenant,
        { email: 'member@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow('keyring unavailable');
    expect(
      queries.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/u.test(sql)),
    ).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('reads idempotency under the organization lock without a row lock', async () => {
    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    const invitationId = randomUUID();
    const manager = commandManager(queries, invitationId);
    const dataSource = {
      transaction: jest.fn(
        async (callback: (entityManager: EntityManager) => Promise<unknown>) =>
          callback(manager),
      ),
    } as unknown as DataSource;
    const service = new InvitationsService(
      dataSource,
      new OrganizationAuditService(),
      new EnabledInvitationIssuanceReadiness(),
      { currentVersion: () => 2, keyFor: () => Buffer.alloc(32, 2) },
    );
    const key = randomUUID();

    await expect(
      service.replace(tenant, invitationId, key, {
        ipAddress: null,
        userAgent: null,
      }),
    ).resolves.toMatchObject({ replayed: true });

    const privateLock = queries.findIndex(({ sql }) =>
      sql.includes('app_private.lock_invitation_context'),
    );
    const actorReload = queries.findIndex(({ sql }) =>
      sql.includes('SELECT id, role FROM memberships'),
    );
    const idempotencyRead = queries.findIndex(({ sql }) =>
      sql.includes('SELECT fingerprint'),
    );
    expect(privateLock).toBeGreaterThanOrEqual(0);
    expect(actorReload).toBeGreaterThan(privateLock);
    expect(idempotencyRead).toBeGreaterThan(actorReload);
    expect(queries[idempotencyRead]?.sql).not.toContain('FOR UPDATE');
  });

  function commandManager(
    queries: Array<{ sql: string; parameters: unknown[] }>,
    replayInvitationId?: string,
  ): EntityManager {
    const query = jest.fn((sql: string, parameters: unknown[] = []) => {
      queries.push({ sql, parameters });
      if (sql.includes('SELECT id, status FROM organizations')) {
        return [{ id: tenant.organizationId, status: 'active' }];
      }
      if (sql.includes('SELECT id, status, email FROM users')) {
        return [
          { id: tenant.userId, status: 'active', email: 'owner@example.com' },
        ];
      }
      if (sql.includes('role, status FROM memberships')) {
        return [
          {
            id: tenant.membershipId,
            userId: tenant.userId,
            organizationId: tenant.organizationId,
            role: MembershipRole.OWNER,
            status: 'active',
          },
        ];
      }
      if (
        sql.includes('SELECT id FROM organizations') &&
        sql.includes("status = 'active'")
      ) {
        return [{ id: tenant.organizationId }];
      }
      if (
        sql.includes('SELECT id FROM users') &&
        sql.includes("status = 'active'")
      ) {
        return [{ id: tenant.userId }];
      }
      if (sql.includes('SELECT id, role FROM memberships')) {
        return [{ id: tenant.membershipId, role: MembershipRole.OWNER }];
      }
      if (sql.includes('SELECT fingerprint')) {
        if (replayInvitationId === undefined) return [];
        const now = new Date('2026-07-20T12:00:00.000Z');
        return [
          {
            fingerprint: createHash('sha256')
              .update(`replace:${replayInvitationId}`, 'utf8')
              .digest('hex'),
            resultPreviousInvitationId: replayInvitationId,
            resultInvitationId: randomUUID(),
            resultStateAtCreation: InvitationStatus.PENDING,
            resultDeliveryStatusAtCreation: InvitationDeliveryStatus.QUEUED,
            responseEmailNormalized: 'member@example.com',
            responseInvitedRole: InvitationRole.MEMBER,
            responseInvitationCreatedAt: now,
            responseInvitationUpdatedAt: now,
            responseInvitationExpiresAt: new Date('2026-07-27T12:00:00.000Z'),
            responseInvitedByMembershipId: tenant.membershipId,
            isExpired: false,
          },
        ];
      }
      if (sql.includes('count(*) FILTER')) {
        return [
          {
            actorCount: '0',
            emailCount: '0',
            organizationCount: '0',
            pendingCount: '0',
          },
        ];
      }
      if (sql.includes('FROM users WHERE email')) return [];
      if (sql.includes('FROM organization_invitations i')) return [];
      if (sql.includes('INSERT INTO organization_invitations')) {
        const now = new Date('2026-07-20T12:00:00.000Z');
        return [
          {
            id: parameters[0],
            organizationId: tenant.organizationId,
            emailNormalized: parameters[2],
            role: InvitationRole.MEMBER,
            status: InvitationStatus.PENDING,
            expiresAt: new Date('2026-07-27T12:00:00.000Z'),
            invitedByMembershipId: tenant.membershipId,
            acceptedByUserId: null,
            resultingMembershipId: null,
            acceptedAt: null,
            revokedByMembershipId: null,
            revokedAt: null,
            revocationReason: null,
            supersededByInvitationId: null,
            tokenKeyVersion: parameters[5],
            tokenVersion: 1,
            createdAt: now,
            updatedAt: now,
            deliveryStatus: InvitationDeliveryStatus.QUEUED,
            effectiveState: 'pending',
          },
        ];
      }
      return [];
    });
    return {
      query,
      getRepository: jest.fn(() => ({
        create: (value: unknown) => value,
        insert: jest.fn(),
      })),
    } as unknown as EntityManager;
  }
});
