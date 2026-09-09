import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { EmailMessage } from '../src/common/email/email-transport';
import { AuthOtpConfig } from '../src/config/auth-otp.config';
import { DeliverPasswordReset1789072800000 } from '../src/database/migrations/1789072800000-DeliverPasswordReset';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../src/database/runtime-executable-functions';
import { AuthEmailChallengesService } from '../src/modules/auth-email-challenges/auth-email-challenges.service';
import { AuthEmailChallenge } from '../src/modules/auth-email-challenges/auth-email-challenge.entity';
import { AuthAuditLog } from '../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthRefreshToken } from '../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthRefreshTokenStatus } from '../src/modules/auth-sessions/enums/auth-refresh-token-status.enum';
import { AuthSessionStatus } from '../src/modules/auth-sessions/enums/auth-session-status.enum';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { InMemoryPasswordResetRateLimiter } from '../src/modules/auth/services/in-memory-password-reset-rate-limiter.service';
import { PasswordResetService } from '../src/modules/auth/services/password-reset.service';
import { PasswordHasher } from '../src/modules/credentials/ports/password-hasher.port';
import { PasswordHashCapacity } from '../src/modules/credentials/services/password-hash-capacity.service';
import {
  hashPassword,
  verifyPassword,
} from '../src/modules/credentials/password-policy';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('password reset on the complete PostgreSQL migration chain', () => {
  let owner: DataSource;
  let runtime: DataSource;
  let challenges: AuthEmailChallengesService;
  let limiter: InMemoryPasswordResetRateLimiter;
  let service: PasswordResetService;
  let messages: EmailMessage[];
  let user: User;
  const oldPassword = 'old-password-value';
  const newPassword = 'new-password-value';
  const context = { ipAddress: '127.0.0.1', userAgent: 'integration-test' };
  const config: AuthOtpConfig = {
    publicFlowsEnabled: true,
    pepper: randomBytes(32),
    ttlSeconds: 600,
    maxAttempts: 5,
    cooldownSeconds: 60,
    sendWindowSeconds: 3600,
    maxSends: 5,
    emailFrom: 'Genesis <auth@example.test>',
    registrationRateLimitWindowSeconds: 900,
    registrationEmailIpMaxAttempts: 5,
    registrationIpMaxAttempts: 20,
    registrationRateLimitMaxBuckets: 10_000,
    passwordResetPublicFlowEnabled: true,
    passwordResetRateLimitWindowSeconds: 900,
    passwordResetIpMaxAttempts: 100,
    passwordResetEmailIpMaxAttempts: 100,
  };

  beforeAll(async () => {
    configureIntegrationRuntimeEnvironment();
    owner = createIntegrationDataSource({ includePasswordReset: true });
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    runtime = createIntegrationRuntimeDataSource();
    await runtime.initialize();
  }, 60_000);

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  beforeEach(async () => {
    messages = [];
    user = await owner.getRepository(User).save(
      owner.getRepository(User).create({
        email: `${randomUUID()}@example.test`,
        name: 'Password Reset Test',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword(oldPassword),
        passwordChangedAt: new Date('2020-01-01T00:00:00.000Z'),
        emailVerifiedAt: null,
      }),
    );
    const configService = new ConfigService({ authOtp: config });
    const audit = new AuthAuditService(runtime.getRepository(AuthAuditLog));
    challenges = new AuthEmailChallengesService(
      runtime,
      configService,
      {
        send: (message) => {
          messages.push(message);
          return Promise.resolve({
            kind: 'sent' as const,
            providerMessageId: randomUUID(),
          });
        },
      },
      audit,
    );
    limiter = new InMemoryPasswordResetRateLimiter(configService);
    const passwordHasher: PasswordHasher = { hash: hashPassword };
    const capacity = {
      run: (operation: () => Promise<string>) => operation(),
    } as PasswordHashCapacity;
    service = new PasswordResetService(
      runtime,
      configService,
      passwordHasher,
      capacity,
      limiter,
      challenges,
      audit,
    );
  });

  afterEach(async () => {
    limiter.onModuleDestroy();
    await challenges.onModuleDestroy();
  });

  function code(): string {
    const value = messages.at(-1)?.text.match(/\b\d{6}\b/u)?.[0];
    if (!value) throw new Error('Missing ephemeral test code.');
    return value;
  }

  async function createActiveSession(): Promise<{
    session: AuthSession;
    refresh: AuthRefreshToken;
  }> {
    const session = await owner.getRepository(AuthSession).save(
      owner.getRepository(AuthSession).create({
        id: randomUUID(),
        userId: user.id,
        status: AuthSessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 86_400_000),
        lastUsedAt: null,
        revokedAt: null,
        revokeReason: null,
        ipAddress: '127.0.0.1',
        userAgent: 'integration-test',
      }),
    );
    const refresh = await owner.getRepository(AuthRefreshToken).save(
      owner.getRepository(AuthRefreshToken).create({
        id: randomUUID(),
        sessionId: session.id,
        tokenHash: randomBytes(32).toString('hex'),
        status: AuthRefreshTokenStatus.ACTIVE,
        expiresAt: session.expiresAt,
        consumedAt: null,
        revokedAt: null,
        replacedByTokenId: null,
      }),
    );
    return { session, refresh };
  }

  it('installs one restricted function without generic users mutation grants', async () => {
    const [migration] = await owner.query<Array<{ count: string }>>(
      'SELECT count(*) FROM migrations WHERE name=$1',
      ['DeliverPasswordReset1789072800000'],
    );
    expect(migration.count).toBe('1');
    const functions = await runtime.query<Array<{ signature: string }>>(
      `SELECT p.oid::regprocedure::text AS signature
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='app_private'
         AND has_function_privilege(current_user,p.oid,'EXECUTE')
       ORDER BY signature`,
    );
    expect(functions.map(({ signature }) => signature)).toContain(
      'app_private.complete_password_reset(uuid,uuid,text)',
    );
    expect(CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS).toContain(
      'app_private.complete_password_reset(uuid,uuid,text)',
    );
    const [acl] = await runtime.query<
      Array<{ tableMutation: boolean; columnMutation: boolean }>
    >(`SELECT
      has_table_privilege(current_user,'users','INSERT,UPDATE,DELETE,TRUNCATE') AS "tableMutation",
      has_any_column_privilege(current_user,'users','INSERT,UPDATE') AS "columnMutation"`);
    expect(acl).toEqual({ tableMutation: false, columnMutation: false });
  });

  it('atomically changes the password, preserves verification state and revokes credentials', async () => {
    const { session, refresh } = await createActiveSession();
    const before = user.passwordChangedAt!.getTime();
    await service.request(user.email, context);
    await challenges.onModuleDestroy();

    await expect(
      service.complete(
        { email: user.email, code: code(), password: newPassword },
        context,
      ),
    ).resolves.toEqual({ status: 'password_reset' });

    const [updated] = await owner.query<
      Array<{
        password_hash: string;
        password_changed_at: Date;
        email_verified_at: Date | null;
      }>
    >(
      'SELECT password_hash,password_changed_at,email_verified_at FROM users WHERE id=$1',
      [user.id],
    );
    expect(await verifyPassword(updated.password_hash, oldPassword)).toBe(
      false,
    );
    expect(await verifyPassword(updated.password_hash, newPassword)).toBe(true);
    expect(updated.password_changed_at.getTime()).toBeGreaterThan(before);
    expect(updated.email_verified_at).toBeNull();
    await expect(
      owner.getRepository(AuthSession).findOneByOrFail({ id: session.id }),
    ).resolves.toMatchObject({
      status: AuthSessionStatus.REVOKED,
      revokeReason: 'password_reset',
    });
    await expect(
      owner.getRepository(AuthRefreshToken).findOneByOrFail({ id: refresh.id }),
    ).resolves.toMatchObject({ status: AuthRefreshTokenStatus.REVOKED });
    await expect(
      owner
        .getRepository(AuthEmailChallenge)
        .findOneByOrFail({ userId: user.id, purpose: 'password_reset' }),
    ).resolves.toMatchObject({ stage: 'invalidated', secretHash: undefined });
    const audit = await owner.getRepository(AuthAuditLog).findOneByOrFail({
      userId: user.id,
      eventType: 'auth.password_reset.succeeded' as never,
    });
    expect(audit.metadata).toEqual({
      revokedSessions: 1,
      revokedRefreshCredentials: 1,
    });
    await expect(
      service.complete(
        { email: user.email, code: code(), password: newPassword },
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'AUTH_PASSWORD_RESET_INVALID' },
    });
  });

  it('commits invalid attempts without changing password or sessions', async () => {
    const { session } = await createActiveSession();
    await service.request(user.email, context);
    await challenges.onModuleDestroy();
    await expect(
      service.complete(
        {
          email: user.email,
          code: code() === '000000' ? '999999' : '000000',
          password: newPassword,
        },
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'AUTH_PASSWORD_RESET_INVALID' },
    });
    const challenge = await owner
      .getRepository(AuthEmailChallenge)
      .findOneByOrFail({ userId: user.id, purpose: 'password_reset' });
    expect(challenge).toMatchObject({ stage: 'otp', failedAttempts: 1 });
    const [credential] = await owner.query<Array<{ password_hash: string }>>(
      'SELECT password_hash FROM users WHERE id=$1',
      [user.id],
    );
    expect(await verifyPassword(credential.password_hash, oldPassword)).toBe(
      true,
    );
    await expect(
      owner.getRepository(AuthSession).findOneByOrFail({ id: session.id }),
    ).resolves.toMatchObject({ status: AuthSessionStatus.ACTIVE });
  });

  it('allows only one concurrent completion and protects migration rollback after use', async () => {
    await service.request(user.email, context);
    await challenges.onModuleDestroy();
    const otp = code();
    const results = await Promise.allSettled([
      service.complete(
        { email: user.email, code: otp, password: newPassword },
        context,
      ),
      service.complete(
        { email: user.email, code: otp, password: 'other-password-value' },
        context,
      ),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    const runner = owner.createQueryRunner();
    try {
      await expect(
        new DeliverPasswordReset1789072800000().down(runner),
      ).rejects.toThrow(
        'Password reset migration rollback requires no completed password resets.',
      );
    } finally {
      await runner.release();
    }
  });
});
