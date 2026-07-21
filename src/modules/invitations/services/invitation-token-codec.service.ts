import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  INVITATION_TOKEN_KEYRING,
  InvitationTokenKeyring,
} from '../ports/invitation-token-keyring.port';
import { InvitationRole } from '../enums/invitation.enums';

export interface InvitationTokenFields {
  invitationId: string;
  keyVersion: number;
  tokenVersion: number;
  organizationId: string;
  emailNormalized: string;
  role: InvitationRole;
  expiresAt: Date;
  nonce: string;
}

@Injectable()
export class InvitationTokenCodec {
  private static readonly UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  private static readonly BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;

  constructor(
    @Inject(INVITATION_TOKEN_KEYRING)
    private readonly keyring: InvitationTokenKeyring,
  ) {}

  issue(fields: InvitationTokenFields): string {
    this.assertFields(fields);
    const mac = this.computeMac(fields);
    return `${fields.invitationId}.${fields.keyVersion}.${fields.tokenVersion}.${mac.toString('base64url')}`;
  }

  verify(token: string, fields: InvitationTokenFields): boolean {
    try {
      this.assertFields(fields);
    } catch {
      return false;
    }
    const parts = token.split('.');
    if (
      parts.length !== 4 ||
      !InvitationTokenCodec.UUID_V4.test(parts[0]) ||
      parts[0] !== fields.invitationId ||
      parts[1] !== String(fields.keyVersion) ||
      parts[2] !== String(fields.tokenVersion) ||
      !InvitationTokenCodec.BASE64URL_32.test(parts[3])
    ) {
      return false;
    }
    const presented = this.decodeCanonical32(parts[3]);
    if (presented === null) return false;
    const expected = this.computeMac(fields);
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  private computeMac(fields: InvitationTokenFields): Buffer {
    const key = this.keyring.keyFor(fields.keyVersion);
    if (key.length < 32) {
      throw new Error('Invitation token key must contain at least 32 bytes.');
    }
    const expires = Buffer.allocUnsafe(8);
    expires.writeBigInt64BE(BigInt(fields.expiresAt.getTime()));
    const nonce = this.decodeCanonical32(fields.nonce);
    if (nonce === null) {
      throw new Error('Invalid invitation token nonce.');
    }
    const values = [
      Buffer.from('genesis.organization-invitation.v1', 'utf8'),
      Buffer.from(fields.invitationId, 'utf8'),
      this.integer(fields.keyVersion),
      this.integer(fields.tokenVersion),
      Buffer.from(fields.organizationId, 'utf8'),
      Buffer.from(fields.emailNormalized, 'utf8'),
      Buffer.from(fields.role, 'utf8'),
      expires,
      nonce,
    ];
    const hmac = createHmac('sha256', key);
    for (const value of values) {
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(value.length);
      hmac.update(length);
      hmac.update(value);
    }
    return hmac.digest();
  }

  private integer(value: number): Buffer {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(value);
    return buffer;
  }

  private assertFields(fields: InvitationTokenFields): void {
    if (
      !InvitationTokenCodec.UUID_V4.test(fields.invitationId) ||
      !InvitationTokenCodec.UUID_V4.test(fields.organizationId) ||
      !this.isUint32(fields.keyVersion) ||
      !this.isUint32(fields.tokenVersion) ||
      !Object.values(InvitationRole).includes(fields.role) ||
      !Number.isSafeInteger(fields.expiresAt.getTime()) ||
      this.decodeCanonical32(fields.nonce) === null
    ) {
      throw new Error('Invalid invitation token fields.');
    }
  }

  private decodeCanonical32(value: string): Buffer | null {
    if (!InvitationTokenCodec.BASE64URL_32.test(value)) return null;
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== value) {
      return null;
    }
    return decoded;
  }

  private isUint32(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
  }
}
