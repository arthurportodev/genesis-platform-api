import { MembershipRole } from '../../memberships/enums/membership-role.enum';

export interface TenantContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role: MembershipRole;
}
