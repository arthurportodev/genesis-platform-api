import { EntityManager } from 'typeorm';

export const PENDING_INVITATION_REVOKER = Symbol('PENDING_INVITATION_REVOKER');

export interface PendingInvitationRevocationContext {
  readonly actorUserId: string | null;
  readonly actorMembershipId: string | null;
  readonly correlationId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface PendingInvitationRevoker {
  revokeByIssuerMembership(
    membershipId: string,
    context: PendingInvitationRevocationContext,
    manager: EntityManager,
  ): Promise<number>;
  revokeByIssuerUser(
    userId: string,
    context: PendingInvitationRevocationContext,
    manager: EntityManager,
  ): Promise<number>;
}
