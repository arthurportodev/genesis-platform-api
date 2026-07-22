export enum OrganizationAuditEventType {
  INVITATION_CREATED = 'organization.invitation.created',
  INVITATION_REPLACED = 'organization.invitation.replaced',
  INVITATION_REVOKED = 'organization.invitation.revoked',
  INVITATIONS_REVOKED_ISSUER_MEMBERSHIP_INACTIVE = 'organization.invitation.revoked_issuer_membership_inactive',
  INVITATIONS_REVOKED_ISSUER_USER_INACTIVE = 'organization.invitation.revoked_issuer_user_inactive',
  INVITATION_ACCEPTED = 'organization.invitation.accepted',
  INVITATION_ACTIVATED = 'organization.invitation.activated',
}
