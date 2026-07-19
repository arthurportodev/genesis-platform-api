import { registerAs } from '@nestjs/config';

export interface AuthConfig {
  accessTokenSecret: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInDays: number;
  refreshTokenPepper: string;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
}

const DURATION_MULTIPLIERS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null) {
    throw new Error('Invalid access token duration.');
  }

  const amount = Number(match[1]);
  const multiplier = DURATION_MULTIPLIERS[match[2]];
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    multiplier === undefined
  ) {
    throw new Error('Invalid access token duration.');
  }

  return amount * multiplier;
}

export default registerAs('auth', (): AuthConfig => ({
  accessTokenSecret: process.env.JWT_ACCESS_SECRET as string,
  accessTokenExpiresInSeconds: parseDurationSeconds(
    process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  ),
  refreshTokenExpiresInDays: Number(
    process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS ?? 30,
  ),
  refreshTokenPepper: process.env.REFRESH_TOKEN_PEPPER as string,
  loginMaxAttempts: Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS ?? 5),
  loginWindowSeconds: Number(process.env.AUTH_LOGIN_WINDOW_SECONDS ?? 900),
}));
