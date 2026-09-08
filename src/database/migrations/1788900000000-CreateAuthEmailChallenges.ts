import { MigrationInterface, QueryRunner } from 'typeorm';

const OTP_EVENTS = [
  'auth.otp.issued',
  'auth.otp.consumed',
  'auth.otp.rejected',
  'auth.otp.delivery_failed',
] as const;
const EXISTING_EVENTS = [
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.refresh.succeeded',
  'auth.refresh.failed',
  'auth.refresh.reuse_detected',
  'auth.logout',
  'auth.logout_all',
] as const;

export class CreateAuthEmailChallenges1788900000000 implements MigrationInterface {
  name = 'CreateAuthEmailChallenges1788900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    await queryRunner.query(`CREATE TABLE public.auth_email_challenges (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      purpose varchar(32) NOT NULL,
      secret_hash varchar(64),
      stage varchar(16) NOT NULL,
      expires_at timestamptz NOT NULL,
      failed_attempts integer NOT NULL DEFAULT 0,
      last_sent_at timestamptz NOT NULL,
      send_window_started_at timestamptz NOT NULL,
      send_count integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT UQ_auth_email_challenges_user_purpose UNIQUE(user_id, purpose),
      CONSTRAINT CHK_auth_email_challenges_purpose CHECK (purpose IN ('email_verification','password_reset')),
      CONSTRAINT CHK_auth_email_challenges_stage CHECK (stage IN ('otp','consumed','invalidated')),
      CONSTRAINT CHK_auth_email_challenges_secret CHECK (
        (stage = 'otp' AND secret_hash IS NOT NULL AND secret_hash ~ '^[a-f0-9]{64}$')
        OR (stage IN ('consumed','invalidated') AND secret_hash IS NULL)),
      CONSTRAINT CHK_auth_email_challenges_counters CHECK (failed_attempts >= 0 AND send_count >= 1),
      CONSTRAINT CHK_auth_email_challenges_dates CHECK (
        expires_at > last_sent_at AND send_window_started_at <= last_sent_at
        AND created_at <= last_sent_at AND updated_at >= last_sent_at)
    )`);
    await queryRunner.query(`CREATE INDEX IDX_auth_email_challenges_expires_at
      ON public.auth_email_challenges(expires_at)`);
    await queryRunner.query(
      `REVOKE ALL ON public.auth_email_challenges FROM PUBLIC, "${runtime}"`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE ON public.auth_email_challenges TO "${runtime}"`,
    );
    await this.auditConstraint(queryRunner, [
      ...EXISTING_EVENTS,
      ...OTP_EVENTS,
    ]);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT EXISTS(SELECT 1 FROM public.auth_email_challenges)
        OR EXISTS(SELECT 1 FROM public.auth_audit_logs WHERE event_type = ANY($1::text[])) AS populated`,
      [OTP_EVENTS],
    )) as Array<{ populated: boolean }>;
    const row = rows[0];
    if (row?.populated !== false)
      throw new Error('OTP migration rollback requires empty foundation data.');
    await this.auditConstraint(queryRunner, EXISTING_EVENTS);
    await queryRunner.query('DROP TABLE public.auth_email_challenges');
  }

  private async auditConstraint(
    queryRunner: QueryRunner,
    events: readonly string[],
  ): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.auth_audit_logs DROP CONSTRAINT "CHK_auth_audit_logs_event_type"',
    );
    await queryRunner.query(`ALTER TABLE public.auth_audit_logs ADD CONSTRAINT "CHK_auth_audit_logs_event_type"
      CHECK (event_type IN (${events.map((event) => `'${event}'`).join(',')}))`);
  }

  private async runtimeRole(queryRunner: QueryRunner): Promise<string> {
    const role = process.env.DATABASE_RUNTIME_ROLE;
    if (!role || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role))
      throw new Error('Invalid runtime role.');
    const rows = (await queryRunner.query(
      `SELECT
      current_user <> rolname AND NOT rolsuper AND NOT rolbypassrls AND rolcanlogin
      AND NOT pg_has_role($1, current_user, 'MEMBER')
      AND NOT has_table_privilege($1, 'public.users', 'INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege($1, 'public.users', 'INSERT,UPDATE')
      AND NOT has_table_privilege($1, 'public.organizations', 'INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege($1, 'public.organizations', 'INSERT,UPDATE')
      AND NOT has_table_privilege($1, 'public.memberships', 'INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege($1, 'public.memberships', 'INSERT,UPDATE') AS safe
      FROM pg_roles WHERE rolname = $1`,
      [role],
    )) as Array<{ safe: boolean }>;
    const row = rows[0];
    if (row?.safe !== true)
      throw new Error('Runtime role violates OTP migration boundary.');
    return role;
  }
}
