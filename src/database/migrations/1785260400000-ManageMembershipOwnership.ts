import { MigrationInterface, QueryRunner } from 'typeorm';
import { RUNTIME_EXECUTABLE_FUNCTIONS } from '../runtime-executable-functions';

const MEMBERSHIP_EVENTS = [
  'organization.membership.role_changed',
  'organization.membership.owner_promoted',
  'organization.membership.owner_demoted',
  'organization.membership.deactivated',
  'organization.membership.reactivated',
  'organization.membership.left',
  'organization.membership.last_owner_change_blocked',
  'organization.ownership.remediated',
] as const;

export class ManageMembershipOwnership1785260400000 implements MigrationInterface {
  name = 'ManageMembershipOwnership1785260400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await this.assertNoOrphanedActiveOrganizations(queryRunner, 'M5401');

    await queryRunner.query(
      `CREATE TYPE app_private.membership_command_enum AS ENUM (
        'change_role', 'promote_owner', 'demote_owner',
        'deactivate', 'reactivate', 'leave'
      )`,
    );
    await queryRunner.query(
      `CREATE TYPE app_private.membership_command_outcome_enum AS ENUM (
        'changed', 'no_change', 'blocked_last_owner'
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_memberships_effective_owner
       ON public.memberships (organization_id, user_id, id)
       WHERE status = 'active' AND role = 'owner'`,
    );

    await queryRunner.query(`
      ALTER TABLE public.organization_audit_logs
        ADD COLUMN target_membership_id uuid,
        ADD COLUMN membership_action varchar(32),
        ADD COLUMN previous_role varchar(16),
        ADD COLUMN new_role varchar(16),
        ADD COLUMN previous_membership_status varchar(16),
        ADD COLUMN new_membership_status varchar(16),
        ADD CONSTRAINT FK_organization_audit_logs_target_membership_org
          FOREIGN KEY (target_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       DROP CONSTRAINT CHK_organization_audit_logs_event`,
    );
    await queryRunner.query(`
      ALTER TABLE public.organization_audit_logs
      ADD CONSTRAINT CHK_organization_audit_logs_event CHECK (event_type IN (
        'organization.invitation.created',
        'organization.invitation.replaced',
        'organization.invitation.revoked',
        'organization.invitation.revoked_issuer_membership_inactive',
        'organization.invitation.revoked_issuer_user_inactive',
        'organization.invitation.accepted',
        'organization.invitation.activated',
        ${MEMBERSHIP_EVENTS.map((event) => `'${event}'`).join(',\n        ')}
      ))
    `);
    await queryRunner.query(`
      ALTER TABLE public.organization_audit_logs
      ADD CONSTRAINT CHK_organization_audit_logs_membership_fields CHECK (
        (
          event_type IN (${MEMBERSHIP_EVENTS.map((event) => `'${event}'`).join(', ')})
          AND target_membership_id IS NOT NULL
          AND membership_action IS NOT NULL
          AND previous_role IS NOT NULL
          AND new_role IS NOT NULL
          AND previous_membership_status IS NOT NULL
          AND new_membership_status IS NOT NULL
          AND invitation_id IS NULL
          AND related_invitation_id IS NULL
          AND invited_role IS NULL
          AND reason IS NULL
          AND membership_result IS NULL
          AND (
            (
              event_type = 'organization.membership.role_changed'
              AND membership_action = 'change_role'
              AND previous_role IN ('member', 'admin')
              AND new_role IN ('member', 'admin')
              AND previous_role <> new_role
              AND previous_membership_status = 'active'
              AND new_membership_status = 'active'
            ) OR (
              event_type = 'organization.membership.owner_promoted'
              AND membership_action = 'promote_owner'
              AND previous_role IN ('member', 'admin')
              AND new_role = 'owner'
              AND previous_membership_status = 'active'
              AND new_membership_status = 'active'
            ) OR (
              event_type = 'organization.membership.owner_demoted'
              AND membership_action = 'demote_owner'
              AND previous_role = 'owner'
              AND new_role IN ('member', 'admin')
              AND previous_membership_status = 'active'
              AND new_membership_status = 'active'
            ) OR (
              event_type = 'organization.membership.deactivated'
              AND membership_action = 'deactivate'
              AND previous_role = new_role
              AND previous_role IN ('owner', 'admin', 'member')
              AND previous_membership_status = 'active'
              AND new_membership_status = 'inactive'
            ) OR (
              event_type = 'organization.membership.reactivated'
              AND membership_action = 'reactivate'
              AND previous_role = new_role
              AND previous_role IN ('owner', 'admin', 'member')
              AND previous_membership_status = 'inactive'
              AND new_membership_status = 'active'
            ) OR (
              event_type = 'organization.membership.left'
              AND membership_action = 'leave'
              AND previous_role = new_role
              AND previous_role IN ('owner', 'admin', 'member')
              AND previous_membership_status = 'active'
              AND new_membership_status = 'inactive'
            ) OR (
              event_type = 'organization.membership.last_owner_change_blocked'
              AND (
                (
                  membership_action = 'demote_owner'
                  AND previous_role = 'owner'
                  AND new_role IN ('member', 'admin')
                  AND previous_membership_status = 'active'
                  AND new_membership_status = 'active'
                ) OR (
                  membership_action IN ('deactivate', 'leave')
                  AND previous_role = 'owner'
                  AND new_role = 'owner'
                  AND previous_membership_status = 'active'
                  AND new_membership_status = 'inactive'
                )
              )
            ) OR (
              event_type = 'organization.ownership.remediated'
              AND membership_action = 'remediate'
              AND previous_role IN ('owner', 'admin', 'member')
              AND new_role = 'owner'
              AND previous_membership_status IN ('active', 'inactive')
              AND new_membership_status = 'active'
              AND (
                previous_role <> new_role
                OR previous_membership_status <> new_membership_status
              )
            )
          )
        ) OR (
          event_type NOT IN (${MEMBERSHIP_EVENTS.map((event) => `'${event}'`).join(', ')})
          AND target_membership_id IS NULL
          AND membership_action IS NULL
          AND previous_role IS NULL
          AND new_role IS NULL
          AND previous_membership_status IS NULL
          AND new_membership_status IS NULL
        )
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION app_private.assert_active_organization_effective_owner(
        p_organization_ids uuid[]
      ) RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      CALLED ON NULL INPUT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF p_organization_ids IS NULL OR pg_catalog.cardinality(p_organization_ids) = 0 THEN
          RETURN;
        END IF;

        PERFORM organization.id
        FROM public.organizations AS organization
        WHERE organization.id IN (
          SELECT DISTINCT candidate.id
          FROM pg_catalog.unnest(p_organization_ids) AS candidate(id)
          WHERE candidate.id IS NOT NULL
        )
        ORDER BY organization.id
        FOR UPDATE OF organization;

        IF EXISTS (
          SELECT 1
          FROM public.organizations AS organization
          WHERE organization.id IN (
            SELECT DISTINCT candidate.id
            FROM pg_catalog.unnest(p_organization_ids) AS candidate(id)
            WHERE candidate.id IS NOT NULL
          )
            AND organization.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM public.memberships AS membership
              JOIN public.users AS application_user
                ON application_user.id = membership.user_id
               AND application_user.status = 'active'
              WHERE membership.organization_id = organization.id
                AND membership.status = 'active'
                AND membership.role = 'owner'
            )
        ) THEN
          RAISE EXCEPTION 'active organization requires an effective owner'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'CHK_active_organization_effective_owner';
        END IF;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.assert_active_organization_effective_owner(uuid[]) FROM PUBLIC`,
    );

    await queryRunner.query(`
      CREATE FUNCTION app_private.enforce_membership_identity_immutable()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF OLD.user_id IS DISTINCT FROM NEW.user_id
           OR OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
          RAISE EXCEPTION 'membership identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'CHK_membership_identity_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.enforce_membership_identity_immutable() FROM PUBLIC`,
    );
    await queryRunner.query(`
      CREATE TRIGGER TRG_memberships_identity_immutable
      BEFORE UPDATE OF user_id, organization_id ON public.memberships
      FOR EACH ROW EXECUTE FUNCTION app_private.enforce_membership_identity_immutable()
    `);

    await this.createInvariantTriggers(queryRunner);
    await queryRunner.query(
      `ALTER FUNCTION public.revoke_invitations_for_inactive_membership()
       SET search_path = pg_catalog, public, pg_temp`,
    );
    await queryRunner.query(
      `ALTER FUNCTION public.revoke_invitations_for_inactive_user()
       SET search_path = pg_catalog, public, pg_temp`,
    );
    await this.createMembershipCommand(queryRunner);

    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.execute_membership_command(
         uuid, uuid, uuid, app_private.membership_command_enum,
         public.membership_role_enum, uuid, inet, text
       ) FROM PUBLIC`,
    );
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.execute_membership_command(
         uuid, uuid, uuid, app_private.membership_command_enum,
         public.membership_role_enum, uuid, inet, text
       ) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT USAGE ON SCHEMA app_private TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.execute_membership_command(
         uuid, uuid, uuid, app_private.membership_command_enum,
         public.membership_role_enum, uuid, inet, text
       ) TO "${runtimeRole}"`,
    );

    await this.assertInstalledBoundary(queryRunner, runtimeRole);
    await this.assertNoOrphanedActiveOrganizations(queryRunner, 'M5402');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await this.assertNoOrphanedActiveOrganizations(queryRunner, 'M5491');
    const rows = (await queryRunner.query(
      `SELECT count(*)::int AS count
       FROM public.organization_audit_logs
       WHERE event_type = ANY($1::text[])`,
      [MEMBERSHIP_EVENTS],
    )) as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error(
        `M5492 membership ownership audit exists; forward-fix required; count=${rows[0]?.count ?? 0}`,
      );
    }

    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.execute_membership_command(
         uuid, uuid, uuid, app_private.membership_command_enum,
         public.membership_role_enum, uuid, inet, text
       ) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `DROP TRIGGER TRG_users_effective_owner ON public.users`,
    );
    await queryRunner.query(
      `DROP TRIGGER TRG_organizations_effective_owner ON public.organizations`,
    );
    await queryRunner.query(
      `DROP TRIGGER TRG_memberships_effective_owner ON public.memberships`,
    );
    await queryRunner.query(
      `DROP TRIGGER TRG_memberships_identity_immutable ON public.memberships`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.enforce_effective_owner_from_user()`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.enforce_effective_owner_from_organization()`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.enforce_effective_owner_from_membership()`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.enforce_membership_identity_immutable()`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.execute_membership_command(
         uuid, uuid, uuid, app_private.membership_command_enum,
         public.membership_role_enum, uuid, inet, text
       )`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.assert_active_organization_effective_owner(uuid[])`,
    );

    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs DROP CONSTRAINT CHK_organization_audit_logs_membership_fields`,
    );
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs DROP CONSTRAINT CHK_organization_audit_logs_event`,
    );
    await queryRunner.query(`
      ALTER TABLE public.organization_audit_logs
      ADD CONSTRAINT CHK_organization_audit_logs_event CHECK (event_type IN (
        'organization.invitation.created',
        'organization.invitation.replaced',
        'organization.invitation.revoked',
        'organization.invitation.revoked_issuer_membership_inactive',
        'organization.invitation.revoked_issuer_user_inactive',
        'organization.invitation.accepted',
        'organization.invitation.activated'
      ))
    `);
    await queryRunner.query(
      `ALTER TABLE public.organization_audit_logs
       DROP CONSTRAINT FK_organization_audit_logs_target_membership_org,
       DROP COLUMN new_membership_status,
       DROP COLUMN previous_membership_status,
       DROP COLUMN new_role,
       DROP COLUMN previous_role,
       DROP COLUMN membership_action,
       DROP COLUMN target_membership_id`,
    );
    await queryRunner.query(
      `DROP INDEX public.IDX_memberships_effective_owner`,
    );
    await queryRunner.query(
      `DROP TYPE app_private.membership_command_outcome_enum`,
    );
    await queryRunner.query(`DROP TYPE app_private.membership_command_enum`);
  }

  private async createInvariantTriggers(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.enforce_effective_owner_from_membership()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM app_private.assert_active_organization_effective_owner(ARRAY[NEW.organization_id]::uuid[]);
        ELSIF TG_OP = 'DELETE' THEN
          PERFORM app_private.assert_active_organization_effective_owner(ARRAY[OLD.organization_id]::uuid[]);
        ELSIF OLD.role IS DISTINCT FROM NEW.role
           OR OLD.status IS DISTINCT FROM NEW.status
           OR OLD.user_id IS DISTINCT FROM NEW.user_id
           OR OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
          PERFORM app_private.assert_active_organization_effective_owner(
            ARRAY[OLD.organization_id, NEW.organization_id]::uuid[]
          );
        END IF;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.enforce_effective_owner_from_membership() FROM PUBLIC`,
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER TRG_memberships_effective_owner
      AFTER INSERT OR UPDATE OR DELETE ON public.memberships
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION app_private.enforce_effective_owner_from_membership()
    `);

    await queryRunner.query(`
      CREATE FUNCTION app_private.enforce_effective_owner_from_organization()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
          PERFORM app_private.assert_active_organization_effective_owner(ARRAY[NEW.id]::uuid[]);
        END IF;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.enforce_effective_owner_from_organization() FROM PUBLIC`,
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER TRG_organizations_effective_owner
      AFTER INSERT OR UPDATE ON public.organizations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION app_private.enforce_effective_owner_from_organization()
    `);

    await queryRunner.query(`
      CREATE FUNCTION app_private.enforce_effective_owner_from_user()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        related_organizations uuid[];
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
          RETURN NULL;
        END IF;
        SELECT pg_catalog.array_agg(scope.organization_id ORDER BY scope.organization_id)
          INTO related_organizations
        FROM (
          SELECT DISTINCT membership.organization_id
          FROM public.memberships AS membership
          WHERE membership.user_id = OLD.id
        ) AS scope;
        PERFORM app_private.assert_active_organization_effective_owner(related_organizations);
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.enforce_effective_owner_from_user() FROM PUBLIC`,
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER TRG_users_effective_owner
      AFTER UPDATE OR DELETE ON public.users
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION app_private.enforce_effective_owner_from_user()
    `);
  }

  private async createMembershipCommand(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.execute_membership_command(
        p_actor_user_id uuid,
        p_actor_membership_id uuid,
        p_target_membership_id uuid,
        p_command app_private.membership_command_enum,
        p_requested_role public.membership_role_enum,
        p_correlation_id uuid,
        p_ip_address inet,
        p_user_agent text
      ) RETURNS TABLE (
        outcome app_private.membership_command_outcome_enum,
        target_membership_id uuid,
        role public.membership_role_enum,
        status public.membership_status_enum
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      CALLED ON NULL INPUT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        actor_pre public.memberships%ROWTYPE;
        target_pre public.memberships%ROWTYPE;
        actor_row public.memberships%ROWTYPE;
        target_row public.memberships%ROWTYPE;
        actor_found boolean := false;
        target_found boolean := false;
        actor_user_status_pre public.user_status_enum;
        organization_status_pre public.organization_status_enum;
        actor_user_status public.user_status_enum;
        target_user_status public.user_status_enum;
        organization_status public.organization_status_enum;
        effective_owner_count integer;
        audit_event text;
        audit_action text;
        old_role public.membership_role_enum;
        old_status public.membership_status_enum;
        database_now timestamptz := pg_catalog.transaction_timestamp();
      BEGIN
        IF p_actor_user_id IS NULL OR p_actor_membership_id IS NULL
           OR p_command IS NULL OR p_correlation_id IS NULL THEN
          RAISE EXCEPTION 'membership command arguments invalid' USING ERRCODE = '22004';
        END IF;
        IF p_user_agent IS NOT NULL AND pg_catalog.char_length(p_user_agent) > 512 THEN
          RAISE EXCEPTION 'membership command context invalid' USING ERRCODE = '22001';
        END IF;
        IF (p_command = 'leave' AND p_target_membership_id IS NOT NULL)
           OR (p_command <> 'leave' AND p_target_membership_id IS NULL)
           OR (p_command IN ('change_role', 'demote_owner')
               AND (p_requested_role IS NULL
                    OR p_requested_role NOT IN ('member', 'admin')))
           OR (p_command NOT IN ('change_role', 'demote_owner')
               AND p_requested_role IS NOT NULL) THEN
          RAISE EXCEPTION 'membership command arguments invalid' USING ERRCODE = '22023';
        END IF;

        SELECT membership.* INTO actor_pre
        FROM public.memberships AS membership
        WHERE membership.id = p_actor_membership_id
          AND membership.user_id = p_actor_user_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P2001';
        END IF;

        SELECT application_user.status INTO actor_user_status_pre
        FROM public.users AS application_user
        WHERE application_user.id = actor_pre.user_id;
        SELECT organization.status INTO organization_status_pre
        FROM public.organizations AS organization
        WHERE organization.id = actor_pre.organization_id;

        IF p_command <> 'leave' THEN
          SELECT membership.* INTO target_pre
          FROM public.memberships AS membership
          WHERE membership.id = p_target_membership_id;
          IF NOT FOUND OR target_pre.organization_id <> actor_pre.organization_id THEN
            RAISE EXCEPTION 'member not found' USING ERRCODE = 'P2002';
          END IF;
        ELSE
          target_pre := actor_pre;
        END IF;

        PERFORM organization.id
        FROM public.organizations AS organization
        WHERE organization.id = actor_pre.organization_id
        FOR UPDATE OF organization;

        PERFORM application_user.id
        FROM public.users AS application_user
        WHERE application_user.id = ANY(
          ARRAY[actor_pre.user_id, target_pre.user_id]::uuid[]
        )
        ORDER BY application_user.id
        FOR UPDATE OF application_user;

        PERFORM membership.id
        FROM public.memberships AS membership
        WHERE membership.id = ANY(
          ARRAY[actor_pre.id, target_pre.id]::uuid[]
        )
        ORDER BY membership.id
        FOR UPDATE OF membership;

        SELECT membership.* INTO actor_row
        FROM public.memberships AS membership
        WHERE membership.id = p_actor_membership_id
          AND membership.user_id = p_actor_user_id;
        actor_found := FOUND;
        IF actor_found THEN
          SELECT application_user.status INTO actor_user_status
          FROM public.users AS application_user
          WHERE application_user.id = actor_row.user_id;
          SELECT organization.status INTO organization_status
          FROM public.organizations AS organization
          WHERE organization.id = actor_row.organization_id;
        END IF;

        IF p_command = 'leave'
           AND actor_pre.status = 'active'
           AND actor_user_status_pre = 'active'
           AND organization_status_pre = 'active'
           AND actor_found
           AND actor_row.id = actor_pre.id
           AND actor_row.user_id = actor_pre.user_id
           AND actor_row.organization_id = actor_pre.organization_id
           AND actor_row.status = 'inactive'
           AND actor_user_status = 'active'
           AND organization_status = 'active' THEN
          RETURN QUERY SELECT 'no_change'::app_private.membership_command_outcome_enum,
            actor_row.id, actor_row.role, actor_row.status;
          RETURN;
        END IF;

        IF NOT actor_found
           OR actor_row.organization_id <> actor_pre.organization_id
           OR actor_row.status <> 'active'
           OR actor_user_status <> 'active'
           OR organization_status <> 'active' THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P2001';
        END IF;

        IF p_command = 'leave' THEN
          target_row := actor_row;
          target_user_status := actor_user_status;
        ELSE
          SELECT membership.* INTO target_row
          FROM public.memberships AS membership
          WHERE membership.id = p_target_membership_id
            AND membership.organization_id = actor_row.organization_id;
          target_found := FOUND;
          IF target_found THEN
            SELECT application_user.status INTO target_user_status
            FROM public.users AS application_user
            WHERE application_user.id = target_row.user_id;
          END IF;
          IF NOT target_found THEN
            RAISE EXCEPTION 'member not found' USING ERRCODE = 'P2002';
          END IF;
          IF target_row.id = actor_row.id THEN
            RAISE EXCEPTION 'membership self target conflict' USING ERRCODE = 'P2003';
          END IF;
        END IF;

        IF p_command <> 'leave' AND actor_row.role = 'member' THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P2001';
        END IF;
        IF p_command <> 'leave'
           AND actor_row.role = 'admin'
           AND target_row.role <> 'member' THEN
          RAISE EXCEPTION 'member not found' USING ERRCODE = 'P2002';
        END IF;
        IF p_command IN ('change_role', 'promote_owner', 'demote_owner')
           AND actor_row.role <> 'owner' THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P2001';
        END IF;

        IF p_command IN ('change_role', 'promote_owner', 'demote_owner')
           AND (target_row.status <> 'active' OR target_user_status <> 'active') THEN
          RAISE EXCEPTION 'membership state conflict' USING ERRCODE = 'P2003';
        END IF;
        IF p_command = 'reactivate' AND target_user_status <> 'active' THEN
          RAISE EXCEPTION 'membership state conflict' USING ERRCODE = 'P2003';
        END IF;

        old_role := target_row.role;
        old_status := target_row.status;

        IF p_command = 'change_role' THEN
          IF target_row.role = 'owner' THEN
            RAISE EXCEPTION 'membership state conflict' USING ERRCODE = 'P2003';
          END IF;
          IF target_row.role = p_requested_role THEN
            RETURN QUERY SELECT 'no_change'::app_private.membership_command_outcome_enum,
              target_row.id, target_row.role, target_row.status;
            RETURN;
          END IF;
          target_row.role := p_requested_role;
          audit_event := 'organization.membership.role_changed';
          audit_action := 'change_role';
        ELSIF p_command = 'promote_owner' THEN
          IF target_row.role = 'owner' THEN
            RETURN QUERY SELECT 'no_change'::app_private.membership_command_outcome_enum,
              target_row.id, target_row.role, target_row.status;
            RETURN;
          END IF;
          target_row.role := 'owner';
          audit_event := 'organization.membership.owner_promoted';
          audit_action := 'promote_owner';
        ELSIF p_command = 'demote_owner' THEN
          IF target_row.role = p_requested_role THEN
            RETURN QUERY SELECT 'no_change'::app_private.membership_command_outcome_enum,
              target_row.id, target_row.role, target_row.status;
            RETURN;
          END IF;
          IF target_row.role <> 'owner' THEN
            RAISE EXCEPTION 'membership state conflict' USING ERRCODE = 'P2003';
          END IF;
          target_row.role := p_requested_role;
          audit_event := 'organization.membership.owner_demoted';
          audit_action := 'demote_owner';
        ELSIF p_command = 'deactivate' THEN
          IF target_row.status = 'inactive' THEN
            RETURN QUERY SELECT 'no_change'::app_private.membership_command_outcome_enum,
              target_row.id, target_row.role, target_row.status;
            RETURN;
          END IF;
          target_row.status := 'inactive';
          audit_event := 'organization.membership.deactivated';
          audit_action := 'deactivate';
        ELSIF p_command = 'reactivate' THEN
          IF target_row.status = 'active' THEN
            RETURN QUERY SELECT 'no_change'::app_private.membership_command_outcome_enum,
              target_row.id, target_row.role, target_row.status;
            RETURN;
          END IF;
          target_row.status := 'active';
          audit_event := 'organization.membership.reactivated';
          audit_action := 'reactivate';
        ELSE
          target_row.status := 'inactive';
          audit_event := 'organization.membership.left';
          audit_action := 'leave';
        END IF;

        IF old_role = 'owner' AND old_status = 'active'
           AND target_user_status = 'active'
           AND (target_row.role <> 'owner' OR target_row.status <> 'active') THEN
          SELECT count(*)::integer INTO effective_owner_count
          FROM public.memberships AS owner_membership
          JOIN public.users AS owner_user
            ON owner_user.id = owner_membership.user_id
           AND owner_user.status = 'active'
          WHERE owner_membership.organization_id = actor_row.organization_id
            AND owner_membership.role = 'owner'
            AND owner_membership.status = 'active';
          IF effective_owner_count <= 1 THEN
            INSERT INTO public.organization_audit_logs (
              organization_id, event_type, actor_user_id, actor_membership_id,
              target_membership_id, membership_action,
              previous_role, new_role,
              previous_membership_status, new_membership_status,
              correlation_id, ip_address, user_agent, occurred_at
            ) VALUES (
              actor_row.organization_id,
              'organization.membership.last_owner_change_blocked',
              actor_row.user_id, actor_row.id, target_row.id, audit_action,
              old_role::text, target_row.role::text,
              old_status::text, target_row.status::text,
              p_correlation_id, p_ip_address, p_user_agent, database_now
            );
            RETURN QUERY SELECT 'blocked_last_owner'::app_private.membership_command_outcome_enum,
              target_row.id, old_role, old_status;
            RETURN;
          END IF;
        END IF;

        UPDATE public.memberships AS membership
        SET role = target_row.role,
            status = target_row.status,
            updated_at = database_now
        WHERE membership.id = target_row.id;

        INSERT INTO public.organization_audit_logs (
          organization_id, event_type, actor_user_id, actor_membership_id,
          target_membership_id, membership_action,
          previous_role, new_role,
          previous_membership_status, new_membership_status,
          correlation_id, ip_address, user_agent, occurred_at
        ) VALUES (
          actor_row.organization_id, audit_event,
          actor_row.user_id, actor_row.id, target_row.id, audit_action,
          old_role::text, target_row.role::text,
          old_status::text, target_row.status::text,
          p_correlation_id, p_ip_address, p_user_agent, database_now
        );

        PERFORM app_private.assert_active_organization_effective_owner(
          ARRAY[actor_row.organization_id]::uuid[]
        );
        RETURN QUERY SELECT 'changed'::app_private.membership_command_outcome_enum,
          target_row.id, target_row.role, target_row.status;
      END;
      $$
    `);
  }

  private async assertNoOrphanedActiveOrganizations(
    queryRunner: QueryRunner,
    code: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT count(*)::int AS count
      FROM public.organizations AS organization
      WHERE organization.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM public.memberships AS membership
          JOIN public.users AS application_user
            ON application_user.id = membership.user_id
           AND application_user.status = 'active'
          WHERE membership.organization_id = organization.id
            AND membership.status = 'active'
            AND membership.role = 'owner'
        )
    `)) as Array<{ count: number }>;
    const count = rows[0]?.count ?? 0;
    if (count > 0) {
      throw new Error(`${code} orphaned active organizations; count=${count}`);
    }
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

  private async assertInstalledBoundary(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT
         has_function_privilege(
           $1,
           'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,public.membership_role_enum,uuid,inet,text)',
           'EXECUTE'
         ) AS "canExecute",
         has_schema_privilege($1, 'app_private', 'USAGE') AS "canUseSchema",
         has_schema_privilege($1, 'app_private', 'CREATE') AS "canCreateSchema",
         EXISTS (
           SELECT 1
           FROM pg_catalog.unnest(ARRAY['users', 'organizations', 'memberships']) AS central(table_name)
           WHERE has_table_privilege(
             $1, 'public.' || central.table_name,
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
           ) OR has_any_column_privilege(
             $1, 'public.' || central.table_name,
             'INSERT,UPDATE,REFERENCES'
           )
         ) AS "canMutateCentralTables",
         EXISTS (
           SELECT 1
           FROM pg_proc AS procedure
           JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
           ) AS acl
           WHERE namespace.nspname = 'app_private'
             AND procedure.proname = 'execute_membership_command'
             AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ) AS "publicCanExecute",
         ARRAY(
           SELECT procedure.oid::regprocedure::text
           FROM pg_proc AS procedure
           JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
           WHERE namespace.nspname = 'app_private'
             AND has_function_privilege($1, procedure.oid, 'EXECUTE')
           ORDER BY procedure.oid::regprocedure::text
         ) AS "executableFunctions",
         (
           SELECT count(*) = 1
           FROM pg_proc AS procedure
           WHERE procedure.oid = to_regprocedure(
             'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,public.membership_role_enum,uuid,inet,text)'
           )
             AND procedure.prosecdef
             AND procedure.provolatile = 'v'
             AND procedure.proparallel = 'u'
             AND NOT procedure.proisstrict
             AND procedure.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
         ) AND (
           SELECT count(*) = 5
           FROM pg_proc AS procedure
           WHERE procedure.oid = ANY(ARRAY[
             to_regprocedure('app_private.assert_active_organization_effective_owner(uuid[])'),
             to_regprocedure('app_private.enforce_membership_identity_immutable()'),
             to_regprocedure('app_private.enforce_effective_owner_from_membership()'),
             to_regprocedure('app_private.enforce_effective_owner_from_organization()'),
             to_regprocedure('app_private.enforce_effective_owner_from_user()')
           ])
             AND procedure.prosecdef
             AND procedure.provolatile = 'v'
             AND procedure.proparallel = 'u'
             AND NOT procedure.proisstrict
             AND procedure.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
         ) AND (
           SELECT count(*) = 2
           FROM pg_proc AS procedure
           JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
           WHERE namespace.nspname = 'public'
             AND procedure.proname IN (
               'revoke_invitations_for_inactive_membership',
               'revoke_invitations_for_inactive_user'
             )
             AND NOT procedure.prosecdef
             AND procedure.provolatile = 'v'
             AND procedure.proparallel = 'u'
             AND NOT procedure.proisstrict
             AND procedure.proconfig =
               ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
         ) AND (
           SELECT count(*) = 6
           FROM pg_trigger AS trigger
           WHERE NOT trigger.tgisinternal
             AND trigger.tgenabled = 'O'
             AND trigger.tgrelid = ANY(ARRAY[
               'public.memberships'::regclass,
               'public.organizations'::regclass,
               'public.users'::regclass
             ])
             AND (
               (trigger.tgname = 'trg_memberships_identity_immutable'
                 AND trigger.tgrelid = 'public.memberships'::regclass
                 AND trigger.tgfoid = to_regprocedure(
                   'app_private.enforce_membership_identity_immutable()'
                 )
                 AND trigger.tgtype = 19
                 AND trigger.tgconstraint = 0
                 AND NOT trigger.tgdeferrable
                 AND NOT trigger.tginitdeferred)
               OR (trigger.tgname = 'trg_memberships_effective_owner'
                 AND trigger.tgrelid = 'public.memberships'::regclass
                 AND trigger.tgfoid = to_regprocedure(
                   'app_private.enforce_effective_owner_from_membership()'
                 )
                 AND trigger.tgtype = 29
                 AND trigger.tgconstraint <> 0
                 AND trigger.tgdeferrable AND trigger.tginitdeferred)
               OR (trigger.tgname = 'trg_organizations_effective_owner'
                 AND trigger.tgrelid = 'public.organizations'::regclass
                 AND trigger.tgfoid = to_regprocedure(
                   'app_private.enforce_effective_owner_from_organization()'
                 )
                 AND trigger.tgtype = 21
                 AND trigger.tgconstraint <> 0
                 AND trigger.tgdeferrable AND trigger.tginitdeferred)
               OR (trigger.tgname = 'trg_users_effective_owner'
                 AND trigger.tgrelid = 'public.users'::regclass
                 AND trigger.tgfoid = to_regprocedure(
                   'app_private.enforce_effective_owner_from_user()'
                 )
                 AND trigger.tgtype = 25
                 AND trigger.tgconstraint <> 0
                 AND trigger.tgdeferrable AND trigger.tginitdeferred)
               OR (trigger.tgname = 'trg_memberships_revoke_pending_invitations'
                 AND trigger.tgrelid = 'public.memberships'::regclass
                 AND trigger.tgfoid = to_regprocedure(
                   'public.revoke_invitations_for_inactive_membership()'
                 )
                 AND trigger.tgtype = 17
                 AND trigger.tgconstraint = 0
                 AND NOT trigger.tgdeferrable
                 AND NOT trigger.tginitdeferred
                 AND trigger.tgattr::text = (
                   SELECT attribute.attnum::text
                   FROM pg_attribute AS attribute
                   WHERE attribute.attrelid = 'public.memberships'::regclass
                     AND attribute.attname = 'status'
                     AND NOT attribute.attisdropped
                 ))
               OR (trigger.tgname = 'trg_users_revoke_pending_invitations'
                 AND trigger.tgrelid = 'public.users'::regclass
                 AND trigger.tgfoid = to_regprocedure(
                   'public.revoke_invitations_for_inactive_user()'
                 )
                 AND trigger.tgtype = 17
                 AND trigger.tgconstraint = 0
                 AND NOT trigger.tgdeferrable
                 AND NOT trigger.tginitdeferred
                 AND trigger.tgattr::text = (
                   SELECT attribute.attnum::text
                   FROM pg_attribute AS attribute
                   WHERE attribute.attrelid = 'public.users'::regclass
                     AND attribute.attname = 'status'
                     AND NOT attribute.attisdropped
                 ))
             )
         ) AS "catalogSafe"`,
      [runtimeRole],
    )) as Array<{
      canExecute: boolean;
      canUseSchema: boolean;
      canCreateSchema: boolean;
      canMutateCentralTables: boolean;
      publicCanExecute: boolean;
      executableFunctions: string[];
      catalogSafe: boolean;
    }>;
    const row = rows[0];
    if (
      row?.canExecute !== true ||
      row.canUseSchema !== true ||
      row.canCreateSchema ||
      row.canMutateCentralTables ||
      row.publicCanExecute ||
      !row.catalogSafe ||
      JSON.stringify(row.executableFunctions) !==
        JSON.stringify(RUNTIME_EXECUTABLE_FUNCTIONS)
    ) {
      throw new Error('Runtime membership boundary is not least-privilege.');
    }
  }
}
