import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import { OAuth2Client } from 'google-auth-library';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import { AuthGoogleConfig } from '../../../config/auth-google.config';
import {
  GoogleIdentityVerifier,
  VerifiedGoogleIdentity,
} from '../ports/google-identity-verifier.port';

@Injectable()
export class GoogleIdentityVerifierService implements GoogleIdentityVerifier {
  private readonly config: AuthGoogleConfig;
  private readonly client = new OAuth2Client();

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AuthGoogleConfig>('authGoogle');
  }

  async verify(credential: string): Promise<VerifiedGoogleIdentity> {
    if (!this.config.publicFlowEnabled || this.config.clientId === null) {
      throw new Error('Google authentication is unavailable.');
    }
    const ticket = await this.client.verifyIdToken({
      idToken: credential,
      audience: this.config.clientId,
    });
    const payload = ticket.getPayload();
    const subject = payload?.sub?.trim() ?? '';
    const email =
      typeof payload?.email === 'string' ? normalizeEmail(payload.email) : '';
    if (
      payload === undefined ||
      (payload.iss !== 'accounts.google.com' &&
        payload.iss !== 'https://accounts.google.com') ||
      typeof payload.sub !== 'string' ||
      payload.sub !== subject ||
      subject.length === 0 ||
      subject.length > 255 ||
      typeof payload.email !== 'string' ||
      email.length === 0 ||
      email.length > 320 ||
      !isEmail(email) ||
      payload.email_verified !== true ||
      typeof payload.nonce !== 'string' ||
      payload.nonce === ''
    ) {
      throw new Error('Google identity assertion is invalid.');
    }
    return {
      subject,
      email,
      emailVerified: true,
      nonce: payload.nonce,
      hostedDomain:
        typeof payload.hd === 'string' && payload.hd.trim() !== ''
          ? payload.hd.trim().toLowerCase()
          : null,
      name: typeof payload.name === 'string' ? payload.name : null,
      givenName:
        typeof payload.given_name === 'string' ? payload.given_name : null,
      familyName:
        typeof payload.family_name === 'string' ? payload.family_name : null,
    };
  }
}
