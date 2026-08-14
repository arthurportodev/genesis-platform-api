import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { getTrustedClientIp } from '../../../common/http/trusted-client-ip';
import { TenantContextPendingRequest } from '../../tenant-context/types/tenant-request.type';
import { LeadReadRateLimiter } from '../services/lead-read-rate-limiter.service';

abstract class LeadRateLimitGuard implements CanActivate {
  protected abstract readonly kind: 'read' | 'metrics';

  constructor(private readonly limiter: LeadReadRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<TenantContextPendingRequest & Request>();
    this.limiter.consume(
      this.kind,
      getTrustedClientIp(request) ?? 'unknown',
      request.tenantContext?.membershipId ?? 'unauthenticated',
    );
    return true;
  }
}

@Injectable()
export class LeadReadRateLimitGuard extends LeadRateLimitGuard {
  protected readonly kind = 'read' as const;

  constructor(limiter: LeadReadRateLimiter) {
    super(limiter);
  }
}

@Injectable()
export class LeadMetricsRateLimitGuard extends LeadRateLimitGuard {
  protected readonly kind = 'metrics' as const;

  constructor(limiter: LeadReadRateLimiter) {
    super(limiter);
  }
}
