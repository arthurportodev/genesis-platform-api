import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { getTrustedClientIp } from '../../../common/http/trusted-client-ip';
import { TenantContextPendingRequest } from '../../tenant-context/types/tenant-request.type';
import { MembershipReadRateLimiter } from '../services/membership-read-rate-limiter.service';

@Injectable()
export class MembershipCommandRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: MembershipReadRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<TenantContextPendingRequest & Request>();
    const actorMembershipId =
      request.tenantContext?.membershipId ?? 'unauthenticated';
    this.limiter.consume(
      'command',
      getTrustedClientIp(request) ?? 'unknown',
      actorMembershipId,
    );
    return true;
  }
}
