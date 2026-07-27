import { MigrationInterface, QueryRunner } from 'typeorm';

export class ManageLeadCommercialPipeline1785433200000 implements MigrationInterface {
  name = 'ManageLeadCommercialPipeline1785433200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await this.createEnums(queryRunner);
    await this.extendLeads(queryRunner);
    await this.createCycles(queryRunner);
    await this.createReturnReviews(queryRunner);
    await this.createCommandIdempotency(queryRunner);
    await this.extendTimeline(queryRunner);
    await this.createLifecycleIntegrity(queryRunner);
    await this.createCommandFunction(queryRunner);
    await this.createIngestFunction(queryRunner);
    await this.createUpdateFunction(queryRunner);
    await this.createKeyInventoryBoundary(queryRunner);
    await this.grantRuntime(queryRunner, runtimeRole);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertSafeRollback(queryRunner);
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.execute_lead_command(
        uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,
        text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,
        public.lead_archive_reason_enum,text) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE SELECT ON public.lead_commercial_cycles,
       public.lead_return_reviews FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_lead_cycles_consistency ON public.lead_commercial_cycles',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_lead_return_reviews_consistency ON public.lead_return_reviews',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_leads_cycle_consistency ON public.leads',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_lead_return_reviews_protect ON public.lead_return_reviews',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_lead_cycles_protect ON public.lead_commercial_cycles',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_leads_state_transition ON public.leads',
    );
    await queryRunner.query(
      'DROP FUNCTION app_private.execute_lead_command(uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,public.lead_archive_reason_enum,text)',
    );
    await queryRunner.query(
      'DROP FUNCTION app_private.assert_lead_cycle_consistency()',
    );
    await queryRunner.query(
      'DROP FUNCTION app_private.protect_lead_return_review_history()',
    );
    await queryRunner.query(
      'DROP FUNCTION app_private.protect_lead_cycle_history()',
    );
    await queryRunner.query(
      'DROP FUNCTION app_private.enforce_lead_state_transition()',
    );
    await this.createLegacyIngestFunction(queryRunner);
    await this.createLegacyUpdateFunction(queryRunner);
    await this.createLegacyKeyInventoryBoundary(queryRunner);
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_lifecycle_payload',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_type',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT FK_lead_timeline_events_return_review_org',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT FK_lead_timeline_events_cycle_org',
    );
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      DROP COLUMN archive_reason, DROP COLUMN lost_reason,
      DROP COLUMN new_stage, DROP COLUMN previous_stage,
      DROP COLUMN new_status, DROP COLUMN previous_status,
      DROP COLUMN return_review_id, DROP COLUMN cycle_id`);
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD CONSTRAINT CHK_lead_timeline_events_type CHECK (event_type IN (
        'lead.created', 'lead.entry.received', 'lead.basic_data.updated',
        'lead.assignment.changed', 'lead.assignment.cleared'
      ))`);
    await queryRunner.query('DROP TABLE public.lead_command_idempotency');
    await queryRunner.query('DROP TABLE public.lead_return_reviews');
    await queryRunner.query('DROP TABLE public.lead_commercial_cycles');
    await queryRunner.query(
      'ALTER TABLE public.lead_entries DROP CONSTRAINT UQ_lead_entries_id_organization_lead',
    );
    await queryRunner.query(
      'DROP INDEX public.IDX_leads_organization_status_stage',
    );
    await queryRunner.query(`ALTER TABLE public.leads
      DROP CONSTRAINT CHK_leads_next_cycle_number,
      DROP COLUMN next_cycle_number, DROP COLUMN stage, DROP COLUMN status`);
    await queryRunner.query('DROP TYPE app_private.lead_command_enum');
    await queryRunner.query('DROP TYPE public.lead_return_review_status_enum');
    await queryRunner.query('DROP TYPE public.lead_cycle_opening_reason_enum');
    await queryRunner.query('DROP TYPE public.lead_archive_reason_enum');
    await queryRunner.query('DROP TYPE public.lead_lost_reason_enum');
    await queryRunner.query('DROP TYPE public.lead_stage_enum');
    await queryRunner.query('DROP TYPE public.lead_status_enum');
  }

  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE public.lead_status_enum AS ENUM ('active','won','lost','archived')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.lead_stage_enum AS ENUM ('new','qualification','diagnosis','proposal','negotiation')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.lead_lost_reason_enum AS ENUM ('not_qualified','no_response','no_budget','not_now','chose_competitor','other')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.lead_archive_reason_enum AS ENUM ('duplicate','spam','test','outdated','other')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.lead_cycle_opening_reason_enum AS ENUM ('created','reactivated')`,
    );
    await queryRunner.query(
      `CREATE TYPE public.lead_return_review_status_enum AS ENUM ('pending','dismissed','reactivated')`,
    );
    await queryRunner.query(
      `CREATE TYPE app_private.lead_command_enum AS ENUM ('move','win','lose','archive','reactivate','dismiss_return')`,
    );
  }

  private async extendLeads(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.leads
      ADD COLUMN status public.lead_status_enum NOT NULL DEFAULT 'active',
      ADD COLUMN stage public.lead_stage_enum NOT NULL DEFAULT 'new',
      ADD COLUMN next_cycle_number bigint NOT NULL DEFAULT 2,
      ADD CONSTRAINT CHK_leads_next_cycle_number CHECK (next_cycle_number >= 2)`);
    await queryRunner.query(`CREATE INDEX IDX_leads_organization_status_stage
      ON public.leads (organization_id, status, stage, created_at DESC, id DESC)`);
  }

  private async createCycles(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.lead_entries
      ADD CONSTRAINT UQ_lead_entries_id_organization_lead
      UNIQUE (id, organization_id, lead_id)`);
    await queryRunner.query(`
      CREATE TABLE public.lead_commercial_cycles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        cycle_number bigint NOT NULL,
        opening_reason public.lead_cycle_opening_reason_enum NOT NULL,
        starting_stage public.lead_stage_enum NOT NULL,
        opened_by_membership_id uuid,
        opened_at timestamptz NOT NULL,
        closed_by_membership_id uuid,
        closed_at timestamptz,
        closing_status public.lead_status_enum,
        stage_at_close public.lead_stage_enum,
        lost_reason public.lead_lost_reason_enum,
        archive_reason public.lead_archive_reason_enum,
        reason_note varchar(500),
        CONSTRAINT UQ_lead_commercial_cycles_id_organization UNIQUE (id, organization_id),
        CONSTRAINT UQ_lead_commercial_cycles_id_organization_lead
          UNIQUE (id, organization_id, lead_id),
        CONSTRAINT UQ_lead_commercial_cycles_lead_number UNIQUE (lead_id, cycle_number),
        CONSTRAINT FK_lead_commercial_cycles_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_commercial_cycles_opened_by_org
          FOREIGN KEY (opened_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_commercial_cycles_closed_by_org
          FOREIGN KEY (closed_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_commercial_cycles_number CHECK (cycle_number >= 1),
        CONSTRAINT CHK_lead_commercial_cycles_opening CHECK (
          opening_reason = 'created' OR opened_by_membership_id IS NOT NULL
        ),
        CONSTRAINT CHK_lead_commercial_cycles_note CHECK (
          reason_note IS NULL OR (
            reason_note = btrim(reason_note) AND length(reason_note) BETWEEN 1 AND 500
            AND reason_note !~ '[[:cntrl:]]'
          )
        ),
        CONSTRAINT CHK_lead_commercial_cycles_closure CHECK (
          (closed_at IS NULL AND closed_by_membership_id IS NULL
            AND closing_status IS NULL AND stage_at_close IS NULL
            AND lost_reason IS NULL AND archive_reason IS NULL AND reason_note IS NULL)
          OR
          (closed_at IS NOT NULL AND closed_by_membership_id IS NOT NULL
            AND closing_status IN ('won','lost','archived') AND stage_at_close IS NOT NULL
            AND (
              (closing_status = 'won' AND lost_reason IS NULL AND archive_reason IS NULL AND reason_note IS NULL)
              OR (closing_status = 'lost' AND lost_reason IS NOT NULL AND archive_reason IS NULL
                AND (lost_reason <> 'other' OR reason_note IS NOT NULL))
              OR (closing_status = 'archived' AND archive_reason IS NOT NULL AND lost_reason IS NULL
                AND (archive_reason <> 'other' OR reason_note IS NOT NULL))
            ))
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_lead_commercial_cycles_one_open
      ON public.lead_commercial_cycles (lead_id) WHERE closed_at IS NULL`);
    await queryRunner.query(`CREATE INDEX IDX_lead_commercial_cycles_org_lead_number
      ON public.lead_commercial_cycles (organization_id, lead_id, cycle_number DESC)`);
    await queryRunner.query(`INSERT INTO public.lead_commercial_cycles (
      organization_id, lead_id, cycle_number, opening_reason, starting_stage,
      opened_by_membership_id, opened_at
    ) SELECT lead.organization_id, lead.id, 1, 'created', 'new',
        lead.created_by_membership_id, lead.created_at
      FROM public.leads lead`);
  }

  private async createReturnReviews(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.lead_return_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        cycle_id uuid NOT NULL,
        status public.lead_return_review_status_enum NOT NULL,
        first_entry_id uuid NOT NULL,
        latest_entry_id uuid NOT NULL,
        entry_count bigint NOT NULL,
        opened_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        resolved_at timestamptz,
        resolved_by_membership_id uuid,
        CONSTRAINT UQ_lead_return_reviews_id_organization UNIQUE (id, organization_id),
        CONSTRAINT UQ_lead_return_reviews_id_organization_lead
          UNIQUE (id, organization_id, lead_id),
        CONSTRAINT FK_lead_return_reviews_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_return_reviews_cycle_org
          FOREIGN KEY (cycle_id, organization_id, lead_id)
          REFERENCES public.lead_commercial_cycles(id, organization_id, lead_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_return_reviews_first_entry_org
          FOREIGN KEY (first_entry_id, organization_id, lead_id)
          REFERENCES public.lead_entries(id, organization_id, lead_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_return_reviews_latest_entry_org
          FOREIGN KEY (latest_entry_id, organization_id, lead_id)
          REFERENCES public.lead_entries(id, organization_id, lead_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_return_reviews_resolver_org
          FOREIGN KEY (resolved_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_return_reviews_count CHECK (entry_count >= 1),
        CONSTRAINT CHK_lead_return_reviews_state CHECK (
          (status = 'pending' AND resolved_at IS NULL AND resolved_by_membership_id IS NULL)
          OR (status IN ('dismissed','reactivated')
            AND resolved_at IS NOT NULL AND resolved_by_membership_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_lead_return_reviews_one_pending
      ON public.lead_return_reviews (lead_id) WHERE status = 'pending'`);
    await queryRunner.query(`CREATE INDEX IDX_lead_return_reviews_org_status_lead
      ON public.lead_return_reviews (organization_id, status, lead_id)`);
  }

  private async createCommandIdempotency(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.lead_command_idempotency (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        actor_membership_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        command app_private.lead_command_enum NOT NULL,
        idempotency_key uuid NOT NULL,
        fingerprint_key_version smallint NOT NULL,
        request_fingerprint char(64) NOT NULL,
        status varchar(16) NOT NULL,
        result_revision bigint,
        result_changed boolean,
        response_status smallint,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT FK_lead_command_idempotency_organization FOREIGN KEY (organization_id)
          REFERENCES public.organizations(id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_command_idempotency_actor_org
          FOREIGN KEY (actor_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_command_idempotency_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT UQ_lead_command_idempotency_scope
          UNIQUE (organization_id, actor_membership_id, command, idempotency_key),
        CONSTRAINT CHK_lead_command_idempotency_fingerprint CHECK (
          fingerprint_key_version >= 1 AND request_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT CHK_lead_command_idempotency_state CHECK (
          (status = 'processing' AND result_revision IS NULL
            AND result_changed IS NULL AND response_status IS NULL)
          OR (status = 'completed' AND result_revision IS NOT NULL
            AND result_changed IS NOT NULL AND response_status = 204)
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_lead_command_idempotency_key_version
      ON public.lead_command_idempotency (fingerprint_key_version)`);
  }

  private async extendTimeline(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DROP CONSTRAINT CHK_lead_timeline_events_type',
    );
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD COLUMN cycle_id uuid,
      ADD COLUMN return_review_id uuid,
      ADD COLUMN previous_status public.lead_status_enum,
      ADD COLUMN new_status public.lead_status_enum,
      ADD COLUMN previous_stage public.lead_stage_enum,
      ADD COLUMN new_stage public.lead_stage_enum,
      ADD COLUMN lost_reason public.lead_lost_reason_enum,
      ADD COLUMN archive_reason public.lead_archive_reason_enum,
      ADD CONSTRAINT FK_lead_timeline_events_cycle_org
        FOREIGN KEY (cycle_id, organization_id, lead_id)
        REFERENCES public.lead_commercial_cycles(id, organization_id, lead_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_lead_timeline_events_return_review_org
        FOREIGN KEY (return_review_id, organization_id, lead_id)
        REFERENCES public.lead_return_reviews(id, organization_id, lead_id) ON DELETE RESTRICT,
      ADD CONSTRAINT CHK_lead_timeline_events_type CHECK (event_type IN (
        'lead.created', 'lead.entry.received', 'lead.basic_data.updated',
        'lead.assignment.changed', 'lead.assignment.cleared',
        'lead.stage.changed', 'lead.won', 'lead.lost', 'lead.archived',
        'lead.reactivated', 'lead.return.received', 'lead.return.dismissed'
      )),
      ADD CONSTRAINT CHK_lead_timeline_events_lifecycle_payload CHECK (
        (event_type IN ('lead.created','lead.entry.received','lead.basic_data.updated',
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
          AND new_responsible_membership_id IS NULL)
      )`);
  }

  private async createLifecycleIntegrity(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.enforce_lead_state_transition() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'active' OR NEW.stage <> 'new' OR NEW.next_cycle_number <> 2 THEN
            RAISE EXCEPTION 'invalid initial lead lifecycle' USING ERRCODE = 'P3007';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.next_cycle_number < OLD.next_cycle_number
          OR NEW.next_cycle_number > OLD.next_cycle_number + 1 THEN
          RAISE EXCEPTION 'invalid lead cycle sequence' USING ERRCODE = 'P3007';
        END IF;
        IF NEW.status = OLD.status THEN
          IF NEW.next_cycle_number <> OLD.next_cycle_number THEN
            RAISE EXCEPTION 'invalid lead cycle sequence' USING ERRCODE = 'P3007';
          END IF;
          IF OLD.status <> 'active' AND NEW.stage <> OLD.stage THEN
            RAISE EXCEPTION 'closed lead stage is immutable' USING ERRCODE = 'P3007';
          END IF;
        ELSIF OLD.status = 'active' AND NEW.status IN ('won','lost','archived') THEN
          IF NEW.stage <> OLD.stage OR NEW.next_cycle_number <> OLD.next_cycle_number THEN
            RAISE EXCEPTION 'invalid lead close transition' USING ERRCODE = 'P3007';
          END IF;
        ELSIF OLD.status IN ('won','lost','archived') AND NEW.status = 'active' THEN
          IF NEW.stage <> 'qualification'
            OR NEW.next_cycle_number <> OLD.next_cycle_number + 1 THEN
            RAISE EXCEPTION 'invalid lead reactivation' USING ERRCODE = 'P3007';
          END IF;
        ELSE
          RAISE EXCEPTION 'invalid lead status transition' USING ERRCODE = 'P3007';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_private.protect_lead_cycle_history() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
          OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
          OR NEW.lead_id <> OLD.lead_id OR NEW.cycle_number <> OLD.cycle_number
          OR NEW.opening_reason <> OLD.opening_reason
          OR NEW.starting_stage <> OLD.starting_stage
          OR NEW.opened_by_membership_id IS DISTINCT FROM OLD.opened_by_membership_id
          OR NEW.opened_at <> OLD.opened_at THEN
          RAISE EXCEPTION 'commercial cycle history is immutable' USING ERRCODE = 'P3006';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_private.protect_lead_return_review_history() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status <> 'pending'
          OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
          OR NEW.lead_id <> OLD.lead_id OR NEW.cycle_id <> OLD.cycle_id
          OR NEW.first_entry_id <> OLD.first_entry_id OR NEW.opened_at <> OLD.opened_at THEN
          RAISE EXCEPTION 'lead return review history is immutable' USING ERRCODE = 'P3006';
        END IF;
        IF NEW.status = 'pending' THEN
          IF NEW.latest_entry_id = OLD.latest_entry_id
            OR NEW.entry_count <> OLD.entry_count + 1
            OR NEW.updated_at < OLD.updated_at
            OR NEW.resolved_at IS NOT NULL OR NEW.resolved_by_membership_id IS NOT NULL THEN
            RAISE EXCEPTION 'invalid pending return aggregation' USING ERRCODE = 'P3006';
          END IF;
        ELSIF NEW.status IN ('dismissed','reactivated') THEN
          IF NEW.latest_entry_id <> OLD.latest_entry_id
            OR NEW.entry_count <> OLD.entry_count
            OR NEW.updated_at < OLD.updated_at
            OR NEW.resolved_at IS NULL OR NEW.resolved_by_membership_id IS NULL THEN
            RAISE EXCEPTION 'invalid return terminalization' USING ERRCODE = 'P3006';
          END IF;
        ELSE
          RAISE EXCEPTION 'invalid return review transition' USING ERRCODE = 'P3006';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_private.assert_lead_cycle_consistency() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE
        v_lead_id uuid;
        v_lead public.leads%ROWTYPE;
        v_cycle_count integer;
        v_open_count integer;
        v_pending_count integer;
        v_pending_cycle_id uuid;
        v_max_cycle bigint;
        v_latest public.lead_commercial_cycles%ROWTYPE;
      BEGIN
        IF TG_TABLE_NAME = 'leads' THEN
          v_lead_id := COALESCE(NEW.id, OLD.id);
        ELSE
          v_lead_id := COALESCE(NEW.lead_id, OLD.lead_id);
        END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead WHERE lead.id = v_lead_id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT count(*)::integer,
               count(*) FILTER (WHERE cycle.closed_at IS NULL)::integer,
               max(cycle.cycle_number)
          INTO v_cycle_count, v_open_count, v_max_cycle
          FROM public.lead_commercial_cycles cycle WHERE cycle.lead_id = v_lead_id;
        SELECT cycle.* INTO v_latest FROM public.lead_commercial_cycles cycle
          WHERE cycle.lead_id = v_lead_id
            AND cycle.cycle_number = v_lead.next_cycle_number - 1;
        SELECT count(*)::integer INTO v_pending_count
          FROM public.lead_return_reviews review
          WHERE review.lead_id = v_lead_id AND review.status = 'pending';
        SELECT review.cycle_id INTO v_pending_cycle_id
          FROM public.lead_return_reviews review
          WHERE review.lead_id = v_lead_id AND review.status = 'pending';
        IF v_cycle_count <> v_lead.next_cycle_number - 1
          OR v_max_cycle IS DISTINCT FROM v_lead.next_cycle_number - 1
          OR (v_lead.status = 'active' AND (
            v_open_count <> 1 OR v_latest.closed_at IS NOT NULL
            OR v_pending_count <> 0))
          OR (v_lead.status <> 'active' AND (
            v_open_count <> 0 OR v_latest.closed_at IS NULL
            OR v_latest.closing_status IS DISTINCT FROM v_lead.status
            OR v_latest.stage_at_close IS DISTINCT FROM v_lead.stage
            OR (v_pending_count = 1
              AND v_pending_cycle_id IS DISTINCT FROM v_latest.id))) THEN
          RAISE EXCEPTION 'lead and commercial cycle are inconsistent' USING ERRCODE = 'P3007';
        END IF;
        RETURN NULL;
      END; $$
    `);
    for (const name of [
      'enforce_lead_state_transition()',
      'protect_lead_cycle_history()',
      'protect_lead_return_review_history()',
      'assert_lead_cycle_consistency()',
    ]) {
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION app_private.${name} FROM PUBLIC`,
      );
    }
    await queryRunner.query(`CREATE TRIGGER TRG_leads_state_transition
      BEFORE INSERT OR UPDATE ON public.leads
      FOR EACH ROW EXECUTE FUNCTION app_private.enforce_lead_state_transition()`);
    await queryRunner.query(`CREATE TRIGGER TRG_lead_cycles_protect
      BEFORE UPDATE OR DELETE ON public.lead_commercial_cycles
      FOR EACH ROW EXECUTE FUNCTION app_private.protect_lead_cycle_history()`);
    await queryRunner.query(`CREATE TRIGGER TRG_lead_return_reviews_protect
      BEFORE UPDATE OR DELETE ON public.lead_return_reviews
      FOR EACH ROW EXECUTE FUNCTION app_private.protect_lead_return_review_history()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_leads_cycle_consistency
      AFTER INSERT OR UPDATE ON public.leads DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION app_private.assert_lead_cycle_consistency()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_lead_cycles_consistency
      AFTER INSERT OR UPDATE OR DELETE ON public.lead_commercial_cycles
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION app_private.assert_lead_cycle_consistency()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_lead_return_reviews_consistency
      AFTER INSERT OR UPDATE OR DELETE ON public.lead_return_reviews
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION app_private.assert_lead_cycle_consistency()`);
  }

  private async createCommandFunction(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.execute_lead_command(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_lead_id uuid, p_command app_private.lead_command_enum,
        p_expected_revision bigint, p_idempotency_key uuid,
        p_fingerprint_key_version smallint, p_request_fingerprint text,
        p_request_fingerprints jsonb, p_stage public.lead_stage_enum,
        p_lost_reason public.lead_lost_reason_enum,
        p_archive_reason public.lead_archive_reason_enum, p_reason_note text
      ) RETURNS TABLE (revision bigint, replayed boolean, response_status smallint)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE
        v_actor public.memberships%ROWTYPE;
        v_lead public.leads%ROWTYPE;
        v_claim public.lead_command_idempotency%ROWTYPE;
        v_claim_id uuid;
        v_cycle public.lead_commercial_cycles%ROWTYPE;
        v_review public.lead_return_reviews%ROWTYPE;
        v_new_cycle_id uuid;
        v_changed boolean := true;
        v_now timestamptz := transaction_timestamp();
        v_event_type text;
        v_new_status public.lead_status_enum;
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
          RAISE EXCEPTION 'invalid lead command' USING ERRCODE = '22023';
        END IF;
        IF (p_command = 'move' AND (p_stage IS NULL OR p_lost_reason IS NOT NULL
              OR p_archive_reason IS NOT NULL OR p_reason_note IS NOT NULL))
          OR (p_command IN ('win','reactivate','dismiss_return')
              AND (p_stage IS NOT NULL OR p_lost_reason IS NOT NULL
                OR p_archive_reason IS NOT NULL OR p_reason_note IS NOT NULL))
          OR (p_command = 'lose' AND (p_stage IS NOT NULL OR p_lost_reason IS NULL
                OR p_archive_reason IS NOT NULL))
          OR (p_command = 'archive' AND (p_stage IS NOT NULL OR p_lost_reason IS NOT NULL
                OR p_archive_reason IS NULL)) THEN
          RAISE EXCEPTION 'invalid lead command payload' USING ERRCODE = '22023';
        END IF;
        IF p_reason_note IS NOT NULL AND (
          p_reason_note <> btrim(p_reason_note) OR length(p_reason_note) NOT BETWEEN 1 AND 500
          OR p_reason_note ~ '[[:cntrl:]]'
          OR strpos(p_reason_note, U&'\\2028') > 0
          OR strpos(p_reason_note, U&'\\2029') > 0) THEN
          RAISE EXCEPTION 'invalid lead reason note' USING ERRCODE = '22023';
        END IF;
        IF (p_lost_reason = 'other' OR p_archive_reason = 'other')
          AND p_reason_note IS NULL THEN
          RAISE EXCEPTION 'reason note is required' USING ERRCODE = '22023';
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
        IF v_actor.role = 'member' AND p_command NOT IN ('move','win','lose') THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
        END IF;

        INSERT INTO public.lead_command_idempotency (
          organization_id, actor_membership_id, lead_id, command,
          idempotency_key, fingerprint_key_version, request_fingerprint, status
        ) VALUES (
          p_organization_id, p_actor_membership_id, p_lead_id, p_command,
          p_idempotency_key, p_fingerprint_key_version, p_request_fingerprint,
          'processing'
        ) ON CONFLICT DO NOTHING RETURNING id INTO v_claim_id;
        IF v_claim_id IS NULL THEN
          SELECT claim.* INTO v_claim FROM public.lead_command_idempotency claim
            WHERE claim.organization_id = p_organization_id
              AND claim.actor_membership_id = p_actor_membership_id
              AND claim.command = p_command
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

        IF p_command = 'move' THEN
          IF v_lead.status <> 'active' THEN
            RAISE EXCEPTION 'lead state conflict' USING ERRCODE = 'P3004';
          END IF;
          IF v_lead.stage = p_stage THEN
            v_changed := false;
          ELSE
            SELECT cycle.* INTO STRICT v_cycle
              FROM public.lead_commercial_cycles cycle
              WHERE cycle.lead_id = v_lead.id AND cycle.organization_id = p_organization_id
                AND cycle.closed_at IS NULL FOR UPDATE;
            INSERT INTO public.lead_timeline_events (
              organization_id, lead_id, sequence, event_type, actor_membership_id,
              cycle_id, previous_status, new_status, previous_stage, new_stage,
              occurred_at
            ) VALUES (
              p_organization_id, v_lead.id, v_lead.next_event_sequence,
              'lead.stage.changed', p_actor_membership_id, v_cycle.id,
              'active', 'active', v_lead.stage, p_stage, v_now
            );
            UPDATE public.leads lead SET stage = p_stage,
              revision = lead.revision + 1,
              next_event_sequence = lead.next_event_sequence + 1,
              updated_at = v_now WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
          END IF;
        ELSIF p_command IN ('win','lose','archive') THEN
          IF v_lead.status <> 'active' THEN
            RAISE EXCEPTION 'lead state conflict' USING ERRCODE = 'P3004';
          END IF;
          SELECT cycle.* INTO STRICT v_cycle
            FROM public.lead_commercial_cycles cycle
            WHERE cycle.lead_id = v_lead.id AND cycle.organization_id = p_organization_id
              AND cycle.closed_at IS NULL FOR UPDATE;
          v_new_status := CASE p_command
            WHEN 'win' THEN 'won'::public.lead_status_enum
            WHEN 'lose' THEN 'lost'::public.lead_status_enum
            ELSE 'archived'::public.lead_status_enum END;
          v_event_type := CASE p_command
            WHEN 'win' THEN 'lead.won'
            WHEN 'lose' THEN 'lead.lost'
            ELSE 'lead.archived' END;
          UPDATE public.lead_commercial_cycles cycle SET
            closed_by_membership_id = p_actor_membership_id,
            closed_at = v_now, closing_status = v_new_status,
            stage_at_close = v_lead.stage, lost_reason = p_lost_reason,
            archive_reason = p_archive_reason, reason_note = p_reason_note
            WHERE cycle.id = v_cycle.id;
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            cycle_id, previous_status, new_status, previous_stage, new_stage,
            lost_reason, archive_reason, occurred_at
          ) VALUES (
            p_organization_id, v_lead.id, v_lead.next_event_sequence,
            v_event_type, p_actor_membership_id, v_cycle.id, 'active',
            v_new_status, v_lead.stage, v_lead.stage, p_lost_reason,
            p_archive_reason, v_now
          );
          UPDATE public.leads lead SET status = v_new_status,
            revision = lead.revision + 1,
            next_event_sequence = lead.next_event_sequence + 1,
            updated_at = v_now WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        ELSIF p_command = 'reactivate' THEN
          IF v_lead.status = 'active' THEN
            RAISE EXCEPTION 'lead state conflict' USING ERRCODE = 'P3004';
          END IF;
          SELECT review.* INTO v_review FROM public.lead_return_reviews review
            WHERE review.lead_id = v_lead.id AND review.organization_id = p_organization_id
              AND review.status = 'pending' FOR UPDATE;
          IF FOUND THEN
            UPDATE public.lead_return_reviews review SET status = 'reactivated',
              resolved_at = v_now, resolved_by_membership_id = p_actor_membership_id,
              updated_at = v_now WHERE review.id = v_review.id;
          END IF;
          v_new_cycle_id := gen_random_uuid();
          INSERT INTO public.lead_commercial_cycles (
            id, organization_id, lead_id, cycle_number, opening_reason,
            starting_stage, opened_by_membership_id, opened_at
          ) VALUES (
            v_new_cycle_id, p_organization_id, v_lead.id,
            v_lead.next_cycle_number, 'reactivated', 'qualification',
            p_actor_membership_id, v_now
          );
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            cycle_id, return_review_id, previous_status, new_status,
            previous_stage, new_stage, occurred_at
          ) VALUES (
            p_organization_id, v_lead.id, v_lead.next_event_sequence,
            'lead.reactivated', p_actor_membership_id, v_new_cycle_id,
            v_review.id, v_lead.status, 'active', v_lead.stage,
            'qualification', v_now
          );
          UPDATE public.leads lead SET status = 'active', stage = 'qualification',
            revision = lead.revision + 1,
            next_cycle_number = lead.next_cycle_number + 1,
            next_event_sequence = lead.next_event_sequence + 1,
            updated_at = v_now WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        ELSE
          IF v_lead.status = 'active' THEN
            RAISE EXCEPTION 'lead state conflict' USING ERRCODE = 'P3004';
          END IF;
          SELECT review.* INTO v_review FROM public.lead_return_reviews review
            WHERE review.lead_id = v_lead.id AND review.organization_id = p_organization_id
              AND review.status = 'pending' FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'lead return state conflict' USING ERRCODE = 'P3004';
          END IF;
          UPDATE public.lead_return_reviews review SET status = 'dismissed',
            resolved_at = v_now, resolved_by_membership_id = p_actor_membership_id,
            updated_at = v_now WHERE review.id = v_review.id;
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            cycle_id, return_review_id, occurred_at
          ) VALUES (
            p_organization_id, v_lead.id, v_lead.next_event_sequence,
            'lead.return.dismissed', p_actor_membership_id, v_review.cycle_id,
            v_review.id, v_now
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
      `REVOKE ALL ON FUNCTION app_private.execute_lead_command(
        uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,
        text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,
        public.lead_archive_reason_enum,text) FROM PUBLIC`,
    );
  }

  private async createIngestFunction(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app_private.ingest_lead(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_intake_channel text, p_display_name text, p_primary_phone text,
        p_email text, p_company_name text, p_instagram text, p_city text,
        p_service_interest text, p_requested_responsible_membership_id uuid,
        p_source text, p_source_detail text, p_utm_source text, p_utm_medium text,
        p_utm_campaign text, p_utm_content text, p_utm_term text,
        p_idempotency_key uuid, p_fingerprint_key_version smallint,
        p_request_fingerprint text, p_request_fingerprints jsonb
      ) RETURNS TABLE (
        outcome text, lead_id uuid, entry_id uuid, revision bigint,
        replayed boolean, actor_can_view boolean, response_status smallint
      ) LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE
        v_actor public.memberships%ROWTYPE;
        v_actor_role public.membership_role_enum;
        v_target public.memberships%ROWTYPE;
        v_target_user_id uuid;
        v_lead public.leads%ROWTYPE;
        v_claim public.lead_ingest_idempotency%ROWTYPE;
        v_claim_id uuid;
        v_entry_id uuid := gen_random_uuid();
        v_cycle_id uuid;
        v_review public.lead_return_reviews%ROWTYPE;
        v_responsible_id uuid;
        v_outcome text;
        v_response smallint;
        v_now timestamptz := transaction_timestamp();
        v_event_sequence bigint;
        v_entry_sequence bigint;
        v_visible boolean := false;
      BEGIN
        IF p_organization_id IS NULL OR p_intake_channel NOT IN ('manual', 'genesis_form')
          OR p_display_name IS NULL OR p_primary_phone IS NULL OR p_source IS NULL
          OR p_idempotency_key IS NULL OR p_fingerprint_key_version IS NULL
          OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
          OR p_request_fingerprints IS NULL
          OR jsonb_typeof(p_request_fingerprints) <> 'object'
          OR COALESCE(p_request_fingerprints ->> p_fingerprint_key_version::text, '') <> p_request_fingerprint THEN
          RAISE EXCEPTION 'invalid lead ingest' USING ERRCODE = '22023';
        END IF;
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active'
          FOR UPDATE OF organization;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;

        IF p_intake_channel = 'manual' THEN
          IF p_actor_user_id IS NULL OR p_actor_membership_id IS NULL THEN
            RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
          END IF;
          SELECT membership.* INTO v_actor FROM public.memberships membership
            WHERE membership.id = p_actor_membership_id
              AND membership.user_id = p_actor_user_id
              AND membership.organization_id = p_organization_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
          IF p_requested_responsible_membership_id IS NOT NULL THEN
            SELECT membership.* INTO v_target FROM public.memberships membership
              WHERE membership.id = p_requested_responsible_membership_id
                AND membership.organization_id = p_organization_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'responsible member not found' USING ERRCODE = 'P3002'; END IF;
            v_target_user_id := v_target.user_id;
          END IF;
          PERFORM application_user.id FROM public.users application_user
            WHERE application_user.id = ANY(array_remove(ARRAY[p_actor_user_id, v_target_user_id]::uuid[], NULL))
            ORDER BY application_user.id FOR UPDATE OF application_user;
          PERFORM membership.id FROM public.memberships membership
            WHERE membership.id = ANY(array_remove(ARRAY[p_actor_membership_id, p_requested_responsible_membership_id]::uuid[], NULL))
            ORDER BY membership.id FOR UPDATE OF membership;
          SELECT membership.* INTO v_actor FROM public.memberships membership
            JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
            WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
              AND membership.organization_id = p_organization_id AND membership.status = 'active';
          IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
          v_actor_role := v_actor.role;
          IF v_actor_role = 'member' THEN
            IF p_requested_responsible_membership_id IS NOT NULL THEN
              RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
            END IF;
            v_responsible_id := p_actor_membership_id;
          ELSIF p_requested_responsible_membership_id IS NOT NULL THEN
            SELECT membership.* INTO v_target FROM public.memberships membership
              JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
              WHERE membership.id = p_requested_responsible_membership_id
                AND membership.organization_id = p_organization_id AND membership.status = 'active';
            IF NOT FOUND THEN RAISE EXCEPTION 'responsible member not found' USING ERRCODE = 'P3002'; END IF;
            v_responsible_id := v_target.id;
          END IF;
        ELSE
          IF p_actor_user_id IS NOT NULL OR p_actor_membership_id IS NOT NULL
            OR p_requested_responsible_membership_id IS NOT NULL THEN
            RAISE EXCEPTION 'invalid lead ingest' USING ERRCODE = '22023';
          END IF;
        END IF;

        SELECT claim.* INTO v_claim FROM public.lead_ingest_idempotency claim
          WHERE claim.organization_id = p_organization_id
            AND claim.idempotency_key = p_idempotency_key
            AND ((p_intake_channel = 'manual' AND claim.scope_type = 'manual'
                  AND claim.actor_membership_id = p_actor_membership_id)
              OR (p_intake_channel = 'genesis_form' AND claim.scope_type = 'form'
                  AND claim.intake_channel = 'genesis_form'));
        IF FOUND THEN
          IF v_claim.request_fingerprint <>
            COALESCE(p_request_fingerprints ->> v_claim.fingerprint_key_version::text, '') THEN
            RAISE EXCEPTION 'idempotency fingerprint conflict' USING ERRCODE = 'P3004';
          END IF;
          IF v_claim.status <> 'completed' THEN
            RAISE EXCEPTION 'idempotency result unavailable' USING ERRCODE = 'P3005';
          END IF;
          SELECT lead.* INTO v_lead FROM public.leads lead
            WHERE lead.id = v_claim.result_lead_id AND lead.organization_id = p_organization_id;
          v_visible := p_intake_channel = 'manual'
            AND (v_actor_role IN ('owner', 'admin') OR v_lead.responsible_membership_id = p_actor_membership_id);
          v_response := CASE WHEN p_intake_channel = 'genesis_form' OR v_actor_role = 'member' THEN 204 ELSE 200 END;
          RETURN QUERY SELECT v_claim.result_outcome::text, v_claim.result_lead_id,
            v_claim.result_entry_id, v_lead.revision, true, v_visible, v_response;
          RETURN;
        END IF;

        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.organization_id = p_organization_id AND lead.primary_phone = p_primary_phone
          FOR UPDATE OF lead;
        v_outcome := CASE WHEN FOUND THEN 'entry_added' ELSE 'created' END;
        IF v_outcome = 'created' THEN
          INSERT INTO public.leads (
            organization_id, display_name, primary_phone, email, company_name,
            instagram, city, service_interest, responsible_membership_id,
            created_by_membership_id, revision, next_entry_sequence,
            next_event_sequence, status, stage, next_cycle_number, created_at, updated_at
          ) VALUES (
            p_organization_id, p_display_name, p_primary_phone, p_email,
            p_company_name, p_instagram, p_city, p_service_interest,
            v_responsible_id, p_actor_membership_id, 0, 1, 1,
            'active', 'new', 2, v_now, v_now
          ) RETURNING * INTO v_lead;
        END IF;

        INSERT INTO public.lead_ingest_idempotency (
          organization_id, scope_type, actor_membership_id, intake_channel,
          idempotency_key, fingerprint_key_version, request_fingerprint, status
        ) VALUES (
          p_organization_id, CASE WHEN p_intake_channel = 'manual' THEN 'manual' ELSE 'form' END,
          p_actor_membership_id, p_intake_channel, p_idempotency_key,
          p_fingerprint_key_version, p_request_fingerprint, 'processing'
        ) ON CONFLICT DO NOTHING RETURNING id INTO v_claim_id;
        IF v_claim_id IS NULL THEN
          SELECT claim.* INTO v_claim FROM public.lead_ingest_idempotency claim
            WHERE claim.organization_id = p_organization_id
              AND claim.idempotency_key = p_idempotency_key
              AND ((p_intake_channel = 'manual' AND claim.scope_type = 'manual'
                    AND claim.actor_membership_id = p_actor_membership_id)
                OR (p_intake_channel = 'genesis_form' AND claim.scope_type = 'form'
                    AND claim.intake_channel = 'genesis_form')) FOR UPDATE;
          IF NOT FOUND OR v_claim.request_fingerprint <>
            COALESCE(p_request_fingerprints ->> v_claim.fingerprint_key_version::text, '') THEN
            RAISE EXCEPTION 'idempotency fingerprint conflict' USING ERRCODE = 'P3004';
          END IF;
          IF v_claim.status <> 'completed' THEN
            RAISE EXCEPTION 'idempotency result unavailable' USING ERRCODE = 'P3005';
          END IF;
          SELECT lead.* INTO v_lead FROM public.leads lead
            WHERE lead.id = v_claim.result_lead_id AND lead.organization_id = p_organization_id;
          v_visible := p_intake_channel = 'manual'
            AND (v_actor_role IN ('owner', 'admin') OR v_lead.responsible_membership_id = p_actor_membership_id);
          v_response := CASE WHEN p_intake_channel = 'genesis_form' OR v_actor_role = 'member' THEN 204 ELSE 200 END;
          RETURN QUERY SELECT v_claim.result_outcome::text, v_claim.result_lead_id,
            v_claim.result_entry_id, v_lead.revision, true, v_visible, v_response;
          RETURN;
        END IF;

        IF v_outcome = 'created' THEN
          INSERT INTO public.lead_commercial_cycles (
            organization_id, lead_id, cycle_number, opening_reason, starting_stage,
            opened_by_membership_id, opened_at
          ) VALUES (
            p_organization_id, v_lead.id, 1, 'created', 'new',
            p_actor_membership_id, v_now
          ) RETURNING id INTO v_cycle_id;
        END IF;
        v_entry_sequence := v_lead.next_entry_sequence;
        v_event_sequence := v_lead.next_event_sequence;
        INSERT INTO public.lead_entries (
          id, organization_id, lead_id, sequence, intake_channel, source,
          source_detail, utm_source, utm_medium, utm_campaign, utm_content,
          utm_term, actor_membership_id, received_at, created_at
        ) VALUES (
          v_entry_id, p_organization_id, v_lead.id, v_entry_sequence,
          p_intake_channel, p_source, p_source_detail, p_utm_source, p_utm_medium,
          p_utm_campaign, p_utm_content, p_utm_term, p_actor_membership_id, v_now, v_now
        );
        IF v_outcome = 'created' THEN
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id, occurred_at
          ) VALUES (p_organization_id, v_lead.id, v_event_sequence,
            'lead.created', p_actor_membership_id, v_now);
          v_event_sequence := v_event_sequence + 1;
        END IF;
        INSERT INTO public.lead_timeline_events (
          organization_id, lead_id, sequence, event_type, actor_membership_id,
          lead_entry_id, occurred_at
        ) VALUES (p_organization_id, v_lead.id, v_event_sequence,
          'lead.entry.received', p_actor_membership_id, v_entry_id, v_now);
        v_event_sequence := v_event_sequence + 1;
        IF v_outcome = 'created' AND v_responsible_id IS NOT NULL THEN
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            new_responsible_membership_id, occurred_at
          ) VALUES (p_organization_id, v_lead.id, v_event_sequence,
            'lead.assignment.changed', p_actor_membership_id, v_responsible_id, v_now);
          v_event_sequence := v_event_sequence + 1;
        ELSIF v_outcome = 'entry_added' AND v_lead.status <> 'active' THEN
          SELECT cycle.id INTO STRICT v_cycle_id FROM public.lead_commercial_cycles cycle
            WHERE cycle.organization_id = p_organization_id AND cycle.lead_id = v_lead.id
              AND cycle.cycle_number = v_lead.next_cycle_number - 1 AND cycle.closed_at IS NOT NULL
            FOR UPDATE;
          SELECT review.* INTO v_review FROM public.lead_return_reviews review
            WHERE review.organization_id = p_organization_id AND review.lead_id = v_lead.id
              AND review.status = 'pending' FOR UPDATE;
          IF NOT FOUND THEN
            INSERT INTO public.lead_return_reviews (
              organization_id, lead_id, cycle_id, first_entry_id, latest_entry_id,
              entry_count, status, opened_at, updated_at
            ) VALUES (
              p_organization_id, v_lead.id, v_cycle_id, v_entry_id, v_entry_id,
              1, 'pending', v_now, v_now
            ) RETURNING * INTO v_review;
            INSERT INTO public.lead_timeline_events (
              organization_id, lead_id, sequence, event_type, actor_membership_id,
              lead_entry_id, cycle_id, return_review_id, occurred_at
            ) VALUES (
              p_organization_id, v_lead.id, v_event_sequence, 'lead.return.received',
              p_actor_membership_id, v_entry_id, v_cycle_id, v_review.id, v_now
            );
            v_event_sequence := v_event_sequence + 1;
          ELSE
            UPDATE public.lead_return_reviews review SET latest_entry_id = v_entry_id,
              entry_count = review.entry_count + 1, updated_at = v_now
              WHERE review.id = v_review.id;
          END IF;
        END IF;
        UPDATE public.leads lead SET revision = lead.revision + 1,
          next_entry_sequence = v_entry_sequence + 1,
          next_event_sequence = v_event_sequence, updated_at = v_now
          WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        v_response := CASE
          WHEN p_intake_channel = 'genesis_form' OR v_actor_role = 'member' THEN 204
          WHEN v_outcome = 'created' THEN 201 ELSE 200 END;
        v_visible := p_intake_channel = 'manual'
          AND (v_actor_role IN ('owner', 'admin') OR v_lead.responsible_membership_id = p_actor_membership_id);
        UPDATE public.lead_ingest_idempotency claim SET status = 'completed',
          result_lead_id = v_lead.id, result_entry_id = v_entry_id,
          result_outcome = v_outcome, response_status = v_response, updated_at = v_now
          WHERE claim.id = v_claim_id;
        RETURN QUERY SELECT v_outcome, v_lead.id, v_entry_id, v_lead.revision,
          false, v_visible, v_response;
      EXCEPTION
        WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
          RAISE EXCEPTION 'lead lifecycle invariant unavailable' USING ERRCODE = 'P3007';
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb) FROM PUBLIC',
    );
  }

  private async createUpdateFunction(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app_private.update_lead(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_lead_id uuid, p_expected_revision bigint, p_display_name text,
        p_primary_phone text, p_email text, p_company_name text,
        p_instagram text, p_city text, p_service_interest text
      ) RETURNS TABLE (lead_id uuid, revision bigint, changed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_actor_role public.membership_role_enum; v_lead public.leads%ROWTYPE;
        v_fields text[]; v_now timestamptz := transaction_timestamp();
      BEGIN
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM application_user.id FROM public.users application_user
          WHERE application_user.id = p_actor_user_id FOR UPDATE;
        PERFORM membership.id FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id FOR UPDATE;
        SELECT membership.role INTO v_actor_role FROM public.memberships membership
          JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
          WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id AND membership.status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.id = p_lead_id AND lead.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND OR (v_actor_role = 'member'
          AND v_lead.responsible_membership_id IS DISTINCT FROM p_actor_membership_id) THEN
          RAISE EXCEPTION 'lead not found' USING ERRCODE = 'P3002';
        END IF;
        IF v_actor_role = 'member' AND v_lead.status <> 'active' THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
        END IF;
        IF v_lead.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'lead revision conflict' USING ERRCODE = 'P3003';
        END IF;
        v_fields := array_remove(ARRAY[
          CASE WHEN v_lead.display_name IS DISTINCT FROM p_display_name THEN 'displayName' END,
          CASE WHEN v_lead.primary_phone IS DISTINCT FROM p_primary_phone THEN 'primaryPhone' END,
          CASE WHEN v_lead.email IS DISTINCT FROM p_email THEN 'email' END,
          CASE WHEN v_lead.company_name IS DISTINCT FROM p_company_name THEN 'companyName' END,
          CASE WHEN v_lead.instagram IS DISTINCT FROM p_instagram THEN 'instagram' END,
          CASE WHEN v_lead.city IS DISTINCT FROM p_city THEN 'city' END,
          CASE WHEN v_lead.service_interest IS DISTINCT FROM p_service_interest THEN 'serviceInterest' END
        ]::text[], NULL);
        IF cardinality(v_fields) = 0 THEN RETURN QUERY SELECT v_lead.id, v_lead.revision, false; RETURN; END IF;
        UPDATE public.leads lead SET display_name = p_display_name,
          primary_phone = p_primary_phone, email = p_email, company_name = p_company_name,
          instagram = p_instagram, city = p_city, service_interest = p_service_interest,
          revision = lead.revision + 1, next_event_sequence = lead.next_event_sequence + 1,
          updated_at = v_now WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        INSERT INTO public.lead_timeline_events (
          organization_id, lead_id, sequence, event_type, actor_membership_id,
          changed_fields, occurred_at
        ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence - 1,
          'lead.basic_data.updated', p_actor_membership_id, v_fields, v_now);
        RETURN QUERY SELECT v_lead.id, v_lead.revision, true;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text) FROM PUBLIC',
    );
  }

  private async createKeyInventoryBoundary(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app_private.required_lead_fingerprint_key_versions()
      RETURNS smallint[] LANGUAGE sql SECURITY DEFINER STABLE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
        SELECT COALESCE(array_agg(DISTINCT inventory.key_version ORDER BY inventory.key_version),
          ARRAY[]::smallint[])
        FROM (
          SELECT claim.fingerprint_key_version AS key_version
            FROM public.lead_ingest_idempotency claim
          UNION
          SELECT claim.fingerprint_key_version AS key_version
            FROM public.lead_command_idempotency claim
        ) inventory
      $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.required_lead_fingerprint_key_versions() FROM PUBLIC',
    );
  }

  private async grantRuntime(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    await queryRunner.query(
      `REVOKE ALL ON public.lead_commercial_cycles, public.lead_return_reviews,
       public.lead_command_idempotency FROM PUBLIC, "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT ON public.lead_commercial_cycles, public.lead_return_reviews TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.execute_lead_command(
        uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,
        text,jsonb,public.lead_stage_enum,public.lead_lost_reason_enum,
        public.lead_archive_reason_enum,text) TO "${runtimeRole}"`,
    );
  }

  private async assertSafeRollback(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM public.lead_command_idempotency) OR
        EXISTS (SELECT 1 FROM public.lead_return_reviews) OR
        EXISTS (SELECT 1 FROM public.lead_timeline_events event WHERE event.event_type IN (
          'lead.stage.changed','lead.won','lead.lost','lead.archived','lead.reactivated',
          'lead.return.received','lead.return.dismissed')) OR
        EXISTS (SELECT 1 FROM public.leads lead WHERE lead.status <> 'active'
          OR lead.stage <> 'new' OR lead.next_cycle_number <> 2) OR
        EXISTS (
          SELECT 1 FROM public.leads lead
          LEFT JOIN public.lead_commercial_cycles cycle
            ON cycle.lead_id = lead.id AND cycle.organization_id = lead.organization_id
          GROUP BY lead.id
          HAVING count(cycle.id) <> 1 OR bool_or(
            cycle.cycle_number <> 1 OR cycle.opening_reason <> 'created'
            OR cycle.starting_stage <> 'new' OR cycle.opened_at <> lead.created_at
            OR cycle.opened_by_membership_id IS DISTINCT FROM lead.created_by_membership_id
            OR cycle.closed_at IS NOT NULL OR cycle.closed_by_membership_id IS NOT NULL
            OR cycle.closing_status IS NOT NULL OR cycle.stage_at_close IS NOT NULL
            OR cycle.lost_reason IS NOT NULL OR cycle.archive_reason IS NOT NULL
            OR cycle.reason_note IS NOT NULL)
        ) AS unsafe
    `)) as Array<{ unsafe: boolean }>;
    if (rows[0]?.unsafe !== false) {
      throw new Error(
        'Unsafe rollback: CRM pipeline lifecycle data already exists.',
      );
    }
  }

  // Legacy function bodies are restored by down() after the rollback safety gate.

  private async createLegacyIngestFunction(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app_private.ingest_lead(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_intake_channel text, p_display_name text, p_primary_phone text,
        p_email text, p_company_name text, p_instagram text, p_city text,
        p_service_interest text, p_requested_responsible_membership_id uuid,
        p_source text, p_source_detail text, p_utm_source text, p_utm_medium text,
        p_utm_campaign text, p_utm_content text, p_utm_term text,
        p_idempotency_key uuid, p_fingerprint_key_version smallint,
        p_request_fingerprint text, p_request_fingerprints jsonb
      ) RETURNS TABLE (
        outcome text, lead_id uuid, entry_id uuid, revision bigint,
        replayed boolean, actor_can_view boolean, response_status smallint
      ) LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE
        v_actor public.memberships%ROWTYPE;
        v_actor_role public.membership_role_enum;
        v_target public.memberships%ROWTYPE;
        v_target_user_id uuid;
        v_lead public.leads%ROWTYPE;
        v_claim public.lead_ingest_idempotency%ROWTYPE;
        v_claim_id uuid;
        v_entry_id uuid := gen_random_uuid();
        v_responsible_id uuid;
        v_outcome text;
        v_response smallint;
        v_now timestamptz := transaction_timestamp();
        v_event_sequence bigint;
        v_entry_sequence bigint;
        v_visible boolean := false;
      BEGIN
        IF p_organization_id IS NULL OR p_intake_channel NOT IN ('manual', 'genesis_form')
          OR p_display_name IS NULL OR p_primary_phone IS NULL OR p_source IS NULL
          OR p_idempotency_key IS NULL OR p_fingerprint_key_version IS NULL
          OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
          OR p_request_fingerprints IS NULL
          OR jsonb_typeof(p_request_fingerprints) <> 'object'
          OR COALESCE(p_request_fingerprints ->> p_fingerprint_key_version::text, '') <> p_request_fingerprint THEN
          RAISE EXCEPTION 'invalid lead ingest' USING ERRCODE = '22023';
        END IF;
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active'
          FOR UPDATE OF organization;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        IF p_intake_channel = 'manual' THEN
          IF p_actor_user_id IS NULL OR p_actor_membership_id IS NULL THEN
            RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
          END IF;
          SELECT membership.* INTO v_actor FROM public.memberships membership
            WHERE membership.id = p_actor_membership_id
              AND membership.user_id = p_actor_user_id
              AND membership.organization_id = p_organization_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
          IF p_requested_responsible_membership_id IS NOT NULL THEN
            SELECT membership.* INTO v_target FROM public.memberships membership
              WHERE membership.id = p_requested_responsible_membership_id
                AND membership.organization_id = p_organization_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'responsible member not found' USING ERRCODE = 'P3002'; END IF;
            v_target_user_id := v_target.user_id;
          END IF;
          PERFORM application_user.id FROM public.users application_user
            WHERE application_user.id = ANY(array_remove(ARRAY[p_actor_user_id, v_target_user_id]::uuid[], NULL))
            ORDER BY application_user.id FOR UPDATE OF application_user;
          PERFORM membership.id FROM public.memberships membership
            WHERE membership.id = ANY(array_remove(ARRAY[p_actor_membership_id, p_requested_responsible_membership_id]::uuid[], NULL))
            ORDER BY membership.id FOR UPDATE OF membership;
          SELECT membership.* INTO v_actor FROM public.memberships membership
            JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
            WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
              AND membership.organization_id = p_organization_id AND membership.status = 'active';
          IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
          v_actor_role := v_actor.role;
          IF v_actor_role = 'member' THEN
            IF p_requested_responsible_membership_id IS NOT NULL THEN
              RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001';
            END IF;
            v_responsible_id := p_actor_membership_id;
          ELSIF p_requested_responsible_membership_id IS NOT NULL THEN
            SELECT membership.* INTO v_target FROM public.memberships membership
              JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
              WHERE membership.id = p_requested_responsible_membership_id
                AND membership.organization_id = p_organization_id AND membership.status = 'active';
            IF NOT FOUND THEN RAISE EXCEPTION 'responsible member not found' USING ERRCODE = 'P3002'; END IF;
            v_responsible_id := v_target.id;
          END IF;
        ELSE
          IF p_actor_user_id IS NOT NULL OR p_actor_membership_id IS NOT NULL
            OR p_requested_responsible_membership_id IS NOT NULL THEN
            RAISE EXCEPTION 'invalid lead ingest' USING ERRCODE = '22023';
          END IF;
        END IF;
        INSERT INTO public.lead_ingest_idempotency (
          organization_id, scope_type, actor_membership_id, intake_channel,
          idempotency_key, fingerprint_key_version, request_fingerprint, status
        ) VALUES (
          p_organization_id, CASE WHEN p_intake_channel = 'manual' THEN 'manual' ELSE 'form' END,
          p_actor_membership_id, p_intake_channel, p_idempotency_key,
          p_fingerprint_key_version, p_request_fingerprint, 'processing'
        ) ON CONFLICT DO NOTHING RETURNING id INTO v_claim_id;
        IF v_claim_id IS NULL THEN
          SELECT claim.* INTO v_claim FROM public.lead_ingest_idempotency claim
            WHERE claim.organization_id = p_organization_id
              AND claim.idempotency_key = p_idempotency_key
              AND ((p_intake_channel = 'manual' AND claim.scope_type = 'manual'
                    AND claim.actor_membership_id = p_actor_membership_id)
                OR (p_intake_channel = 'genesis_form' AND claim.scope_type = 'form'
                    AND claim.intake_channel = 'genesis_form')) FOR UPDATE;
          IF NOT FOUND OR v_claim.request_fingerprint <>
            COALESCE(p_request_fingerprints ->> v_claim.fingerprint_key_version::text, '') THEN
            RAISE EXCEPTION 'idempotency fingerprint conflict' USING ERRCODE = 'P3004';
          END IF;
          IF v_claim.status <> 'completed' THEN
            RAISE EXCEPTION 'idempotency result unavailable' USING ERRCODE = 'P3005';
          END IF;
          SELECT lead.* INTO v_lead FROM public.leads lead
            WHERE lead.id = v_claim.result_lead_id AND lead.organization_id = p_organization_id;
          v_visible := p_intake_channel = 'manual'
            AND (v_actor_role IN ('owner', 'admin') OR v_lead.responsible_membership_id = p_actor_membership_id);
          v_response := CASE WHEN p_intake_channel = 'genesis_form' OR v_actor_role = 'member' THEN 204 ELSE 200 END;
          RETURN QUERY SELECT v_claim.result_outcome::text, v_claim.result_lead_id,
            v_claim.result_entry_id, v_lead.revision, true, v_visible, v_response;
          RETURN;
        END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.organization_id = p_organization_id AND lead.primary_phone = p_primary_phone
          FOR UPDATE OF lead;
        IF NOT FOUND THEN
          INSERT INTO public.leads (
            organization_id, display_name, primary_phone, email, company_name,
            instagram, city, service_interest, responsible_membership_id,
            created_by_membership_id, revision, next_entry_sequence,
            next_event_sequence, created_at, updated_at
          ) VALUES (
            p_organization_id, p_display_name, p_primary_phone, p_email,
            p_company_name, p_instagram, p_city, p_service_interest,
            v_responsible_id, p_actor_membership_id, 0, 1, 1, v_now, v_now
          ) RETURNING * INTO v_lead;
          v_outcome := 'created';
        ELSE
          v_outcome := 'entry_added';
        END IF;
        v_entry_sequence := v_lead.next_entry_sequence;
        v_event_sequence := v_lead.next_event_sequence;
        INSERT INTO public.lead_entries (
          id, organization_id, lead_id, sequence, intake_channel, source,
          source_detail, utm_source, utm_medium, utm_campaign, utm_content,
          utm_term, actor_membership_id, received_at, created_at
        ) VALUES (
          v_entry_id, p_organization_id, v_lead.id, v_entry_sequence,
          p_intake_channel, p_source, p_source_detail, p_utm_source, p_utm_medium,
          p_utm_campaign, p_utm_content, p_utm_term, p_actor_membership_id, v_now, v_now
        );
        IF v_outcome = 'created' THEN
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id, occurred_at
          ) VALUES (p_organization_id, v_lead.id, v_event_sequence,
            'lead.created', p_actor_membership_id, v_now);
          v_event_sequence := v_event_sequence + 1;
        END IF;
        INSERT INTO public.lead_timeline_events (
          organization_id, lead_id, sequence, event_type, actor_membership_id,
          lead_entry_id, occurred_at
        ) VALUES (p_organization_id, v_lead.id, v_event_sequence,
          'lead.entry.received', p_actor_membership_id, v_entry_id, v_now);
        v_event_sequence := v_event_sequence + 1;
        IF v_outcome = 'created' AND v_responsible_id IS NOT NULL THEN
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type, actor_membership_id,
            new_responsible_membership_id, occurred_at
          ) VALUES (p_organization_id, v_lead.id, v_event_sequence,
            'lead.assignment.changed', p_actor_membership_id, v_responsible_id, v_now);
          v_event_sequence := v_event_sequence + 1;
        END IF;
        UPDATE public.leads lead SET revision = lead.revision + 1,
          next_entry_sequence = v_entry_sequence + 1,
          next_event_sequence = v_event_sequence, updated_at = v_now
          WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        v_response := CASE
          WHEN p_intake_channel = 'genesis_form' OR v_actor_role = 'member' THEN 204
          WHEN v_outcome = 'created' THEN 201 ELSE 200 END;
        v_visible := p_intake_channel = 'manual'
          AND (v_actor_role IN ('owner', 'admin') OR v_lead.responsible_membership_id = p_actor_membership_id);
        UPDATE public.lead_ingest_idempotency claim SET status = 'completed',
          result_lead_id = v_lead.id, result_entry_id = v_entry_id,
          result_outcome = v_outcome, response_status = v_response, updated_at = v_now
          WHERE claim.id = v_claim_id;
        RETURN QUERY SELECT v_outcome, v_lead.id, v_entry_id, v_lead.revision,
          false, v_visible, v_response;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb) FROM PUBLIC',
    );
  }

  private async createLegacyUpdateFunction(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app_private.update_lead(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_lead_id uuid, p_expected_revision bigint, p_display_name text,
        p_primary_phone text, p_email text, p_company_name text,
        p_instagram text, p_city text, p_service_interest text
      ) RETURNS TABLE (lead_id uuid, revision bigint, changed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_actor_role public.membership_role_enum; v_lead public.leads%ROWTYPE;
        v_fields text[]; v_now timestamptz := transaction_timestamp();
      BEGIN
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM application_user.id FROM public.users application_user
          WHERE application_user.id = p_actor_user_id FOR UPDATE;
        PERFORM membership.id FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id FOR UPDATE;
        SELECT membership.role INTO v_actor_role FROM public.memberships membership
          JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
          WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id AND membership.status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.id = p_lead_id AND lead.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND OR (v_actor_role = 'member' AND v_lead.responsible_membership_id <> p_actor_membership_id) THEN
          RAISE EXCEPTION 'lead not found' USING ERRCODE = 'P3002';
        END IF;
        IF v_lead.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'lead revision conflict' USING ERRCODE = 'P3003';
        END IF;
        v_fields := array_remove(ARRAY[
          CASE WHEN v_lead.display_name IS DISTINCT FROM p_display_name THEN 'displayName' END,
          CASE WHEN v_lead.primary_phone IS DISTINCT FROM p_primary_phone THEN 'primaryPhone' END,
          CASE WHEN v_lead.email IS DISTINCT FROM p_email THEN 'email' END,
          CASE WHEN v_lead.company_name IS DISTINCT FROM p_company_name THEN 'companyName' END,
          CASE WHEN v_lead.instagram IS DISTINCT FROM p_instagram THEN 'instagram' END,
          CASE WHEN v_lead.city IS DISTINCT FROM p_city THEN 'city' END,
          CASE WHEN v_lead.service_interest IS DISTINCT FROM p_service_interest THEN 'serviceInterest' END
        ]::text[], NULL);
        IF cardinality(v_fields) = 0 THEN RETURN QUERY SELECT v_lead.id, v_lead.revision, false; RETURN; END IF;
        UPDATE public.leads lead SET display_name = p_display_name,
          primary_phone = p_primary_phone, email = p_email, company_name = p_company_name,
          instagram = p_instagram, city = p_city, service_interest = p_service_interest,
          revision = lead.revision + 1, next_event_sequence = lead.next_event_sequence + 1,
          updated_at = v_now WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        INSERT INTO public.lead_timeline_events (
          organization_id, lead_id, sequence, event_type, actor_membership_id,
          changed_fields, occurred_at
        ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence - 1,
          'lead.basic_data.updated', p_actor_membership_id, v_fields, v_now);
        RETURN QUERY SELECT v_lead.id, v_lead.revision, true;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text) FROM PUBLIC',
    );
  }

  private async createLegacyKeyInventoryBoundary(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION app_private.required_lead_fingerprint_key_versions()
      RETURNS smallint[] LANGUAGE sql SECURITY DEFINER STABLE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
        SELECT COALESCE(
          array_agg(DISTINCT claim.fingerprint_key_version ORDER BY claim.fingerprint_key_version),
          ARRAY[]::smallint[]
        ) FROM public.lead_ingest_idempotency claim
      $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.required_lead_fingerprint_key_versions() FROM PUBLIC',
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
