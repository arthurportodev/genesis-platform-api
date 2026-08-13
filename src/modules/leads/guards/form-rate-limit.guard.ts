import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { getTrustedClientIp } from '../../../common/http/trusted-client-ip';
import { FormRateLimiter } from '../services/form-rate-limiter.service';

@Injectable()
export class FormRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: FormRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    this.limiter.consumeIp(getTrustedClientIp(request) ?? 'unknown');
    return true;
  }
}
