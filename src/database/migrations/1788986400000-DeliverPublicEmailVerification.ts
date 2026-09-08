import { MigrationInterface, QueryRunner } from 'typeorm';

const REGISTRATION_EVENTS = [
  'auth.registration.succeeded',
  'auth.email.verified',
] as const;
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
] as const;

export class DeliverPublicEmailVerification1788986400000 implements MigrationInterface {
  name = 'DeliverPublicEmailVerification1788986400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    await this.auditConstraint(queryRunner, [
      ...PREVIOUS_EVENTS,
      ...REGISTRATION_EVENTS,
    ]);
    await queryRunner.query(`
      CREATE FUNCTION app_private.register_unverified_user(
        p_email text,
        p_name text,
        p_password_hash text
      ) RETURNS TABLE(user_id uuid)
      LANGUAGE plpgsql
      SECURITY DEFINER
      CALLED ON NULL INPUT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      DECLARE
        created_user_id uuid := pg_catalog.gen_random_uuid();
        database_now timestamptz := pg_catalog.transaction_timestamp();
      BEGIN
        IF p_email IS NULL OR p_name IS NULL OR p_password_hash IS NULL THEN
          RAISE EXCEPTION 'registration arguments unavailable' USING ERRCODE = '22004';
        END IF;
        IF p_email <> pg_catalog.lower(pg_catalog.btrim(p_email))
           OR pg_catalog.char_length(p_email) < 3
           OR pg_catalog.char_length(p_email) > 320
           OR pg_catalog.strpos(p_email, '@') < 2
           OR p_email ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'registration email invalid' USING ERRCODE = '22023';
        END IF;
        IF p_name <> pg_catalog.btrim(p_name)
           OR pg_catalog.char_length(p_name) < 1
           OR pg_catalog.char_length(p_name) > 160
           OR p_name ~ '[[:cntrl:]]'
           OR EXISTS (
             SELECT 1
             FROM pg_catalog.unnest(ARRAY[
               1564, 8206, 8207, 8232, 8233, 8234, 8235, 8236,
               8237, 8238, 8294, 8295, 8296, 8297
             ]) AS forbidden(code_point)
             WHERE pg_catalog.strpos(
               p_name,
               pg_catalog.chr(forbidden.code_point)
             ) > 0
           ) THEN
          RAISE EXCEPTION 'registration name invalid' USING ERRCODE = '22023';
        END IF;
        IF pg_catalog.octet_length(p_password_hash) > 255
           OR p_password_hash !~ '^\\$argon2id\\$v=19\\$m=65536,(t=3,p=1|p=1,t=3)\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$' THEN
          RAISE EXCEPTION 'registration credential invalid' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.users (
          id, email, name, status, password_hash, password_changed_at,
          email_verified_at, created_at, updated_at
        ) VALUES (
          created_user_id, p_email, p_name, 'active', p_password_hash,
          database_now, NULL, database_now, database_now
        );
        RETURN QUERY SELECT created_user_id;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_private.verify_user_email(
        p_user_id uuid,
        p_challenge_id uuid
      ) RETURNS boolean
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
        IF p_user_id IS NULL OR p_challenge_id IS NULL THEN
          RETURN false;
        END IF;
        PERFORM app_private.lock_auth_refresh_user(p_user_id);
        SELECT * INTO application_user
        FROM public.users
        WHERE id = p_user_id
        FOR UPDATE;
        IF NOT FOUND OR application_user.status <> 'active' THEN
          RETURN false;
        END IF;
        SELECT * INTO challenge
        FROM public.auth_email_challenges
        WHERE id = p_challenge_id
          AND user_id = p_user_id
          AND purpose = 'email_verification'
        FOR UPDATE;
        IF NOT FOUND OR challenge.stage <> 'consumed' THEN
          RETURN false;
        END IF;
        IF application_user.email_verified_at IS NULL THEN
          UPDATE public.users
          SET email_verified_at = database_now, updated_at = database_now
          WHERE id = p_user_id AND email_verified_at IS NULL;
        END IF;
        RETURN true;
      END;
      $$
    `);
    for (const signature of [
      'app_private.register_unverified_user(text, text, text)',
      'app_private.verify_user_email(uuid, uuid)',
    ]) {
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, "${runtime}"`,
      );
      await queryRunner.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO "${runtime}"`,
      );
    }
    await this.assertLeastPrivilege(queryRunner, runtime);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    const rows = (await queryRunner.query(
      `SELECT EXISTS(
         SELECT 1 FROM public.auth_audit_logs
         WHERE event_type = ANY($1::text[])
       ) AS populated`,
      [REGISTRATION_EVENTS],
    )) as Array<{ populated: boolean }>;
    if (rows[0]?.populated !== false)
      throw new Error(
        'Registration migration rollback requires empty registration audit data.',
      );
    for (const signature of [
      'app_private.verify_user_email(uuid, uuid)',
      'app_private.register_unverified_user(text, text, text)',
    ]) {
      await queryRunner.query(
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM "${runtime}"`,
      );
      await queryRunner.query(`DROP FUNCTION ${signature}`);
    }
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
      `SELECT current_user <> rolname
        AND NOT rolsuper AND NOT rolbypassrls AND rolcanlogin
        AND NOT pg_has_role($1, current_user, 'MEMBER')
        AND NOT has_table_privilege($1, 'public.users', 'INSERT,UPDATE,DELETE,TRUNCATE')
        AND NOT has_any_column_privilege($1, 'public.users', 'INSERT,UPDATE') AS safe
       FROM pg_roles WHERE rolname = $1`,
      [role],
    )) as Array<{ safe: boolean }>;
    if (rows[0]?.safe !== true)
      throw new Error('Runtime role violates registration migration boundary.');
    return role;
  }

  private async assertLeastPrivilege(
    queryRunner: QueryRunner,
    runtime: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT
         has_function_privilege($1,
           'app_private.register_unverified_user(text,text,text)', 'EXECUTE')
           AS "canRegister",
         has_function_privilege($1,
           'app_private.verify_user_email(uuid,uuid)', 'EXECUTE')
           AS "canVerify",
         has_table_privilege($1, 'public.users',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
           AS "canMutateUsers",
         has_any_column_privilege($1, 'public.users', 'INSERT,UPDATE,REFERENCES')
           AS "canMutateUserColumn",
         has_schema_privilege($1, 'app_private', 'CREATE') AS "canCreateSchema",
         pg_has_role($1, current_user, 'MEMBER') AS "canAssumeOwner"`,
      [runtime],
    )) as Array<{
      canRegister: boolean;
      canVerify: boolean;
      canMutateUsers: boolean;
      canMutateUserColumn: boolean;
      canCreateSchema: boolean;
      canAssumeOwner: boolean;
    }>;
    const row = rows[0];
    if (
      row?.canRegister !== true ||
      row.canVerify !== true ||
      row.canMutateUsers ||
      row.canMutateUserColumn ||
      row.canCreateSchema ||
      row.canAssumeOwner
    ) {
      throw new Error('Runtime registration boundary is not least-privilege.');
    }
  }
}
