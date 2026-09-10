import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export const authGoogleEnvironmentFields = {
  AUTH_GOOGLE_PUBLIC_FLOW_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false'),
  GOOGLE_CLIENT_ID: Joi.string().trim().max(512).allow('').default(''),
};

export interface AuthGoogleConfig {
  publicFlowEnabled: boolean;
  clientId: string | null;
  challengeTtlSeconds: number;
  maxAttempts: number;
  rateLimitWindowSeconds: number;
  challengeIpMaxAttempts: number;
  verificationIpMaxAttempts: number;
  maxBuckets: number;
}

export default registerAs('authGoogle', (): AuthGoogleConfig => {
  const publicFlowEnabled =
    process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED === 'true';
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || null;
  if (publicFlowEnabled && clientId === null) {
    throw new Error('Public Google authentication requires GOOGLE_CLIENT_ID.');
  }
  if (
    publicFlowEnabled &&
    process.env.AUTH_OTP_PUBLIC_FLOWS_ENABLED !== 'true'
  ) {
    throw new Error(
      'Public Google authentication requires the public OTP foundation to be enabled.',
    );
  }
  return {
    publicFlowEnabled,
    clientId,
    challengeTtlSeconds: 300,
    maxAttempts: 5,
    rateLimitWindowSeconds: 900,
    challengeIpMaxAttempts: 30,
    verificationIpMaxAttempts: 20,
    maxBuckets: 10_000,
  };
});
