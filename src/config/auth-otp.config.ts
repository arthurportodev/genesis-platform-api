import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export const authOtpEnvironmentFields = {
  AUTH_OTP_PUBLIC_FLOWS_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false'),
  AUTH_OTP_PEPPER: Joi.string()
    .allow('')
    .custom((value: string, helpers) => {
      if (value === '') return value;
      const decoded = Buffer.from(value, 'base64');
      return decoded.length === 32 && decoded.toString('base64') === value
        ? value
        : helpers.error('any.invalid');
    })
    .invalid(Joi.ref('JWT_ACCESS_SECRET'), Joi.ref('REFRESH_TOKEN_PEPPER'))
    .optional(),
  AUTH_OTP_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(600),
  AUTH_OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  AUTH_OTP_RESEND_COOLDOWN_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3600)
    .default(60),
  AUTH_OTP_SEND_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(86400)
    .default(3600),
  AUTH_OTP_MAX_SENDS: Joi.number().integer().min(1).max(100).default(5),
  AUTH_EMAIL_FROM: Joi.string()
    .trim()
    .max(320)
    .pattern(/^[^\r\n]+$/u)
    .allow('')
    .default(''),
  AUTH_REGISTRATION_RATE_LIMIT_WINDOW_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(86_400)
    .default(900),
  AUTH_REGISTRATION_EMAIL_IP_MAX_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(1_000)
    .default(5),
  AUTH_REGISTRATION_IP_MAX_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10_000)
    .default(20),
  AUTH_REGISTRATION_RATE_LIMIT_MAX_BUCKETS: Joi.number()
    .integer()
    .min(2)
    .max(1_000_000)
    .default(10_000),
};

export interface AuthOtpConfig {
  publicFlowsEnabled: boolean;
  pepper: Buffer | null;
  ttlSeconds: number;
  maxAttempts: number;
  cooldownSeconds: number;
  sendWindowSeconds: number;
  maxSends: number;
  emailFrom: string;
  registrationRateLimitWindowSeconds: number;
  registrationEmailIpMaxAttempts: number;
  registrationIpMaxAttempts: number;
  registrationRateLimitMaxBuckets: number;
}

export default registerAs('authOtp', (): AuthOtpConfig => {
  const publicFlowsEnabled =
    process.env.AUTH_OTP_PUBLIC_FLOWS_ENABLED === 'true';
  const pepper = process.env.AUTH_OTP_PEPPER
    ? Buffer.from(process.env.AUTH_OTP_PEPPER, 'base64')
    : null;
  const emailFrom = process.env.AUTH_EMAIL_FROM?.trim() ?? '';
  const resendApiKey = process.env.RESEND_API_KEY?.trim() ?? '';
  const publicReplicaCount = Number(process.env.API_PUBLIC_REPLICA_COUNT ?? 1);
  if (
    publicFlowsEnabled &&
    (pepper?.length !== 32 ||
      emailFrom === '' ||
      resendApiKey === '' ||
      publicReplicaCount !== 1)
  ) {
    throw new Error(
      'Public OTP flows require a dedicated pepper, email sender, Resend key, and exactly one public API replica.',
    );
  }
  return {
    publicFlowsEnabled,
    pepper,
    ttlSeconds: Number(process.env.AUTH_OTP_TTL_SECONDS ?? 600),
    maxAttempts: Number(process.env.AUTH_OTP_MAX_ATTEMPTS ?? 5),
    cooldownSeconds: Number(process.env.AUTH_OTP_RESEND_COOLDOWN_SECONDS ?? 60),
    sendWindowSeconds: Number(process.env.AUTH_OTP_SEND_WINDOW_SECONDS ?? 3600),
    maxSends: Number(process.env.AUTH_OTP_MAX_SENDS ?? 5),
    emailFrom,
    registrationRateLimitWindowSeconds: Number(
      process.env.AUTH_REGISTRATION_RATE_LIMIT_WINDOW_SECONDS ?? 900,
    ),
    registrationEmailIpMaxAttempts: Number(
      process.env.AUTH_REGISTRATION_EMAIL_IP_MAX_ATTEMPTS ?? 5,
    ),
    registrationIpMaxAttempts: Number(
      process.env.AUTH_REGISTRATION_IP_MAX_ATTEMPTS ?? 20,
    ),
    registrationRateLimitMaxBuckets: Number(
      process.env.AUTH_REGISTRATION_RATE_LIMIT_MAX_BUCKETS ?? 10_000,
    ),
  };
});
