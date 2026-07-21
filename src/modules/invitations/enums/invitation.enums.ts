export enum InvitationRole {
  ADMIN = 'admin',
  MEMBER = 'member',
}

export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
}

export enum InvitationEffectiveState {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}

export enum InvitationRevocationReason {
  MANUAL = 'manual',
  REPLACED = 'replaced',
  EXPIRED_REISSUED = 'expired_reissued',
  ISSUER_MEMBERSHIP_INACTIVE = 'issuer_membership_inactive',
  ISSUER_USER_INACTIVE = 'issuer_user_inactive',
}

export enum InvitationDeliveryStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  SENT = 'sent',
  DEAD = 'dead',
  CANCELLED = 'cancelled',
}

export enum InvitationDeliveryEventType {
  REQUESTED = 'delivery.requested',
}

export enum InvitationCommandOperation {
  REPLACE = 'replace',
}
