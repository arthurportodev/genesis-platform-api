import { randomBytes } from 'node:crypto';
import { parseDurationSeconds } from '../src/config/auth.config';
import { environmentValidationSchema } from '../src/config/environment.validation';

describe('Authentication configuration', () => {
  const validEnvironment = {
    NODE_ENV: 'test',
    PORT: 3000,
    APP_NAME: 'Genesis Platform API',
    APP_VERSION: '0.1.0',
    DATABASE_HOST: 'localhost',
    DATABASE_PORT: 5432,
    DATABASE_NAME: 'genesis_platform_test',
    DATABASE_USER: 'genesis_test',
    DATABASE_PASSWORD: 'test-only',
    FRONTEND_URL: 'http://localhost:5173',
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
    JWT_ACCESS_EXPIRES_IN: '15m',
    REFRESH_TOKEN_EXPIRES_IN_DAYS: 30,
    REFRESH_TOKEN_PEPPER: randomBytes(48).toString('base64url'),
    AUTH_LOGIN_MAX_ATTEMPTS: 5,
    AUTH_LOGIN_WINDOW_SECONDS: 900,
  };

  it('accepts strong secrets and parses configured durations', () => {
    expect(environmentValidationSchema.validate(validEnvironment).error).toBe(
      undefined,
    );
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('2h')).toBe(7_200);
  });

  it('rejects missing, short, or placeholder secrets', () => {
    const missing = { ...validEnvironment, JWT_ACCESS_SECRET: undefined };
    const short = { ...validEnvironment, REFRESH_TOKEN_PEPPER: 'short' };
    const placeholder = {
      ...validEnvironment,
      JWT_ACCESS_SECRET: 'replace-with-a-long-random-secret',
    };
    const placeholderPassword = {
      ...validEnvironment,
      INITIAL_OWNER_PASSWORD: 'change-me-locally',
    };

    expect(environmentValidationSchema.validate(missing).error).toBeDefined();
    expect(environmentValidationSchema.validate(short).error).toBeDefined();
    expect(
      environmentValidationSchema.validate(placeholder).error,
    ).toBeDefined();
    expect(
      environmentValidationSchema.validate(placeholderPassword).error,
    ).toBeDefined();
  });
});
