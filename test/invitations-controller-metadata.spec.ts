import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AccessTokenGuard } from '../src/modules/auth/guards/access-token.guard';
import { ROLES_METADATA_KEY } from '../src/modules/authorization/decorators/roles.decorator';
import { RoleGuard } from '../src/modules/authorization/guards/role.guard';
import { InvitationsController } from '../src/modules/invitations/controllers/invitations.controller';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { TenantContextGuard } from '../src/modules/tenant-context/guards/tenant-context.guard';

describe('InvitationsController authorization metadata', () => {
  const reflector = new Reflector();
  const handlers = ['create', 'list', 'get', 'revoke', 'replace'] as const;

  it.each(handlers)('%s declares the exact guard chain and roles', (name) => {
    const handler = InvitationsController.prototype[name];
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      AccessTokenGuard,
      TenantContextGuard,
      RoleGuard,
    ]);
    expect(
      reflector.get<MembershipRole[]>(ROLES_METADATA_KEY, handler),
    ).toEqual([MembershipRole.OWNER, MembershipRole.ADMIN]);
  });
});
