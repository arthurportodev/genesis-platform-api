import { MigrationInterface, QueryRunner } from 'typeorm';

const IDENTITY_LINKED_EVENT = 'auth.identity.linked';
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
  'auth.password_reset.succeeded',
] as const;

export class DeliverGoogleIdentity1789159200000 implements MigrationInterface {
  name = 'DeliverGoogleIdentity1789159200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    await queryRunner.query(`CREATE TABLE public.auth_identities (
      id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
      user_id uuid NOT NULL,
      provider varchar(32) NOT NULL,
      provider_subject varchar(255) NOT NULL,
      provider_email varchar(320) NOT NULL,
      last_login_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "FK_auth_identities_user" FOREIGN KEY (user_id)
        REFERENCES public.users(id) ON DELETE RESTRICT,
      CONSTRAINT "UQ_auth_identities_provider_subject" UNIQUE(provider, provider_subject),
      CONSTRAINT "UQ_auth_identities_user_provider" UNIQUE(user_id, provider),
      CONSTRAINT "CHK_auth_identities_provider" CHECK(provider = 'google'),
      CONSTRAINT "CHK_auth_identities_subject" CHECK(provider_subject = btrim(provider_subject) AND length(provider_subject) > 0),
      CONSTRAINT "CHK_auth_identities_email_normalized" CHECK(provider_email = lower(btrim(provider_email)) AND char_length(provider_email) BETWEEN 3 AND 320 AND strpos(provider_email,'@') >= 2 AND provider_email !~ '[[:cntrl:]]')
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_identities_user_id" ON public.auth_identities(user_id)`,
    );
    await queryRunner.query(`CREATE TABLE public.auth_google_challenges (
      id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
      token_hash varchar(64) NOT NULL,
      nonce_hash varchar(64) NOT NULL,
      stage varchar(32) NOT NULL,
      user_id uuid NULL,
      provider_subject varchar(255) NULL,
      provider_email varchar(320) NULL,
      email_authoritative boolean NULL,
      expires_at timestamptz NOT NULL,
      failed_attempts smallint NOT NULL DEFAULT 0,
      consumed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "FK_auth_google_challenges_user" FOREIGN KEY(user_id)
        REFERENCES public.users(id) ON DELETE CASCADE,
      CONSTRAINT "UQ_auth_google_challenges_token_hash" UNIQUE(token_hash),
      CONSTRAINT "UQ_auth_google_challenges_nonce_hash" UNIQUE(nonce_hash),
      CONSTRAINT "CHK_auth_google_challenges_token_hash" CHECK(token_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT "CHK_auth_google_challenges_nonce_hash" CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT "CHK_auth_google_challenges_stage" CHECK(stage IN ('issued','profile_pending','link_pending','consumed')),
      CONSTRAINT "CHK_auth_google_challenges_attempts" CHECK(failed_attempts >= 0 AND failed_attempts <= 5),
      CONSTRAINT "CHK_auth_google_challenges_email" CHECK(provider_email IS NULL OR (provider_email = lower(btrim(provider_email)) AND char_length(provider_email) BETWEEN 3 AND 320 AND strpos(provider_email,'@') >= 2 AND provider_email !~ '[[:cntrl:]]')),
      CONSTRAINT "CHK_auth_google_challenges_continuation" CHECK(
        (stage = 'issued' AND provider_subject IS NULL AND provider_email IS NULL AND user_id IS NULL AND consumed_at IS NULL)
        OR (stage = 'profile_pending' AND provider_subject IS NOT NULL AND provider_email IS NOT NULL AND user_id IS NULL AND email_authoritative IS NOT NULL AND consumed_at IS NULL)
        OR (stage = 'link_pending' AND provider_subject IS NOT NULL AND provider_email IS NOT NULL AND user_id IS NOT NULL AND consumed_at IS NULL)
        OR (stage = 'consumed' AND consumed_at IS NOT NULL)
      )
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_google_challenges_expires_at" ON public.auth_google_challenges(expires_at)`,
    );

    await queryRunner.query(`CREATE FUNCTION app_private.create_google_user_identity(
      p_email text, p_name text, p_email_verified boolean, p_provider_subject text
    ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
    SET search_path = pg_catalog, app_private, pg_temp AS $$
    DECLARE created_user_id uuid := pg_catalog.gen_random_uuid(); database_now timestamptz := pg_catalog.transaction_timestamp();
    BEGIN
      IF p_email IS NULL OR p_name IS NULL OR p_email_verified IS NULL OR p_provider_subject IS NULL THEN
        RAISE EXCEPTION 'google identity arguments unavailable' USING ERRCODE='22004';
      END IF;
      IF p_email <> lower(btrim(p_email)) OR char_length(p_email) < 3 OR char_length(p_email) > 320 OR strpos(p_email,'@') < 2 OR p_email ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'google email invalid' USING ERRCODE='22023';
      END IF;
      IF p_name <> btrim(p_name) OR char_length(p_name) < 1 OR char_length(p_name) > 160 OR p_name ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'google name invalid' USING ERRCODE='22023';
      END IF;
      IF p_provider_subject <> btrim(p_provider_subject) OR char_length(p_provider_subject) < 1 OR char_length(p_provider_subject) > 255 THEN
        RAISE EXCEPTION 'google subject invalid' USING ERRCODE='22023';
      END IF;
      INSERT INTO public.users(id,email,name,status,password_hash,password_changed_at,email_verified_at,created_at,updated_at)
      VALUES(created_user_id,p_email,p_name,'active',NULL,NULL,CASE WHEN p_email_verified THEN database_now ELSE NULL END,database_now,database_now);
      INSERT INTO public.auth_identities(user_id,provider,provider_subject,provider_email,last_login_at,created_at,updated_at)
      VALUES(created_user_id,'google',p_provider_subject,p_email,database_now,database_now,database_now);
      RETURN created_user_id;
    END; $$`);

    await queryRunner.query(`CREATE FUNCTION app_private.link_google_identity(
      p_user_id uuid, p_provider_subject text, p_provider_email text
    ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
    SET search_path = pg_catalog, app_private, pg_temp AS $$
    DECLARE application_user public.users%ROWTYPE; database_now timestamptz := pg_catalog.transaction_timestamp();
    BEGIN
      IF p_user_id IS NULL OR p_provider_subject IS NULL OR p_provider_email IS NULL THEN RETURN false; END IF;
      PERFORM app_private.lock_auth_refresh_user(p_user_id);
      SELECT * INTO application_user FROM public.users WHERE id=p_user_id FOR UPDATE;
      IF NOT FOUND OR application_user.status <> 'active' OR application_user.email_verified_at IS NULL OR application_user.email <> p_provider_email THEN RETURN false; END IF;
      INSERT INTO public.auth_identities(user_id,provider,provider_subject,provider_email,last_login_at,created_at,updated_at)
      VALUES(p_user_id,'google',p_provider_subject,p_provider_email,database_now,database_now,database_now);
      RETURN true;
    EXCEPTION WHEN unique_violation THEN RETURN false;
    END; $$`);

    await queryRunner.query(`CREATE FUNCTION app_private.touch_google_identity(
      p_identity_id uuid, p_provider_email text
    ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
    SET search_path = pg_catalog, app_private, pg_temp AS $$
    BEGIN
      IF p_identity_id IS NULL OR p_provider_email IS NULL OR p_provider_email <> lower(btrim(p_provider_email)) OR char_length(p_provider_email) < 3 OR char_length(p_provider_email) > 320 OR strpos(p_provider_email,'@') < 2 OR p_provider_email ~ '[[:cntrl:]]' THEN RETURN false; END IF;
      UPDATE public.auth_identities SET provider_email=p_provider_email,last_login_at=transaction_timestamp(),updated_at=transaction_timestamp()
      WHERE id=p_identity_id AND provider='google';
      RETURN FOUND;
    END; $$`);

    await this.auditConstraint(queryRunner, [
      ...PREVIOUS_EVENTS,
      IDENTITY_LINKED_EVENT,
    ]);
    await queryRunner.query(
      `REVOKE ALL ON public.auth_identities, public.auth_google_challenges FROM PUBLIC, "${runtime}"`,
    );
    await queryRunner.query(
      `GRANT SELECT ON public.auth_identities TO "${runtime}"`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_google_challenges TO "${runtime}"`,
    );
    for (const signature of [
      'app_private.create_google_user_identity(text,text,boolean,text)',
      'app_private.link_google_identity(uuid,text,text)',
      'app_private.touch_google_identity(uuid,text)',
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
      `SELECT
      EXISTS(SELECT 1 FROM public.auth_identities) OR
      EXISTS(SELECT 1 FROM public.auth_google_challenges) OR
      EXISTS(SELECT 1 FROM public.auth_audit_logs WHERE event_type=$1) AS populated`,
      [IDENTITY_LINKED_EVENT],
    )) as Array<{ populated: boolean }>;
    if (rows[0]?.populated !== false)
      throw new Error(
        'Google identity rollback requires empty Google auth data.',
      );
    for (const signature of [
      'app_private.touch_google_identity(uuid,text)',
      'app_private.link_google_identity(uuid,text,text)',
      'app_private.create_google_user_identity(text,text,boolean,text)',
    ]) {
      await queryRunner.query(
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM "${runtime}"`,
      );
      await queryRunner.query(`DROP FUNCTION ${signature}`);
    }
    await queryRunner.query('DROP TABLE public.auth_google_challenges');
    await queryRunner.query('DROP TABLE public.auth_identities');
    await this.auditConstraint(queryRunner, PREVIOUS_EVENTS);
  }

  private async auditConstraint(
    queryRunner: QueryRunner,
    events: readonly string[],
  ): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.auth_audit_logs DROP CONSTRAINT "CHK_auth_audit_logs_event_type"',
    );
    await queryRunner.query(
      `ALTER TABLE public.auth_audit_logs ADD CONSTRAINT "CHK_auth_audit_logs_event_type" CHECK(event_type IN (${events.map((event) => `'${event}'`).join(',')}))`,
    );
  }

  private async runtimeRole(queryRunner: QueryRunner): Promise<string> {
    const role = process.env.DATABASE_RUNTIME_ROLE;
    if (!role || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role))
      throw new Error('Invalid runtime role.');
    const rows = (await queryRunner.query(
      `SELECT current_user <> rolname AND NOT rolsuper AND NOT rolbypassrls AND rolcanlogin
      AND NOT pg_has_role($1,current_user,'MEMBER')
      AND NOT has_table_privilege($1,'public.users','INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege($1,'public.users','INSERT,UPDATE') AS safe
      FROM pg_roles WHERE rolname=$1`,
      [role],
    )) as Array<{ safe: boolean }>;
    if (rows[0]?.safe !== true)
      throw new Error('Runtime role violates Google identity boundary.');
    return role;
  }

  private async assertLeastPrivilege(
    queryRunner: QueryRunner,
    runtime: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT
      has_function_privilege($1,'app_private.create_google_user_identity(text,text,boolean,text)','EXECUTE') AS "canCreate",
      has_function_privilege($1,'app_private.link_google_identity(uuid,text,text)','EXECUTE') AS "canLink",
      has_function_privilege($1,'app_private.touch_google_identity(uuid,text)','EXECUTE') AS "canTouch",
      has_table_privilege($1,'public.auth_identities','INSERT,UPDATE,DELETE,TRUNCATE') AS "canMutateIdentity",
      has_table_privilege($1,'public.users','INSERT,UPDATE,DELETE,TRUNCATE') AS "canMutateUsers"`,
      [runtime],
    )) as Array<{
      canCreate: boolean;
      canLink: boolean;
      canTouch: boolean;
      canMutateIdentity: boolean;
      canMutateUsers: boolean;
    }>;
    const row = rows[0];
    if (
      row?.canCreate !== true ||
      row.canLink !== true ||
      row.canTouch !== true ||
      row.canMutateIdentity ||
      row.canMutateUsers
    ) {
      throw new Error(
        'Runtime Google identity boundary is not least-privilege.',
      );
    }
  }
}
