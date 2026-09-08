import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export type EmailChallengePurpose = 'email_verification' | 'password_reset';

export function generateOtp(): string {
  return randomInt(1_000_000).toString().padStart(6, '0');
}

export function hashOtp(
  pepper: Buffer,
  purpose: EmailChallengePurpose,
  userId: string,
  challengeId: string,
  otp: string,
): string {
  if (pepper.length !== 32 || !/^\d{6}$/u.test(otp)) {
    throw new Error('Invalid OTP cryptographic input.');
  }
  return createHmac('sha256', pepper)
    .update(
      JSON.stringify([
        'genesis-email-otp/v1',
        purpose,
        userId,
        challengeId,
        otp,
      ]),
    )
    .digest('hex');
}

export function equalOtpHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
