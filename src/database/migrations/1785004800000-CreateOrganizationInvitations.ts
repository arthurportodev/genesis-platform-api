import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrganizationInvitations1785004800000 implements MigrationInterface {
  name = 'CreateOrganizationInvitations1785004800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await queryRunner.query(
      "CREATE TYPE organization_invitation_role_enum AS ENUM ('admin', 'member')",
    );
    await queryRunner.query(
      "CREATE TYPE organization_invitation_status_enum AS ENUM ('pending', 'accepted', 'revoked')",
    );
    await queryRunner.query(
      "CREATE TYPE organization_invitation_revocation_reason_enum AS ENUM ('manual', 'replaced', 'expired_reissued', 'issuer_membership_inactive', 'issuer_user_inactive')",
    );
    await queryRunner.query(
      `ALTER TABLE memberships ADD CONSTRAINT UQ_memberships_id_organization
       UNIQUE (id, organization_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE organization_invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        email_normalized varchar(320) NOT NULL,
        role organization_invitation_role_enum NOT NULL,
        status organization_invitation_status_enum NOT NULL DEFAULT 'pending',
        expires_at timestamptz NOT NULL,
        invited_by_membership_id uuid NOT NULL,
        accepted_by_user_id uuid,
        resulting_membership_id uuid,
        accepted_at timestamptz,
        revoked_by_membership_id uuid,
        revoked_at timestamptz,
        revocation_reason organization_invitation_revocation_reason_enum,
        superseded_by_invitation_id uuid,
        token_key_version smallint NOT NULL,
        token_version smallint NOT NULL DEFAULT 1,
        token_nonce varchar(43) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT UQ_organization_invitations_id_organization
          UNIQUE (id, organization_id),
        CONSTRAINT FK_organization_invitations_organization
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_invitations_issuer_membership_org
          FOREIGN KEY (invited_by_membership_id, organization_id)
          REFERENCES memberships(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_invitations_accepted_user
          FOREIGN KEY (accepted_by_user_id) REFERENCES users(id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_invitations_resulting_membership_org
          FOREIGN KEY (resulting_membership_id, organization_id)
          REFERENCES memberships(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_invitations_revoker_membership_org
          FOREIGN KEY (revoked_by_membership_id, organization_id)
          REFERENCES memberships(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_invitations_superseded_by
          FOREIGN KEY (superseded_by_invitation_id, organization_id)
          REFERENCES organization_invitations(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE
          DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT CHK_organization_invitations_email_normalized
          CHECK (email_normalized = lower(btrim(email_normalized))),
        CONSTRAINT CHK_organization_invitations_nonce
          CHECK (token_nonce ~ '^[A-Za-z0-9_-]{43}$'),
        CONSTRAINT CHK_organization_invitations_token_versions
          CHECK (token_key_version > 0 AND token_version = 1),
        CONSTRAINT CHK_organization_invitations_expiration
          CHECK (expires_at > created_at),
        CONSTRAINT CHK_organization_invitations_state
          CHECK (
            (status = 'pending' AND accepted_by_user_id IS NULL
              AND resulting_membership_id IS NULL AND accepted_at IS NULL
              AND revoked_by_membership_id IS NULL AND revoked_at IS NULL
              AND revocation_reason IS NULL AND superseded_by_invitation_id IS NULL)
            OR
            (status = 'accepted' AND accepted_by_user_id IS NOT NULL
              AND resulting_membership_id IS NOT NULL AND accepted_at IS NOT NULL
              AND revoked_by_membership_id IS NULL AND revoked_at IS NULL
              AND revocation_reason IS NULL AND superseded_by_invitation_id IS NULL)
            OR
            (status = 'revoked' AND accepted_by_user_id IS NULL
              AND resulting_membership_id IS NULL AND accepted_at IS NULL
              AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
              AND ((revocation_reason IN ('replaced', 'expired_reissued')
                    AND superseded_by_invitation_id IS NOT NULL)
                   OR (revocation_reason NOT IN ('replaced', 'expired_reissued')
                       AND superseded_by_invitation_id IS NULL)))
          )
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX UQ_organization_invitations_live_email
       ON organization_invitations (organization_id, email_normalized)
       WHERE status = 'pending'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX UQ_organization_invitations_token_nonce
       ON organization_invitations (token_key_version, token_nonce)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX UQ_organization_invitations_superseded_by
       ON organization_invitations (superseded_by_invitation_id)
       WHERE superseded_by_invitation_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_organization_invitations_org_status_created
       ON organization_invitations (organization_id, status, created_at DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_organization_invitations_org_email_created
       ON organization_invitations (organization_id, email_normalized, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_organization_invitations_issuer_created
       ON organization_invitations (invited_by_membership_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_organization_invitations_status_expires
       ON organization_invitations (status, expires_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE organization_audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        event_type varchar(96) NOT NULL,
        invitation_id uuid,
        related_invitation_id uuid,
        actor_user_id uuid,
        actor_membership_id uuid,
        invited_role varchar(16),
        reason varchar(64),
        correlation_id uuid,
        ip_address inet,
        user_agent varchar(512),
        occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT FK_organization_audit_logs_organization
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_audit_logs_invitation_org
          FOREIGN KEY (invitation_id, organization_id)
          REFERENCES organization_invitations(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_audit_logs_related_invitation_org
          FOREIGN KEY (related_invitation_id, organization_id)
          REFERENCES organization_invitations(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE
          DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT CHK_organization_audit_logs_event
          CHECK (event_type IN (
            'organization.invitation.created',
            'organization.invitation.replaced',
            'organization.invitation.revoked',
            'organization.invitation.revoked_issuer_membership_inactive',
            'organization.invitation.revoked_issuer_user_inactive'
          )),
        CONSTRAINT CHK_organization_audit_logs_role
          CHECK (invited_role IS NULL OR invited_role IN ('admin', 'member')),
        CONSTRAINT CHK_organization_audit_logs_reason
          CHECK (reason IS NULL OR reason IN (
            'manual', 'replaced', 'expired_reissued',
            'issuer_membership_inactive', 'issuer_user_inactive'
          ))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IDX_organization_audit_logs_org_occurred
       ON organization_audit_logs (organization_id, occurred_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_organization_audit_logs_invitation
       ON organization_audit_logs (invitation_id)`,
    );
    await queryRunner.query(`
      CREATE FUNCTION reject_organization_audit_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'organization_audit_logs is append-only';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER TRG_organization_audit_logs_append_only
      BEFORE UPDATE OR DELETE ON organization_audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_organization_audit_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER TRG_organization_audit_logs_append_only_statement
      BEFORE UPDATE OR DELETE ON organization_audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION reject_organization_audit_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER TRG_organization_audit_logs_reject_truncate
      BEFORE TRUNCATE ON organization_audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION reject_organization_audit_mutation()
    `);
    await queryRunner.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON organization_audit_logs FROM PUBLIC`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `CREATE POLICY organization_audit_logs_select ON organization_audit_logs
       FOR SELECT TO PUBLIC USING (true)`,
    );
    await queryRunner.query(
      `CREATE POLICY organization_audit_logs_insert ON organization_audit_logs
       FOR INSERT TO PUBLIC WITH CHECK (true)`,
    );

    await queryRunner.query(`
      CREATE TABLE invitation_delivery_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        invitation_id uuid NOT NULL,
        event_type varchar(64) NOT NULL,
        token_version smallint NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'queued',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        locked_by varchar(128),
        locked_at timestamptz,
        lease_until timestamptz,
        provider_message_id varchar(255),
        last_error_code varchar(64),
        sent_at timestamptz,
        cancelled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT FK_invitation_delivery_outbox_organization
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_invitation_delivery_outbox_invitation_org
          FOREIGN KEY (invitation_id, organization_id)
          REFERENCES organization_invitations(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT UQ_invitation_delivery_outbox_event
          UNIQUE (invitation_id, token_version, event_type),
        CONSTRAINT CHK_invitation_delivery_outbox_event
          CHECK (event_type = 'delivery.requested'),
        CONSTRAINT CHK_invitation_delivery_outbox_status
          CHECK (status IN ('queued', 'processing', 'sent', 'dead', 'cancelled')),
        CONSTRAINT CHK_invitation_delivery_outbox_attempts
          CHECK (attempts >= 0),
        CONSTRAINT CHK_invitation_delivery_outbox_state
          CHECK (
            (status = 'queued' AND sent_at IS NULL AND cancelled_at IS NULL)
            OR (status = 'processing' AND sent_at IS NULL AND cancelled_at IS NULL
                AND locked_by IS NOT NULL AND locked_at IS NOT NULL
                AND lease_until IS NOT NULL)
            OR (status = 'sent' AND sent_at IS NOT NULL AND cancelled_at IS NULL)
            OR (status = 'dead' AND sent_at IS NULL AND cancelled_at IS NULL)
            OR (status = 'cancelled' AND sent_at IS NULL AND cancelled_at IS NOT NULL)
          )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IDX_invitation_delivery_outbox_dispatch
       ON invitation_delivery_outbox (status, next_attempt_at, created_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE organization_command_idempotency (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        actor_membership_id uuid NOT NULL,
        operation varchar(32) NOT NULL,
        idempotency_key uuid NOT NULL,
        fingerprint varchar(64) NOT NULL,
        result_previous_invitation_id uuid NOT NULL,
        result_invitation_id uuid NOT NULL,
        result_state_at_creation varchar(16) NOT NULL,
        result_delivery_status_at_creation varchar(16) NOT NULL,
        response_email_normalized varchar(320) NOT NULL,
        response_invited_role varchar(16) NOT NULL,
        response_invitation_created_at timestamptz NOT NULL,
        response_invitation_updated_at timestamptz NOT NULL,
        response_invitation_expires_at timestamptz NOT NULL,
        response_invited_by_membership_id uuid NOT NULL,
        response_status smallint NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT FK_organization_command_idempotency_organization
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_command_idempotency_actor_org
          FOREIGN KEY (actor_membership_id, organization_id)
          REFERENCES memberships(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_command_idempotency_previous_org
          FOREIGN KEY (result_previous_invitation_id, organization_id)
          REFERENCES organization_invitations(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_command_idempotency_result_org
          FOREIGN KEY (result_invitation_id, organization_id)
          REFERENCES organization_invitations(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_command_idempotency_result_issuer_org
          FOREIGN KEY (response_invited_by_membership_id, organization_id)
          REFERENCES memberships(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT UQ_organization_command_idempotency_scope
          UNIQUE (organization_id, actor_membership_id, operation, idempotency_key),
        CONSTRAINT CHK_organization_command_idempotency_operation
          CHECK (operation = 'replace'),
        CONSTRAINT CHK_organization_command_idempotency_fingerprint
          CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
        CONSTRAINT CHK_organization_command_idempotency_snapshot
          CHECK (response_invited_role IN ('admin', 'member')
            AND result_state_at_creation = 'pending'
            AND result_delivery_status_at_creation = 'queued'
            AND response_status = 201
            AND expires_at > created_at)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IDX_organization_command_idempotency_cleanup
       ON organization_command_idempotency (created_at)`,
    );

    await queryRunner.query(`
      CREATE FUNCTION revoke_invitations_for_inactive_membership()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status <> 'inactive' AND NEW.status = 'inactive' THEN
          WITH revoked AS (
            UPDATE organization_invitations
            SET status = 'revoked',
                revoked_at = date_trunc('milliseconds', transaction_timestamp()),
                revocation_reason = 'issuer_membership_inactive',
                updated_at = transaction_timestamp()
            WHERE status = 'pending' AND invited_by_membership_id = NEW.id
            RETURNING id, organization_id, role
          ), cancelled AS (
            UPDATE invitation_delivery_outbox o
            SET status = 'cancelled', cancelled_at = transaction_timestamp(),
                locked_by = NULL, locked_at = NULL, lease_until = NULL,
                updated_at = transaction_timestamp()
            FROM revoked r
            WHERE o.invitation_id = r.id
              AND o.organization_id = r.organization_id
              AND o.status IN ('queued', 'processing', 'dead')
          )
          INSERT INTO organization_audit_logs (
            organization_id, event_type, invitation_id, invited_role, reason
          ) SELECT organization_id,
            'organization.invitation.revoked_issuer_membership_inactive',
            id, role, 'issuer_membership_inactive' FROM revoked;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER TRG_memberships_revoke_pending_invitations
      AFTER UPDATE OF status ON memberships
      FOR EACH ROW EXECUTE FUNCTION revoke_invitations_for_inactive_membership()
    `);

    await queryRunner.query(`
      CREATE FUNCTION revoke_invitations_for_inactive_user()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status <> 'inactive' AND NEW.status = 'inactive' THEN
          WITH revoked AS (
            UPDATE organization_invitations i
            SET status = 'revoked',
                revoked_at = date_trunc('milliseconds', transaction_timestamp()),
                revocation_reason = 'issuer_user_inactive',
                updated_at = transaction_timestamp()
            FROM memberships issuer
            WHERE i.status = 'pending'
              AND issuer.id = i.invited_by_membership_id
              AND issuer.user_id = NEW.id
            RETURNING i.id, i.organization_id, i.role
          ), cancelled AS (
            UPDATE invitation_delivery_outbox o
            SET status = 'cancelled', cancelled_at = transaction_timestamp(),
                locked_by = NULL, locked_at = NULL, lease_until = NULL,
                updated_at = transaction_timestamp()
            FROM revoked r
            WHERE o.invitation_id = r.id
              AND o.organization_id = r.organization_id
              AND o.status IN ('queued', 'processing', 'dead')
          )
          INSERT INTO organization_audit_logs (
            organization_id, event_type, invitation_id, invited_role, reason
          ) SELECT organization_id,
            'organization.invitation.revoked_issuer_user_inactive',
            id, role, 'issuer_user_inactive' FROM revoked;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER TRG_users_revoke_pending_invitations
      AFTER UPDATE OF status ON users
      FOR EACH ROW EXECUTE FUNCTION revoke_invitations_for_inactive_user()
    `);
    await queryRunner.query(`CREATE SCHEMA app_private`);
    await queryRunner.query(`REVOKE ALL ON SCHEMA app_private FROM PUBLIC`);
    await queryRunner.query(`
      CREATE FUNCTION app_private.lock_invitation_context(
        p_organization_ids uuid[],
        p_user_ids uuid[],
        p_membership_ids uuid[]
      ) RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      STRICT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      BEGIN
        IF pg_catalog.array_position(p_organization_ids, NULL) IS NOT NULL
           OR pg_catalog.array_position(p_user_ids, NULL) IS NOT NULL
           OR pg_catalog.array_position(p_membership_ids, NULL) IS NOT NULL THEN
          RAISE EXCEPTION 'Invitation lock identifiers must not contain NULL.'
            USING ERRCODE = '22004';
        END IF;

        PERFORM organization.id
        FROM public.organizations AS organization
        WHERE organization.id IN (
          SELECT DISTINCT requested.id
          FROM pg_catalog.unnest(p_organization_ids) AS requested(id)
        )
        ORDER BY organization.id
        FOR UPDATE OF organization;

        PERFORM application_user.id
        FROM public.users AS application_user
        WHERE application_user.id IN (
          SELECT DISTINCT requested.id
          FROM pg_catalog.unnest(p_user_ids) AS requested(id)
        )
        ORDER BY application_user.id
        FOR UPDATE OF application_user;

        PERFORM membership.id
        FROM public.memberships AS membership
        WHERE membership.id IN (
          SELECT DISTINCT requested.id
          FROM pg_catalog.unnest(p_membership_ids) AS requested(id)
        )
        ORDER BY membership.id
        FOR UPDATE OF membership;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.lock_invitation_context(uuid[], uuid[], uuid[])
       FROM PUBLIC`,
    );
    await queryRunner.query(`
      CREATE FUNCTION app_private.lock_auth_refresh_user(p_user_id uuid)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      STRICT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      BEGIN
        PERFORM application_user.id
        FROM public.users AS application_user
        WHERE application_user.id = p_user_id
        FOR NO KEY UPDATE OF application_user;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.lock_auth_refresh_user(uuid)
       FROM PUBLIC`,
    );
    await this.grantRuntimePrivileges(queryRunner, runtimeRole);
    await this.assertRuntimeAuditPrivileges(queryRunner, runtimeRole);
    await this.assertRuntimeLockBoundaryPrivileges(queryRunner, runtimeRole);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await this.revokeRuntimePrivileges(queryRunner, runtimeRole);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS app_private.lock_auth_refresh_user(uuid)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS app_private.lock_invitation_context(uuid[], uuid[], uuid[])`,
    );
    await queryRunner.query(`DROP SCHEMA IF EXISTS app_private`);
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_users_revoke_pending_invitations ON users',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS revoke_invitations_for_inactive_user()',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_memberships_revoke_pending_invitations ON memberships',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS revoke_invitations_for_inactive_membership()',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS organization_command_idempotency',
    );
    await queryRunner.query('DROP TABLE IF EXISTS invitation_delivery_outbox');
    await queryRunner.query(
      'DROP POLICY IF EXISTS organization_audit_logs_insert ON organization_audit_logs',
    );
    await queryRunner.query(
      'DROP POLICY IF EXISTS organization_audit_logs_select ON organization_audit_logs',
    );
    await queryRunner.query(
      'ALTER TABLE organization_audit_logs NO FORCE ROW LEVEL SECURITY',
    );
    await queryRunner.query(
      'ALTER TABLE organization_audit_logs DISABLE ROW LEVEL SECURITY',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_organization_audit_logs_reject_truncate ON organization_audit_logs',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_organization_audit_logs_append_only_statement ON organization_audit_logs',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_organization_audit_logs_append_only ON organization_audit_logs',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS reject_organization_audit_mutation()',
    );
    await queryRunner.query('DROP TABLE IF EXISTS organization_audit_logs');
    await queryRunner.query('DROP TABLE IF EXISTS organization_invitations');
    await queryRunner.query(
      'ALTER TABLE memberships DROP CONSTRAINT IF EXISTS UQ_memberships_id_organization',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS organization_invitation_revocation_reason_enum',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS organization_invitation_status_enum',
    );
    await queryRunner.query(
      'DROP TYPE IF EXISTS organization_invitation_role_enum',
    );
  }

  private async validatedRuntimeRole(
    queryRunner: QueryRunner,
  ): Promise<string> {
    const role = process.env.DATABASE_RUNTIME_ROLE;
    if (role === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role)) {
      throw new Error(
        'DATABASE_RUNTIME_ROLE must name a pre-existing safe PostgreSQL role.',
      );
    }
    const rows = (await queryRunner.query(
      `SELECT current_user AS "currentUser", r.rolname AS "roleName",
              r.rolsuper AS "isSuperuser", r.rolbypassrls AS "bypassRls",
              r.rolcanlogin AS "canLogin"
       FROM (SELECT 1) singleton
       LEFT JOIN pg_roles r ON r.rolname = $1`,
      [role],
    )) as Array<{
      currentUser: string;
      roleName: string | null;
      isSuperuser: boolean | null;
      bypassRls: boolean | null;
      canLogin: boolean | null;
    }>;
    const row = rows[0];
    if (
      row?.roleName !== role ||
      row.currentUser === role ||
      row.isSuperuser !== false ||
      row.bypassRls !== false ||
      row.canLogin !== true
    ) {
      throw new Error(
        'DATABASE_RUNTIME_ROLE must be a LOGIN role distinct from the migration owner without SUPERUSER or BYPASSRLS.',
      );
    }
    return role;
  }

  private async grantRuntimePrivileges(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    const databaseGrantRows = (await queryRunner.query(
      `SELECT format(
         'GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text
       ) AS command`,
      [runtimeRole],
    )) as Array<{ command: string }>;
    const databaseGrant = databaseGrantRows[0]?.command;
    if (databaseGrant === undefined) {
      throw new Error('Could not build the runtime database grant.');
    }
    await queryRunner.query(databaseGrant);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await queryRunner.query(
      `REVOKE ALL ON SCHEMA app_private FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT USAGE ON SCHEMA app_private TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.lock_invitation_context(uuid[], uuid[], uuid[])
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.lock_invitation_context(uuid[], uuid[], uuid[])
       TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.lock_auth_refresh_user(uuid)
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.lock_auth_refresh_user(uuid)
       TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE ALL PRIVILEGES ON TABLE
         users, organizations, memberships, auth_sessions,
         auth_refresh_tokens, auth_audit_logs, organization_invitations,
         invitation_delivery_outbox, organization_command_idempotency,
         organization_audit_logs
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT ON TABLE users, organizations, memberships
       TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE ON TABLE
         auth_sessions, auth_refresh_tokens, organization_invitations,
         invitation_delivery_outbox
       TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT ON TABLE auth_audit_logs TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, DELETE ON TABLE organization_command_idempotency
       TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT ON TABLE organization_audit_logs
       TO "${runtimeRole}"`,
    );
  }

  private async revokeRuntimePrivileges(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.lock_invitation_context(uuid[], uuid[], uuid[])
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.lock_auth_refresh_user(uuid)
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE USAGE ON SCHEMA app_private FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE ALL PRIVILEGES ON TABLE
         users, organizations, memberships, auth_sessions,
         auth_refresh_tokens, auth_audit_logs, organization_invitations,
         invitation_delivery_outbox, organization_command_idempotency,
         organization_audit_logs
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE USAGE ON SCHEMA public FROM "${runtimeRole}"`,
    );
    const databaseRevokeRows = (await queryRunner.query(
      `SELECT format(
         'REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), $1::text
       ) AS command`,
      [runtimeRole],
    )) as Array<{ command: string }>;
    const databaseRevoke = databaseRevokeRows[0]?.command;
    if (databaseRevoke === undefined) {
      throw new Error('Could not build the runtime database revoke.');
    }
    await queryRunner.query(databaseRevoke);
  }

  private async assertRuntimeAuditPrivileges(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT
         has_table_privilege($1, 'organization_audit_logs', 'SELECT') AS "canSelect",
         has_table_privilege($1, 'organization_audit_logs', 'INSERT') AS "canInsert",
         has_table_privilege($1, 'organization_audit_logs', 'UPDATE') AS "canUpdate",
         has_any_column_privilege($1, 'organization_audit_logs', 'UPDATE') AS "canUpdateColumn",
         has_table_privilege($1, 'organization_audit_logs', 'DELETE') AS "canDelete",
         has_table_privilege($1, 'organization_audit_logs', 'TRUNCATE') AS "canTruncate",
         has_table_privilege($1, 'organization_audit_logs', 'REFERENCES') AS "canReference",
         has_any_column_privilege($1, 'organization_audit_logs', 'REFERENCES') AS "canReferenceColumn",
         has_table_privilege($1, 'organization_audit_logs', 'TRIGGER') AS "canTrigger",
         has_table_privilege($1, 'organization_audit_logs', 'MAINTAIN') AS "canMaintain"`,
      [runtimeRole],
    )) as Array<{
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canUpdateColumn: boolean;
      canDelete: boolean;
      canTruncate: boolean;
      canReference: boolean;
      canReferenceColumn: boolean;
      canTrigger: boolean;
      canMaintain: boolean;
    }>;
    const privileges = rows[0];
    if (
      privileges?.canSelect !== true ||
      privileges.canInsert !== true ||
      privileges.canUpdate !== false ||
      privileges.canUpdateColumn !== false ||
      privileges.canDelete !== false ||
      privileges.canTruncate !== false ||
      privileges.canReference !== false ||
      privileges.canReferenceColumn !== false ||
      privileges.canTrigger !== false ||
      privileges.canMaintain !== false
    ) {
      throw new Error(
        'DATABASE_RUNTIME_ROLE has effective privileges outside SELECT/INSERT on organization_audit_logs, including inherited grants.',
      );
    }
  }

  private async assertRuntimeLockBoundaryPrivileges(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT
         has_function_privilege(
           $1,
           'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
           'EXECUTE'
         ) AS "canExecuteInvitationLock",
         has_function_privilege(
           $1,
           'app_private.lock_auth_refresh_user(uuid)',
           'EXECUTE'
         ) AS "canExecuteAuthRefreshLock",
         has_schema_privilege($1, 'app_private', 'USAGE') AS "canUseSchema",
         has_schema_privilege($1, 'app_private', 'CREATE') AS "canCreateInSchema",
         has_table_privilege($1, 'public.organizations', 'UPDATE') AS "canUpdateOrganizations",
         has_any_column_privilege($1, 'public.organizations', 'UPDATE') AS "canUpdateOrganizationColumn",
         has_table_privilege($1, 'public.users', 'UPDATE') AS "canUpdateUsers",
         has_any_column_privilege($1, 'public.users', 'UPDATE') AS "canUpdateUserColumn",
         has_table_privilege($1, 'public.memberships', 'UPDATE') AS "canUpdateMemberships",
         has_any_column_privilege($1, 'public.memberships', 'UPDATE') AS "canUpdateMembershipColumn",
         pg_has_role($1, current_user, 'MEMBER') AS "canAssumeOwner"`,
      [runtimeRole],
    )) as Array<{
      canExecuteInvitationLock: boolean;
      canExecuteAuthRefreshLock: boolean;
      canUseSchema: boolean;
      canCreateInSchema: boolean;
      canUpdateOrganizations: boolean;
      canUpdateOrganizationColumn: boolean;
      canUpdateUsers: boolean;
      canUpdateUserColumn: boolean;
      canUpdateMemberships: boolean;
      canUpdateMembershipColumn: boolean;
      canAssumeOwner: boolean;
    }>;
    const privileges = rows[0];
    if (
      privileges?.canExecuteInvitationLock !== true ||
      privileges.canExecuteAuthRefreshLock !== true ||
      privileges.canUseSchema !== true ||
      privileges.canCreateInSchema !== false ||
      privileges.canUpdateOrganizations !== false ||
      privileges.canUpdateOrganizationColumn !== false ||
      privileges.canUpdateUsers !== false ||
      privileges.canUpdateUserColumn !== false ||
      privileges.canUpdateMemberships !== false ||
      privileges.canUpdateMembershipColumn !== false ||
      privileges.canAssumeOwner !== false
    ) {
      throw new Error(
        'DATABASE_RUNTIME_ROLE violates a least-privilege lock boundary.',
      );
    }
  }
}
