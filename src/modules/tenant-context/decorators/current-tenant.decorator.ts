import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { TenantContext } from '../types/tenant-context.type';
import { TenantContextPendingRequest } from '../types/tenant-request.type';

export function currentTenantFactory(
  _data: unknown,
  context: ExecutionContext,
): TenantContext {
  const request = context
    .switchToHttp()
    .getRequest<TenantContextPendingRequest>();

  if (request.tenantContext === undefined) {
    throw new InternalServerErrorException('Tenant context is unavailable.');
  }

  return request.tenantContext;
}

export const CurrentTenant = createParamDecorator(currentTenantFactory);
