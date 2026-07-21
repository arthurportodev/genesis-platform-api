import { randomBytes } from 'node:crypto';
import { parseDurationSeconds } from '../src/config/auth.config';
import { assertRuntimeDatabaseIdentity } from '../src/config/database.config';
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
    DATABASE_USER: 'genesis_runtime_test',
    DATABASE_PASSWORD: 'test-only',
    DATABASE_RUNTIME_ROLE: 'genesis_runtime_test',
    FRONTEND_URL: 'http://localhost:5173',
    TRUST_PROXY_HOPS: 0,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
    JWT_ACCESS_EXPIRES_IN: '15m',
    REFRESH_TOKEN_EXPIRES_IN_DAYS: 30,
    REFRESH_TOKEN_PEPPER: randomBytes(48).toString('base64url'),
    AUTH_LOGIN_MAX_ATTEMPTS: 5,
    AUTH_LOGIN_IP_MAX_ATTEMPTS: 25,
    AUTH_LOGIN_MAX_BUCKETS: 10_000,
    AUTH_LOGIN_WINDOW_SECONDS: 900,
  };

  it('accepts strong secrets and parses configured durations', () => {
    const validation = environmentValidationSchema.validate(validEnvironment);
    expect(validation.error).toBeUndefined();
    expect(validation.value).toMatchObject({
      TRUST_PROXY_HOPS: 0,
      AUTH_LOGIN_IP_MAX_ATTEMPTS: 25,
      AUTH_LOGIN_MAX_BUCKETS: 10_000,
    });
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('2h')).toBe(7_200);
  });

  it('fails startup unless the connection user is the configured runtime role', () => {
    expect(() =>
      assertRuntimeDatabaseIdentity(
        validEnvironment.DATABASE_USER,
        validEnvironment.DATABASE_RUNTIME_ROLE,
      ),
    ).not.toThrow();
    expect(() =>
      assertRuntimeDatabaseIdentity('migration_owner', 'genesis_runtime_test'),
    ).toThrow('DATABASE_USER must equal DATABASE_RUNTIME_ROLE');
  });

  it('does not require the seed-only initial owner password at runtime', () => {
    const withoutSeedPassword = { ...validEnvironment };
    delete (withoutSeedPassword as Record<string, unknown>)
      .INITIAL_OWNER_PASSWORD;

    expect(
      environmentValidationSchema.validate(withoutSeedPassword).error,
    ).toBeUndefined();
    expect(
      environmentValidationSchema.validate({
        ...validEnvironment,
        INITIAL_OWNER_PASSWORD: '',
      }).error,
    ).toBeDefined();
  });

  it('rejects invalid trust-proxy and limiter bounds', () => {
    expect(
      environmentValidationSchema.validate({
        ...validEnvironment,
        TRUST_PROXY_HOPS: 6,
      }).error,
    ).toBeDefined();
    expect(
      environmentValidationSchema.validate({
        ...validEnvironment,
        TRUST_PROXY_HOPS: -1,
      }).error,
    ).toBeDefined();
    expect(
      environmentValidationSchema.validate({
        ...validEnvironment,
        AUTH_LOGIN_MAX_BUCKETS: 1,
      }).error,
    ).toBeDefined();
    expect(
      environmentValidationSchema.validate({
        ...validEnvironment,
        DATABASE_RUNTIME_ROLE: 'unsafe-role;drop',
      }).error,
    ).toBeDefined();
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
