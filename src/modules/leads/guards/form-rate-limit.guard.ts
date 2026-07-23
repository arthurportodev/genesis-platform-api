import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { FormRateLimiter } from '../services/form-rate-limiter.service';

@Injectable()
export class FormRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: FormRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    this.limiter.consumeIp(
      request.ip || request.socket.remoteAddress || 'unknown',
    );
    return true;
  }
}
