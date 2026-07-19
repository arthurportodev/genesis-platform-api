import { SetMetadata } from '@nestjs/common';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';

export const ROLES_METADATA_KEY = 'authorization:roles';

export function Roles(
  ...roles: [MembershipRole, ...MembershipRole[]]
): MethodDecorator & ClassDecorator {
  const allowedRoles: readonly MembershipRole[] = roles;
  return SetMetadata(ROLES_METADATA_KEY, allowedRoles);
}
