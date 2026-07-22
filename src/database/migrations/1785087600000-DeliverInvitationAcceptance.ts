import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeliverInvitationAcceptance1785087600000 implements MigrationInterface {
  name = 'DeliverInvitationAcceptance1785087600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION clear_cancelled_invitation_delivery_error()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
          NEW.last_error_code := NULL;
          NEW.next_attempt_at := NULL;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_invitation_delivery_clear_cancelled_error ON invitation_delivery_outbox',
    );
    await queryRunner.query(`
      CREATE TRIGGER TRG_invitation_delivery_clear_cancelled_error
      BEFORE UPDATE OF status ON invitation_delivery_outbox
      FOR EACH ROW EXECUTE FUNCTION clear_cancelled_invitation_delivery_error()
    `);

    await queryRunner.query(
      `ALTER TABLE memberships ADD CONSTRAINT UQ_memberships_id_user_organization
       UNIQUE (id, user_id, organization_id)`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_invitations
       DROP CONSTRAINT FK_organization_invitations_resulting_membership_org`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_invitations
       ADD CONSTRAINT FK_organization_invitations_resulting_membership_actor_org
       FOREIGN KEY (resulting_membership_id, accepted_by_user_id, organization_id)
       REFERENCES memberships(id, user_id, organization_id)
       ON DELETE RESTRICT ON UPDATE CASCADE`,
    );

    await queryRunner.query(
      `ALTER TABLE organization_audit_logs
       ADD COLUMN membership_result varchar(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_event`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs
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
      `ALTER TABLE organization_audit_logs
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

    await queryRunner.query(`
      CREATE FUNCTION app_private.apply_existing_user_invitation_membership(
        p_invitation_id uuid,
        p_authenticated_user_id uuid
      ) RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      STRICT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      DECLARE
        invitation_row public.organization_invitations%ROWTYPE;
        pre_organization_id uuid;
        pre_membership_id uuid;
        user_row public.users%ROWTYPE;
        organization_status public.organization_status_enum;
        membership_row public.memberships%ROWTYPE;
      BEGIN
        SELECT invitation.organization_id INTO pre_organization_id
        FROM public.organization_invitations AS invitation
        WHERE invitation.id = p_invitation_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P0001';
        END IF;

        SELECT membership.id INTO pre_membership_id
        FROM public.memberships AS membership
        WHERE membership.user_id = p_authenticated_user_id
          AND membership.organization_id = pre_organization_id;

        PERFORM app_private.lock_invitation_context(
          ARRAY[pre_organization_id]::uuid[],
          ARRAY[p_authenticated_user_id]::uuid[],
          CASE WHEN pre_membership_id IS NULL THEN ARRAY[]::uuid[]
               ELSE ARRAY[pre_membership_id]::uuid[] END
        );

        SELECT invitation.* INTO invitation_row
        FROM public.organization_invitations AS invitation
        WHERE invitation.id = p_invitation_id
        FOR UPDATE OF invitation;

        IF NOT FOUND OR invitation_row.organization_id <> pre_organization_id
           OR invitation_row.status <> 'pending'
           OR invitation_row.expires_at <= pg_catalog.transaction_timestamp() THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P0001';
        END IF;

        SELECT application_user.* INTO user_row
        FROM public.users AS application_user
        WHERE application_user.id = p_authenticated_user_id
        FOR UPDATE OF application_user;
        IF NOT FOUND OR user_row.status <> 'active'
           OR user_row.email <> invitation_row.email_normalized THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P0001';
        END IF;

        SELECT organization.status INTO organization_status
        FROM public.organizations AS organization
        WHERE organization.id = invitation_row.organization_id
        FOR UPDATE OF organization;
        IF NOT FOUND OR organization_status <> 'active' THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P0001';
        END IF;

        IF invitation_row.role::text NOT IN ('member', 'admin') THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P0001';
        END IF;

        SELECT membership.* INTO membership_row
        FROM public.memberships AS membership
        WHERE membership.user_id = p_authenticated_user_id
          AND membership.organization_id = invitation_row.organization_id
        FOR UPDATE OF membership;

        IF membership_row.id IS DISTINCT FROM pre_membership_id THEN
          RAISE EXCEPTION 'invitation scope changed' USING ERRCODE = 'P0001';
        END IF;

        IF NOT FOUND THEN
          INSERT INTO public.memberships (
            user_id, organization_id, role, status
          ) VALUES (
            p_authenticated_user_id,
            invitation_row.organization_id,
            invitation_row.role::text::public.membership_role_enum,
            'active'
          ) RETURNING * INTO membership_row;
        ELSIF membership_row.status = 'active' THEN
          IF membership_row.role::text <> invitation_row.role::text THEN
            RAISE EXCEPTION 'membership state conflict' USING ERRCODE = 'P0001';
          END IF;
        ELSIF membership_row.status = 'inactive' THEN
          UPDATE public.memberships AS membership
          SET role = invitation_row.role::text::public.membership_role_enum,
              status = 'active',
              updated_at = pg_catalog.transaction_timestamp()
          WHERE membership.id = membership_row.id
            AND membership.user_id = p_authenticated_user_id
            AND membership.organization_id = invitation_row.organization_id
          RETURNING membership.* INTO membership_row;
        ELSE
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P0001';
        END IF;

        IF membership_row.user_id <> p_authenticated_user_id
           OR membership_row.organization_id <> invitation_row.organization_id
           OR membership_row.role::text <> invitation_row.role::text
           OR membership_row.status <> 'active' THEN
          RAISE EXCEPTION 'invitation unavailable' USING ERRCODE = 'P0001';
        END IF;
        RETURN membership_row.id;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.apply_existing_user_invitation_membership(uuid, uuid)
       FROM PUBLIC`,
    );
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.apply_existing_user_invitation_membership(uuid, uuid)
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.apply_existing_user_invitation_membership(uuid, uuid)
       TO "${runtimeRole}"`,
    );
    await this.assertLeastPrivilege(queryRunner, runtimeRole);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_invitation_delivery_clear_cancelled_error ON invitation_delivery_outbox',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS clear_cancelled_invitation_delivery_error()',
    );
    const rows = (await queryRunner.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM organization_invitations WHERE status = 'accepted'
         ) AS "hasAcceptedInvitation",
         EXISTS (
           SELECT 1 FROM organization_audit_logs
           WHERE event_type = 'organization.invitation.accepted'
         ) AS "hasAcceptedAudit",
         EXISTS (
           SELECT 1 FROM organization_audit_logs
           WHERE membership_result IS NOT NULL
         ) AS "hasMembershipResult"`,
    )) as Array<{
      hasAcceptedInvitation: boolean;
      hasAcceptedAudit: boolean;
      hasMembershipResult: boolean;
    }>;
    if (
      rows[0]?.hasAcceptedInvitation === true ||
      rows[0]?.hasAcceptedAudit === true ||
      rows[0]?.hasMembershipResult === true
    ) {
      throw new Error(
        'Cannot revert invitation acceptance migration while accepted audit exists.',
      );
    }
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.apply_existing_user_invitation_membership(uuid, uuid)
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.apply_existing_user_invitation_membership(uuid, uuid)`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_membership_result`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_event`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs
       ADD CONSTRAINT CHK_organization_audit_logs_event CHECK (event_type IN (
         'organization.invitation.created',
         'organization.invitation.replaced',
         'organization.invitation.revoked',
         'organization.invitation.revoked_issuer_membership_inactive',
         'organization.invitation.revoked_issuer_user_inactive'
       ))`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_audit_logs DROP COLUMN membership_result`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_invitations
       DROP CONSTRAINT FK_organization_invitations_resulting_membership_actor_org`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_invitations
       ADD CONSTRAINT FK_organization_invitations_resulting_membership_org
       FOREIGN KEY (resulting_membership_id, organization_id)
       REFERENCES memberships(id, organization_id)
       ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE memberships DROP CONSTRAINT UQ_memberships_id_user_organization`,
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
              rolcanlogin AS "canLogin"
       FROM pg_roles WHERE rolname = $1`,
      [role],
    )) as Array<{
      currentUser: string;
      roleName: string;
      isSuperuser: boolean;
      bypassRls: boolean;
      canLogin: boolean;
    }>;
    const row = rows[0];
    if (
      row?.roleName !== role ||
      row.currentUser === role ||
      row.isSuperuser ||
      row.bypassRls ||
      !row.canLogin
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
      `SELECT
         has_function_privilege(
           $1,
           'app_private.apply_existing_user_invitation_membership(uuid,uuid)',
           'EXECUTE'
         ) AS "canExecute",
         has_table_privilege($1, 'memberships', 'INSERT') AS "canInsert",
         has_table_privilege($1, 'memberships', 'UPDATE') AS "canUpdate",
         has_any_column_privilege($1, 'memberships', 'UPDATE') AS "canUpdateColumn",
         has_schema_privilege($1, 'app_private', 'CREATE') AS "canCreate"
       `,
      [runtimeRole],
    )) as Array<{
      canExecute: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canUpdateColumn: boolean;
      canCreate: boolean;
    }>;
    const row = rows[0];
    if (
      row?.canExecute !== true ||
      row.canInsert ||
      row.canUpdate ||
      row.canUpdateColumn ||
      row.canCreate
    ) {
      throw new Error('Runtime membership boundary is not least-privilege.');
    }
  }
}
