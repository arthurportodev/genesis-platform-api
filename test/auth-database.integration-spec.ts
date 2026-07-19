import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { seedInitialTenant } from '../src/database/seeds/initial-tenant.seed';
import { AuthAuditLog } from '../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthRefreshToken } from '../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthAuditEventType } from '../src/modules/auth-sessions/enums/auth-audit-event-type.enum';
import { AuthRefreshTokenStatus } from '../src/modules/auth-sessions/enums/auth-refresh-token-status.enum';
import { AuthSessionStatus } from '../src/modules/auth-sessions/enums/auth-session-status.enum';
import { User } from '../src/modules/users/entities/user.entity';
import { createIntegrationDataSource } from './support/integration-data-source';

interface NameRow {
  name: string;
}

describe('Authentication database integration', () => {
  let connection: DataSource;
  const initialOwnerPassword = randomBytes(24).toString('base64url');

  beforeAll(async () => {
    connection = createIntegrationDataSource();
    await connection.initialize();
    await connection.dropDatabase();
    await connection.runMigrations();
  });

  afterAll(async () => {
    if (connection.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('creates credential, session, and audit schema with required indexes', async () => {
    const columns = await connection.query<NameRow[]>(`
      SELECT column_name AS name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN ('password_hash', 'password_changed_at')
      ORDER BY column_name
    `);
    expect(columns.map((row) => row.name)).toEqual([
      'password_changed_at',
      'password_hash',
    ]);

    const indexes = await connection.query<NameRow[]>(`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'IDX_auth_sessions_user_id',
          'IDX_auth_sessions_status',
          'IDX_auth_sessions_expires_at',
          'IDX_auth_refresh_tokens_session_id',
          'IDX_auth_refresh_tokens_status',
          'IDX_auth_refresh_tokens_expires_at',
          'IDX_auth_audit_logs_user_id',
          'IDX_auth_audit_logs_event_type',
          'IDX_auth_audit_logs_created_at'
        )
      ORDER BY indexname
    `);
    expect(indexes).toHaveLength(9);
  });

  it('requires the initial password only while the credential is missing', async () => {
    const originalPassword = process.env.INITIAL_OWNER_PASSWORD;
    delete process.env.INITIAL_OWNER_PASSWORD;
    await expect(
      seedInitialTenant(connection, { log: jest.fn() }),
    ).rejects.toThrow('INITIAL_OWNER_PASSWORD is required');
    expect(await connection.getRepository(User).count()).toBe(0);

    const firstRun = await seedInitialTenant(
      connection,
      { log: jest.fn() },
      { initialOwnerPassword },
    );
    const secondRun = await seedInitialTenant(connection, { log: jest.fn() });
    expect(firstRun.credentialCreated).toBe(true);
    expect(secondRun.credentialCreated).toBe(false);

    if (originalPassword !== undefined) {
      process.env.INITIAL_OWNER_PASSWORD = originalPassword;
    }
  });

  it('enforces refresh-token hash, state, uniqueness, and foreign keys', async () => {
    const user = await connection.getRepository(User).findOneByOrFail({
      email: 'contato@agenciagenesismkt.com.br',
    });
    const sessions = connection.getRepository(AuthSession);
    const session = await sessions.save(
      sessions.create({
        id: randomUUID(),
        userId: user.id,
        status: AuthSessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 60_000),
        lastUsedAt: null,
        revokedAt: null,
        revokeReason: null,
        userAgent: null,
        ipAddress: '127.0.0.1',
      }),
    );
    const refreshTokens = connection.getRepository(AuthRefreshToken);
    const token = await refreshTokens.save(
      refreshTokens.create({
        sessionId: session.id,
        tokenHash: 'a'.repeat(64),
        status: AuthRefreshTokenStatus.ACTIVE,
        expiresAt: session.expiresAt,
        consumedAt: null,
        revokedAt: null,
        replacedByTokenId: null,
      }),
    );

    await expect(
      refreshTokens.save(
        refreshTokens.create({
          sessionId: session.id,
          tokenHash: 'not-a-valid-hash',
          status: AuthRefreshTokenStatus.ACTIVE,
          expiresAt: session.expiresAt,
          consumedAt: null,
          revokedAt: null,
          replacedByTokenId: null,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      refreshTokens.save(
        refreshTokens.create({
          sessionId: session.id,
          tokenHash: token.tokenHash,
          status: AuthRefreshTokenStatus.ACTIVE,
          expiresAt: session.expiresAt,
          consumedAt: null,
          revokedAt: null,
          replacedByTokenId: null,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      refreshTokens.update(token.id, {
        status: AuthRefreshTokenStatus.CONSUMED,
        consumedAt: null,
      }),
    ).rejects.toThrow();
    await expect(
      connection.getRepository(User).delete(user.id),
    ).rejects.toThrow();

    await connection.getRepository(AuthAuditLog).save({
      eventType: AuthAuditEventType.LOGIN_SUCCEEDED,
      userId: user.id,
      sessionId: session.id,
      ipAddress: '127.0.0.1',
      userAgent: 'integration-test',
      metadata: {},
    });
    expect(await connection.getRepository(AuthAuditLog).count()).toBe(1);
  });
});
