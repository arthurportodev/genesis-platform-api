import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import { OrganizationAuditEventType } from '../../organization-audit/enums/organization-audit-event-type.enum';
import { OrganizationAuditService } from '../../organization-audit/services/organization-audit.service';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import { CreateInvitationDto } from '../dto/create-invitation.dto';
import { ListInvitationsDto } from '../dto/list-invitations.dto';
import {
  InvitationDeliveryEventType,
  InvitationDeliveryStatus,
  InvitationEffectiveState,
  InvitationRevocationReason,
  InvitationRole,
  InvitationStatus,
} from '../enums/invitation.enums';
import {
  INVITATION_ISSUANCE_READINESS,
  InvitationIssuanceReadiness,
} from '../ports/invitation-issuance-readiness.port';
import {
  INVITATION_TOKEN_KEYRING,
  InvitationTokenKeyring,
} from '../ports/invitation-token-keyring.port';
import {
  PendingInvitationRevocationContext,
  PendingInvitationRevoker,
} from '../ports/pending-invitation-revoker.port';
import {
  InvitationAdminView,
  InvitationListResponse,
  InvitationReplacementExecution,
  InvitationReplacementResult,
  InvitationRequestContext,
} from '../types/invitation-api.type';

interface ActorRow {
  userId: string;
  membershipId: string;
  organizationId: string;
  role: MembershipRole;
}

interface RecipientUserRow {
  id: string;
  email: string;
  status: string;
}

interface RecipientMembershipRow {
  id: string;
  userId: string;
  organizationId: string;
  role: MembershipRole;
  status: string;
}

interface CreateLockScope {
  actor: ActorRow;
  recipientUser: RecipientUserRow | null;
  recipientMembership: RecipientMembershipRow | null;
  existingInvitation: InvitationRow | null;
}

class CreateScopeChangedError extends Error {}
class CentralLockScopeChangedError extends Error {}

const CREATE_SCOPE_RETRY_LIMIT = 3;

interface InvitationRow {
  id: string;
  organizationId: string;
  emailNormalized: string;
  role: InvitationRole;
  status: InvitationStatus;
  expiresAt: Date;
  invitedByMembershipId: string;
  acceptedByUserId: string | null;
  resultingMembershipId: string | null;
  acceptedAt: Date | null;
  revokedByMembershipId: string | null;
  revokedAt: Date | null;
  revocationReason: InvitationRevocationReason | null;
  supersededByInvitationId: string | null;
  tokenKeyVersion: number;
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deliveryStatus: InvitationDeliveryStatus;
  effectiveState: InvitationEffectiveState;
}

interface IdempotencyRow {
  fingerprint: string;
  resultPreviousInvitationId: string;
  resultInvitationId: string;
  resultStateAtCreation: InvitationEffectiveState.PENDING;
  resultDeliveryStatusAtCreation: InvitationDeliveryStatus.QUEUED;
  responseEmailNormalized: string;
  responseInvitedRole: InvitationRole;
  responseInvitationCreatedAt: Date;
  responseInvitationUpdatedAt: Date;
  responseInvitationExpiresAt: Date;
  responseInvitedByMembershipId: string;
  isExpired: boolean;
}

interface CursorValue {
  createdAt: string;
  id: string;
}

@Injectable()
export class InvitationsService implements PendingInvitationRevoker {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: OrganizationAuditService,
    @Inject(INVITATION_ISSUANCE_READINESS)
    private readonly readiness: InvitationIssuanceReadiness,
    @Inject(INVITATION_TOKEN_KEYRING)
    private readonly keyring: InvitationTokenKeyring,
  ) {}

  async create(
    tenant: TenantContext,
    dto: CreateInvitationDto,
    requestContext: InvitationRequestContext,
  ): Promise<InvitationAdminView> {
    this.readiness.assertReady();
    const email = normalizeEmail(dto.email);

    for (let attempt = 0; attempt < CREATE_SCOPE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const scope = await this.lockCreateScope(manager, tenant, email);
          const { actor, existingInvitation: existing } = scope;
          this.assertCanTarget(actor.role, dto.role);
          const keyVersion = this.currentKeyVersion();
          await this.assertQuotas(manager, actor, email);
          this.assertRecipientAvailable(
            scope.recipientUser,
            scope.recipientMembership,
          );

          if (existing !== null) {
            this.assertExistingInvitationVisible(actor.role, existing.role);
          }
          if (
            existing !== null &&
            existing.effectiveState === InvitationEffectiveState.PENDING
          ) {
            throw new ConflictException('Invitation already pending.');
          }

          const invitationId = randomUUID();
          if (existing !== null) {
            await this.retireInvitation(
              manager,
              existing,
              invitationId,
              actor.userId,
              actor.membershipId,
              InvitationRevocationReason.EXPIRED_REISSUED,
              requestContext,
            );
          }
          const invitation = await this.insertInvitation(
            manager,
            actor,
            email,
            dto.role,
            invitationId,
            keyVersion,
          );
          await this.enqueueDelivery(manager, invitation);
          await this.audit.record(
            {
              organizationId: actor.organizationId,
              eventType: OrganizationAuditEventType.INVITATION_CREATED,
              invitationId: invitation.id,
              relatedInvitationId: existing?.id ?? null,
              actorUserId: actor.userId,
              actorMembershipId: actor.membershipId,
              invitedRole: invitation.role,
              reason: null,
              correlationId: randomUUID(),
              ipAddress: requestContext.ipAddress,
              userAgent: requestContext.userAgent,
            },
            manager,
          );
          return this.toView(invitation);
        });
      } catch (error) {
        if (
          error instanceof CreateScopeChangedError &&
          attempt + 1 < CREATE_SCOPE_RETRY_LIMIT
        ) {
          continue;
        }
        if (error instanceof CreateScopeChangedError) {
          throw new ConflictException('Invitation state changed.');
        }
        throw error;
      }
    }
    throw new ConflictException('Invitation state changed.');
  }

  async list(
    tenant: TenantContext,
    query: ListInvitationsDto,
  ): Promise<InvitationListResponse> {
    const actor = await this.resolveActor(tenant);
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    if (
      actor.role === MembershipRole.ADMIN &&
      query.role === InvitationRole.ADMIN
    ) {
      return { items: [], page: { nextCursor: null, limit: query.limit } };
    }

    const parameters: unknown[] = [actor.organizationId];
    const predicates = ['i.organization_id = $1'];
    if (actor.role === MembershipRole.ADMIN) {
      parameters.push(InvitationRole.MEMBER);
      predicates.push(`i.role = $${parameters.length}`);
    } else if (query.role !== undefined) {
      parameters.push(query.role);
      predicates.push(`i.role = $${parameters.length}`);
    }
    if (query.email !== undefined) {
      parameters.push(normalizeEmail(query.email));
      predicates.push(`i.email_normalized = $${parameters.length}`);
    }
    if (query.state !== undefined) {
      parameters.push(query.state);
      predicates.push(`${this.effectiveStateSql('i')} = $${parameters.length}`);
    }
    if (cursor !== null) {
      parameters.push(cursor.createdAt, cursor.id);
      predicates.push(
        `(i.created_at, i.id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`,
      );
    }
    parameters.push(query.limit + 1);
    const rows = await this.dataSource.query<InvitationRow[]>(
      `${this.selectInvitationSql('i')}
       WHERE ${predicates.join(' AND ')}
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => this.toView(row)),
      page: {
        nextCursor:
          hasMore && last !== undefined
            ? this.encodeCursor(last.createdAt, last.id)
            : null,
        limit: query.limit,
      },
    };
  }

  async get(
    tenant: TenantContext,
    invitationId: string,
  ): Promise<InvitationAdminView> {
    const actor = await this.resolveActor(tenant);
    const invitation = await this.findVisibleInvitation(
      this.dataSource.manager,
      actor,
      invitationId,
      false,
    );
    if (invitation === null) {
      throw new NotFoundException('Invitation not found.');
    }
    return this.toView(invitation);
  }

  async revoke(
    tenant: TenantContext,
    invitationId: string,
    requestContext: InvitationRequestContext,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const actor = await this.lockActor(manager, tenant);
      const invitation = await this.findVisibleInvitation(
        manager,
        actor,
        invitationId,
        true,
      );
      if (invitation === null) {
        throw new NotFoundException('Invitation not found.');
      }
      if (invitation.status === InvitationStatus.ACCEPTED) {
        throw new ConflictException('Invitation state conflict.');
      }
      if (invitation.status === InvitationStatus.REVOKED) {
        return;
      }
      await this.revokeRow(
        manager,
        invitation,
        actor.membershipId,
        InvitationRevocationReason.MANUAL,
      );
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          eventType: OrganizationAuditEventType.INVITATION_REVOKED,
          invitationId: invitation.id,
          relatedInvitationId: null,
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId,
          invitedRole: invitation.role,
          reason: InvitationRevocationReason.MANUAL,
          correlationId: randomUUID(),
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent,
        },
        manager,
      );
    });
  }

  async replace(
    tenant: TenantContext,
    invitationId: string,
    idempotencyKey: string,
    requestContext: InvitationRequestContext,
  ): Promise<InvitationReplacementExecution> {
    this.readiness.assertReady();
    const fingerprint = createHash('sha256')
      .update(`replace:${invitationId}`, 'utf8')
      .digest('hex');

    return this.dataSource.transaction(async (manager) => {
      const actor = await this.lockActor(manager, tenant);
      await manager.query(
        `DELETE FROM organization_command_idempotency
         WHERE organization_id = $1
           AND created_at < transaction_timestamp() - interval '30 days'`,
        [actor.organizationId],
      );
      const replay = await this.findIdempotencyUnderOrganizationLock(
        manager,
        actor,
        idempotencyKey,
      );
      if (replay !== null) {
        if (
          replay.fingerprint !== fingerprint ||
          replay.resultPreviousInvitationId !== invitationId
        ) {
          throw new ConflictException('Idempotency key conflict.');
        }
        if (replay.isExpired) {
          throw new ConflictException('Idempotency key expired.');
        }
        this.assertReplayVisible(actor.role, replay.responseInvitedRole);
        return Object.freeze({
          view: this.snapshotToView(replay),
          result: this.idempotencyResult(replay),
          replayed: true,
        });
      }

      const invitation = await this.findVisibleInvitation(
        manager,
        actor,
        invitationId,
        true,
      );
      if (invitation === null) {
        throw new NotFoundException('Invitation not found.');
      }
      if (invitation.status !== InvitationStatus.PENDING) {
        throw new ConflictException('Invitation state conflict.');
      }
      await this.assertQuotas(manager, actor, invitation.emailNormalized);
      const keyVersion = this.currentKeyVersion();
      const replacementId = randomUUID();
      await this.retireInvitation(
        manager,
        invitation,
        replacementId,
        actor.userId,
        actor.membershipId,
        InvitationRevocationReason.REPLACED,
        requestContext,
      );
      const replacement = await this.insertInvitation(
        manager,
        actor,
        invitation.emailNormalized,
        invitation.role,
        replacementId,
        keyVersion,
      );
      await this.enqueueDelivery(manager, replacement);
      const snapshot = this.replacementView(replacement);
      const result = this.replacementResult(invitation.id, replacement.id);
      await this.insertIdempotency(
        manager,
        actor,
        idempotencyKey,
        fingerprint,
        result,
        snapshot,
      );
      return Object.freeze({ view: snapshot, result, replayed: false });
    });
  }

  async revokeByIssuerMembership(
    membershipId: string,
    context: PendingInvitationRevocationContext,
    manager: EntityManager,
  ): Promise<number> {
    await this.lockMembershipRevocationScope(manager, membershipId);
    return this.bulkRevoke(
      manager,
      `i.invited_by_membership_id = $1`,
      [membershipId],
      InvitationRevocationReason.ISSUER_MEMBERSHIP_INACTIVE,
      OrganizationAuditEventType.INVITATIONS_REVOKED_ISSUER_MEMBERSHIP_INACTIVE,
      context,
    );
  }

  async revokeByIssuerUser(
    userId: string,
    context: PendingInvitationRevocationContext,
    manager: EntityManager,
  ): Promise<number> {
    await this.lockUserRevocationScope(manager, userId);
    return this.bulkRevoke(
      manager,
      `EXISTS (
        SELECT 1 FROM memberships issuer_membership
        WHERE issuer_membership.id = i.invited_by_membership_id
          AND issuer_membership.user_id = $1
      )`,
      [userId],
      InvitationRevocationReason.ISSUER_USER_INACTIVE,
      OrganizationAuditEventType.INVITATIONS_REVOKED_ISSUER_USER_INACTIVE,
      context,
    );
  }

  private async lockMembershipRevocationScope(
    manager: EntityManager,
    membershipId: string,
  ): Promise<void> {
    const scopes = await manager.query<
      Array<{ organizationId: string; userId: string }>
    >(
      `SELECT organization_id AS "organizationId", user_id AS "userId"
       FROM memberships WHERE id = $1`,
      [membershipId],
    );
    const scope = scopes[0];
    if (scope === undefined) return;
    await this.lockInvitationContext(
      manager,
      [scope.organizationId],
      [scope.userId],
      [membershipId],
    );
    const currentScopes = await manager.query<
      Array<{ organizationId: string; userId: string }>
    >(
      `SELECT organization_id AS "organizationId", user_id AS "userId"
       FROM memberships WHERE id = $1`,
      [membershipId],
    );
    const currentScope = currentScopes[0];
    if (currentScope === undefined) return;
    if (
      currentScope.organizationId !== scope.organizationId ||
      currentScope.userId !== scope.userId
    ) {
      throw new CentralLockScopeChangedError();
    }
    await manager.query(
      `SELECT id FROM organization_invitations
       WHERE invited_by_membership_id = $1 AND status = 'pending'
       ORDER BY id FOR UPDATE`,
      [membershipId],
    );
  }

  private async lockUserRevocationScope(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const scopes = await manager.query<
      Array<{ membershipId: string; organizationId: string }>
    >(
      `SELECT id AS "membershipId", organization_id AS "organizationId"
       FROM memberships WHERE user_id = $1 ORDER BY organization_id, id`,
      [userId],
    );
    const organizationIds = [
      ...new Set(scopes.map((scope) => scope.organizationId)),
    ].sort();
    const membershipIds = scopes.map((scope) => scope.membershipId).sort();
    await this.lockInvitationContext(
      manager,
      organizationIds,
      [userId],
      membershipIds,
    );
    const currentScopes = await manager.query<
      Array<{ membershipId: string; organizationId: string }>
    >(
      `SELECT id AS "membershipId", organization_id AS "organizationId"
       FROM memberships WHERE user_id = $1 ORDER BY organization_id, id`,
      [userId],
    );
    if (JSON.stringify(currentScopes) !== JSON.stringify(scopes)) {
      throw new CentralLockScopeChangedError();
    }
    if (membershipIds.length > 0) {
      await manager.query(
        `SELECT id FROM organization_invitations
         WHERE invited_by_membership_id = ANY($1::uuid[]) AND status = 'pending'
         ORDER BY organization_id, id FOR UPDATE`,
        [membershipIds],
      );
    }
  }

  private async resolveActor(tenant: TenantContext): Promise<ActorRow> {
    const rows = await this.dataSource.query<ActorRow[]>(
      `SELECT u.id AS "userId", m.id AS "membershipId",
              o.id AS "organizationId", m.role AS "role"
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
       WHERE m.id = $1 AND m.user_id = $2 AND m.organization_id = $3
         AND m.status = 'active'`,
      [tenant.membershipId, tenant.userId, tenant.organizationId],
    );
    const actor = rows[0];
    if (
      actor === undefined ||
      ![MembershipRole.OWNER, MembershipRole.ADMIN].includes(actor.role)
    ) {
      throw new ForbiddenException('Organization access denied.');
    }
    return actor;
  }

  private async lockActor(
    manager: EntityManager,
    tenant: TenantContext,
  ): Promise<ActorRow> {
    await this.lockInvitationContext(
      manager,
      [tenant.organizationId],
      [tenant.userId],
      [tenant.membershipId],
    );
    const organizations = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM organizations
       WHERE id = $1 AND status = 'active'`,
      [tenant.organizationId],
    );
    if (organizations[0] === undefined) {
      throw new ForbiddenException('Organization access denied.');
    }
    const users = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
      [tenant.userId],
    );
    if (users[0] === undefined) {
      throw new ForbiddenException('Organization access denied.');
    }
    const memberships = await manager.query<
      Array<{ id: string; role: MembershipRole }>
    >(
      `SELECT id, role FROM memberships
       WHERE id = $1 AND user_id = $2 AND organization_id = $3
         AND status = 'active'`,
      [tenant.membershipId, tenant.userId, tenant.organizationId],
    );
    const membership = memberships[0];
    if (
      membership === undefined ||
      ![MembershipRole.OWNER, MembershipRole.ADMIN].includes(membership.role)
    ) {
      throw new ForbiddenException('Organization access denied.');
    }
    return {
      userId: tenant.userId,
      membershipId: membership.id,
      organizationId: tenant.organizationId,
      role: membership.role,
    };
  }

  private async lockCreateScope(
    manager: EntityManager,
    tenant: TenantContext,
    email: string,
  ): Promise<CreateLockScope> {
    const recipientUsers = await manager.query<RecipientUserRow[]>(
      `SELECT id, email, status FROM users WHERE email = $1 ORDER BY id`,
      [email],
    );
    const recipientMemberships = await manager.query<RecipientMembershipRow[]>(
      `SELECT m.id, m.user_id AS "userId",
              m.organization_id AS "organizationId", m.role, m.status
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE u.email = $1 AND m.organization_id = $2
       ORDER BY m.id`,
      [email, tenant.organizationId],
    );
    const invitationIds = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM organization_invitations
       WHERE organization_id = $1 AND email_normalized = $2
         AND status = 'pending' ORDER BY id`,
      [tenant.organizationId, email],
    );

    const organizationIds = [tenant.organizationId].sort();
    const userIds = [
      ...new Set([tenant.userId, ...recipientUsers.map(({ id }) => id)]),
    ]
      .map(String)
      .sort();
    const membershipIds = [
      ...new Set([
        tenant.membershipId,
        ...recipientMemberships.map(({ id }) => id),
      ]),
    ]
      .map(String)
      .sort();
    await this.lockInvitationContext(
      manager,
      organizationIds,
      userIds,
      membershipIds,
    );
    const organizations = await manager.query<
      Array<{ id: string; status: string }>
    >(
      `SELECT id, status FROM organizations
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [organizationIds],
    );
    const users = await manager.query<RecipientUserRow[]>(
      `SELECT id, status, email FROM users
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [userIds],
    );
    const memberships = await manager.query<RecipientMembershipRow[]>(
      `SELECT id, user_id AS "userId", organization_id AS "organizationId",
              role, status FROM memberships
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [membershipIds],
    );
    const sortedInvitationIds = invitationIds.map(({ id }) => id).sort();
    let lockedInvitations: InvitationRow[] = [];
    if (sortedInvitationIds.length > 0) {
      lockedInvitations = await manager.query<InvitationRow[]>(
        `${this.selectInvitationSql('i')}
         WHERE i.id = ANY($1::uuid[]) ORDER BY i.id FOR UPDATE OF i`,
        [sortedInvitationIds],
      );
    }

    const currentRecipientUsers = await manager.query<RecipientUserRow[]>(
      `SELECT id, email, status FROM users WHERE email = $1 ORDER BY id`,
      [email],
    );
    const currentRecipientMemberships = await manager.query<
      RecipientMembershipRow[]
    >(
      `SELECT m.id, m.user_id AS "userId",
              m.organization_id AS "organizationId", m.role, m.status
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE u.email = $1 AND m.organization_id = $2
       ORDER BY m.id`,
      [email, tenant.organizationId],
    );
    const currentInvitationIds = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM organization_invitations
       WHERE organization_id = $1 AND email_normalized = $2
         AND status = 'pending' ORDER BY id`,
      [tenant.organizationId, email],
    );
    if (
      !this.sameSnapshot(recipientUsers, currentRecipientUsers) ||
      !this.sameSnapshot(recipientMemberships, currentRecipientMemberships) ||
      !this.sameSnapshot(invitationIds, currentInvitationIds)
    ) {
      throw new CreateScopeChangedError();
    }

    const organization = organizations.find(
      ({ id }) => id === tenant.organizationId,
    );
    const actorUser = users.find(({ id }) => id === tenant.userId);
    const actorMembership = memberships.find(
      ({ id }) => id === tenant.membershipId,
    );
    if (
      organization?.status !== 'active' ||
      actorUser?.status !== 'active' ||
      actorMembership?.userId !== tenant.userId ||
      actorMembership.organizationId !== tenant.organizationId ||
      actorMembership.status !== 'active' ||
      ![MembershipRole.OWNER, MembershipRole.ADMIN].includes(
        actorMembership.role,
      )
    ) {
      throw new ForbiddenException('Organization access denied.');
    }
    return {
      actor: {
        userId: tenant.userId,
        membershipId: actorMembership.id,
        organizationId: tenant.organizationId,
        role: actorMembership.role,
      },
      recipientUser:
        users.find(({ id }) => id === recipientUsers[0]?.id) ?? null,
      recipientMembership:
        memberships.find(({ id }) => id === recipientMemberships[0]?.id) ??
        null,
      existingInvitation: lockedInvitations[0] ?? null,
    };
  }

  private async lockInvitationContext(
    manager: EntityManager,
    organizationIds: string[],
    userIds: string[],
    membershipIds: string[],
  ): Promise<void> {
    await manager.query(
      `SELECT app_private.lock_invitation_context(
         $1::uuid[], $2::uuid[], $3::uuid[]
       )`,
      [organizationIds, userIds, membershipIds],
    );
  }

  private sameSnapshot<T>(left: T[], right: T[]): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private assertCanTarget(
    actorRole: MembershipRole,
    role: InvitationRole,
  ): void {
    if (!Object.values(InvitationRole).includes(role)) {
      throw new BadRequestException('Invalid invitation role.');
    }
    if (
      actorRole !== MembershipRole.OWNER &&
      !(actorRole === MembershipRole.ADMIN && role === InvitationRole.MEMBER)
    ) {
      throw new ForbiddenException('Organization access denied.');
    }
  }

  private assertReplayVisible(
    actorRole: MembershipRole,
    role: InvitationRole,
  ): void {
    const ownerVisible =
      actorRole === MembershipRole.OWNER &&
      [InvitationRole.MEMBER, InvitationRole.ADMIN].includes(role);
    const adminVisible =
      actorRole === MembershipRole.ADMIN && role === InvitationRole.MEMBER;
    if (!ownerVisible && !adminVisible) {
      throw new NotFoundException('Invitation not found.');
    }
  }

  private assertExistingInvitationVisible(
    actorRole: MembershipRole,
    existingRole: InvitationRole,
  ): void {
    if (
      actorRole === MembershipRole.ADMIN &&
      existingRole !== InvitationRole.MEMBER
    ) {
      throw new NotFoundException('Invitation not found.');
    }
  }

  private assertRecipientAvailable(
    user: RecipientUserRow | null,
    membership: RecipientMembershipRow | null,
  ): void {
    if (user === null) {
      return;
    }
    if (user.status === 'inactive') {
      throw new ConflictException('Invitation cannot be created.');
    }
    if (membership?.status === 'active') {
      throw new ConflictException('Invitation cannot be created.');
    }
  }

  private async assertQuotas(
    manager: EntityManager,
    actor: ActorRow,
    email: string,
  ): Promise<void> {
    const rows = await manager.query<
      Array<{
        actorCount: string;
        emailCount: string;
        organizationCount: string;
        pendingCount: string;
      }>
    >(
      `SELECT
        count(*) FILTER (
          WHERE invited_by_membership_id = $2
            AND created_at >= transaction_timestamp() - interval '15 minutes'
        )::text AS "actorCount",
        count(*) FILTER (
          WHERE email_normalized = $3
            AND created_at >= transaction_timestamp() - interval '24 hours'
        )::text AS "emailCount",
        count(*) FILTER (
          WHERE created_at >= transaction_timestamp() - interval '24 hours'
        )::text AS "organizationCount",
        count(*) FILTER (
          WHERE status = 'pending' AND expires_at > transaction_timestamp()
        )::text AS "pendingCount"
       FROM organization_invitations
       WHERE organization_id = $1`,
      [actor.organizationId, actor.membershipId, email],
    );
    const counts = rows[0];
    if (
      counts !== undefined &&
      (Number(counts.actorCount) >= 10 ||
        Number(counts.emailCount) >= 3 ||
        Number(counts.organizationCount) >= 100 ||
        Number(counts.pendingCount) >= 100)
    ) {
      throw new HttpException(
        'Invitation rate limit exceeded.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async findVisibleInvitation(
    manager: EntityManager,
    actor: ActorRow,
    invitationId: string,
    lock: boolean,
  ): Promise<InvitationRow | null> {
    const parameters: unknown[] = [invitationId, actor.organizationId];
    let rolePredicate = '';
    if (actor.role === MembershipRole.ADMIN) {
      parameters.push(InvitationRole.MEMBER);
      rolePredicate = ` AND i.role = $3`;
    }
    const rows = await manager.query<InvitationRow[]>(
      `${this.selectInvitationSql('i')}
       WHERE i.id = $1 AND i.organization_id = $2${rolePredicate}
       ${lock ? 'FOR UPDATE OF i' : ''}`,
      parameters,
    );
    return rows[0] ?? null;
  }

  private async insertInvitation(
    manager: EntityManager,
    actor: ActorRow,
    email: string,
    role: InvitationRole,
    invitationId: string,
    keyVersion: number,
  ): Promise<InvitationRow> {
    const nonce = randomBytes(32).toString('base64url');
    const rows = await manager.query<InvitationRow[]>(
      `INSERT INTO organization_invitations (
        id, organization_id, email_normalized, role, status, expires_at,
        invited_by_membership_id, token_key_version, token_version, token_nonce
      ) VALUES (
        $1, $2, $3, $4, 'pending',
        date_trunc('milliseconds', transaction_timestamp()) + interval '7 days',
        $5, $6, 1, $7
      ) RETURNING
        id, organization_id AS "organizationId",
        email_normalized AS "emailNormalized", role, status,
        expires_at AS "expiresAt", invited_by_membership_id AS "invitedByMembershipId",
        accepted_by_user_id AS "acceptedByUserId",
        resulting_membership_id AS "resultingMembershipId",
        accepted_at AS "acceptedAt", revoked_by_membership_id AS "revokedByMembershipId",
        revoked_at AS "revokedAt", revocation_reason AS "revocationReason",
        superseded_by_invitation_id AS "supersededByInvitationId",
        token_key_version AS "tokenKeyVersion", token_version AS "tokenVersion",
        created_at AS "createdAt", updated_at AS "updatedAt",
        'queued'::text AS "deliveryStatus",
        'pending'::text AS "effectiveState"`,
      [
        invitationId,
        actor.organizationId,
        email,
        role,
        actor.membershipId,
        keyVersion,
        nonce,
      ],
    );
    const invitation = rows[0];
    if (invitation === undefined) {
      throw new Error('Invitation insert did not return a row.');
    }
    return invitation;
  }

  private currentKeyVersion(): number {
    const version = this.keyring.currentVersion();
    if (!Number.isSafeInteger(version) || version <= 0 || version > 32767) {
      throw new Error('Invalid invitation token key version.');
    }
    const key = this.keyring.keyFor(version);
    if (key.length < 32) {
      throw new Error('Invitation token key must contain at least 32 bytes.');
    }
    return version;
  }

  private async enqueueDelivery(
    manager: EntityManager,
    invitation: InvitationRow,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO invitation_delivery_outbox (
        organization_id, invitation_id, event_type, token_version, status
      ) VALUES ($1, $2, $3, $4, 'queued')`,
      [
        invitation.organizationId,
        invitation.id,
        InvitationDeliveryEventType.REQUESTED,
        invitation.tokenVersion,
      ],
    );
  }

  private async retireInvitation(
    manager: EntityManager,
    previous: InvitationRow,
    replacementId: string,
    actorUserId: string,
    actorMembershipId: string,
    reason: InvitationRevocationReason,
    requestContext: InvitationRequestContext,
  ): Promise<void> {
    await this.revokeRow(
      manager,
      previous,
      actorMembershipId,
      reason,
      replacementId,
    );
    await this.audit.record(
      {
        organizationId: previous.organizationId,
        eventType: OrganizationAuditEventType.INVITATION_REPLACED,
        invitationId: previous.id,
        relatedInvitationId: replacementId,
        actorUserId,
        actorMembershipId,
        invitedRole: previous.role,
        reason,
        correlationId: randomUUID(),
        ipAddress: requestContext.ipAddress,
        userAgent: requestContext.userAgent,
      },
      manager,
    );
  }

  private async revokeRow(
    manager: EntityManager,
    invitation: InvitationRow,
    actorMembershipId: string | null,
    reason: InvitationRevocationReason,
    supersededByInvitationId: string | null = null,
  ): Promise<void> {
    await manager.query(
      `UPDATE organization_invitations
       SET status = 'revoked', revoked_by_membership_id = $2,
           revoked_at = date_trunc('milliseconds', transaction_timestamp()),
           revocation_reason = $3, superseded_by_invitation_id = $4,
           updated_at = transaction_timestamp()
       WHERE id = $1 AND status = 'pending'`,
      [invitation.id, actorMembershipId, reason, supersededByInvitationId],
    );
    await manager.query(
      `UPDATE invitation_delivery_outbox
       SET status = 'cancelled', cancelled_at = transaction_timestamp(),
           locked_by = NULL, locked_at = NULL, lease_until = NULL,
           updated_at = transaction_timestamp()
       WHERE invitation_id = $1 AND organization_id = $2
         AND status IN ('queued', 'processing', 'dead')`,
      [invitation.id, invitation.organizationId],
    );
  }

  private async findIdempotencyUnderOrganizationLock(
    manager: EntityManager,
    actor: ActorRow,
    key: string,
  ): Promise<IdempotencyRow | null> {
    const rows = await manager.query<IdempotencyRow[]>(
      `SELECT fingerprint,
              result_previous_invitation_id AS "resultPreviousInvitationId",
              result_invitation_id AS "resultInvitationId",
              result_state_at_creation AS "resultStateAtCreation",
              result_delivery_status_at_creation AS "resultDeliveryStatusAtCreation",
              response_email_normalized AS "responseEmailNormalized",
              response_invited_role AS "responseInvitedRole",
              response_invitation_created_at AS "responseInvitationCreatedAt",
              response_invitation_updated_at AS "responseInvitationUpdatedAt",
              response_invitation_expires_at AS "responseInvitationExpiresAt",
              response_invited_by_membership_id AS "responseInvitedByMembershipId",
              expires_at <= transaction_timestamp() AS "isExpired"
       FROM organization_command_idempotency
       WHERE organization_id = $1 AND actor_membership_id = $2
         AND operation = 'replace' AND idempotency_key = $3`,
      [actor.organizationId, actor.membershipId, key],
    );
    return rows[0] ?? null;
  }

  private async insertIdempotency(
    manager: EntityManager,
    actor: ActorRow,
    key: string,
    fingerprint: string,
    result: Readonly<InvitationReplacementResult>,
    snapshot: Readonly<InvitationAdminView>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO organization_command_idempotency (
        organization_id, actor_membership_id, operation, idempotency_key,
        fingerprint, result_previous_invitation_id, result_invitation_id,
        result_state_at_creation, result_delivery_status_at_creation,
        response_email_normalized, response_invited_role,
        response_invitation_created_at, response_invitation_updated_at,
        response_invitation_expires_at, response_invited_by_membership_id,
        response_status, expires_at
      ) VALUES (
        $1, $2, 'replace', $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, 201, transaction_timestamp() + interval '24 hours'
      )`,
      [
        actor.organizationId,
        actor.membershipId,
        key,
        fingerprint,
        result.previousInvitationId,
        result.invitationId,
        result.stateAtCreation,
        result.deliveryStatusAtCreation,
        snapshot.email,
        snapshot.role,
        new Date(snapshot.createdAt),
        new Date(snapshot.updatedAt),
        new Date(snapshot.expiresAt),
        snapshot.invitedByMembershipId,
      ],
    );
  }

  private async bulkRevoke(
    manager: EntityManager,
    predicate: string,
    parameters: unknown[],
    reason: InvitationRevocationReason,
    eventType: OrganizationAuditEventType,
    context: PendingInvitationRevocationContext,
  ): Promise<number> {
    const safeContext = this.sanitizeRevocationContext(context);
    const rows = await manager.query<
      Array<{ id: string; organizationId: string; role: InvitationRole }>
    >(
      `WITH revoked AS (
         UPDATE organization_invitations i
         SET status = 'revoked', revoked_at = date_trunc('milliseconds', transaction_timestamp()),
             revocation_reason = $${parameters.length + 1}, updated_at = transaction_timestamp()
         WHERE i.status = 'pending' AND ${predicate}
         RETURNING i.id, i.organization_id, i.role
       ), cancelled AS (
         UPDATE invitation_delivery_outbox o
         SET status = 'cancelled', cancelled_at = transaction_timestamp(),
             locked_by = NULL, locked_at = NULL, lease_until = NULL,
             updated_at = transaction_timestamp()
         FROM revoked r
         WHERE o.invitation_id = r.id
           AND o.organization_id = r.organization_id
           AND o.status IN ('queued', 'processing', 'dead')
       )
       SELECT id, organization_id AS "organizationId", role FROM revoked`,
      [...parameters, reason],
    );
    for (const row of rows) {
      await this.audit.record(
        {
          organizationId: row.organizationId,
          eventType,
          invitationId: row.id,
          relatedInvitationId: null,
          actorUserId: safeContext.actorUserId,
          actorMembershipId: safeContext.actorMembershipId,
          invitedRole: row.role,
          reason,
          correlationId: safeContext.correlationId,
          ipAddress: safeContext.ipAddress,
          userAgent: safeContext.userAgent,
        },
        manager,
      );
    }
    return rows.length;
  }

  private sanitizeRevocationContext(
    context: PendingInvitationRevocationContext,
  ): PendingInvitationRevocationContext {
    return {
      actorUserId: context.actorUserId,
      actorMembershipId: context.actorMembershipId,
      correlationId: context.correlationId,
      ipAddress: context.ipAddress?.slice(0, 64) ?? null,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
    };
  }

  private toView(invitation: InvitationRow): InvitationAdminView {
    return {
      id: invitation.id,
      email: invitation.emailNormalized,
      role: invitation.role,
      state: invitation.effectiveState,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
      updatedAt: invitation.updatedAt.toISOString(),
      revokedAt: invitation.revokedAt?.toISOString() ?? null,
      acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
      invitedByMembershipId: invitation.invitedByMembershipId,
      revokedByMembershipId: invitation.revokedByMembershipId,
      acceptedByUserId: invitation.acceptedByUserId,
      resultingMembershipId: invitation.resultingMembershipId,
      supersededByInvitationId: invitation.supersededByInvitationId,
      deliveryStatus: invitation.deliveryStatus,
    };
  }

  private replacementView(
    invitation: InvitationRow,
  ): Readonly<InvitationAdminView> {
    return Object.freeze({
      id: invitation.id,
      email: invitation.emailNormalized,
      role: invitation.role,
      state: InvitationEffectiveState.PENDING,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
      updatedAt: invitation.updatedAt.toISOString(),
      revokedAt: null,
      acceptedAt: null,
      invitedByMembershipId: invitation.invitedByMembershipId,
      revokedByMembershipId: null,
      acceptedByUserId: null,
      resultingMembershipId: null,
      supersededByInvitationId: null,
      deliveryStatus: InvitationDeliveryStatus.QUEUED,
    });
  }

  private replacementResult(
    previousInvitationId: string,
    invitationId: string,
  ): Readonly<InvitationReplacementResult> {
    return Object.freeze({
      previousInvitationId,
      invitationId,
      stateAtCreation: InvitationEffectiveState.PENDING,
      deliveryStatusAtCreation: InvitationDeliveryStatus.QUEUED,
    });
  }

  private idempotencyResult(
    snapshot: IdempotencyRow,
  ): Readonly<InvitationReplacementResult> {
    return Object.freeze({
      previousInvitationId: snapshot.resultPreviousInvitationId,
      invitationId: snapshot.resultInvitationId,
      stateAtCreation: snapshot.resultStateAtCreation,
      deliveryStatusAtCreation: snapshot.resultDeliveryStatusAtCreation,
    });
  }

  private snapshotToView(
    snapshot: IdempotencyRow,
  ): Readonly<InvitationAdminView> {
    if (
      snapshot.resultStateAtCreation !== InvitationEffectiveState.PENDING ||
      snapshot.resultDeliveryStatusAtCreation !==
        InvitationDeliveryStatus.QUEUED
    ) {
      throw new Error('Invalid invitation replacement snapshot.');
    }
    return Object.freeze({
      id: snapshot.resultInvitationId,
      email: snapshot.responseEmailNormalized,
      role: snapshot.responseInvitedRole,
      state: snapshot.resultStateAtCreation,
      expiresAt: snapshot.responseInvitationExpiresAt.toISOString(),
      createdAt: snapshot.responseInvitationCreatedAt.toISOString(),
      updatedAt: snapshot.responseInvitationUpdatedAt.toISOString(),
      revokedAt: null,
      acceptedAt: null,
      invitedByMembershipId: snapshot.responseInvitedByMembershipId,
      revokedByMembershipId: null,
      acceptedByUserId: null,
      resultingMembershipId: null,
      supersededByInvitationId: null,
      deliveryStatus: snapshot.resultDeliveryStatusAtCreation,
    });
  }

  private selectInvitationSql(alias: string): string {
    return `SELECT ${alias}.id, ${alias}.organization_id AS "organizationId",
      ${alias}.email_normalized AS "emailNormalized", ${alias}.role, ${alias}.status,
      ${alias}.expires_at AS "expiresAt",
      ${alias}.invited_by_membership_id AS "invitedByMembershipId",
      ${alias}.accepted_by_user_id AS "acceptedByUserId",
      ${alias}.resulting_membership_id AS "resultingMembershipId",
      ${alias}.accepted_at AS "acceptedAt",
      ${alias}.revoked_by_membership_id AS "revokedByMembershipId",
      ${alias}.revoked_at AS "revokedAt", ${alias}.revocation_reason AS "revocationReason",
      ${alias}.superseded_by_invitation_id AS "supersededByInvitationId",
      ${alias}.token_key_version AS "tokenKeyVersion", ${alias}.token_version AS "tokenVersion",
      ${alias}.created_at AS "createdAt", ${alias}.updated_at AS "updatedAt",
      COALESCE(outbox.status, 'cancelled') AS "deliveryStatus",
      ${this.effectiveStateSql(alias)} AS "effectiveState"
      FROM organization_invitations ${alias}
      LEFT JOIN invitation_delivery_outbox outbox
        ON outbox.invitation_id = ${alias}.id
       AND outbox.organization_id = ${alias}.organization_id
       AND outbox.token_version = ${alias}.token_version
       AND outbox.event_type = 'delivery.requested'`;
  }

  private effectiveStateSql(alias: string): string {
    return `CASE
      WHEN ${alias}.status = 'accepted' THEN 'accepted'
      WHEN ${alias}.status = 'revoked' THEN 'revoked'
      WHEN ${alias}.expires_at <= transaction_timestamp() THEN 'expired'
      ELSE 'pending'
    END`;
  }

  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(
      JSON.stringify({ createdAt: createdAt.toISOString(), id }),
      'utf8',
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): CursorValue {
    try {
      const value = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as Partial<CursorValue>;
      if (
        typeof value.createdAt !== 'string' ||
        Number.isNaN(Date.parse(value.createdAt)) ||
        typeof value.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          value.id,
        )
      ) {
        throw new Error('invalid cursor');
      }
      return { createdAt: value.createdAt, id: value.id };
    } catch {
      throw new BadRequestException('Invalid invitation cursor.');
    }
  }
}
