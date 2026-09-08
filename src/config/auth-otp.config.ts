import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export const authOtpEnvironmentFields = {
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
};

export interface AuthOtpConfig {
  pepper: Buffer | null;
  ttlSeconds: number;
  maxAttempts: number;
  cooldownSeconds: number;
  sendWindowSeconds: number;
  maxSends: number;
  emailFrom: string;
}

export default registerAs('authOtp', (): AuthOtpConfig => ({
  pepper: process.env.AUTH_OTP_PEPPER
    ? Buffer.from(process.env.AUTH_OTP_PEPPER, 'base64')
    : null,
  ttlSeconds: Number(process.env.AUTH_OTP_TTL_SECONDS ?? 600),
  maxAttempts: Number(process.env.AUTH_OTP_MAX_ATTEMPTS ?? 5),
  cooldownSeconds: Number(process.env.AUTH_OTP_RESEND_COOLDOWN_SECONDS ?? 60),
  sendWindowSeconds: Number(process.env.AUTH_OTP_SEND_WINDOW_SECONDS ?? 3600),
  maxSends: Number(process.env.AUTH_OTP_MAX_SENDS ?? 5),
  emailFrom: process.env.AUTH_EMAIL_FROM?.trim() ?? '',
}));
