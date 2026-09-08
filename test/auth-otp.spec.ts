import { ConfigService } from '@nestjs/config';
import { instanceToPlain } from 'class-transformer';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ResendInvitationEmailAdapter } from '../src/modules/invitations/delivery/resend-invitation-email.adapter';
import { ResendEmailTransport } from '../src/common/email/resend-email.transport';
import { environmentValidationSchema } from '../src/config/environment.validation';
import authOtpConfig, { AuthOtpConfig } from '../src/config/auth-otp.config';
import {
  AuthAuditService,
  sanitizeAuditMetadata,
} from '../src/modules/auth/services/auth-audit.service';
import { AuthEmailChallenge } from '../src/modules/auth-email-challenges/auth-email-challenge.entity';
import { AuthEmailChallengesService } from '../src/modules/auth-email-challenges/auth-email-challenges.service';
import {
  equalOtpHash,
  generateOtp,
  hashOtp,
} from '../src/modules/auth-email-challenges/otp-codec';

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomInt: jest.fn(() => 7),
}));

describe('OTP cryptography and boundary', () => {
  it('generates exactly six digits preserving leading zeros', () => {
    expect(generateOtp()).toMatch(/^\d{6}$/u);
    expect(generateOtp()).toBe('000007');
  });

  it('binds the MAC to purpose, user, challenge, code and pepper', () => {
    const pepper = randomBytes(32);
    const user = randomUUID();
    const challenge = randomUUID();
    const code = generateOtp();
    const hash = hashOtp(pepper, 'email_verification', user, challenge, code);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      equalOtpHash(
        hash,
        hashOtp(pepper, 'email_verification', user, challenge, code),
      ),
    ).toBe(true);
    for (const other of [
      hashOtp(pepper, 'password_reset', user, challenge, code),
      hashOtp(pepper, 'email_verification', randomUUID(), challenge, code),
      hashOtp(pepper, 'email_verification', user, randomUUID(), code),
      hashOtp(pepper, 'email_verification', user, challenge, '999999'),
      hashOtp(randomBytes(32), 'email_verification', user, challenge, code),
      'invalid',
    ])
      expect(equalOtpHash(hash, other)).toBe(false);
    expect(() =>
      hashOtp(Buffer.alloc(0), 'email_verification', user, challenge, code),
    ).toThrow('Invalid OTP cryptographic input.');
  });

  it('does not serialize a persisted hash or accept secret metadata', () => {
    const challenge = new AuthEmailChallenge();
    challenge.secretHash = 'not-public';
    expect(instanceToPlain(challenge)).not.toHaveProperty('secretHash');
    expect(
      sanitizeAuditMetadata({
        purpose: 'password_reset',
        otp: 'sensitive',
        code: 'sensitive',
        secret_hash: 'sensitive',
        resetGrant: 'sensitive',
      }),
    ).toEqual({ purpose: 'password_reset' });
  });

  it('uses the exact same Resend implementation for invitations and OTP', () => {
    expect(ResendInvitationEmailAdapter).toBe(ResendEmailTransport);
  });

  it('fails closed without OTP configuration before database or network access', async () => {
    const transaction = jest.fn();
    const service = new AuthEmailChallengesService(
      { transaction } as unknown as DataSource,
      new ConfigService({ authOtp: { ...authOtpConfig(), pepper: null } }),
      null,
      {} as AuthAuditService,
    );
    await expect(service.issueEmailVerification(randomUUID())).rejects.toThrow(
      'Email challenges are unavailable.',
    );
    await expect(
      service.consumePasswordReset(randomUUID(), randomUUID(), generateOtp()),
    ).rejects.toThrow('Email challenges are unavailable.');
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('OTP environment configuration', () => {
  const base = {
    NODE_ENV: 'test',
    APP_NAME: 'Test',
    APP_VERSION: '1',
    DATABASE_HOST: 'localhost',
    DATABASE_NAME: 'genesis_auth_otp_test',
    DATABASE_USER: 'runtime',
    DATABASE_PASSWORD: 'test-only',
    DATABASE_RUNTIME_ROLE: 'runtime',
    FRONTEND_URL: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'jwt-test-only-secret-longer-than-32-bytes',
    REFRESH_TOKEN_PEPPER: 'refresh-test-only-secret-longer-than-32-bytes',
  };

  it('keeps existing deployments valid with OTP absent and sets approved defaults', () => {
    const result = environmentValidationSchema.validate(base);
    expect(result.error).toBeUndefined();
    expect(result.value as Record<string, unknown>).toMatchObject({
      AUTH_OTP_TTL_SECONDS: 600,
      AUTH_OTP_MAX_ATTEMPTS: 5,
      AUTH_OTP_RESEND_COOLDOWN_SECONDS: 60,
      AUTH_OTP_SEND_WINDOW_SECONDS: 3600,
      AUTH_OTP_MAX_SENDS: 5,
      AUTH_EMAIL_FROM: '',
    });
  });

  it.each([
    { AUTH_OTP_PEPPER: 'not-a-dedicated-key' },
    { AUTH_OTP_PEPPER: randomBytes(31).toString('base64') },
    { AUTH_OTP_TTL_SECONDS: 0 },
    { AUTH_OTP_MAX_ATTEMPTS: 0 },
    { AUTH_OTP_MAX_ATTEMPTS: 1.5 },
    { AUTH_OTP_RESEND_COOLDOWN_SECONDS: 59 },
    { AUTH_OTP_SEND_WINDOW_SECONDS: -1 },
    { AUTH_OTP_MAX_SENDS: 0 },
    { AUTH_EMAIL_FROM: 'sender@example.com\r\nBcc: attacker@example.com' },
  ])('rejects invalid supplied configuration %#', (delta) => {
    expect(
      environmentValidationSchema.validate({ ...base, ...delta }).error,
    ).toBeDefined();
  });

  it('accepts a dedicated key and rejects reuse of the session secrets', () => {
    const key = randomBytes(32).toString('base64');
    expect(
      environmentValidationSchema.validate({ ...base, AUTH_OTP_PEPPER: key })
        .error,
    ).toBeUndefined();
    for (const name of ['JWT_ACCESS_SECRET', 'REFRESH_TOKEN_PEPPER']) {
      expect(
        environmentValidationSchema.validate({
          ...base,
          [name]: key,
          AUTH_OTP_PEPPER: key,
        }).error,
      ).toBeDefined();
    }
  });

  it('loads the defaults without requiring a new secret for existing login', () => {
    const result: AuthOtpConfig = authOtpConfig();
    expect(result.ttlSeconds).toBe(600);
    expect(result.pepper).toBeNull();
  });
});
