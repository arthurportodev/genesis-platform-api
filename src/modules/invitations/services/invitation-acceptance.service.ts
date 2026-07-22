import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { MembershipStatus } from '../../memberships/enums/membership-status.enum';
import { OrganizationAuditEventType } from '../../organization-audit/enums/organization-audit-event-type.enum';
import { OrganizationAuditService } from '../../organization-audit/services/organization-audit.service';
import { OrganizationStatus } from '../../organizations/enums/organization-status.enum';
import { UserStatus } from '../../users/enums/user-status.enum';
import { InvitationRequestContext } from '../types/invitation-api.type';
import { InvitationRole, InvitationStatus } from '../enums/invitation.enums';
import {
  INVITATION_ACCEPTANCE_READINESS,
  InvitationAcceptanceReadiness,
} from '../ports/invitation-acceptance-readiness.port';
import {
  InvitationTokenCodec,
  InvitationTokenFields,
} from './invitation-token-codec.service';

type MembershipResult =
  'membership_created' | 'membership_preserved' | 'membership_reactivated';

class AcceptanceScopeChangedError extends Error {}

interface InspectRow extends InvitationTokenFields {
  organizationName: string;
  status: InvitationStatus;
  organizationStatus: OrganizationStatus;
  databaseNow: Date;
}

interface AcceptancePreRead {
  organizationId: string;
  membershipId: string | null;
}

interface AcceptanceRow extends InvitationTokenFields {
  status: InvitationStatus;
  acceptedByUserId: string | null;
  resultingMembershipId: string | null;
  organizationStatus: OrganizationStatus;
  userEmail: string | null;
  userStatus: UserStatus | null;
  membershipId: string | null;
  membershipRole: MembershipRole | null;
  membershipStatus: MembershipStatus | null;
  databaseNow: Date;
}

export interface InvitationInspectResponse {
  organization: { name: string };
  emailMasked: string;
  role: InvitationRole;
  expiresAt: string;
}

export interface InvitationAcceptResponse {
  organizationId: string;
  membershipId: string;
}

@Injectable()
export class InvitationAcceptanceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly codec: InvitationTokenCodec,
    private readonly audit: OrganizationAuditService,
    @Inject(INVITATION_ACCEPTANCE_READINESS)
    private readonly readiness: InvitationAcceptanceReadiness,
  ) {}

  async inspect(token: string): Promise<InvitationInspectResponse> {
    await this.readiness.assertReady();
    const parsed = this.codec.parse(token);
    if (parsed === null) this.unavailable();
    const rows = await this.dataSource.query<InspectRow[]>(
      `SELECT invitation.id AS "invitationId",
              invitation.token_key_version AS "keyVersion",
              invitation.token_version AS "tokenVersion",
              invitation.organization_id AS "organizationId",
              invitation.email_normalized AS "emailNormalized",
              invitation.role, invitation.expires_at AS "expiresAt",
              invitation.token_nonce AS nonce, invitation.status,
              organization.name AS "organizationName",
              organization.status AS "organizationStatus",
              transaction_timestamp() AS "databaseNow"
       FROM organization_invitations AS invitation
       JOIN organizations AS organization
         ON organization.id = invitation.organization_id
       WHERE invitation.id = $1`,
      [parsed.invitationId],
    );
    const row = rows[0] ?? null;
    const validMac = this.codec.verifySafely(token, row);
    if (
      row === null ||
      !validMac ||
      row.status !== InvitationStatus.PENDING ||
      row.organizationStatus !== OrganizationStatus.ACTIVE ||
      row.expiresAt.getTime() <= row.databaseNow.getTime()
    ) {
      this.unavailable();
    }
    return InvitationAcceptanceService.toInspectResponse(row);
  }

  async accept(
    token: string,
    authenticatedUserId: string,
    requestContext: InvitationRequestContext,
  ): Promise<InvitationAcceptResponse> {
    await this.readiness.assertReady();
    const parsed = this.codec.parse(token);
    if (parsed === null) this.unavailable();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const preRead = await this.preRead(
            manager,
            parsed.invitationId,
            authenticatedUserId,
          );
          if (preRead === null) this.unavailable();
          await manager.query(
            `SELECT app_private.lock_invitation_context($1::uuid[], $2::uuid[], $3::uuid[])`,
            [
              [preRead.organizationId],
              [authenticatedUserId],
              preRead.membershipId === null ? [] : [preRead.membershipId],
            ],
          );
          const row = await this.readLocked(
            manager,
            parsed.invitationId,
            authenticatedUserId,
          );
          if (row === null) this.unavailable();
          if (
            row.organizationId !== preRead.organizationId ||
            row.membershipId !== preRead.membershipId
          ) {
            throw new AcceptanceScopeChangedError();
          }

          const validMac = this.codec.verifySafely(token, row);
          if (!validMac) this.unavailable();

          if (row.status === InvitationStatus.ACCEPTED) {
            if (
              row.acceptedByUserId === authenticatedUserId &&
              row.resultingMembershipId !== null &&
              row.membershipId === row.resultingMembershipId &&
              row.organizationStatus === OrganizationStatus.ACTIVE &&
              row.userStatus === UserStatus.ACTIVE
            ) {
              return {
                organizationId: row.organizationId,
                membershipId: row.resultingMembershipId,
              };
            }
            this.unavailable();
          }

          if (
            row.status !== InvitationStatus.PENDING ||
            row.organizationStatus !== OrganizationStatus.ACTIVE ||
            row.userStatus !== UserStatus.ACTIVE ||
            row.userEmail === null ||
            normalizeEmail(row.userEmail) !== row.emailNormalized ||
            row.expiresAt.getTime() <= row.databaseNow.getTime()
          ) {
            this.unavailable();
          }

          const membershipResult = this.membershipResult(row);
          const membershipId = await this.applyMembership(
            manager,
            row.invitationId,
            authenticatedUserId,
          );
          const updated = await manager.query<Array<{ id: string }>>(
            `UPDATE organization_invitations
         SET status = 'accepted', accepted_by_user_id = $2,
             resulting_membership_id = $3,
             accepted_at = date_trunc('milliseconds', transaction_timestamp()),
             updated_at = transaction_timestamp()
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
            [row.invitationId, authenticatedUserId, membershipId],
          );
          if (updated[0] === undefined) this.unavailable();
          await manager.query(
            `UPDATE invitation_delivery_outbox
         SET status = 'cancelled', cancelled_at = transaction_timestamp(),
             last_error_code = NULL, locked_by = NULL, locked_at = NULL,
             lease_until = NULL, next_attempt_at = NULL,
             updated_at = transaction_timestamp()
         WHERE invitation_id = $1 AND organization_id = $2
           AND status IN ('queued', 'processing', 'dead')`,
            [row.invitationId, row.organizationId],
          );
          await this.audit.record(
            {
              organizationId: row.organizationId,
              eventType: OrganizationAuditEventType.INVITATION_ACCEPTED,
              invitationId: row.invitationId,
              relatedInvitationId: null,
              actorUserId: authenticatedUserId,
              actorMembershipId: membershipId,
              invitedRole: row.role,
              reason: null,
              membershipResult,
              correlationId: randomUUID(),
              ipAddress: requestContext.ipAddress,
              userAgent: requestContext.userAgent,
            },
            manager,
          );
          return { organizationId: row.organizationId, membershipId };
        });
      } catch (error) {
        if (error instanceof AcceptanceScopeChangedError && attempt < 2) {
          continue;
        }
        if (error instanceof AcceptanceScopeChangedError) {
          throw new ConflictException('Invitation state changed.');
        }
        throw error;
      }
    }
    throw new ConflictException('Invitation state changed.');
  }

  static maskEmail(email: string): string {
    const [local = '', domain = ''] = email.split('@');
    const labels = domain.split('.');
    const suffix = labels.length > 1 ? `.${labels.at(-1)}` : '';
    const domainHead = labels[0] ?? '';
    const localMask =
      local.length <= 1
        ? `${local.slice(0, 1)}***`
        : `${local[0]}***${local.at(-1)}`;
    return `${localMask}@${domainHead.slice(0, 1)}***${suffix}`;
  }

  static toInspectResponse(input: {
    organizationName: string;
    emailNormalized: string;
    role: InvitationRole | 'member' | 'admin';
    expiresAt: Date;
  }): InvitationInspectResponse {
    return {
      organization: { name: input.organizationName },
      emailMasked: this.maskEmail(input.emailNormalized),
      role: input.role as InvitationRole,
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  private async preRead(
    manager: EntityManager,
    invitationId: string,
    userId: string,
  ): Promise<AcceptancePreRead | null> {
    const rows = await manager.query<AcceptancePreRead[]>(
      `SELECT invitation.organization_id AS "organizationId",
              membership.id AS "membershipId"
       FROM organization_invitations AS invitation
       LEFT JOIN memberships AS membership
         ON membership.organization_id = invitation.organization_id
        AND membership.user_id = $2
       WHERE invitation.id = $1`,
      [invitationId, userId],
    );
    return rows[0] ?? null;
  }

  private async readLocked(
    manager: EntityManager,
    invitationId: string,
    userId: string,
  ): Promise<AcceptanceRow | null> {
    const rows = await manager.query<AcceptanceRow[]>(
      `SELECT invitation.id AS "invitationId",
              invitation.token_key_version AS "keyVersion",
              invitation.token_version AS "tokenVersion",
              invitation.organization_id AS "organizationId",
              invitation.email_normalized AS "emailNormalized",
              invitation.role, invitation.expires_at AS "expiresAt",
              invitation.token_nonce AS nonce, invitation.status,
              invitation.accepted_by_user_id AS "acceptedByUserId",
              invitation.resulting_membership_id AS "resultingMembershipId",
              organization.status AS "organizationStatus",
              application_user.email AS "userEmail",
              application_user.status AS "userStatus",
              membership.id AS "membershipId", membership.role AS "membershipRole",
              membership.status AS "membershipStatus",
              transaction_timestamp() AS "databaseNow"
       FROM organization_invitations AS invitation
       JOIN organizations AS organization
         ON organization.id = invitation.organization_id
       LEFT JOIN users AS application_user ON application_user.id = $2
       LEFT JOIN memberships AS membership
         ON membership.organization_id = invitation.organization_id
        AND membership.user_id = $2
       WHERE invitation.id = $1
       FOR UPDATE OF invitation`,
      [invitationId, userId],
    );
    return rows[0] ?? null;
  }

  private membershipResult(row: AcceptanceRow): MembershipResult {
    if (row.membershipId === null) return 'membership_created';
    if (row.membershipStatus === MembershipStatus.INACTIVE) {
      return 'membership_reactivated';
    }
    if (
      row.membershipStatus === MembershipStatus.ACTIVE &&
      row.membershipRole === (row.role as unknown as MembershipRole)
    ) {
      return 'membership_preserved';
    }
    throw new ConflictException('Membership state conflict.');
  }

  private async applyMembership(
    manager: EntityManager,
    invitationId: string,
    userId: string,
  ): Promise<string> {
    try {
      const rows = await manager.query<Array<{ membershipId: string }>>(
        `SELECT app_private.apply_existing_user_invitation_membership($1, $2)
                AS "membershipId"`,
        [invitationId, userId],
      );
      const id = rows[0]?.membershipId;
      if (id === undefined) this.unavailable();
      return id;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('membership state conflict')
      ) {
        throw new ConflictException('Membership state conflict.');
      }
      this.unavailable();
    }
  }

  private unavailable(): never {
    throw new NotFoundException('Invitation unavailable.');
  }
}
