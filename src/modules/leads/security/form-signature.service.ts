import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { LeadConfig } from '../../../config/lead.config';

export interface FormSignatureInput {
  keyVersion: string | undefined;
  timestamp: string | undefined;
  idempotencyKey: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | undefined;
}

@Injectable()
export class FormSignatureService {
  private readonly config: LeadConfig;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<LeadConfig>('lead');
  }

  verify(input: FormSignatureInput): number {
    const version = Number(input.keyVersion);
    const timestamp = Number(input.timestamp);
    const key = this.config.formKeys.get(version);
    if (
      !Number.isInteger(version) ||
      !Number.isInteger(timestamp) ||
      key === undefined ||
      input.rawBody === undefined ||
      input.idempotencyKey === undefined ||
      input.signature === undefined ||
      !/^[0-9a-f]{64}$/u.test(input.signature) ||
      Math.abs(Date.now() - timestamp * 1000) > 300_000
    ) {
      throw new UnauthorizedException('Invalid form signature.');
    }
    const bodyHash = createHash('sha256').update(input.rawBody).digest('hex');
    const expected = createHmac('sha256', key)
      .update(`v1\n${timestamp}\n${input.idempotencyKey}\n${bodyHash}`, 'utf8')
      .digest();
    const supplied = Buffer.from(input.signature, 'hex');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      throw new UnauthorizedException('Invalid form signature.');
    }
    return version;
  }
}
