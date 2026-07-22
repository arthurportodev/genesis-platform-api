import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActivateNewInvitationUser1785174000000 implements MigrationInterface {
  name = 'ActivateNewInvitationUser1785174000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);

    await queryRunner.query(
      `ALTER TABLE public.users ADD COLUMN email_verified_at timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_membership_result`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_event`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       ADD CONSTRAINT CHK_organization_audit_logs_event CHECK (event_type IN (
         'organization.invitation.created',
         'organization.invitation.replaced',
         'organization.invitation.revoked',
         'organization.invitation.revoked_issuer_membership_inactive',
         'organization.invitation.revoked_issuer_user_inactive',
         'organization.invitation.accepted',
         'organization.invitation.activated'
       ))`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       ADD CONSTRAINT CHK_organization_audit_logs_membership_result CHECK (
         (event_type = 'organization.invitation.accepted'
           AND membership_result IN (
             'membership_created', 'membership_preserved',
             'membership_reactivated'
           ))
         OR
         (event_type = 'organization.invitation.activated'
           AND membership_result = 'membership_created')
         OR
         (event_type NOT IN (
            'organization.invitation.accepted',
            'organization.invitation.activated'
          ) AND membership_result IS NULL)
       )`,
    );

    await queryRunner.query(`
      CREATE FUNCTION app_private.activate_new_user_invitation(
        p_invitation_id uuid,
        p_name text,
        p_password_hash text,
        p_correlation_id uuid,
        p_ip_address inet,
        p_user_agent text
      ) RETURNS TABLE (
        organization_id uuid,
        user_id uuid,
        membership_id uuid
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      CALLED ON NULL INPUT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      DECLARE
        invitation_row public.organization_invitations%ROWTYPE;
        pre_organization_id uuid;
        organization_status public.organization_status_enum;
        created_user_id uuid := pg_catalog.gen_random_uuid();
        created_membership_id uuid := pg_catalog.gen_random_uuid();
        database_now timestamptz := pg_catalog.transaction_timestamp();
      BEGIN
        IF p_invitation_id IS NULL OR p_name IS NULL
           OR p_password_hash IS NULL OR p_correlation_id IS NULL THEN
          RAISE EXCEPTION 'activation arguments unavailable' USING ERRCODE = '22004';
        END IF;
        IF p_user_agent IS NOT NULL AND pg_catalog.char_length(p_user_agent) > 512 THEN
          RAISE EXCEPTION 'activation request context invalid' USING ERRCODE = '22001';
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
          RAISE EXCEPTION 'activation name invalid' USING ERRCODE = '22023';
        END IF;
        IF pg_catalog.octet_length(p_password_hash) > 255
           OR p_password_hash !~ '^\\$argon2id\\$v=19\\$m=65536,(t=3,p=1|p=1,t=3)\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$' THEN
          RAISE EXCEPTION 'activation credential invalid' USING ERRCODE = '22023';
        END IF;

        SELECT invitation.organization_id INTO pre_organization_id
        FROM public.organization_invitations AS invitation
        WHERE invitation.id = p_invitation_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P1001';
        END IF;

        PERFORM app_private.lock_invitation_context(
          ARRAY[pre_organization_id]::uuid[],
          ARRAY[]::uuid[],
          ARRAY[]::uuid[]
        );

        SELECT invitation.* INTO invitation_row
        FROM public.organization_invitations AS invitation
        WHERE invitation.id = p_invitation_id
        FOR UPDATE OF invitation;
        IF NOT FOUND
           OR invitation_row.organization_id <> pre_organization_id
           OR invitation_row.status <> 'pending'
           OR invitation_row.expires_at <= database_now
           OR invitation_row.role::text NOT IN ('admin', 'member') THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P1001';
        END IF;

        SELECT organization.status INTO organization_status
        FROM public.organizations AS organization
        WHERE organization.id = invitation_row.organization_id;
        IF NOT FOUND OR organization_status <> 'active' THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P1001';
        END IF;

        PERFORM application_user.id
        FROM public.users AS application_user
        WHERE application_user.email = invitation_row.email_normalized;
        IF FOUND THEN
          RAISE EXCEPTION 'user email already exists'
            USING ERRCODE = '23505', CONSTRAINT = 'UQ_users_email';
        END IF;

        INSERT INTO public.users (
          id, email, name, status, password_hash, password_changed_at,
          email_verified_at, created_at, updated_at
        ) VALUES (
          created_user_id, invitation_row.email_normalized, p_name, 'active',
          p_password_hash, database_now, database_now, database_now, database_now
        );

        INSERT INTO public.memberships (
          id, user_id, organization_id, role, status, created_at, updated_at
        ) VALUES (
          created_membership_id,
          created_user_id,
          invitation_row.organization_id,
          invitation_row.role::text::public.membership_role_enum,
          'active',
          database_now,
          database_now
        );

        UPDATE public.organization_invitations AS invitation
        SET status = 'accepted',
            accepted_by_user_id = created_user_id,
            resulting_membership_id = created_membership_id,
            accepted_at = database_now,
            updated_at = database_now
        WHERE invitation.id = invitation_row.id
          AND invitation.status = 'pending';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P1001';
        END IF;

        UPDATE public.invitation_delivery_outbox AS outbox
        SET status = 'cancelled',
            cancelled_at = database_now,
            last_error_code = NULL,
            locked_by = NULL,
            locked_at = NULL,
            lease_until = NULL,
            next_attempt_at = NULL,
            updated_at = database_now
        WHERE outbox.invitation_id = invitation_row.id
          AND outbox.organization_id = invitation_row.organization_id
          AND outbox.status IN ('queued', 'processing', 'dead');

        INSERT INTO public.organization_audit_logs (
          organization_id, event_type, invitation_id, related_invitation_id,
          actor_user_id, actor_membership_id, invited_role, reason,
          membership_result, correlation_id, ip_address, user_agent, occurred_at
        ) VALUES (
          invitation_row.organization_id,
          'organization.invitation.activated',
          invitation_row.id,
          NULL,
          created_user_id,
          created_membership_id,
          invitation_row.role::text,
          NULL,
          'membership_created',
          p_correlation_id,
          p_ip_address,
          p_user_agent,
          database_now
        );

        RETURN QUERY SELECT
          invitation_row.organization_id,
          created_user_id,
          created_membership_id;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.activate_new_user_invitation(uuid, text, text, uuid, inet, text)
       FROM PUBLIC`,
    );
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.activate_new_user_invitation(uuid, text, text, uuid, inet, text)
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT USAGE ON SCHEMA app_private TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.activate_new_user_invitation(uuid, text, text, uuid, inet, text)
       TO "${runtimeRole}"`,
    );
    await this.assertLeastPrivilege(queryRunner, runtimeRole);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    const rows = (await queryRunner.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM public.organization_audit_logs
           WHERE event_type = 'organization.invitation.activated'
         ) AS "hasActivationAudit",
         EXISTS (
           SELECT 1 FROM public.users WHERE email_verified_at IS NOT NULL
         ) AS "hasVerifiedEmail"`,
    )) as Array<{ hasActivationAudit: boolean; hasVerifiedEmail: boolean }>;
    if (
      rows[0]?.hasActivationAudit === true ||
      rows[0]?.hasVerifiedEmail === true
    ) {
      throw new Error(
        'Cannot revert invitation activation migration while activation data exists.',
      );
    }

    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.activate_new_user_invitation(uuid, text, text, uuid, inet, text)
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.activate_new_user_invitation(uuid, text, text, uuid, inet, text)`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_membership_result`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_event`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       ADD CONSTRAINT CHK_organization_audit_logs_event CHECK (event_type IN (
         'organization.invitation.created',
         'organization.invitation.replaced',
         'organization.invitation.revoked',
         'organization.invitation.revoked_issuer_membership_inactive',
         'organization.invitation.revoked_issuer_user_inactive',
         'organization.invitation.accepted'
       ))`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       ADD CONSTRAINT CHK_organization_audit_logs_membership_result CHECK (
         (event_type = 'organization.invitation.accepted'
           AND membership_result IN (
             'membership_created', 'membership_preserved',
             'membership_reactivated'
           ))
         OR
         (event_type <> 'organization.invitation.accepted'
           AND membership_result IS NULL)
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE public.users DROP COLUMN email_verified_at`,
    );
  }

  private async validatedRuntimeRole(
    queryRunner: QueryRunner,
  ): Promise<string> {
    const role = process.env.DATABASE_RUNTIME_ROLE;
    if (role === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role)) {
      throw new Error(
        'DATABASE_RUNTIME_ROLE must name a safe PostgreSQL role.',
      );
    }
    const rows = (await queryRunner.query(
      `SELECT current_user AS "currentUser", rolname AS "roleName",
              rolsuper AS "isSuperuser", rolbypassrls AS "bypassRls",
              rolcanlogin AS "canLogin",
              pg_has_role($1, current_user, 'MEMBER') AS "canAssumeOwner"
       FROM pg_roles WHERE rolname = $1`,
      [role],
    )) as Array<{
      currentUser: string;
      roleName: string;
      isSuperuser: boolean;
      bypassRls: boolean;
      canLogin: boolean;
      canAssumeOwner: boolean;
    }>;
    const row = rows[0];
    if (
      row?.roleName !== role ||
      row.currentUser === role ||
      row.isSuperuser ||
      row.bypassRls ||
      !row.canLogin ||
      row.canAssumeOwner
    ) {
      throw new Error('DATABASE_RUNTIME_ROLE violates the migration boundary.');
    }
    return role;
  }

  private async assertLeastPrivilege(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `WITH activation AS (
         SELECT procedure_acl.grantee, procedure_acl.privilege_type
         FROM pg_proc AS p
         JOIN pg_namespace AS namespace ON namespace.oid = p.pronamespace
         LEFT JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(p.proacl, acldefault('f', p.proowner))
         ) AS procedure_acl ON true
         WHERE namespace.nspname = 'app_private'
           AND p.oid = to_regprocedure(
             'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)'
           )
       ), executable_functions AS (
         SELECT p.oid::regprocedure::text AS signature
         FROM pg_proc AS p
         JOIN pg_namespace AS namespace ON namespace.oid = p.pronamespace
         WHERE namespace.nspname = 'app_private'
           AND has_function_privilege($1, p.oid, 'EXECUTE')
       )
       SELECT
         has_function_privilege(
           $1,
           'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
           'EXECUTE'
         ) AS "canExecute",
         has_schema_privilege($1, 'app_private', 'USAGE') AS "canUseSchema",
         has_schema_privilege($1, 'app_private', 'CREATE') AS "canCreateSchema",
         pg_has_role($1, current_user, 'MEMBER') AS "canAssumeOwner",
         EXISTS (
           SELECT 1 FROM activation
           WHERE grantee = 0 AND privilege_type = 'EXECUTE'
         ) AS "publicCanExecute",
         ARRAY(
           SELECT signature FROM executable_functions ORDER BY signature
         ) AS "executableFunctions",
         has_table_privilege($1, 'users', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
           AS "canMutateUsers",
         has_table_privilege($1, 'memberships', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
           AS "canMutateMemberships",
         has_any_column_privilege($1, 'users', 'INSERT,UPDATE,REFERENCES')
           AS "canMutateUserColumn",
         has_any_column_privilege($1, 'memberships', 'INSERT,UPDATE,REFERENCES')
           AS "canMutateMembershipColumn"
       `,
      [runtimeRole],
    )) as Array<{
      canExecute: boolean;
      canUseSchema: boolean;
      canCreateSchema: boolean;
      canAssumeOwner: boolean;
      publicCanExecute: boolean;
      executableFunctions: string[];
      canMutateUsers: boolean;
      canMutateMemberships: boolean;
      canMutateUserColumn: boolean;
      canMutateMembershipColumn: boolean;
    }>;
    const row = rows[0];
    if (
      row?.canExecute !== true ||
      row.canUseSchema !== true ||
      row.canCreateSchema ||
      row.canAssumeOwner ||
      row.publicCanExecute ||
      row.canMutateUsers ||
      row.canMutateMemberships ||
      row.canMutateUserColumn ||
      row.canMutateMembershipColumn ||
      JSON.stringify(row.executableFunctions) !==
        JSON.stringify([
          'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
          'app_private.apply_existing_user_invitation_membership(uuid,uuid)',
          'app_private.lock_auth_refresh_user(uuid)',
          'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
        ])
    ) {
      throw new Error('Runtime activation boundary is not least-privilege.');
    }
  }
}
