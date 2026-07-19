import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { TenantContextPendingRequest } from '../../tenant-context/types/tenant-request.type';
import { ROLES_METADATA_KEY } from '../decorators/roles.decorator';

const MEMBERSHIP_ROLE_VALUES = new Set<string>(Object.values(MembershipRole));

function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === 'string' && MEMBERSHIP_ROLE_VALUES.has(value);
}

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rolesMetadata = this.reflector.getAllAndOverride<unknown>(
      ROLES_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!this.isValidRolesMetadata(rolesMetadata)) {
      throw new InternalServerErrorException(
        'Authorization configuration is invalid.',
      );
    }

    const request = context
      .switchToHttp()
      .getRequest<TenantContextPendingRequest>();

    if (request.tenantContext === undefined) {
      throw new InternalServerErrorException('Tenant context is unavailable.');
    }

    if (!rolesMetadata.includes(request.tenantContext.role)) {
      throw new ForbiddenException('Organization access denied.');
    }

    return true;
  }

  private isValidRolesMetadata(
    value: unknown,
  ): value is readonly MembershipRole[] {
    if (!Array.isArray(value) || value.length === 0) {
      return false;
    }

    const roles: readonly unknown[] = value;

    for (let index = 0; index < roles.length; index += 1) {
      if (
        !Object.prototype.hasOwnProperty.call(roles, index) ||
        !isMembershipRole(roles[index])
      ) {
        return false;
      }
    }

    return true;
  }
}
