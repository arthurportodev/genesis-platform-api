import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  EmailMessage,
  EmailTransport,
} from '../src/common/email/email-transport';
import { AuthOtpConfig } from '../src/config/auth-otp.config';
import { CreateAuthEmailChallenges1788900000000 } from '../src/database/migrations/1788900000000-CreateAuthEmailChallenges';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../src/database/runtime-executable-functions';
import { AuthAuditLog } from '../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { AuthEmailChallenge } from '../src/modules/auth-email-challenges/auth-email-challenge.entity';
import {
  AuthEmailChallengesService,
  ChallengeIssueResult,
} from '../src/modules/auth-email-challenges/auth-email-challenges.service';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('OTP foundation on the complete PostgreSQL migration chain', () => {
  let owner: DataSource;
  let runtime: DataSource;
  let second: DataSource;
  let service: AuthEmailChallengesService;
  let peer: AuthEmailChallengesService;
  let user: User;
  let messages: EmailMessage[];
  const config: AuthOtpConfig = {
    publicFlowsEnabled: true,
    pepper: randomBytes(32),
    ttlSeconds: 600,
    maxAttempts: 5,
    cooldownSeconds: 60,
    sendWindowSeconds: 3600,
    maxSends: 5,
    emailFrom: 'Genesis <auth@example.com>',
    registrationRateLimitWindowSeconds: 900,
    registrationEmailIpMaxAttempts: 5,
    registrationIpMaxAttempts: 20,
    registrationRateLimitMaxBuckets: 10_000,
    passwordResetPublicFlowEnabled: true,
    passwordResetRateLimitWindowSeconds: 900,
    passwordResetIpMaxAttempts: 20,
    passwordResetEmailIpMaxAttempts: 5,
  };
  let sender: EmailTransport;

  function makeService(
    connection: DataSource,
    transport = sender,
    audit?: AuthAuditService,
  ): AuthEmailChallengesService {
    return new AuthEmailChallengesService(
      connection,
      new ConfigService({ authOtp: config }),
      transport,
      audit ?? new AuthAuditService(connection.getRepository(AuthAuditLog)),
    );
  }

  beforeAll(async () => {
    configureIntegrationRuntimeEnvironment();
    owner = createIntegrationDataSource({ includePasswordReset: true });
    owner.setOptions({
      entities: [
        ...Object.values(owner.options.entities ?? {}),
        AuthEmailChallenge,
      ],
      migrations: [join(__dirname, '../src/database/migrations/*.ts')],
    });
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    runtime = createIntegrationRuntimeDataSource();
    runtime.setOptions({
      entities: [
        ...Object.values(runtime.options.entities ?? {}),
        AuthEmailChallenge,
      ],
    });
    await runtime.initialize();
    second = createIntegrationRuntimeDataSource();
    second.setOptions({
      entities: [
        ...Object.values(second.options.entities ?? {}),
        AuthEmailChallenge,
      ],
    });
    await second.initialize();
  }, 60000);

  afterAll(async () => {
    if (second?.isInitialized) await second.destroy();
    if (runtime?.isInitialized) await runtime.destroy();
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  beforeEach(async () => {
    messages = [];
    sender = {
      send: async (message) => {
        messages.push(message);
        // Separate connection can read the committed row while delivery runs.
        const row = await second
          .getRepository(AuthEmailChallenge)
          .findOneBy({ userId: user.id });
        expect(row).not.toBeNull();
        return { kind: 'sent', providerMessageId: 'test-delivery' };
      },
    };
    user = await owner.getRepository(User).save(
      owner.getRepository(User).create({
        email: `${randomUUID()}@example.com`,
        name: 'OTP Test',
        status: UserStatus.ACTIVE,
      }),
    );
    service = makeService(runtime);
    peer = makeService(second);
  });

  function issued(result: ChallengeIssueResult): {
    challengeId: string;
    expiresAt: Date;
  } {
    expect(result.status).toBe('sent');
    if (!('challengeId' in result)) throw new Error('Missing challenge.');
    return result;
  }
  function code(index = messages.length - 1): string {
    const value = messages[index]?.text.match(/\b\d{6}\b/u)?.[0];
    if (!value) throw new Error('Missing ephemeral test code.');
    return value;
  }
  function wrong(): string {
    return code() === '000000' ? '999999' : '000000';
  }
  async function age(seconds: number): Promise<void> {
    // Shift persisted timestamps coherently, instead of waiting or changing the process clock.
    await owner.query(
      `UPDATE public.auth_email_challenges SET
      created_at = created_at - make_interval(secs => $2),
      updated_at = updated_at - make_interval(secs => $2),
      last_sent_at = last_sent_at - make_interval(secs => $2),
      expires_at = expires_at - make_interval(secs => $2),
      send_window_started_at = send_window_started_at - make_interval(secs => $2)
      WHERE user_id = $1`,
      [user.id, seconds],
    );
  }

  it('installs an additive migration and leaves the exact runtime function inventory unchanged', async () => {
    const [migration] = await owner.query<Array<{ count: string }>>(
      `SELECT count(*) FROM migrations WHERE name = $1`,
      ['CreateAuthEmailChallenges1788900000000'],
    );
    expect(migration.count).toBe('1');
    const functions = await runtime.query<
      Array<{ signature: string }>
    >(`SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='app_private' AND has_function_privilege(current_user,p.oid,'EXECUTE') ORDER BY signature`);
    expect(functions.map((row) => row.signature)).toEqual(
      CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS,
    );
    const runner = owner.createQueryRunner();
    try {
      await new CreateAuthEmailChallenges1788900000000().down(runner);
      await new CreateAuthEmailChallenges1788900000000().up(runner);
    } finally {
      await runner.release();
    }
  });

  it('grants only challenge SELECT/INSERT/UPDATE and preserves central-table ACL', async () => {
    for (const table of ['users', 'organizations', 'memberships']) {
      const [acl] = await runtime.query<
        Array<{ mutation: boolean; columnMutation: boolean }>
      >(
        `SELECT
        has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS mutation,
        has_any_column_privilege(current_user,$1,'INSERT,UPDATE') AS "columnMutation"`,
        [table],
      );
      expect(acl).toEqual({ mutation: false, columnMutation: false });
    }
    const [acl] = await runtime.query<
      Array<{ allowed: boolean; forbidden: boolean; publicAllowed: boolean }>
    >(`SELECT
      has_table_privilege(current_user,'auth_email_challenges','SELECT')
      AND has_table_privilege(current_user,'auth_email_challenges','INSERT')
      AND has_table_privilege(current_user,'auth_email_challenges','UPDATE') AS allowed,
      has_table_privilege(current_user,'auth_email_challenges','DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS forbidden,
      EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
        WHERE c.oid='auth_email_challenges'::regclass AND a.grantee=0) AS "publicAllowed"`);
    expect(acl).toEqual({
      allowed: true,
      forbidden: false,
      publicAllowed: false,
    });
    await expect(
      runtime.query('DELETE FROM auth_email_challenges'),
    ).rejects.toThrow(/permission denied/u);
  });

  it('persists only the MAC, derives recipient from User, consumes once and records no secrets', async () => {
    const result = issued(await service.issueEmailVerification(user.id));
    const [row] = await owner.query<Array<Record<string, unknown>>>(
      'SELECT * FROM auth_email_challenges WHERE id=$1',
      [result.challengeId],
    );
    expect(row.secret_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(row)).not.toContain(code());
    expect(messages[0].to).toBe(user.email);
    expect(result).not.toHaveProperty('otp');
    expect(
      await service.consumeEmailVerification(
        user.id,
        result.challengeId,
        code(),
      ),
    ).toBe(true);
    expect(
      await service.consumeEmailVerification(
        user.id,
        result.challengeId,
        code(),
      ),
    ).toBe(false);
    const logs = await runtime
      .getRepository(AuthAuditLog)
      .findBy({ userId: user.id });
    expect(logs.map((log) => log.eventType)).toContain('auth.otp.consumed');
    for (const log of logs)
      expect(log.metadata).toEqual({ purpose: 'email_verification' });
    expect(JSON.stringify(logs)).not.toContain(code());
    expect(JSON.stringify(logs)).not.toContain(row.secret_hash);
    expect(
      await owner.getRepository(User).findOneByOrFail({ id: user.id }),
    ).toMatchObject({ emailVerifiedAt: null, passwordHash: undefined });
  });

  it('durably limits errors even if the caller throws and a service is recreated', async () => {
    const { challengeId } = issued(await service.issuePasswordReset(user.id));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        (async () => {
          expect(
            await makeService(second).consumePasswordReset(
              user.id,
              challengeId,
              wrong(),
            ),
          ).toBe(false);
          throw new Error('Subsequent HTTP rejection');
        })(),
      ).rejects.toThrow('Subsequent HTTP rejection');
      expect(
        await runtime
          .getRepository(AuthEmailChallenge)
          .findOneByOrFail({ id: challengeId }),
      ).toMatchObject({ failedAttempts: attempt });
    }
    expect(await peer.consumePasswordReset(user.id, challengeId, code())).toBe(
      false,
    );
    expect(
      await runtime
        .getRepository(AuthEmailChallenge)
        .findOneByOrFail({ id: challengeId }),
    ).toMatchObject({ stage: 'invalidated', failedAttempts: 5 });
  });

  it('commits an invalid attempt even when audit subsequently fails, without exposing the failure', async () => {
    const { challengeId } = issued(
      await service.issueEmailVerification(user.id),
    );
    const audit = new AuthAuditService(runtime.getRepository(AuthAuditLog));
    jest
      .spyOn(audit, 'record')
      .mockRejectedValue(new Error('SENSITIVE_PROVIDER_OR_SQL_INPUT'));
    await expect(
      makeService(runtime, sender, audit).consumeEmailVerification(
        user.id,
        challengeId,
        wrong(),
      ),
    ).rejects.toThrow('Email challenges are unavailable.');
    expect(
      await runtime
        .getRepository(AuthEmailChallenge)
        .findOneByOrFail({ id: challengeId }),
    ).toMatchObject({ failedAttempts: 1 });
  });

  it('expires by database time and clears the unusable hash', async () => {
    const { challengeId } = issued(
      await service.issueEmailVerification(user.id),
    );
    await age(601);
    expect(
      await peer.consumeEmailVerification(user.id, challengeId, code()),
    ).toBe(false);
    const [row] = await owner.query<
      Array<{ secret_hash: string | null; stage: string }>
    >('SELECT secret_hash,stage FROM auth_email_challenges WHERE id=$1', [
      challengeId,
    ]);
    expect(row).toEqual({ secret_hash: null, stage: 'invalidated' });
  });

  it('canonicalizes equivalent UUID spellings before authenticating the MAC', async () => {
    const first = issued(
      await service.issueEmailVerification(user.id.toUpperCase()),
    );
    expect(
      await peer.consumeEmailVerification(
        user.id,
        first.challengeId.toUpperCase(),
        code(),
      ),
    ).toBe(true);
    const secondIssue = issued(await service.issuePasswordReset(user.id));
    expect(
      await peer.consumePasswordReset(
        user.id.toUpperCase(),
        secondIssue.challengeId,
        code(),
      ),
    ).toBe(true);
  });

  it('permits at most one concurrent consumption across connections', async () => {
    const { challengeId } = issued(
      await service.issueEmailVerification(user.id),
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? peer : service).consumeEmailVerification(
          user.id,
          challengeId,
          code(),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('serializes first issuance and resend, preserving cooldown and the single current row', async () => {
    const results = await Promise.all([
      service.issueEmailVerification(user.id),
      peer.issueEmailVerification(user.id),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'rate_limited',
      'sent',
    ]);
    const previous = issued(
      results.find((result) => result.status === 'sent')!,
    );
    const previousCode = code();
    await age(61);
    const retries = await Promise.all([
      service.issueEmailVerification(user.id),
      peer.issueEmailVerification(user.id),
    ]);
    expect(retries.map((result) => result.status).sort()).toEqual([
      'rate_limited',
      'sent',
    ]);
    const current = issued(retries.find((result) => result.status === 'sent')!);
    expect(current.challengeId).not.toBe(previous.challengeId);
    expect(code()).not.toBe(previousCode);
    expect(
      await service.consumeEmailVerification(
        user.id,
        previous.challengeId,
        previousCode,
      ),
    ).toBe(false);
    expect(
      await service.consumeEmailVerification(
        user.id,
        current.challengeId,
        previousCode,
      ),
    ).toBe(false);
    expect(
      await runtime
        .getRepository(AuthEmailChallenge)
        .countBy({ userId: user.id }),
    ).toBe(1);
    expect(
      await peer.consumeEmailVerification(user.id, current.challengeId, code()),
    ).toBe(true);
  });

  it('preserves the hourly send budget through resends, consumption and service restart', async () => {
    for (let emission = 1; emission <= 5; emission += 1) {
      const { challengeId } = issued(
        await makeService(runtime).issueEmailVerification(user.id),
      );
      expect(
        await runtime
          .getRepository(AuthEmailChallenge)
          .findOneByOrFail({ id: challengeId }),
      ).toMatchObject({ sendCount: emission });
      expect(
        await service.consumeEmailVerification(user.id, challengeId, code()),
      ).toBe(true);
      await age(61);
    }
    expect(await makeService(second).issueEmailVerification(user.id)).toEqual({
      status: 'rate_limited',
    });
    await age(3601);
    const { challengeId } = issued(await peer.issueEmailVerification(user.id));
    expect(
      await runtime
        .getRepository(AuthEmailChallenge)
        .findOneByOrFail({ id: challengeId }),
    ).toMatchObject({ sendCount: 1 });
  });

  it('isolates user and purpose and does not overwrite the other purpose on resend', async () => {
    const verification = issued(await service.issueEmailVerification(user.id));
    const verificationCode = code();
    const reset = issued(await service.issuePasswordReset(user.id));
    const resetCode = code();
    expect(
      await service.consumePasswordReset(
        user.id,
        verification.challengeId,
        verificationCode,
      ),
    ).toBe(false);
    expect(
      await service.consumeEmailVerification(
        randomUUID(),
        verification.challengeId,
        verificationCode,
      ),
    ).toBe(false);
    expect(
      await service.consumeEmailVerification(
        user.id,
        verification.challengeId,
        verificationCode,
      ),
    ).toBe(true);
    expect(
      await peer.consumePasswordReset(user.id, reset.challengeId, resetCode),
    ).toBe(true);
  });

  it('retains issuance budget after provider failure without holding a transaction open', async () => {
    let locksAvailable = false;
    const transport: EmailTransport = {
      send: async () => {
        // NOWAIT proves issuance no longer holds the user/challenge locks.
        await owner.transaction(async (manager) => {
          await manager.query(
            'SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',
            [user.id],
          );
          await manager.query(
            'SELECT id FROM auth_email_challenges WHERE user_id=$1 FOR UPDATE NOWAIT',
            [user.id],
          );
        });
        locksAvailable = true;
        throw new Error('SENSITIVE_EMAIL_PAYLOAD');
      },
    };
    const result = await makeService(runtime, transport).issueEmailVerification(
      user.id,
    );
    expect(result.status).toBe('delivery_unavailable');
    expect(locksAvailable).toBe(true);
    expect(await peer.issueEmailVerification(user.id)).toEqual({
      status: 'rate_limited',
    });
    expect(
      await runtime
        .getRepository(AuthEmailChallenge)
        .findOneByOrFail({ userId: user.id }),
    ).toMatchObject({ sendCount: 1 });
  });

  it('persists password reset before returning and does not expose provider latency', async () => {
    let releaseDelivery!: () => void;
    const deliveryPending = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const transport: EmailTransport = {
      send: async (message) => {
        messages.push(message);
        await deliveryPending;
        return { kind: 'sent', providerMessageId: 'delayed-delivery' };
      },
    };
    const detached = makeService(runtime, transport);
    const result = await detached.issuePasswordReset(user.id, 'detached');
    expect(result.status).toBe('accepted');
    await expect(
      owner
        .getRepository(AuthEmailChallenge)
        .findOneByOrFail({ userId: user.id, purpose: 'password_reset' }),
    ).resolves.toMatchObject({ stage: 'otp' });
    expect(messages).toHaveLength(1);
    releaseDelivery();
    await detached.onModuleDestroy();
  });

  it('keeps detached password reset accepted when the provider is unavailable', async () => {
    const unavailable = makeService(runtime, {
      send: () => Promise.reject(new Error('SENSITIVE_PROVIDER_FAILURE')),
    });
    await expect(
      unavailable.issuePasswordReset(user.id, 'detached'),
    ).resolves.toMatchObject({ status: 'accepted' });
    await unavailable.onModuleDestroy();
    const logs = await runtime
      .getRepository(AuthAuditLog)
      .findBy({ userId: user.id });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'auth.otp.delivery_failed',
          metadata: { purpose: 'password_reset' },
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain('SENSITIVE_PROVIDER_FAILURE');
  });

  it('fails closed for inactive and missing users and never mutates login credentials', async () => {
    await owner
      .getRepository(User)
      .update(user.id, { status: UserStatus.INACTIVE });
    expect(await service.issueEmailVerification(user.id)).toEqual({
      status: 'unavailable',
    });
    expect(await peer.issuePasswordReset(randomUUID())).toEqual({
      status: 'unavailable',
    });
    expect(messages).toHaveLength(0);
  });

  it('enforces purpose, hash, state, counter and uniqueness constraints', async () => {
    const { challengeId } = issued(
      await service.issueEmailVerification(user.id),
    );
    for (const assignment of [
      "purpose='login'",
      "stage='reset_authorized'",
      "secret_hash='plaintext'",
      'failed_attempts=-1',
      'send_count=0',
      "stage='consumed'",
    ]) {
      await expect(
        owner.query(
          `UPDATE auth_email_challenges SET ${assignment} WHERE id=$1`,
          [challengeId],
        ),
      ).rejects.toThrow(/check constraint/u);
    }
    await expect(
      owner.query(
        `INSERT INTO auth_email_challenges SELECT $2,id_user.* FROM (SELECT
      user_id,purpose,secret_hash,stage,expires_at,failed_attempts,last_sent_at,send_window_started_at,send_count,created_at,updated_at
      FROM auth_email_challenges WHERE id=$1) id_user`,
        [challengeId, randomUUID()],
      ),
    ).rejects.toThrow(/unique constraint/u);
    const runner = owner.createQueryRunner();
    try {
      await expect(
        new CreateAuthEmailChallenges1788900000000().down(runner),
      ).rejects.toThrow(
        'OTP migration rollback requires empty foundation data.',
      );
    } finally {
      await runner.release();
    }
    expect(
      await runtime
        .getRepository(AuthEmailChallenge)
        .countBy({ id: challengeId }),
    ).toBe(1);
  });
});
