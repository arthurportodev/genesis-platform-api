export const GOOGLE_IDENTITY_VERIFIER = Symbol('GOOGLE_IDENTITY_VERIFIER');

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  emailVerified: true;
  nonce: string;
  hostedDomain: string | null;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
}

export interface GoogleIdentityVerifier {
  verify(credential: string): Promise<VerifiedGoogleIdentity>;
}
