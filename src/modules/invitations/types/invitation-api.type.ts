import {
  InvitationDeliveryStatus,
  InvitationEffectiveState,
  InvitationRole,
} from '../enums/invitation.enums';

export interface InvitationAdminView {
  readonly id: string;
  readonly email: string;
  readonly role: InvitationRole;
  readonly state: InvitationEffectiveState;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
  readonly acceptedAt: string | null;
  readonly invitedByMembershipId: string;
  readonly revokedByMembershipId: string | null;
  readonly acceptedByUserId: string | null;
  readonly resultingMembershipId: string | null;
  readonly supersededByInvitationId: string | null;
  readonly deliveryStatus: InvitationDeliveryStatus;
}

export interface InvitationReplacementResult {
  readonly previousInvitationId: string;
  readonly invitationId: string;
  readonly stateAtCreation: InvitationEffectiveState.PENDING;
  readonly deliveryStatusAtCreation: InvitationDeliveryStatus.QUEUED;
}

export interface InvitationReplacementExecution {
  readonly view: Readonly<InvitationAdminView>;
  readonly result: Readonly<InvitationReplacementResult>;
  readonly replayed: boolean;
}

export interface InvitationListResponse {
  items: InvitationAdminView[];
  page: { nextCursor: string | null; limit: number };
}

export interface InvitationRequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}
