import { MembershipRole } from '../enums/membership-role.enum';
import { MembershipStatus } from '../enums/membership-status.enum';

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemberListResponse {
  items: MemberView[];
  page: { nextCursor: string | null; limit: number };
}

export interface MembershipRequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}
