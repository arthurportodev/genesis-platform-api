import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import {
  ROLES_METADATA_KEY,
  Roles,
} from '../src/modules/authorization/decorators/roles.decorator';

@Roles(MembershipRole.OWNER)
@Controller('roles-metadata')
class RolesMetadataController {
  @Get('multiple')
  @Roles(MembershipRole.MEMBER, MembershipRole.ADMIN, MembershipRole.OWNER)
  multiple(this: void): void {}

  @Get('single')
  @Roles(MembershipRole.ADMIN)
  single(this: void): void {}
}

describe('@Roles', () => {
  const reflector = new Reflector();

  it('uses the approved metadata key', () => {
    expect(ROLES_METADATA_KEY).toBe('authorization:roles');
  });

  it('stores one MembershipRole on a controller', () => {
    expect(
      reflector.get<readonly MembershipRole[]>(
        ROLES_METADATA_KEY,
        RolesMetadataController,
      ),
    ).toEqual([MembershipRole.OWNER]);
  });

  it('stores multiple MembershipRole values on a handler in declaration order', () => {
    const metadata = reflector.get<readonly MembershipRole[]>(
      ROLES_METADATA_KEY,
      RolesMetadataController.prototype.multiple,
    );

    expect(metadata).toEqual([
      MembershipRole.MEMBER,
      MembershipRole.ADMIN,
      MembershipRole.OWNER,
    ]);
    expect(
      metadata?.every((role) => Object.values(MembershipRole).includes(role)),
    ).toBe(true);
  });

  it('supports metadata on an individual handler', () => {
    expect(
      reflector.get<readonly MembershipRole[]>(
        ROLES_METADATA_KEY,
        RolesMetadataController.prototype.single,
      ),
    ).toEqual([MembershipRole.ADMIN]);
  });
});
