import { MigrationInterface, QueryRunner } from 'typeorm';

export class ManageLeadActivitiesFollowUp1785519600000 implements MigrationInterface {
  name = 'ManageLeadActivitiesFollowUp1785519600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await this.createEnums(queryRunner);
    await this.addOrganizationTimezone(queryRunner);
    await this.createTables(queryRunner);
    await this.extendTimeline(queryRunner);
    await this.createProtectionAndConsistency(queryRunner);
    await this.createTimelineEnrichment(queryRunner);
    await this.createCommandFunction(queryRunner);
    await this.createKeyInventoryBoundary(queryRunner);
    await this.grantRuntime(queryRunner, runtimeRole);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertSafeRollback(queryRunner);
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.execute_lead_follow_up_command(
        uuid,uuid,uuid,uuid,app_private.lead_follow_up_command_enum,bigint,
        uuid,smallint,text,jsonb,public.lead_activity_type_enum,timestamptz,
        text,text,public.lead_next_action_type_enum,text,timestamptz,text
      ) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.required_lead_follow_up_fingerprint_key_versions()
       FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE SELECT ON public.lead_activities, public.lead_notes,
       public.lead_next_actions FROM "${runtimeRole}"`,
    );
    for (const statement of [
      'DROP TRIGGER TRG_lead_timeline_follow_up_enrichment ON public.lead_timeline_events',
      'DROP TRIGGER TRG_leads_next_action_consistency ON public.leads',
      'DROP TRIGGER TRG_lead_next_actions_consistency ON public.lead_next_actions',
      'DROP TRIGGER TRG_lead_activities_next_action_consistency ON public.lead_activities',
      'DROP TRIGGER TRG_lead_next_actions_protect ON public.lead_next_actions',
      'DROP TRIGGER TRG_lead_activities_append_only ON public.lead_activities',
      'DROP TRIGGER TRG_lead_activities_append_only_statement ON public.lead_activities',
      'DROP TRIGGER TRG_lead_activities_reject_truncate ON public.lead_activities',
      'DROP TRIGGER TRG_lead_notes_append_only ON public.lead_notes',
      'DROP TRIGGER TRG_lead_notes_append_only_statement ON public.lead_notes',
      'DROP TRIGGER TRG_lead_notes_reject_truncate ON public.lead_notes',
      'DROP TRIGGER TRG_organizations_crm_time_zone ON public.organizations',
    ]) {
      await queryRunner.query(statement);
    }
    for (const signature of [
      'app_private.execute_lead_follow_up_command(uuid,uuid,uuid,uuid,app_private.lead_follow_up_command_enum,bigint,uuid,smallint,text,jsonb,public.lead_activity_type_enum,timestamptz,text,text,public.lead_next_action_type_enum,text,timestamptz,text)',
      'app_private.required_lead_follow_up_fingerprint_key_versions()',
      'app_private.enrich_lead_follow_up_timeline()',
      'app_private.assert_lead_next_action_consistency()',
      'app_private.protect_lead_next_action_history()',
      'app_private.validate_organization_crm_time_zone()',
    ]) {
      await queryRunner.query(`DROP FUNCTION ${signature}`);
    }
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_follow_up_payload',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_lifecycle_payload',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_type',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT FK_lead_timeline_events_activity_org',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT FK_lead_timeline_events_note_org',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT FK_lead_timeline_events_next_action_org',
    );
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      DROP COLUMN next_action_cancellation_reason,
      DROP COLUMN next_action_revision,
      DROP COLUMN new_due_at,
      DROP COLUMN previous_due_at,
      DROP COLUMN new_next_action_status,
      DROP COLUMN previous_next_action_status,
      DROP COLUMN next_action_id,
      DROP COLUMN note_id,
      DROP COLUMN activity_id`);
    await this.restoreLegacyTimelineChecks(queryRunner);
    await queryRunner.query('DROP TABLE public.lead_follow_up_idempotency');
    await queryRunner.query('DROP TABLE public.lead_activities');
    await queryRunner.query('DROP TABLE public.lead_notes');
    await queryRunner.query('DROP TABLE public.lead_next_actions');
    await queryRunner.query(
      'ALTER TABLE public.organizations DROP COLUMN crm_time_zone',
    );
    await queryRunner.query(
      'DROP TYPE app_private.lead_follow_up_command_enum',
    );
    await queryRunner.query(
      'DROP TYPE public.lead_next_action_cancellation_reason_enum',
    );
    await queryRunner.query('DROP TYPE public.lead_next_action_status_enum');
    await queryRunner.query('DROP TYPE public.lead_next_action_type_enum');
    await queryRunner.query('DROP TYPE public.lead_activity_type_enum');
  }

  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE public.lead_activity_type_enum AS ENUM (
      'whatsapp','call','meeting','diagnosis','proposal_sent','follow_up','internal_task')`);
    await queryRunner.query(`CREATE TYPE public.lead_next_action_type_enum AS ENUM (
      'whatsapp','call','meeting','diagnosis','send_proposal','follow_up','internal_task')`);
    await queryRunner.query(`CREATE TYPE public.lead_next_action_status_enum AS ENUM (
      'pending','completed','canceled')`);
    await queryRunner.query(`CREATE TYPE public.lead_next_action_cancellation_reason_enum AS ENUM (
      'manual','lead_closed')`);
    await queryRunner.query(`CREATE TYPE app_private.lead_follow_up_command_enum AS ENUM (
      'create_activity','create_note','create_next_action','reschedule_next_action',
      'complete_next_action','cancel_next_action')`);
  }

  private async addOrganizationTimezone(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.organizations
      ADD COLUMN crm_time_zone varchar(64) NOT NULL DEFAULT 'America/Belem',
      ADD CONSTRAINT CHK_organizations_crm_time_zone_trimmed CHECK (
        crm_time_zone = btrim(crm_time_zone) AND length(crm_time_zone) BETWEEN 1 AND 64
      )`);
    await queryRunner.query(`
      CREATE FUNCTION app_private.validate_organization_crm_time_zone() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_timezone_names timezone
          WHERE timezone.name = NEW.crm_time_zone
        ) THEN
          RAISE EXCEPTION 'invalid organization time zone' USING ERRCODE = '22023';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.validate_organization_crm_time_zone() FROM PUBLIC',
    );
    await queryRunner.query(`CREATE TRIGGER TRG_organizations_crm_time_zone
      BEFORE INSERT OR UPDATE OF crm_time_zone ON public.organizations
      FOR EACH ROW EXECUTE FUNCTION app_private.validate_organization_crm_time_zone()`);
  }

  private async createTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.lead_next_actions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        cycle_id uuid NOT NULL,
        type public.lead_next_action_type_enum NOT NULL,
        description varchar(500) NOT NULL,
        due_at timestamptz NOT NULL,
        responsible_membership_id uuid,
        status public.lead_next_action_status_enum NOT NULL,
        revision bigint NOT NULL DEFAULT 1,
        created_by_membership_id uuid NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        completed_by_membership_id uuid,
        completed_at timestamptz,
        canceled_by_membership_id uuid,
        canceled_at timestamptz,
        cancellation_reason public.lead_next_action_cancellation_reason_enum,
        cancellation_note varchar(500),
        CONSTRAINT UQ_lead_next_actions_id_organization UNIQUE (id, organization_id),
        CONSTRAINT UQ_lead_next_actions_id_organization_lead UNIQUE (id, organization_id, lead_id),
        CONSTRAINT FK_lead_next_actions_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_next_actions_cycle_org FOREIGN KEY (cycle_id, organization_id, lead_id)
          REFERENCES public.lead_commercial_cycles(id, organization_id, lead_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_next_actions_responsible_org
          FOREIGN KEY (responsible_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_next_actions_creator_org
          FOREIGN KEY (created_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_next_actions_completer_org
          FOREIGN KEY (completed_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_next_actions_canceler_org
          FOREIGN KEY (canceled_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_next_actions_revision CHECK (revision >= 1),
        CONSTRAINT CHK_lead_next_actions_description CHECK (
          description = btrim(description) AND length(description) BETWEEN 1 AND 500
          AND description !~ '[[:cntrl:]]'
          AND strpos(description, U&'\\2028') = 0 AND strpos(description, U&'\\2029') = 0
        ),
        CONSTRAINT CHK_lead_next_actions_cancellation_note CHECK (
          cancellation_note IS NULL OR (
            cancellation_note = btrim(cancellation_note)
            AND length(cancellation_note) BETWEEN 1 AND 500
            AND cancellation_note !~ '[[:cntrl:]]'
            AND strpos(cancellation_note, U&'\\2028') = 0
            AND strpos(cancellation_note, U&'\\2029') = 0
          )
        ),
        CONSTRAINT CHK_lead_next_actions_state CHECK (
          (status = 'pending' AND completed_by_membership_id IS NULL AND completed_at IS NULL
            AND canceled_by_membership_id IS NULL AND canceled_at IS NULL
            AND cancellation_reason IS NULL AND cancellation_note IS NULL)
          OR (status = 'completed' AND completed_by_membership_id IS NOT NULL
            AND completed_at IS NOT NULL AND canceled_by_membership_id IS NULL
            AND canceled_at IS NULL AND cancellation_reason IS NULL AND cancellation_note IS NULL)
          OR (status = 'canceled' AND completed_by_membership_id IS NULL
            AND completed_at IS NULL AND canceled_by_membership_id IS NOT NULL
            AND canceled_at IS NOT NULL AND cancellation_reason IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_lead_next_actions_one_pending
      ON public.lead_next_actions (lead_id) WHERE status = 'pending'`);
    await queryRunner.query(`CREATE INDEX IDX_lead_next_actions_org_lead_created
      ON public.lead_next_actions (organization_id, lead_id, created_at DESC, id DESC)`);

    await queryRunner.query(`
      CREATE TABLE public.lead_activities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        cycle_id uuid NOT NULL,
        type public.lead_activity_type_enum NOT NULL,
        performed_at timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL,
        recorded_by_membership_id uuid NOT NULL,
        responsible_membership_id uuid,
        outcome varchar(2000),
        next_action_id uuid,
        CONSTRAINT UQ_lead_activities_id_organization UNIQUE (id, organization_id),
        CONSTRAINT UQ_lead_activities_id_organization_lead UNIQUE (id, organization_id, lead_id),
        CONSTRAINT UQ_lead_activities_next_action UNIQUE (next_action_id),
        CONSTRAINT FK_lead_activities_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_activities_cycle_org FOREIGN KEY (cycle_id, organization_id, lead_id)
          REFERENCES public.lead_commercial_cycles(id, organization_id, lead_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_activities_recorder_org
          FOREIGN KEY (recorded_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_activities_responsible_org
          FOREIGN KEY (responsible_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_activities_next_action_org
          FOREIGN KEY (next_action_id, organization_id, lead_id)
          REFERENCES public.lead_next_actions(id, organization_id, lead_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_activities_outcome CHECK (
          outcome IS NULL OR (
            outcome = btrim(outcome) AND length(outcome) BETWEEN 1 AND 2000
            AND regexp_replace(outcome, E'\\n', '', 'g') !~ '[[:cntrl:]]'
            AND strpos(outcome, U&'\\2028') = 0 AND strpos(outcome, U&'\\2029') = 0
          )
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_lead_activities_org_lead_performed
      ON public.lead_activities (organization_id, lead_id, performed_at, id)`);

    await queryRunner.query(`
      CREATE TABLE public.lead_notes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        cycle_id uuid NOT NULL,
        content varchar(4000) NOT NULL,
        author_membership_id uuid NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT UQ_lead_notes_id_organization UNIQUE (id, organization_id),
        CONSTRAINT UQ_lead_notes_id_organization_lead UNIQUE (id, organization_id, lead_id),
        CONSTRAINT FK_lead_notes_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_notes_cycle_org FOREIGN KEY (cycle_id, organization_id, lead_id)
          REFERENCES public.lead_commercial_cycles(id, organization_id, lead_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_notes_author_org FOREIGN KEY (author_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_notes_content CHECK (
          content = btrim(content) AND length(content) BETWEEN 1 AND 4000
          AND regexp_replace(content, E'\\n', '', 'g') !~ '[[:cntrl:]]'
          AND strpos(content, U&'\\2028') = 0 AND strpos(content, U&'\\2029') = 0
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_lead_notes_org_lead_created
      ON public.lead_notes (organization_id, lead_id, created_at, id)`);

    await queryRunner.query(`
      CREATE TABLE public.lead_follow_up_idempotency (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        actor_membership_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        command app_private.lead_follow_up_command_enum NOT NULL,
        idempotency_key uuid NOT NULL,
        fingerprint_key_version smallint NOT NULL,
        request_fingerprint char(64) NOT NULL,
        status varchar(16) NOT NULL,
        result_lead_revision bigint,
        result_activity_id uuid,
        result_note_id uuid,
        result_next_action_id uuid,
        response_status smallint,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT FK_lead_follow_up_idempotency_org FOREIGN KEY (organization_id)
          REFERENCES public.organizations(id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_follow_up_idempotency_actor_org
          FOREIGN KEY (actor_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_follow_up_idempotency_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT UQ_lead_follow_up_idempotency_scope
          UNIQUE (organization_id, actor_membership_id, command, idempotency_key),
        CONSTRAINT CHK_lead_follow_up_idempotency_fingerprint CHECK (
          fingerprint_key_version >= 1 AND request_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT CHK_lead_follow_up_idempotency_state CHECK (
          (status = 'processing' AND result_lead_revision IS NULL
            AND result_activity_id IS NULL AND result_note_id IS NULL
            AND result_next_action_id IS NULL AND response_status IS NULL)
          OR (status = 'completed' AND result_lead_revision IS NOT NULL
            AND response_status IN (201,204))
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_lead_follow_up_idempotency_key_version
      ON public.lead_follow_up_idempotency (fingerprint_key_version)`);
  }

  private async extendTimeline(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_lifecycle_payload',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_type',
    );
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD COLUMN activity_id uuid,
      ADD COLUMN note_id uuid,
      ADD COLUMN next_action_id uuid,
      ADD COLUMN previous_next_action_status public.lead_next_action_status_enum,
      ADD COLUMN new_next_action_status public.lead_next_action_status_enum,
      ADD COLUMN previous_due_at timestamptz,
      ADD COLUMN new_due_at timestamptz,
      ADD COLUMN next_action_revision bigint,
      ADD COLUMN next_action_cancellation_reason public.lead_next_action_cancellation_reason_enum,
      ADD CONSTRAINT FK_lead_timeline_events_activity_org
        FOREIGN KEY (activity_id, organization_id, lead_id)
        REFERENCES public.lead_activities(id, organization_id, lead_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_lead_timeline_events_note_org
        FOREIGN KEY (note_id, organization_id, lead_id)
        REFERENCES public.lead_notes(id, organization_id, lead_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_lead_timeline_events_next_action_org
        FOREIGN KEY (next_action_id, organization_id, lead_id)
        REFERENCES public.lead_next_actions(id, organization_id, lead_id) ON DELETE RESTRICT,
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
      ),
      ADD CONSTRAINT CHK_lead_timeline_events_follow_up_payload CHECK (
        (event_type = 'lead.activity.created'
          AND actor_membership_id IS NOT NULL AND cycle_id IS NOT NULL
          AND activity_id IS NOT NULL AND note_id IS NULL AND next_action_id IS NULL
          AND previous_next_action_status IS NULL AND new_next_action_status IS NULL
          AND previous_due_at IS NULL AND new_due_at IS NULL
          AND next_action_revision IS NULL AND next_action_cancellation_reason IS NULL)
        OR (event_type = 'lead.note.created'
          AND actor_membership_id IS NOT NULL AND cycle_id IS NOT NULL
          AND activity_id IS NULL AND note_id IS NOT NULL AND next_action_id IS NULL
          AND previous_next_action_status IS NULL AND new_next_action_status IS NULL
          AND previous_due_at IS NULL AND new_due_at IS NULL
          AND next_action_revision IS NULL AND next_action_cancellation_reason IS NULL)
        OR (event_type = 'lead.next_action.created'
          AND actor_membership_id IS NOT NULL AND cycle_id IS NOT NULL
          AND activity_id IS NULL AND note_id IS NULL AND next_action_id IS NOT NULL
          AND previous_next_action_status IS NULL AND new_next_action_status = 'pending'
          AND previous_due_at IS NULL AND new_due_at IS NOT NULL
          AND next_action_revision = 1 AND next_action_cancellation_reason IS NULL)
        OR (event_type = 'lead.next_action.rescheduled'
          AND actor_membership_id IS NOT NULL AND cycle_id IS NOT NULL
          AND activity_id IS NULL AND note_id IS NULL AND next_action_id IS NOT NULL
          AND previous_next_action_status = 'pending' AND new_next_action_status = 'pending'
          AND previous_due_at IS NOT NULL AND new_due_at IS NOT NULL
          AND previous_due_at <> new_due_at AND next_action_revision >= 2
          AND next_action_cancellation_reason IS NULL)
        OR (event_type = 'lead.next_action.completed'
          AND actor_membership_id IS NOT NULL AND cycle_id IS NOT NULL
          AND activity_id IS NOT NULL AND note_id IS NULL AND next_action_id IS NOT NULL
          AND previous_next_action_status = 'pending' AND new_next_action_status = 'completed'
          AND previous_due_at IS NOT NULL AND new_due_at = previous_due_at
          AND next_action_revision >= 2 AND next_action_cancellation_reason IS NULL)
        OR (event_type = 'lead.next_action.canceled'
          AND actor_membership_id IS NOT NULL AND cycle_id IS NOT NULL
          AND activity_id IS NULL AND note_id IS NULL AND next_action_id IS NOT NULL
          AND previous_next_action_status = 'pending' AND new_next_action_status = 'canceled'
          AND previous_due_at IS NOT NULL AND new_due_at = previous_due_at
          AND next_action_revision >= 2 AND next_action_cancellation_reason = 'manual')
        OR (event_type IN ('lead.assignment.changed','lead.assignment.cleared')
          AND activity_id IS NULL AND note_id IS NULL
          AND (
            (next_action_id IS NULL AND previous_next_action_status IS NULL
              AND new_next_action_status IS NULL AND previous_due_at IS NULL
              AND new_due_at IS NULL AND next_action_revision IS NULL
              AND next_action_cancellation_reason IS NULL)
            OR (next_action_id IS NOT NULL
              AND previous_next_action_status = 'pending'
              AND new_next_action_status = 'pending'
              AND previous_due_at IS NOT NULL AND new_due_at = previous_due_at
              AND next_action_revision >= 2
              AND next_action_cancellation_reason IS NULL)
          ))
        OR (event_type IN ('lead.won','lead.lost','lead.archived')
          AND activity_id IS NULL AND note_id IS NULL
          AND (
            (next_action_id IS NULL AND previous_next_action_status IS NULL
              AND new_next_action_status IS NULL AND previous_due_at IS NULL
              AND new_due_at IS NULL AND next_action_revision IS NULL
              AND next_action_cancellation_reason IS NULL)
            OR (next_action_id IS NOT NULL
              AND previous_next_action_status = 'pending'
              AND new_next_action_status = 'canceled'
              AND previous_due_at IS NOT NULL AND new_due_at = previous_due_at
              AND next_action_revision >= 2
              AND next_action_cancellation_reason = 'lead_closed')
          ))
        OR (event_type NOT IN (
            'lead.activity.created','lead.note.created','lead.next_action.created',
            'lead.next_action.rescheduled','lead.next_action.completed',
            'lead.next_action.canceled','lead.assignment.changed',
            'lead.assignment.cleared','lead.won','lead.lost','lead.archived'
          ) AND activity_id IS NULL AND note_id IS NULL AND next_action_id IS NULL
          AND previous_next_action_status IS NULL AND new_next_action_status IS NULL
          AND previous_due_at IS NULL AND new_due_at IS NULL
          AND next_action_revision IS NULL AND next_action_cancellation_reason IS NULL)
      )`);
  }

  private async createProtectionAndConsistency(
    queryRunner: QueryRunner,
  ): Promise<void> {
    for (const table of ['lead_activities', 'lead_notes']) {
      await queryRunner.query(`CREATE TRIGGER TRG_${table}_append_only
        BEFORE UPDATE OR DELETE ON public.${table} FOR EACH ROW
        EXECUTE FUNCTION app_private.reject_lead_append_only()`);
      await queryRunner.query(`CREATE TRIGGER TRG_${table}_append_only_statement
        BEFORE UPDATE OR DELETE ON public.${table} FOR EACH STATEMENT
        EXECUTE FUNCTION app_private.reject_lead_append_only()`);
      await queryRunner.query(`CREATE TRIGGER TRG_${table}_reject_truncate
        BEFORE TRUNCATE ON public.${table} FOR EACH STATEMENT
        EXECUTE FUNCTION app_private.reject_lead_truncate()`);
    }
    await queryRunner.query(`
      CREATE FUNCTION app_private.protect_lead_next_action_history() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status <> 'pending'
          OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
          OR NEW.lead_id <> OLD.lead_id OR NEW.cycle_id <> OLD.cycle_id
          OR NEW.type <> OLD.type OR NEW.description <> OLD.description
          OR NEW.created_by_membership_id <> OLD.created_by_membership_id
          OR NEW.created_at <> OLD.created_at OR NEW.revision <> OLD.revision + 1
          OR NEW.updated_at < OLD.updated_at THEN
          RAISE EXCEPTION 'next action history is immutable' USING ERRCODE = 'P3006';
        END IF;
        IF NEW.status = 'pending' THEN
          IF NEW.due_at IS NOT DISTINCT FROM OLD.due_at
            AND NEW.responsible_membership_id IS NOT DISTINCT FROM OLD.responsible_membership_id THEN
            RAISE EXCEPTION 'next action update is empty' USING ERRCODE = 'P3006';
          END IF;
        ELSIF NEW.status IN ('completed','canceled') THEN
          IF NEW.due_at <> OLD.due_at
            OR NEW.responsible_membership_id IS DISTINCT FROM OLD.responsible_membership_id THEN
            RAISE EXCEPTION 'invalid next action terminalization' USING ERRCODE = 'P3006';
          END IF;
        ELSE
          RAISE EXCEPTION 'invalid next action transition' USING ERRCODE = 'P3006';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.protect_lead_next_action_history() FROM PUBLIC',
    );
    await queryRunner.query(`CREATE TRIGGER TRG_lead_next_actions_protect
      BEFORE UPDATE OR DELETE ON public.lead_next_actions FOR EACH ROW
      EXECUTE FUNCTION app_private.protect_lead_next_action_history()`);

    await queryRunner.query(`
      CREATE FUNCTION app_private.assert_lead_next_action_consistency() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_lead_id uuid; v_lead public.leads%ROWTYPE;
        v_pending public.lead_next_actions%ROWTYPE; v_activity_count integer;
      BEGIN
        IF TG_TABLE_NAME = 'leads' THEN v_lead_id := COALESCE(NEW.id, OLD.id);
        ELSE v_lead_id := COALESCE(NEW.lead_id, OLD.lead_id); END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead WHERE lead.id = v_lead_id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT action.* INTO v_pending FROM public.lead_next_actions action
          WHERE action.lead_id = v_lead_id AND action.status = 'pending';
        IF v_lead.status = 'active' AND FOUND THEN
          IF v_pending.organization_id <> v_lead.organization_id
            OR v_pending.responsible_membership_id IS DISTINCT FROM v_lead.responsible_membership_id
            OR NOT EXISTS (
              SELECT 1 FROM public.lead_commercial_cycles cycle
              WHERE cycle.id = v_pending.cycle_id AND cycle.lead_id = v_lead.id
                AND cycle.organization_id = v_lead.organization_id AND cycle.closed_at IS NULL
            ) THEN
            RAISE EXCEPTION 'lead next action is inconsistent' USING ERRCODE = 'P3007';
          END IF;
        ELSIF v_lead.status <> 'active' AND FOUND THEN
          RAISE EXCEPTION 'closed lead has pending next action' USING ERRCODE = 'P3007';
        END IF;
        IF TG_TABLE_NAME = 'lead_next_actions' THEN
          IF COALESCE(NEW.status, OLD.status) = 'completed' THEN
            SELECT count(*)::integer INTO v_activity_count
            FROM public.lead_activities activity
            WHERE activity.next_action_id = COALESCE(NEW.id, OLD.id);
            IF v_activity_count <> 1 THEN
              RAISE EXCEPTION 'completed next action activity is inconsistent' USING ERRCODE = 'P3007';
            END IF;
          END IF;
        END IF;
        RETURN NULL;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.assert_lead_next_action_consistency() FROM PUBLIC',
    );
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_leads_next_action_consistency
      AFTER INSERT OR UPDATE ON public.leads DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION app_private.assert_lead_next_action_consistency()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_lead_next_actions_consistency
      AFTER INSERT OR UPDATE OR DELETE ON public.lead_next_actions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION app_private.assert_lead_next_action_consistency()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_lead_activities_next_action_consistency
      AFTER INSERT OR UPDATE OR DELETE ON public.lead_activities
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION app_private.assert_lead_next_action_consistency()`);
  }

  private async createTimelineEnrichment(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.enrich_lead_follow_up_timeline() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_action public.lead_next_actions%ROWTYPE;
      BEGIN
        IF NEW.event_type IN ('lead.assignment.changed','lead.assignment.cleared') THEN
          SELECT action.* INTO v_action FROM public.lead_next_actions action
          WHERE action.organization_id = NEW.organization_id AND action.lead_id = NEW.lead_id
            AND action.status = 'pending' FOR UPDATE;
          IF FOUND THEN
            UPDATE public.lead_next_actions action SET
              responsible_membership_id = NEW.new_responsible_membership_id,
              revision = action.revision + 1, updated_at = NEW.occurred_at
            WHERE action.id = v_action.id RETURNING * INTO v_action;
            NEW.next_action_id := v_action.id;
            NEW.previous_next_action_status := 'pending';
            NEW.new_next_action_status := 'pending';
            NEW.previous_due_at := v_action.due_at; NEW.new_due_at := v_action.due_at;
            NEW.next_action_revision := v_action.revision;
          END IF;
        ELSIF NEW.event_type IN ('lead.won','lead.lost','lead.archived') THEN
          SELECT action.* INTO v_action FROM public.lead_next_actions action
          WHERE action.organization_id = NEW.organization_id AND action.lead_id = NEW.lead_id
            AND action.status = 'pending' FOR UPDATE;
          IF FOUND THEN
            UPDATE public.lead_next_actions action SET status = 'canceled',
              revision = action.revision + 1, canceled_by_membership_id = NEW.actor_membership_id,
              canceled_at = NEW.occurred_at, cancellation_reason = 'lead_closed',
              updated_at = NEW.occurred_at
            WHERE action.id = v_action.id RETURNING * INTO v_action;
            NEW.next_action_id := v_action.id;
            NEW.previous_next_action_status := 'pending';
            NEW.new_next_action_status := 'canceled';
            NEW.previous_due_at := v_action.due_at; NEW.new_due_at := v_action.due_at;
            NEW.next_action_revision := v_action.revision;
            NEW.next_action_cancellation_reason := 'lead_closed';
          END IF;
        END IF;
        RETURN NEW;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.enrich_lead_follow_up_timeline() FROM PUBLIC',
    );
    await queryRunner.query(`CREATE TRIGGER TRG_lead_timeline_follow_up_enrichment
      BEFORE INSERT ON public.lead_timeline_events FOR EACH ROW
      EXECUTE FUNCTION app_private.enrich_lead_follow_up_timeline()`);
  }

  private async createCommandFunction(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.execute_lead_follow_up_command(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_lead_id uuid, p_command app_private.lead_follow_up_command_enum,
        p_expected_revision bigint, p_idempotency_key uuid,
        p_fingerprint_key_version smallint, p_request_fingerprint text,
        p_request_fingerprints jsonb, p_activity_type public.lead_activity_type_enum,
        p_performed_at timestamptz, p_activity_outcome text, p_note_content text,
        p_next_action_type public.lead_next_action_type_enum,
        p_next_action_description text, p_due_at timestamptz,
        p_cancellation_note text
      ) RETURNS TABLE (
        revision bigint, replayed boolean, response_status smallint,
        activity_id uuid, note_id uuid, next_action_id uuid
      )
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE
        v_actor public.memberships%ROWTYPE;
        v_lead public.leads%ROWTYPE;
        v_cycle public.lead_commercial_cycles%ROWTYPE;
        v_action public.lead_next_actions%ROWTYPE;
        v_claim public.lead_follow_up_idempotency%ROWTYPE;
        v_claim_id uuid; v_activity_id uuid; v_note_id uuid; v_action_id uuid;
        v_now timestamptz := transaction_timestamp(); v_previous_due_at timestamptz;
        v_changed boolean := true; v_response_status smallint;
        v_generated_type public.lead_activity_type_enum;
      BEGIN
        IF p_actor_user_id IS NULL OR p_actor_membership_id IS NULL
          OR p_organization_id IS NULL OR p_lead_id IS NULL OR p_command IS NULL
          OR p_expected_revision IS NULL OR p_idempotency_key IS NULL
          OR p_fingerprint_key_version IS NULL
          OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
          OR p_request_fingerprints IS NULL
          OR jsonb_typeof(p_request_fingerprints) <> 'object'
          OR COALESCE(p_request_fingerprints ->> p_fingerprint_key_version::text, '')
            <> p_request_fingerprint THEN
          RAISE EXCEPTION 'invalid lead follow up command' USING ERRCODE = '22023';
        END IF;
        IF (p_command = 'create_activity' AND (
              p_activity_type IS NULL OR p_performed_at IS NULL
              OR p_note_content IS NOT NULL OR p_next_action_type IS NOT NULL
              OR p_next_action_description IS NOT NULL OR p_due_at IS NOT NULL
              OR p_cancellation_note IS NOT NULL))
          OR (p_command = 'create_note' AND (
              p_activity_type IS NOT NULL OR p_performed_at IS NOT NULL
              OR p_activity_outcome IS NOT NULL OR p_note_content IS NULL
              OR p_next_action_type IS NOT NULL OR p_next_action_description IS NOT NULL
              OR p_due_at IS NOT NULL OR p_cancellation_note IS NOT NULL))
          OR (p_command = 'create_next_action' AND (
              p_activity_type IS NOT NULL OR p_performed_at IS NOT NULL
              OR p_activity_outcome IS NOT NULL OR p_note_content IS NOT NULL
              OR p_next_action_type IS NULL OR p_next_action_description IS NULL
              OR p_due_at IS NULL OR p_cancellation_note IS NOT NULL))
          OR (p_command = 'reschedule_next_action' AND (
              p_activity_type IS NOT NULL OR p_performed_at IS NOT NULL
              OR p_activity_outcome IS NOT NULL OR p_note_content IS NOT NULL
              OR p_next_action_type IS NOT NULL OR p_next_action_description IS NOT NULL
              OR p_due_at IS NULL OR p_cancellation_note IS NOT NULL))
          OR (p_command = 'complete_next_action' AND (
              p_activity_type IS NOT NULL OR p_performed_at IS NULL
              OR p_note_content IS NOT NULL OR p_next_action_type IS NOT NULL
              OR p_next_action_description IS NOT NULL OR p_due_at IS NOT NULL
              OR p_cancellation_note IS NOT NULL))
          OR (p_command = 'cancel_next_action' AND (
              p_activity_type IS NOT NULL OR p_performed_at IS NOT NULL
              OR p_activity_outcome IS NOT NULL OR p_note_content IS NOT NULL
              OR p_next_action_type IS NOT NULL OR p_next_action_description IS NOT NULL
              OR p_due_at IS NOT NULL)) THEN
          RAISE EXCEPTION 'invalid lead follow up payload' USING ERRCODE = '22023';
        END IF;
        IF p_activity_outcome IS NOT NULL AND (
          p_activity_outcome <> btrim(p_activity_outcome)
          OR length(p_activity_outcome) NOT BETWEEN 1 AND 2000
          OR regexp_replace(p_activity_outcome, E'\\n', '', 'g') ~ '[[:cntrl:]]'
          OR strpos(p_activity_outcome, U&'\\2028') > 0
          OR strpos(p_activity_outcome, U&'\\2029') > 0) THEN
          RAISE EXCEPTION 'invalid activity outcome' USING ERRCODE = '22023';
        END IF;
        IF p_note_content IS NOT NULL AND (
          p_note_content <> btrim(p_note_content)
          OR length(p_note_content) NOT BETWEEN 1 AND 4000
          OR regexp_replace(p_note_content, E'\\n', '', 'g') ~ '[[:cntrl:]]'
          OR strpos(p_note_content, U&'\\2028') > 0
          OR strpos(p_note_content, U&'\\2029') > 0) THEN
          RAISE EXCEPTION 'invalid lead note' USING ERRCODE = '22023';
        END IF;
        IF p_next_action_description IS NOT NULL AND (
          p_next_action_description <> btrim(p_next_action_description)
          OR length(p_next_action_description) NOT BETWEEN 1 AND 500
          OR p_next_action_description ~ '[[:cntrl:]]'
          OR strpos(p_next_action_description, U&'\\2028') > 0
          OR strpos(p_next_action_description, U&'\\2029') > 0) THEN
          RAISE EXCEPTION 'invalid next action description' USING ERRCODE = '22023';
        END IF;
        IF p_cancellation_note IS NOT NULL AND (
          p_cancellation_note <> btrim(p_cancellation_note)
          OR length(p_cancellation_note) NOT BETWEEN 1 AND 500
          OR p_cancellation_note ~ '[[:cntrl:]]'
          OR strpos(p_cancellation_note, U&'\\2028') > 0
          OR strpos(p_cancellation_note, U&'\\2029') > 0) THEN
          RAISE EXCEPTION 'invalid cancellation note' USING ERRCODE = '22023';
        END IF;

        SELECT membership.* INTO v_actor FROM public.memberships membership
        WHERE membership.id = p_actor_membership_id
          AND membership.user_id = p_actor_user_id
          AND membership.organization_id = p_organization_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM organization.id FROM public.organizations organization
        WHERE organization.id = p_organization_id AND organization.status = 'active'
        FOR UPDATE OF organization;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM application_user.id FROM public.users application_user
        WHERE application_user.id = p_actor_user_id ORDER BY application_user.id
        FOR UPDATE OF application_user;
        PERFORM membership.id FROM public.memberships membership
        WHERE membership.id = p_actor_membership_id ORDER BY membership.id
        FOR UPDATE OF membership;
        SELECT membership.* INTO v_actor FROM public.memberships membership
        JOIN public.users application_user ON application_user.id = membership.user_id
          AND application_user.status = 'active'
        WHERE membership.id = p_actor_membership_id
          AND membership.user_id = p_actor_user_id
          AND membership.organization_id = p_organization_id
          AND membership.status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
        WHERE lead.id = p_lead_id AND lead.organization_id = p_organization_id
        FOR UPDATE OF lead;
        IF NOT FOUND OR (v_actor.role = 'member'
          AND v_lead.responsible_membership_id IS DISTINCT FROM p_actor_membership_id) THEN
          RAISE EXCEPTION 'lead not found' USING ERRCODE = 'P3002';
        END IF;
        IF v_actor.role = 'member' AND v_lead.status <> 'active' THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
        END IF;
        INSERT INTO public.lead_follow_up_idempotency (
          organization_id, actor_membership_id, lead_id, command,
          idempotency_key, fingerprint_key_version, request_fingerprint, status
        ) VALUES (
          p_organization_id, p_actor_membership_id, p_lead_id, p_command,
          p_idempotency_key, p_fingerprint_key_version, p_request_fingerprint, 'processing'
        ) ON CONFLICT DO NOTHING RETURNING id INTO v_claim_id;
        IF v_claim_id IS NULL THEN
          SELECT claim.* INTO v_claim FROM public.lead_follow_up_idempotency claim
          WHERE claim.organization_id = p_organization_id
            AND claim.actor_membership_id = p_actor_membership_id
            AND claim.command = p_command AND claim.idempotency_key = p_idempotency_key
          FOR UPDATE;
          IF NOT FOUND OR v_claim.lead_id <> p_lead_id
            OR v_claim.request_fingerprint <>
              COALESCE(p_request_fingerprints ->> v_claim.fingerprint_key_version::text, '') THEN
            RAISE EXCEPTION 'idempotency fingerprint conflict' USING ERRCODE = 'P3004';
          END IF;
          IF v_claim.status <> 'completed' THEN
            RAISE EXCEPTION 'idempotency result unavailable' USING ERRCODE = 'P3005';
          END IF;
          RETURN QUERY SELECT v_claim.result_lead_revision, true,
            v_claim.response_status, v_claim.result_activity_id,
            v_claim.result_note_id, v_claim.result_next_action_id;
          RETURN;
        END IF;
        IF v_lead.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'lead revision conflict' USING ERRCODE = 'P3003';
        END IF;
        IF p_command IN ('create_next_action','reschedule_next_action',
          'complete_next_action','cancel_next_action') AND v_lead.status <> 'active' THEN
          RAISE EXCEPTION 'lead state conflict' USING ERRCODE = 'P3004';
        END IF;

        IF v_lead.status = 'active' THEN
          SELECT cycle.* INTO STRICT v_cycle FROM public.lead_commercial_cycles cycle
          WHERE cycle.organization_id = p_organization_id AND cycle.lead_id = v_lead.id
            AND cycle.closed_at IS NULL FOR UPDATE;
        ELSE
          SELECT cycle.* INTO STRICT v_cycle FROM public.lead_commercial_cycles cycle
          WHERE cycle.organization_id = p_organization_id AND cycle.lead_id = v_lead.id
            AND cycle.cycle_number = v_lead.next_cycle_number - 1 FOR UPDATE;
        END IF;

        IF p_command = 'create_activity' THEN
          IF p_performed_at < v_cycle.opened_at
            OR p_performed_at > COALESCE(v_cycle.closed_at, v_now + interval '5 minutes') THEN
            RAISE EXCEPTION 'activity outside commercial cycle' USING ERRCODE = '22023';
          END IF;
          INSERT INTO public.lead_activities (
            organization_id, lead_id, cycle_id, type, performed_at, recorded_at,
            recorded_by_membership_id, responsible_membership_id, outcome
          ) VALUES (
            p_organization_id, v_lead.id, v_cycle.id, p_activity_type,
            p_performed_at, v_now, p_actor_membership_id,
            v_lead.responsible_membership_id, p_activity_outcome
          ) RETURNING id INTO v_activity_id;
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            cycle_id, activity_id, occurred_at
          ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence,
            'lead.activity.created', p_actor_membership_id, v_cycle.id,
            v_activity_id, v_now);
        ELSIF p_command = 'create_note' THEN
          INSERT INTO public.lead_notes (
            organization_id, lead_id, cycle_id, content, author_membership_id, created_at
          ) VALUES (p_organization_id, v_lead.id, v_cycle.id, p_note_content,
            p_actor_membership_id, v_now) RETURNING id INTO v_note_id;
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            cycle_id, note_id, occurred_at
          ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence,
            'lead.note.created', p_actor_membership_id, v_cycle.id, v_note_id, v_now);
        ELSIF p_command = 'create_next_action' THEN
          IF EXISTS (SELECT 1 FROM public.lead_next_actions action
            WHERE action.organization_id = p_organization_id
              AND action.lead_id = v_lead.id AND action.status = 'pending') THEN
            RAISE EXCEPTION 'next action already pending' USING ERRCODE = 'P3004';
          END IF;
          INSERT INTO public.lead_next_actions (
            organization_id, lead_id, cycle_id, type, description, due_at,
            responsible_membership_id, status, revision, created_by_membership_id,
            created_at, updated_at
          ) VALUES (p_organization_id, v_lead.id, v_cycle.id, p_next_action_type,
            p_next_action_description, p_due_at, v_lead.responsible_membership_id,
            'pending', 1, p_actor_membership_id, v_now, v_now)
          RETURNING id INTO v_action_id;
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            cycle_id, next_action_id, new_next_action_status, new_due_at,
            next_action_revision, occurred_at
          ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence,
            'lead.next_action.created', p_actor_membership_id, v_cycle.id,
            v_action_id, 'pending', p_due_at, 1, v_now);
        ELSE
          SELECT action.* INTO v_action FROM public.lead_next_actions action
          WHERE action.organization_id = p_organization_id AND action.lead_id = v_lead.id
            AND action.status = 'pending' FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'next action state conflict' USING ERRCODE = 'P3004';
          END IF;
          v_action_id := v_action.id;
          IF p_command = 'reschedule_next_action' THEN
            IF v_action.due_at = p_due_at THEN
              v_changed := false;
            ELSE
              v_previous_due_at := v_action.due_at;
              UPDATE public.lead_next_actions action SET due_at = p_due_at,
                revision = action.revision + 1, updated_at = v_now
              WHERE action.id = v_action.id RETURNING * INTO v_action;
              INSERT INTO public.lead_timeline_events (
                organization_id, lead_id, sequence, event_type, actor_membership_id,
                cycle_id, next_action_id, previous_next_action_status,
                new_next_action_status, previous_due_at, new_due_at,
                next_action_revision, occurred_at
              ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence,
                'lead.next_action.rescheduled', p_actor_membership_id, v_cycle.id,
                v_action.id, 'pending', 'pending', v_previous_due_at,
                p_due_at, v_action.revision, v_now);
            END IF;
          ELSIF p_command = 'complete_next_action' THEN
            IF p_performed_at < v_cycle.opened_at OR p_performed_at > v_now + interval '5 minutes' THEN
              RAISE EXCEPTION 'activity outside commercial cycle' USING ERRCODE = '22023';
            END IF;
            v_generated_type := CASE v_action.type
              WHEN 'send_proposal' THEN 'proposal_sent'::public.lead_activity_type_enum
              ELSE v_action.type::text::public.lead_activity_type_enum END;
            INSERT INTO public.lead_activities (
              organization_id, lead_id, cycle_id, type, performed_at, recorded_at,
              recorded_by_membership_id, responsible_membership_id, outcome,
              next_action_id
            ) VALUES (p_organization_id, v_lead.id, v_cycle.id, v_generated_type,
              p_performed_at, v_now, p_actor_membership_id,
              v_action.responsible_membership_id, p_activity_outcome, v_action.id)
            RETURNING id INTO v_activity_id;
            UPDATE public.lead_next_actions action SET status = 'completed',
              revision = action.revision + 1,
              completed_by_membership_id = p_actor_membership_id,
              completed_at = v_now, updated_at = v_now
            WHERE action.id = v_action.id RETURNING * INTO v_action;
            INSERT INTO public.lead_timeline_events (
              organization_id, lead_id, sequence, event_type, actor_membership_id,
              cycle_id, activity_id, next_action_id, previous_next_action_status,
              new_next_action_status, previous_due_at, new_due_at,
              next_action_revision, occurred_at
            ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence,
              'lead.next_action.completed', p_actor_membership_id, v_cycle.id,
              v_activity_id, v_action.id, 'pending', 'completed', v_action.due_at,
              v_action.due_at, v_action.revision, v_now);
          ELSE
            UPDATE public.lead_next_actions action SET status = 'canceled',
              revision = action.revision + 1,
              canceled_by_membership_id = p_actor_membership_id,
              canceled_at = v_now, cancellation_reason = 'manual',
              cancellation_note = p_cancellation_note, updated_at = v_now
            WHERE action.id = v_action.id RETURNING * INTO v_action;
            INSERT INTO public.lead_timeline_events (
              organization_id, lead_id, sequence, event_type, actor_membership_id,
              cycle_id, next_action_id, previous_next_action_status,
              new_next_action_status, previous_due_at, new_due_at,
              next_action_revision, next_action_cancellation_reason, occurred_at
            ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence,
              'lead.next_action.canceled', p_actor_membership_id, v_cycle.id,
              v_action.id, 'pending', 'canceled', v_action.due_at, v_action.due_at,
              v_action.revision, 'manual', v_now);
          END IF;
        END IF;

        IF v_changed THEN
          UPDATE public.leads lead SET revision = lead.revision + 1,
            next_event_sequence = lead.next_event_sequence + 1, updated_at = v_now
          WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        END IF;
        v_response_status := CASE WHEN p_command IN (
          'create_activity','create_note','create_next_action') THEN 201 ELSE 204 END;
        UPDATE public.lead_follow_up_idempotency claim SET status = 'completed',
          result_lead_revision = v_lead.revision,
          result_activity_id = v_activity_id, result_note_id = v_note_id,
          result_next_action_id = v_action_id, response_status = v_response_status,
          updated_at = v_now WHERE claim.id = v_claim_id;
        RETURN QUERY SELECT v_lead.revision, false, v_response_status,
          v_activity_id, v_note_id, v_action_id;
      EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'lead follow up invariant unavailable' USING ERRCODE = 'P3007';
      END; $$
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION app_private.execute_lead_follow_up_command(
      uuid,uuid,uuid,uuid,app_private.lead_follow_up_command_enum,bigint,
      uuid,smallint,text,jsonb,public.lead_activity_type_enum,timestamptz,
      text,text,public.lead_next_action_type_enum,text,timestamptz,text
    ) FROM PUBLIC`);
  }

  private async createKeyInventoryBoundary(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.required_lead_follow_up_fingerprint_key_versions()
      RETURNS smallint[] LANGUAGE sql SECURITY DEFINER STABLE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
        SELECT COALESCE(
          array_agg(DISTINCT claim.fingerprint_key_version
            ORDER BY claim.fingerprint_key_version),
          ARRAY[]::smallint[]
        ) FROM public.lead_follow_up_idempotency claim
      $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.required_lead_follow_up_fingerprint_key_versions() FROM PUBLIC',
    );
  }

  private async grantRuntime(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    await queryRunner.query(
      `REVOKE ALL ON public.lead_activities, public.lead_notes,
       public.lead_next_actions, public.lead_follow_up_idempotency
       FROM PUBLIC, "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT ON public.lead_activities, public.lead_notes,
       public.lead_next_actions TO "${runtimeRole}"`,
    );
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION app_private.execute_lead_follow_up_command(
      uuid,uuid,uuid,uuid,app_private.lead_follow_up_command_enum,bigint,
      uuid,smallint,text,jsonb,public.lead_activity_type_enum,timestamptz,
      text,text,public.lead_next_action_type_enum,text,timestamptz,text
    ) TO "${runtimeRole}"`);
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.required_lead_follow_up_fingerprint_key_versions()
       TO "${runtimeRole}"`,
    );
  }

  private async assertSafeRollback(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`SELECT
      EXISTS (SELECT 1 FROM public.lead_activities)
      OR EXISTS (SELECT 1 FROM public.lead_notes)
      OR EXISTS (SELECT 1 FROM public.lead_next_actions)
      OR EXISTS (SELECT 1 FROM public.lead_follow_up_idempotency)
      OR EXISTS (SELECT 1 FROM public.lead_timeline_events event
        WHERE event.activity_id IS NOT NULL OR event.note_id IS NOT NULL
          OR event.next_action_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM public.organizations organization
        WHERE organization.crm_time_zone <> 'America/Belem') AS unsafe`)) as Array<{
      unsafe: boolean;
    }>;
    if (rows[0]?.unsafe !== false) {
      throw new Error(
        'Unsafe rollback: CRM activity or follow-up data already exists.',
      );
    }
  }

  private async restoreLegacyTimelineChecks(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD CONSTRAINT CHK_lead_timeline_events_type CHECK (event_type IN (
        'lead.created','lead.entry.received','lead.basic_data.updated',
        'lead.assignment.changed','lead.assignment.cleared','lead.stage.changed',
        'lead.won','lead.lost','lead.archived','lead.reactivated',
        'lead.return.received','lead.return.dismissed'
      )),
      ADD CONSTRAINT CHK_lead_timeline_events_lifecycle_payload CHECK (
        ${this.legacyTimelinePayloadExpression()}
      )`);
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
