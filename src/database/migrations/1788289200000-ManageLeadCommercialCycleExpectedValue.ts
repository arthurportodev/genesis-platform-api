import { MigrationInterface, QueryRunner } from 'typeorm';

export class ManageLeadCommercialCycleExpectedValue1788289200000 implements MigrationInterface {
  name = 'ManageLeadCommercialCycleExpectedValue1788289200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);

    await queryRunner.query(
      `ALTER TYPE app_private.lead_command_enum ADD VALUE IF NOT EXISTS 'set_expected_value'`,
    );
    await queryRunner.query(`ALTER TABLE public.lead_commercial_cycles
      ADD COLUMN expected_value_minor bigint,
      ADD CONSTRAINT CHK_lead_commercial_cycles_expected_value
        CHECK (expected_value_minor IS NULL OR expected_value_minor >= 0)`);

    await this.extendTimeline(queryRunner);
    await this.replaceCycleProtection(queryRunner, true);
    await this.createExpectedValueCommand(queryRunner);
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.execute_lead_expected_value_command(
        uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,bigint
      ) TO "${runtimeRole}"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await this.assertSafeRollback(queryRunner);

    const rows = (await queryRunner.query(
      `SELECT pg_get_functiondef(
        to_regprocedure('app_private.execute_lead_command(uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,text,jsonb,lead_stage_enum,lead_lost_reason_enum,lead_archive_reason_enum,text)')
      ) AS definition`,
    )) as Array<{ definition: string }>;
    const legacyCommandDefinition = rows[0]?.definition;
    if (legacyCommandDefinition === undefined) {
      throw new Error('Legacy lead command function is unavailable.');
    }

    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.execute_lead_expected_value_command(
        uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,bigint
      ) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.execute_lead_expected_value_command(
        uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,bigint
      )`,
    );

    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.execute_lead_command(
        uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,
        text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,
        public.lead_archive_reason_enum,text
      ) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `DROP FUNCTION app_private.execute_lead_command(
        uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,
        text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,
        public.lead_archive_reason_enum,text
      )`,
    );
    await queryRunner.query(`ALTER TABLE public.lead_command_idempotency
      ALTER COLUMN command TYPE text USING command::text`);
    await queryRunner.query('DROP TYPE app_private.lead_command_enum');
    await queryRunner.query(
      `CREATE TYPE app_private.lead_command_enum AS ENUM (
        'move','win','lose','archive','reactivate','dismiss_return'
      )`,
    );
    await queryRunner.query(`ALTER TABLE public.lead_command_idempotency
      ALTER COLUMN command TYPE app_private.lead_command_enum
      USING command::app_private.lead_command_enum`);
    await queryRunner.query(legacyCommandDefinition);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.execute_lead_command(
        uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,
        text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,
        public.lead_archive_reason_enum,text
      ) FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.execute_lead_command(
        uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,
        text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,
        public.lead_archive_reason_enum,text
      ) TO "${runtimeRole}"`,
    );

    await this.replaceCycleProtection(queryRunner, false);
    await this.restoreTimeline(queryRunner);
    await queryRunner.query(`ALTER TABLE public.lead_commercial_cycles
      DROP CONSTRAINT CHK_lead_commercial_cycles_expected_value,
      DROP COLUMN expected_value_minor`);
  }

  private async extendTimeline(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_lifecycle_payload',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_type',
    );
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD COLUMN previous_expected_value_minor bigint,
      ADD COLUMN new_expected_value_minor bigint,
      ADD CONSTRAINT CHK_lead_timeline_events_type CHECK (event_type IN (
        'lead.created','lead.entry.received','lead.basic_data.updated',
        'lead.assignment.changed','lead.assignment.cleared','lead.stage.changed',
        'lead.won','lead.lost','lead.archived','lead.reactivated',
        'lead.return.received','lead.return.dismissed','lead.activity.created',
        'lead.note.created','lead.next_action.created','lead.next_action.rescheduled',
        'lead.next_action.completed','lead.next_action.canceled',
        'lead.expected_value.changed'
      )),
      ADD CONSTRAINT CHK_lead_timeline_events_lifecycle_payload CHECK (
        event_type = 'lead.expected_value.changed'
        OR event_type IN ('lead.activity.created','lead.note.created',
          'lead.next_action.created','lead.next_action.rescheduled',
          'lead.next_action.completed','lead.next_action.canceled')
        OR (${this.legacyTimelinePayloadExpression()})
      ),
      ADD CONSTRAINT CHK_lead_timeline_events_expected_value_payload CHECK (
        (event_type = 'lead.expected_value.changed'
          AND actor_membership_id IS NOT NULL AND cycle_id IS NOT NULL
          AND lead_entry_id IS NULL AND return_review_id IS NULL
          AND changed_fields IS NULL
          AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL
          AND previous_status IS NULL AND new_status IS NULL
          AND previous_stage IS NULL AND new_stage IS NULL
          AND lost_reason IS NULL AND archive_reason IS NULL
          AND activity_id IS NULL AND note_id IS NULL AND next_action_id IS NULL
          AND previous_next_action_status IS NULL
          AND new_next_action_status IS NULL
          AND previous_due_at IS NULL AND new_due_at IS NULL
          AND next_action_revision IS NULL
          AND next_action_cancellation_reason IS NULL
          AND previous_expected_value_minor IS DISTINCT FROM new_expected_value_minor
          AND (previous_expected_value_minor IS NULL OR previous_expected_value_minor >= 0)
          AND (new_expected_value_minor IS NULL OR new_expected_value_minor >= 0))
        OR (event_type <> 'lead.expected_value.changed'
          AND previous_expected_value_minor IS NULL
          AND new_expected_value_minor IS NULL)
      )`);
  }

  private async restoreTimeline(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_expected_value_payload',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_lifecycle_payload',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_type',
    );
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      DROP COLUMN previous_expected_value_minor,
      DROP COLUMN new_expected_value_minor,
      ADD CONSTRAINT CHK_lead_timeline_events_type CHECK (event_type IN (
        'lead.created','lead.entry.received','lead.basic_data.updated',
        'lead.assignment.changed','lead.assignment.cleared','lead.stage.changed',
        'lead.won','lead.lost','lead.archived','lead.reactivated',
        'lead.return.received','lead.return.dismissed','lead.activity.created',
        'lead.note.created','lead.next_action.created','lead.next_action.rescheduled',
        'lead.next_action.completed','lead.next_action.canceled'
      )),
      ADD CONSTRAINT CHK_lead_timeline_events_lifecycle_payload CHECK (
        event_type IN ('lead.activity.created','lead.note.created',
          'lead.next_action.created','lead.next_action.rescheduled',
          'lead.next_action.completed','lead.next_action.canceled')
        OR (${this.legacyTimelinePayloadExpression()})
      )`);
  }

  private async replaceCycleProtection(
    queryRunner: QueryRunner,
    allowExpectedValueUpdate: boolean,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app_private.protect_lead_cycle_history()
      RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.closed_at IS NOT NULL
          OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
          OR NEW.lead_id <> OLD.lead_id OR NEW.cycle_number <> OLD.cycle_number
          OR NEW.opening_reason <> OLD.opening_reason
          OR NEW.starting_stage <> OLD.starting_stage
          OR NEW.opened_by_membership_id IS DISTINCT FROM OLD.opened_by_membership_id
          OR NEW.opened_at <> OLD.opened_at
          ${
            allowExpectedValueUpdate
              ? 'OR (NEW.closed_at IS NOT NULL AND NEW.expected_value_minor IS DISTINCT FROM OLD.expected_value_minor)'
              : 'OR NEW.closed_at IS NULL'
          } THEN
          RAISE EXCEPTION 'commercial cycle history is immutable' USING ERRCODE = 'P3006';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.protect_lead_cycle_history() FROM PUBLIC',
    );
  }

  private async createExpectedValueCommand(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.execute_lead_expected_value_command(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_lead_id uuid, p_expected_revision bigint, p_idempotency_key uuid,
        p_fingerprint_key_version smallint, p_request_fingerprint text,
        p_request_fingerprints jsonb, p_expected_value_minor bigint
      ) RETURNS TABLE (revision bigint, replayed boolean, response_status smallint)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE
        v_actor public.memberships%ROWTYPE;
        v_lead public.leads%ROWTYPE;
        v_claim public.lead_command_idempotency%ROWTYPE;
        v_claim_id uuid;
        v_cycle public.lead_commercial_cycles%ROWTYPE;
        v_changed boolean := true;
        v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_actor_user_id IS NULL OR p_actor_membership_id IS NULL
          OR p_organization_id IS NULL OR p_lead_id IS NULL
          OR p_expected_revision IS NULL OR p_idempotency_key IS NULL
          OR p_fingerprint_key_version IS NULL
          OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
          OR p_request_fingerprints IS NULL
          OR jsonb_typeof(p_request_fingerprints) <> 'object'
          OR COALESCE(p_request_fingerprints ->> p_fingerprint_key_version::text, '')
            <> p_request_fingerprint
          OR p_expected_value_minor < 0 THEN
          RAISE EXCEPTION 'invalid lead command' USING ERRCODE = '22023';
        END IF;

        SELECT membership.* INTO v_actor FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id
            AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
        END IF;
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active'
          FOR UPDATE OF organization;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
        END IF;
        PERFORM application_user.id FROM public.users application_user
          WHERE application_user.id = p_actor_user_id
          ORDER BY application_user.id FOR UPDATE OF application_user;
        PERFORM membership.id FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id
          ORDER BY membership.id FOR UPDATE OF membership;
        SELECT membership.* INTO v_actor FROM public.memberships membership
          JOIN public.users application_user ON application_user.id = membership.user_id
            AND application_user.status = 'active'
          WHERE membership.id = p_actor_membership_id
            AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id
            AND membership.status = 'active';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
        END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.id = p_lead_id AND lead.organization_id = p_organization_id
          FOR UPDATE OF lead;
        IF NOT FOUND OR (v_actor.role = 'member'
          AND v_lead.responsible_membership_id IS DISTINCT FROM p_actor_membership_id) THEN
          RAISE EXCEPTION 'lead not found' USING ERRCODE = 'P3002';
        END IF;

        INSERT INTO public.lead_command_idempotency (
          organization_id, actor_membership_id, lead_id, command,
          idempotency_key, fingerprint_key_version, request_fingerprint, status
        ) VALUES (
          p_organization_id, p_actor_membership_id, p_lead_id,
          'set_expected_value', p_idempotency_key, p_fingerprint_key_version,
          p_request_fingerprint, 'processing'
        ) ON CONFLICT DO NOTHING RETURNING id INTO v_claim_id;
        IF v_claim_id IS NULL THEN
          SELECT claim.* INTO v_claim FROM public.lead_command_idempotency claim
            WHERE claim.organization_id = p_organization_id
              AND claim.actor_membership_id = p_actor_membership_id
              AND claim.command = 'set_expected_value'
              AND claim.idempotency_key = p_idempotency_key FOR UPDATE;
          IF NOT FOUND OR v_claim.lead_id <> p_lead_id
            OR v_claim.request_fingerprint <>
              COALESCE(p_request_fingerprints ->> v_claim.fingerprint_key_version::text, '') THEN
            RAISE EXCEPTION 'idempotency fingerprint conflict' USING ERRCODE = 'P3004';
          END IF;
          IF v_claim.status <> 'completed' THEN
            RAISE EXCEPTION 'idempotency result unavailable' USING ERRCODE = 'P3005';
          END IF;
          RETURN QUERY SELECT v_claim.result_revision, true, v_claim.response_status;
          RETURN;
        END IF;

        IF v_lead.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'lead revision conflict' USING ERRCODE = 'P3003';
        END IF;
        IF v_lead.status <> 'active' THEN
          RAISE EXCEPTION 'lead state conflict' USING ERRCODE = 'P3004';
        END IF;
        SELECT cycle.* INTO STRICT v_cycle
          FROM public.lead_commercial_cycles cycle
          WHERE cycle.lead_id = v_lead.id
            AND cycle.organization_id = p_organization_id
            AND cycle.closed_at IS NULL FOR UPDATE;

        IF v_cycle.expected_value_minor IS NOT DISTINCT FROM p_expected_value_minor THEN
          v_changed := false;
        ELSE
          UPDATE public.lead_commercial_cycles cycle
            SET expected_value_minor = p_expected_value_minor
            WHERE cycle.id = v_cycle.id;
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            cycle_id, previous_expected_value_minor, new_expected_value_minor,
            occurred_at
          ) VALUES (
            p_organization_id, v_lead.id, v_lead.next_event_sequence,
            'lead.expected_value.changed', p_actor_membership_id, v_cycle.id,
            v_cycle.expected_value_minor, p_expected_value_minor, v_now
          );
          UPDATE public.leads lead SET revision = lead.revision + 1,
            next_event_sequence = lead.next_event_sequence + 1,
            updated_at = v_now WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        END IF;

        UPDATE public.lead_command_idempotency claim SET status = 'completed',
          result_revision = v_lead.revision, result_changed = v_changed,
          response_status = 204, updated_at = v_now WHERE claim.id = v_claim_id;
        RETURN QUERY SELECT v_lead.revision, false, 204::smallint;
      EXCEPTION
        WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
          RAISE EXCEPTION 'lead lifecycle invariant unavailable' USING ERRCODE = 'P3007';
      END; $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_private.execute_lead_expected_value_command(
        uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,bigint
      ) FROM PUBLIC`,
    );
  }

  private async assertSafeRollback(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM public.lead_commercial_cycles cycle
          WHERE cycle.expected_value_minor IS NOT NULL)
        OR EXISTS (SELECT 1 FROM public.lead_timeline_events event
          WHERE event.event_type = 'lead.expected_value.changed')
        OR EXISTS (SELECT 1 FROM public.lead_command_idempotency claim
          WHERE claim.command = 'set_expected_value') AS unsafe
    `)) as Array<{ unsafe: boolean }>;
    if (rows[0]?.unsafe !== false) {
      throw new Error(
        'Unsafe rollback: lead expected-value data or history already exists.',
      );
    }
  }

  private legacyTimelinePayloadExpression(): string {
    return `(event_type IN ('lead.created','lead.entry.received','lead.basic_data.updated',
          'lead.assignment.changed','lead.assignment.cleared')
          AND cycle_id IS NULL AND return_review_id IS NULL
          AND previous_status IS NULL AND new_status IS NULL
          AND previous_stage IS NULL AND new_stage IS NULL
          AND lost_reason IS NULL AND archive_reason IS NULL)
        OR (event_type = 'lead.stage.changed' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND return_review_id IS NULL AND lead_entry_id IS NULL
          AND previous_status = 'active' AND new_status = 'active'
          AND previous_stage IS NOT NULL AND new_stage IS NOT NULL
          AND previous_stage <> new_stage AND lost_reason IS NULL AND archive_reason IS NULL
          AND changed_fields IS NULL AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL)
        OR (event_type = 'lead.won' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND return_review_id IS NULL AND lead_entry_id IS NULL
          AND previous_status = 'active' AND new_status = 'won'
          AND previous_stage IS NOT NULL AND new_stage = previous_stage
          AND lost_reason IS NULL AND archive_reason IS NULL
          AND changed_fields IS NULL AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL)
        OR (event_type = 'lead.lost' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND return_review_id IS NULL AND lead_entry_id IS NULL
          AND previous_status = 'active' AND new_status = 'lost'
          AND previous_stage IS NOT NULL AND new_stage = previous_stage
          AND lost_reason IS NOT NULL AND archive_reason IS NULL
          AND changed_fields IS NULL AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL)
        OR (event_type = 'lead.archived' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND return_review_id IS NULL AND lead_entry_id IS NULL
          AND previous_status = 'active' AND new_status = 'archived'
          AND previous_stage IS NOT NULL AND new_stage = previous_stage
          AND lost_reason IS NULL AND archive_reason IS NOT NULL
          AND changed_fields IS NULL AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL)
        OR (event_type = 'lead.reactivated' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND lead_entry_id IS NULL
          AND previous_status IN ('won','lost','archived') AND new_status = 'active'
          AND previous_stage IS NOT NULL AND new_stage = 'qualification'
          AND lost_reason IS NULL AND archive_reason IS NULL
          AND changed_fields IS NULL AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL)
        OR (event_type = 'lead.return.received' AND cycle_id IS NOT NULL
          AND return_review_id IS NOT NULL AND lead_entry_id IS NOT NULL
          AND previous_status IS NULL AND new_status IS NULL
          AND previous_stage IS NULL AND new_stage IS NULL
          AND lost_reason IS NULL AND archive_reason IS NULL
          AND changed_fields IS NULL AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL)
        OR (event_type = 'lead.return.dismissed' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND return_review_id IS NOT NULL AND lead_entry_id IS NULL
          AND previous_status IS NULL AND new_status IS NULL
          AND previous_stage IS NULL AND new_stage IS NULL
          AND lost_reason IS NULL AND archive_reason IS NULL
          AND changed_fields IS NULL AND previous_responsible_membership_id IS NULL
          AND new_responsible_membership_id IS NULL)`;
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
      `SELECT role.rolname FROM pg_roles role
       WHERE role.rolname = $1 AND role.rolcanlogin
         AND NOT role.rolsuper AND NOT role.rolbypassrls
         AND role.rolname <> current_user`,
      [role],
    )) as Array<{ rolname: string }>;
    if (rows[0]?.rolname !== role) {
      throw new Error(
        'DATABASE_RUNTIME_ROLE is not a safe distinct login role.',
      );
    }
    return role;
  }
}
