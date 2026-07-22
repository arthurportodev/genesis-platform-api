import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedRequest } from '../../auth/types/auth-request.type';
import { InvitationAcceptanceRateLimiter } from '../services/invitation-acceptance-rate-limiter.service';

function clientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function noStore(context: ExecutionContext): void {
  context
    .switchToHttp()
    .getResponse<{ setHeader(name: string, value: string): void }>()
    .setHeader('Cache-Control', 'no-store');
}

@Injectable()
export class InvitationInspectRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: InvitationAcceptanceRateLimiter) {}
  canActivate(context: ExecutionContext): boolean {
    noStore(context);
    const request = context.switchToHttp().getRequest<Request>();
    this.limiter.consume('inspect-ip', clientIp(request));
    return true;
  }
}

@Injectable()
export class InvitationAcceptIpRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: InvitationAcceptanceRateLimiter) {}
  canActivate(context: ExecutionContext): boolean {
    noStore(context);
    const request = context.switchToHttp().getRequest<Request>();
    this.limiter.consume('accept-ip', clientIp(request));
    return true;
  }
}

@Injectable()
export class InvitationAcceptUserIpRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: InvitationAcceptanceRateLimiter) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    this.limiter.consume(
      'accept-user-ip',
      `${request.user.userId}:${clientIp(request)}`,
    );
    return true;
  }
}
