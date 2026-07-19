import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  TENANT_CONTEXT_RESOLVER,
  TenantContextResolver,
} from '../services/tenant-context.service';
import { TenantContextPendingRequest } from '../types/tenant-request.type';

const ORGANIZATION_HEADER = 'x-organization-id';

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(TENANT_CONTEXT_RESOLVER)
    private readonly tenantContextResolver: TenantContextResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<TenantContextPendingRequest>();

    if (request.user === undefined) {
      throw new UnauthorizedException('Invalid access token.');
    }

    const organizationId = this.parseOrganizationId(
      request.headers[ORGANIZATION_HEADER],
    );
    const tenantContext = await this.tenantContextResolver.resolve(
      request.user.userId,
      organizationId,
    );

    if (tenantContext === null) {
      throw new ForbiddenException('Organization access denied.');
    }

    request.tenantContext = tenantContext;
    return true;
  }

  private parseOrganizationId(header: string | string[] | undefined): string {
    if (
      typeof header !== 'string' ||
      header.length === 0 ||
      header.includes(',') ||
      !isUUID(header, '4')
    ) {
      throw new BadRequestException('Invalid organization context.');
    }

    return header;
  }
}
