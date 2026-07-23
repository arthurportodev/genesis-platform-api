import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { FormSignatureService } from '../security/form-signature.service';
import { FormRateLimiter } from '../services/form-rate-limiter.service';

export interface SignedFormRequest extends RawBodyRequest<Request> {
  formKeyVersion?: number;
}

@Injectable()
export class FormSignatureGuard implements CanActivate {
  constructor(
    private readonly signatures: FormSignatureService,
    private readonly limiter: FormRateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SignedFormRequest>();
    request.formKeyVersion = this.signatures.verify({
      keyVersion: this.header(request, 'x-genesis-key-version'),
      timestamp: this.header(request, 'x-genesis-timestamp'),
      idempotencyKey: this.header(request, 'idempotency-key'),
      signature: this.header(request, 'x-genesis-signature'),
      rawBody: request.rawBody,
    });
    this.limiter.consumeAuthenticatedKey(request.formKeyVersion);
    return true;
  }

  private header(request: Request, name: string): string | undefined {
    const value = request.headers[name];
    return typeof value === 'string' ? value : undefined;
  }
}
