import { AuthenticatedRequest } from '../../auth/types/auth-request.type';
import { TenantContext } from './tenant-context.type';

export interface TenantContextRequest extends AuthenticatedRequest {
  tenantContext: TenantContext;
}

export interface TenantContextPendingRequest extends AuthenticatedRequest {
  tenantContext?: TenantContext;
}
