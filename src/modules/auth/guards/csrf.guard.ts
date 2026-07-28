import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { WebSessionService } from '../services/web-session.service';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly webSessionService: WebSessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    http.getResponse<Response>().setHeader('Cache-Control', 'no-store');
    this.webSessionService.assertCsrf(request);
    return true;
  }
}
