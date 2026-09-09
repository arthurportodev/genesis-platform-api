import { MigrationInterface, QueryRunner } from 'typeorm';

const PASSWORD_RESET_EVENT = 'auth.password_reset.succeeded';
const PREVIOUS_EVENTS = [
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.refresh.succeeded',
  'auth.refresh.failed',
  'auth.refresh.reuse_detected',
  'auth.logout',
  'auth.logout_all',
  'auth.otp.issued',
  'auth.otp.consumed',
  'auth.otp.rejected',
  'auth.otp.delivery_failed',
  'auth.registration.succeeded',
  'auth.email.verified',
] as const;

export class DeliverPasswordReset1789072800000 implements MigrationInterface {
  name = 'DeliverPasswordReset1789072800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    await this.auditConstraint(queryRunner, [
      ...PREVIOUS_EVENTS,
      PASSWORD_RESET_EVENT,
    ]);
    await queryRunner.query(`
      CREATE FUNCTION app_private.complete_password_reset(
        p_user_id uuid,
        p_challenge_id uuid,
        p_password_hash text
      ) RETURNS TABLE(
        completed boolean,
        revoked_session_count bigint,
        revoked_refresh_token_count bigint
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      CALLED ON NULL INPUT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      DECLARE
        application_user public.users%ROWTYPE;
        challenge public.auth_email_challenges%ROWTYPE;
        database_now timestamptz := pg_catalog.transaction_timestamp();
      BEGIN
        completed := false;
        revoked_session_count := 0;
        revoked_refresh_token_count := 0;
        IF p_user_id IS NULL OR p_challenge_id IS NULL OR p_password_hash IS NULL THEN
          RAISE EXCEPTION 'password reset arguments unavailable' USING ERRCODE = '22004';
        END IF;
        IF pg_catalog.octet_length(p_password_hash) > 255
           OR p_password_hash !~ '^\\$argon2id\\$v=19\\$m=65536,(t=3,p=1|p=1,t=3)\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$' THEN
          RAISE EXCEPTION 'password reset credential invalid' USING ERRCODE = '22023';
        END IF;

        PERFORM app_private.lock_auth_refresh_user(p_user_id);
        SELECT * INTO application_user
        FROM public.users WHERE id = p_user_id FOR UPDATE;
        IF NOT FOUND OR application_user.status <> 'active' THEN
          RETURN NEXT;
          RETURN;
        END IF;
        SELECT * INTO challenge
        FROM public.auth_email_challenges
        WHERE id = p_challenge_id
          AND user_id = p_user_id
          AND purpose = 'password_reset'
        FOR UPDATE;
        IF NOT FOUND OR challenge.stage <> 'consumed' THEN
          RETURN NEXT;
          RETURN;
        END IF;

        UPDATE public.users SET
          password_hash = p_password_hash,
          password_changed_at = database_now,
          updated_at = database_now
        WHERE id = p_user_id;
        UPDATE public.auth_email_challenges SET
          stage = 'invalidated', secret_hash = NULL, updated_at = database_now
        WHERE id = p_challenge_id AND stage = 'consumed';
        IF NOT FOUND THEN
          RETURN NEXT;
          RETURN;
        END IF;
        UPDATE public.auth_sessions SET
          status = 'revoked', revoked_at = database_now,
          revoke_reason = 'password_reset', updated_at = database_now
        WHERE user_id = p_user_id AND status = 'active';
        GET DIAGNOSTICS revoked_session_count = ROW_COUNT;
        UPDATE public.auth_refresh_tokens AS refresh_token SET
          status = 'revoked', revoked_at = database_now, updated_at = database_now
        FROM public.auth_sessions AS session
        WHERE refresh_token.session_id = session.id
          AND session.user_id = p_user_id
          AND refresh_token.status = 'active';
        GET DIAGNOSTICS revoked_refresh_token_count = ROW_COUNT;
        completed := true;
        RETURN NEXT;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.complete_password_reset(uuid, uuid, text) FROM PUBLIC, "${runtime}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.complete_password_reset(uuid, uuid, text) TO "${runtime}"`,
    );
    await this.assertLeastPrivilege(queryRunner, runtime);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    const rows = (await queryRunner.query(
      `SELECT EXISTS(SELECT 1 FROM public.auth_audit_logs WHERE event_type = $1) AS populated`,
      [PASSWORD_RESET_EVENT],
    )) as Array<{ populated: boolean }>;
    if (rows[0]?.populated !== false)
      throw new Error(
        'Password reset migration rollback requires no completed password resets.',
      );
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.complete_password_reset(uuid, uuid, text) FROM "${runtime}"`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.complete_password_reset(uuid, uuid, text)`,
    );
    await this.auditConstraint(queryRunner, PREVIOUS_EVENTS);
  }

  private async auditConstraint(
    queryRunner: QueryRunner,
    events: readonly string[],
  ): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.auth_audit_logs DROP CONSTRAINT "CHK_auth_audit_logs_event_type"',
    );
    await queryRunner.query(`ALTER TABLE public.auth_audit_logs
      ADD CONSTRAINT "CHK_auth_audit_logs_event_type"
      CHECK (event_type IN (${events.map((event) => `'${event}'`).join(',')}))`);
  }

  private async runtimeRole(queryRunner: QueryRunner): Promise<string> {
    const role = process.env.DATABASE_RUNTIME_ROLE;
    if (!role || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role))
      throw new Error('Invalid runtime role.');
    const rows = (await queryRunner.query(
      `SELECT current_user <> rolname AND NOT rolsuper AND NOT rolbypassrls
        AND rolcanlogin AND NOT pg_has_role($1, current_user, 'MEMBER')
        AND NOT has_table_privilege($1, 'public.users', 'INSERT,UPDATE,DELETE,TRUNCATE')
        AND NOT has_any_column_privilege($1, 'public.users', 'INSERT,UPDATE') AS safe
       FROM pg_roles WHERE rolname = $1`,
      [role],
    )) as Array<{ safe: boolean }>;
    if (rows[0]?.safe !== true)
      throw new Error('Runtime role violates password reset boundary.');
    return role;
  }

  private async assertLeastPrivilege(
    queryRunner: QueryRunner,
    runtime: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT
        has_function_privilege($1, 'app_private.complete_password_reset(uuid,uuid,text)', 'EXECUTE') AS "canComplete",
        EXISTS (
          SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          LEFT JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl ON true
          WHERE n.nspname = 'app_private'
            AND p.oid = to_regprocedure('app_private.complete_password_reset(uuid,uuid,text)')
            AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS "publicCanExecute",
        has_table_privilege($1, 'public.users', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS "canMutateUsers",
        has_any_column_privilege($1, 'public.users', 'INSERT,UPDATE,REFERENCES') AS "canMutateUserColumn",
        has_schema_privilege($1, 'app_private', 'CREATE') AS "canCreateSchema",
        pg_has_role($1, current_user, 'MEMBER') AS "canAssumeOwner"`,
      [runtime],
    )) as Array<{
      canComplete: boolean;
      publicCanExecute: boolean;
      canMutateUsers: boolean;
      canMutateUserColumn: boolean;
      canCreateSchema: boolean;
      canAssumeOwner: boolean;
    }>;
    const row = rows[0];
    if (
      row?.canComplete !== true ||
      row.publicCanExecute ||
      row.canMutateUsers ||
      row.canMutateUserColumn ||
      row.canCreateSchema ||
      row.canAssumeOwner
    )
      throw new Error(
        'Runtime password reset boundary is not least-privilege.',
      );
  }
}
