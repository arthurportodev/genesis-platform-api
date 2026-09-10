import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
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

describe('Google identity on the complete PostgreSQL migration chain', () => {
  let owner: DataSource;
  let runtime: DataSource;

  beforeAll(async () => {
    configureIntegrationRuntimeEnvironment();
    owner = createIntegrationDataSource({
      includePasswordReset: true,
      includeGoogleIdentity: true,
    });
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

  it('installs narrow functions without generic identity or users mutation grants', async () => {
    const [privileges] = await runtime.query<
      Array<{
        canCreate: boolean;
        canLink: boolean;
        canTouch: boolean;
        canMutateIdentity: boolean;
        canMutateUsers: boolean;
      }>
    >(`SELECT
      has_function_privilege(current_user,'app_private.create_google_user_identity(text,text,boolean,text)','EXECUTE') AS "canCreate",
      has_function_privilege(current_user,'app_private.link_google_identity(uuid,text,text)','EXECUTE') AS "canLink",
      has_function_privilege(current_user,'app_private.touch_google_identity(uuid,text)','EXECUTE') AS "canTouch",
      has_table_privilege(current_user,'public.auth_identities','INSERT,UPDATE,DELETE,TRUNCATE') AS "canMutateIdentity",
      has_table_privilege(current_user,'public.users','INSERT,UPDATE,DELETE,TRUNCATE') AS "canMutateUsers"`);
    expect(privileges).toEqual({
      canCreate: true,
      canLink: true,
      canTouch: true,
      canMutateIdentity: false,
      canMutateUsers: false,
    });
  });

  it('installs the exact tables, checks, uniqueness and FK delete policies', async () => {
    const constraints = await owner.query<
      Array<{ name: string; deleteAction: string }>
    >(`SELECT conname AS name, confdeltype AS "deleteAction"
       FROM pg_constraint
       WHERE conrelid IN ('auth_identities'::regclass,'auth_google_challenges'::regclass)
       ORDER BY conname`);
    const names = constraints.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        'FK_auth_google_challenges_user',
        'FK_auth_identities_user',
        'UQ_auth_google_challenges_nonce_hash',
        'UQ_auth_google_challenges_token_hash',
        'UQ_auth_identities_provider_subject',
        'UQ_auth_identities_user_provider',
        'CHK_auth_google_challenges_attempts',
        'CHK_auth_google_challenges_continuation',
        'CHK_auth_identities_email_normalized',
        'CHK_auth_identities_provider',
        'CHK_auth_identities_subject',
      ]),
    );
    expect(
      constraints.find(({ name }) => name === 'FK_auth_identities_user')
        ?.deleteAction,
    ).toBe('r');
    expect(
      constraints.find(({ name }) => name === 'FK_auth_google_challenges_user')
        ?.deleteAction,
    ).toBe('c');
    await expect(
      owner.query(
        `INSERT INTO auth_identities(user_id,provider,provider_subject,provider_email)
         VALUES(gen_random_uuid(),'other','subject','not-normalized')`,
      ),
    ).rejects.toThrow();
  });

  it('uses constraints as final authority for concurrent first login', async () => {
    const email = `${randomUUID()}@gmail.com`;
    const subject = `subject-${randomUUID()}`;
    const call = () =>
      runtime.query(
        `SELECT app_private.create_google_user_identity($1,$2,true,$3) AS user_id`,
        [email, 'Google User', subject],
      );
    const attempts = await Promise.allSettled([call(), call()]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    const [counts] = await owner.query<
      Array<{ users: string; identities: string }>
    >(
      `SELECT
        (SELECT count(*) FROM public.users WHERE email=$1)::text AS users,
        (SELECT count(*) FROM public.auth_identities WHERE provider='google' AND provider_subject=$2)::text AS identities`,
      [email, subject],
    );
    expect(counts).toEqual({ users: '1', identities: '1' });
  });

  it('serializes concurrent challenge attempt debits without losing increments', async () => {
    const tokenHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const nonceHash = randomUUID().replaceAll('-', '').padEnd(64, '1');
    const [challenge] = await owner.query<Array<{ id: string }>>(
      `INSERT INTO auth_google_challenges(token_hash,nonce_hash,stage,expires_at)
       VALUES($1,$2,'issued',now()+interval '5 minutes') RETURNING id`,
      [tokenHash, nonceHash],
    );
    await Promise.all([
      runtime.query(
        `UPDATE auth_google_challenges SET failed_attempts=failed_attempts+1 WHERE id=$1`,
        [challenge.id],
      ),
      runtime.query(
        `UPDATE auth_google_challenges SET failed_attempts=failed_attempts+1 WHERE id=$1`,
        [challenge.id],
      ),
    ]);
    const [row] = await owner.query<Array<{ failed_attempts: number }>>(
      `SELECT failed_attempts FROM auth_google_challenges WHERE id=$1`,
      [challenge.id],
    );
    expect(row.failed_attempts).toBe(2);
    await expect(
      runtime.query(
        `UPDATE auth_google_challenges SET failed_attempts=6 WHERE id=$1`,
        [challenge.id],
      ),
    ).rejects.toThrow();
  });

  it('allows only one User in a concurrent Google/password signup race', async () => {
    const email = `${randomUUID()}@gmail.com`;
    const passwordHash = await hashPassword('signup-race-password');
    const attempts = await Promise.allSettled([
      runtime.query(
        `SELECT app_private.create_google_user_identity($1,$2,true,$3)`,
        [email, 'Google Race', `subject-${randomUUID()}`],
      ),
      runtime.query(
        `SELECT * FROM app_private.register_unverified_user($1,$2,$3)`,
        [email, 'Password Race', passwordHash],
      ),
    ]);
    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    const [counts] = await owner.query<
      Array<{ users: number; identities: number }>
    >(
      `SELECT
        (SELECT count(*)::int FROM users WHERE email=$1) AS users,
        (SELECT count(*)::int FROM auth_identities WHERE provider_email=$1) AS identities`,
      [email],
    );
    expect(counts.users).toBe(1);
    expect([0, 1]).toContain(counts.identities);
  });

  it('enforces challenge single-use shape, expiry data and FK cascade', async () => {
    const email = `${randomUUID()}@example.test`;
    const passwordHash = await hashPassword('challenge-owner-password');
    const [created] = await runtime.query<Array<{ user_id: string }>>(
      `SELECT * FROM app_private.register_unverified_user($1,$2,$3)`,
      [email, 'Challenge Owner', passwordHash],
    );
    const tokenHash = randomUUID().replaceAll('-', '').padEnd(64, 'a');
    const nonceHash = randomUUID().replaceAll('-', '').padEnd(64, 'b');
    const [challenge] = await owner.query<Array<{ id: string }>>(
      `INSERT INTO auth_google_challenges(
        token_hash,nonce_hash,stage,user_id,provider_subject,provider_email,expires_at
       ) VALUES($1,$2,'link_pending',$3,$4,$5,now()-interval '1 second') RETURNING id`,
      [tokenHash, nonceHash, created.user_id, `subject-${randomUUID()}`, email],
    );
    await expect(
      owner.query(
        `INSERT INTO auth_google_challenges(token_hash,nonce_hash,stage,expires_at)
         VALUES($1,$2,'issued',now()+interval '5 minutes')`,
        [tokenHash, randomUUID().replaceAll('-', '').padEnd(64, 'c')],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `UPDATE auth_google_challenges SET stage='consumed',consumed_at=NULL WHERE id=$1`,
        [challenge.id],
      ),
    ).rejects.toThrow();
    await owner.query(`DELETE FROM users WHERE id=$1`, [created.user_id]);
    expect(
      await owner.query(`SELECT id FROM auth_google_challenges WHERE id=$1`, [
        challenge.id,
      ]),
    ).toEqual([]);
  });

  it('never duplicates or auto-links an existing password account by email', async () => {
    const email = `${randomUUID()}@example.test`;
    const passwordHash = await hashPassword('password-account-value');
    const [created] = await runtime.query<Array<{ user_id: string }>>(
      `SELECT * FROM app_private.register_unverified_user($1,$2,$3)`,
      [email, 'Password User', passwordHash],
    );
    await expect(
      runtime.query(
        `SELECT app_private.create_google_user_identity($1,$2,true,$3)`,
        [email, 'Google Collision', `subject-${randomUUID()}`],
      ),
    ).rejects.toThrow();
    const [counts] = await owner.query<
      Array<{ users: string; identities: string }>
    >(
      `SELECT
        (SELECT count(*) FROM public.users WHERE email=$1)::text AS users,
        (SELECT count(*) FROM public.auth_identities WHERE user_id=$2)::text AS identities`,
      [email, created.user_id],
    );
    expect(counts).toEqual({ users: '1', identities: '0' });
  });

  it('links once and keeps User email stable when provider metadata changes', async () => {
    const email = `${randomUUID()}@example.test`;
    const user = await owner.getRepository(User).save(
      owner.getRepository(User).create({
        email,
        name: 'Linked User',
        status: UserStatus.ACTIVE,
        passwordHash: await hashPassword('linked-password-value'),
        passwordChangedAt: new Date(),
        emailVerifiedAt: new Date(),
      }),
    );
    const subject = `subject-${randomUUID()}`;
    const links = await Promise.all([
      runtime.query<Array<{ linked: boolean }>>(
        `SELECT app_private.link_google_identity($1,$2,$3) AS linked`,
        [user.id, subject, email],
      ),
      runtime.query<Array<{ linked: boolean }>>(
        `SELECT app_private.link_google_identity($1,$2,$3) AS linked`,
        [user.id, subject, email],
      ),
    ]);
    expect(links.flat().filter((row) => row.linked)).toHaveLength(1);
    const [identity] = await owner.query<Array<{ id: string }>>(
      `SELECT id FROM auth_identities WHERE provider_subject=$1`,
      [subject],
    );
    const changedProviderEmail = `${randomUUID()}@gmail.com`;
    await runtime.query(`SELECT app_private.touch_google_identity($1,$2)`, [
      identity.id,
      changedProviderEmail,
    ]);
    const stableUser = await owner
      .getRepository(User)
      .findOneByOrFail({ id: user.id });
    expect(stableUser.email).toBe(email);
  });

  it('allows the existing reset function to set the first password', async () => {
    const email = `${randomUUID()}@gmail.com`;
    const [created] = await runtime.query<Array<{ user_id: string }>>(
      `SELECT app_private.create_google_user_identity($1,$2,true,$3) AS user_id`,
      [email, 'Google First', `subject-${randomUUID()}`],
    );
    const challengeId = randomUUID();
    await owner.query(
      `INSERT INTO auth_email_challenges(
      id,user_id,purpose,stage,secret_hash,expires_at,failed_attempts,send_count,
      send_window_started_at,last_sent_at,created_at,updated_at
    ) VALUES($1,$2,'password_reset','consumed',NULL,now()+interval '10 minutes',0,1,now(),now(),now(),now())`,
      [challengeId, created.user_id],
    );
    const password = 'first-password-value';
    const encoded = await hashPassword(password);
    const [result] = await runtime.query<Array<{ completed: boolean }>>(
      `SELECT completed FROM app_private.complete_password_reset($1,$2,$3)`,
      [created.user_id, challengeId, encoded],
    );
    expect(result.completed).toBe(true);
    const [row] = await owner.query<Array<{ password_hash: string }>>(
      `SELECT password_hash FROM users WHERE id=$1`,
      [created.user_id],
    );
    expect(await verifyPassword(row.password_hash, password)).toBe(true);
  });
});
