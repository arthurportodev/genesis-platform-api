import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  AUTH_REGISTRATION_RUNTIME_EXECUTABLE_FUNCTIONS,
  RUNTIME_EXECUTABLE_FUNCTIONS,
} from '../src/database/runtime-executable-functions';
import { hashPassword } from '../src/modules/credentials/password-policy';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('Public registration database boundary', () => {
  let owner: DataSource;
  let runtime: DataSource;

  beforeAll(async () => {
    configureIntegrationRuntimeEnvironment();
    owner = createIntegrationDataSource();
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

  it('creates only one active unverified user through the restricted function', async () => {
    const email = `${randomUUID()}@example.test`;
    const passwordHash = await hashPassword('synthetic-password-only');
    const rows = await runtime.query<Array<{ user_id: string }>>(
      `SELECT * FROM app_private.register_unverified_user($1, $2, $3)`,
      [email, 'Pessoa Teste', passwordHash],
    );
    const userId = rows[0]?.user_id;
    expect(userId).toEqual(expect.any(String));
    const [state] = await owner.query<
      Array<{
        status: string;
        emailVerifiedAt: Date | null;
        organizations: string;
        memberships: string;
        sessions: string;
      }>
    >(
      `SELECT application_user.status,
              application_user.email_verified_at AS "emailVerifiedAt",
              (SELECT count(*) FROM public.organizations)::text AS organizations,
              (SELECT count(*) FROM public.memberships WHERE user_id = $1)::text AS memberships,
              (SELECT count(*) FROM public.auth_sessions WHERE user_id = $1)::text AS sessions
       FROM public.users AS application_user WHERE id = $1`,
      [userId],
    );
    expect(state).toEqual({
      status: 'active',
      emailVerifiedAt: null,
      organizations: '0',
      memberships: '0',
      sessions: '0',
    });
    await expect(
      runtime.query(
        `SELECT * FROM app_private.register_unverified_user($1, $2, $3)`,
        [email, 'Outra Pessoa', passwordHash],
      ),
    ).rejects.toMatchObject({
      driverError: { code: '23505', constraint: 'UQ_users_email' },
    });
    const [preserved] = await owner.query<Array<{ name: string }>>(
      'SELECT name FROM public.users WHERE id = $1',
      [userId],
    );
    expect(preserved?.name).toBe('Pessoa Teste');
  });

  it('lets the unique email constraint choose one winner under concurrent registration', async () => {
    const email = `${randomUUID()}@example.test`;
    const passwordHash = await hashPassword('concurrent-synthetic-password');
    const attempts = await Promise.allSettled([
      runtime.query(
        `SELECT * FROM app_private.register_unverified_user($1, $2, $3)`,
        [email, 'Primeira Pessoa', passwordHash],
      ),
      runtime.query(
        `SELECT * FROM app_private.register_unverified_user($1, $2, $3)`,
        [email, 'Segunda Pessoa', passwordHash],
      ),
    ]);

    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await owner.query<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM public.users WHERE email = $1',
        [email],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('requires a consumed challenge bound to the same user before verification', async () => {
    const passwordHash = await hashPassword('second-synthetic-password');
    const [registered] = await runtime.query<Array<{ user_id: string }>>(
      `SELECT * FROM app_private.register_unverified_user($1, $2, $3)`,
      [`${randomUUID()}@example.test`, 'Segunda Pessoa', passwordHash],
    );
    const userId = registered?.user_id;
    const challengeId = randomUUID();
    await runtime.query(
      `INSERT INTO public.auth_email_challenges (
         id, user_id, purpose, secret_hash, stage, expires_at,
         failed_attempts, last_sent_at, send_window_started_at, send_count,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'email_verification', NULL, 'consumed',
         transaction_timestamp() + interval '10 minutes', 0,
         transaction_timestamp(), transaction_timestamp(), 1,
         transaction_timestamp(), transaction_timestamp()
       )`,
      [challengeId, userId],
    );
    expect(
      await runtime.query<Array<{ verified: boolean }>>(
        `SELECT app_private.verify_user_email($1, $2) AS verified`,
        [userId, randomUUID()],
      ),
    ).toEqual([{ verified: false }]);
    expect(
      await runtime.query<Array<{ verified: boolean }>>(
        `SELECT app_private.verify_user_email($1, $2) AS verified`,
        [userId, challengeId],
      ),
    ).toEqual([{ verified: true }]);
    const [verified] = await owner.query<Array<{ emailVerifiedAt: Date }>>(
      `SELECT email_verified_at AS "emailVerifiedAt"
       FROM public.users WHERE id = $1`,
      [userId],
    );
    expect(verified?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('keeps generic user mutation revoked and exposes exactly the approved functions', async () => {
    const role = process.env.DATABASE_RUNTIME_ROLE!;
    const [privileges] = await owner.query<
      Array<{
        canMutateUsers: boolean;
        functions: string[];
      }>
    >(
      `SELECT
         has_table_privilege($1, 'public.users',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
           OR has_any_column_privilege($1, 'public.users', 'INSERT,UPDATE,REFERENCES')
           AS "canMutateUsers",
         ARRAY(
           SELECT p.oid::regprocedure::text
           FROM pg_proc AS p
           JOIN pg_namespace AS namespace ON namespace.oid = p.pronamespace
           WHERE namespace.nspname = 'app_private'
             AND has_function_privilege($1, p.oid, 'EXECUTE')
           ORDER BY p.oid::regprocedure::text
         ) AS functions`,
      [role],
    );
    expect(privileges?.canMutateUsers).toBe(false);
    expect(privileges?.functions).toEqual(
      [
        ...RUNTIME_EXECUTABLE_FUNCTIONS,
        ...AUTH_REGISTRATION_RUNTIME_EXECUTABLE_FUNCTIONS,
      ].sort(),
    );
  });
});
