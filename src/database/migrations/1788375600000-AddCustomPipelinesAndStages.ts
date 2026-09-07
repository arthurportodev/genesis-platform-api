import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCustomPipelinesAndStages1788375600000 implements MigrationInterface {
  name = 'AddCustomPipelinesAndStages1788375600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await this.createCatalog(queryRunner);
    await this.provisionExistingOrganizations(queryRunner);
    await this.expandLifecycle(queryRunner);
    await this.backfillLifecycle(queryRunner);
    await this.installConstraints(queryRunner);
    await this.extendTimelineChecks(queryRunner);
    await this.installCompatibilityFunctions(queryRunner);
    await this.installConfigurationFunctions(queryRunner);
    await this.installDynamicLeadFunctions(queryRunner);
    await this.installGrants(queryRunner, runtimeRole);
    await this.assertBackfill(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertSafeRollback(queryRunner);
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await queryRunner.query(
      `REVOKE SELECT ON public.pipelines, public.pipeline_stages FROM "${runtimeRole}"`,
    );
    for (const signature of this.runtimeSignatures()) {
      await queryRunner.query(
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM "${runtimeRole}"`,
      );
      await queryRunner.query(`DROP FUNCTION ${signature}`);
    }
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_organizations_default_pipeline ON public.organizations',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_leads_pipeline_snapshot ON public.leads',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_leads_sync_open_cycle ON public.leads',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_cycles_pipeline_snapshot ON public.lead_commercial_cycles',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_timeline_pipeline_snapshot ON public.lead_timeline_events',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_pipelines_invariants ON public.pipelines',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_pipeline_stages_invariants ON public.pipeline_stages',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_leads_cycle_consistency ON public.leads',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_leads_state_transition ON public.leads',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_lead_cycles_consistency ON public.lead_commercial_cycles',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_lead_return_reviews_consistency ON public.lead_return_reviews',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_lead_cycles_protect ON public.lead_commercial_cycles',
    );
    for (const name of [
      'provision_default_pipeline()',
      'prepare_lead_pipeline_snapshot()',
      'sync_open_cycle_from_lead()',
      'prepare_cycle_pipeline_snapshot()',
      'prepare_timeline_pipeline_snapshot()',
      'assert_pipeline_invariants()',
      'legacy_position_for_stage(lead_stage_enum)',
      'legacy_stage_for_position(integer)',
      'assert_pipeline_admin(uuid,uuid,uuid)',
    ]) {
      await queryRunner.query(`DROP FUNCTION app_private.${name}`);
    }
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      DROP CONSTRAINT CHK_lead_timeline_events_lifecycle_payload,
      DROP CONSTRAINT CHK_lead_timeline_events_type`);
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      DROP CONSTRAINT IF EXISTS FK_timeline_previous_pipeline_stage_org,
      DROP CONSTRAINT IF EXISTS FK_timeline_new_pipeline_stage_org,
      DROP CONSTRAINT IF EXISTS CHK_timeline_previous_stage_snapshot,
      DROP CONSTRAINT IF EXISTS CHK_timeline_new_stage_snapshot,
      DROP COLUMN previous_pipeline_stage_id,
      DROP COLUMN previous_stage_name,
      DROP COLUMN new_pipeline_stage_id,
      DROP COLUMN new_stage_name`);
    await this.restoreTimelineChecks(queryRunner);
    await queryRunner.query(`ALTER TABLE public.lead_commercial_cycles
      DROP CONSTRAINT IF EXISTS FK_cycles_pipeline_org,
      DROP CONSTRAINT IF EXISTS FK_cycles_current_stage_org_pipeline,
      DROP CONSTRAINT IF EXISTS FK_cycles_starting_stage_org_pipeline,
      DROP CONSTRAINT IF EXISTS FK_cycles_close_stage_org_pipeline,
      DROP CONSTRAINT IF EXISTS CHK_cycles_dynamic_close,
      DROP COLUMN pipeline_id,
      DROP COLUMN pipeline_stage_id,
      DROP COLUMN starting_pipeline_stage_id,
      DROP COLUMN starting_stage_name,
      DROP COLUMN stage_at_close_pipeline_stage_id,
      DROP COLUMN stage_at_close_name`);
    await queryRunner.query(`ALTER TABLE public.leads
      DROP CONSTRAINT IF EXISTS FK_leads_pipeline_org,
      DROP CONSTRAINT IF EXISTS FK_leads_pipeline_stage_org_pipeline,
      DROP CONSTRAINT IF EXISTS CHK_leads_pipeline_snapshot,
      DROP CONSTRAINT IF EXISTS CHK_leads_next_cycle_number,
      DROP COLUMN pipeline_id,
      DROP COLUMN pipeline_stage_id,
      ADD CONSTRAINT CHK_leads_next_cycle_number CHECK (next_cycle_number >= 2)`);
    await queryRunner.query('DROP TABLE public.lead_cycle_start_idempotency');
    await queryRunner.query('DROP TABLE public.pipeline_stages');
    await queryRunner.query('DROP TABLE public.pipelines');
    await this.restoreLegacyLifecycleIntegrity(queryRunner);
  }

  private async createCatalog(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE public.pipelines (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      name varchar(160) NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      revision bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT UQ_pipelines_id_organization UNIQUE (id, organization_id),
      CONSTRAINT FK_pipelines_organization FOREIGN KEY (organization_id)
        REFERENCES public.organizations(id) ON DELETE RESTRICT,
      CONSTRAINT CHK_pipelines_name CHECK (
        name = btrim(name) AND length(name) BETWEEN 1 AND 160
        AND name !~ '[[:cntrl:]]' AND strpos(name, U&'\\2028') = 0
        AND strpos(name, U&'\\2029') = 0),
      CONSTRAINT CHK_pipelines_revision CHECK (revision >= 0)
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_pipelines_org_name_ci
      ON public.pipelines (organization_id, lower(normalize(name, NFC)))`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_pipelines_one_default
      ON public.pipelines (organization_id) WHERE is_default`);
    await queryRunner.query(`CREATE TABLE public.pipeline_stages (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      pipeline_id uuid NOT NULL,
      name varchar(120) NOT NULL,
      position integer NOT NULL,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT UQ_pipeline_stages_id_organization UNIQUE (id, organization_id),
      CONSTRAINT UQ_pipeline_stages_id_organization_pipeline
        UNIQUE (id, organization_id, pipeline_id),
      CONSTRAINT FK_pipeline_stages_pipeline_org
        FOREIGN KEY (pipeline_id, organization_id)
        REFERENCES public.pipelines(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT CHK_pipeline_stages_name CHECK (
        name = btrim(name) AND length(name) BETWEEN 1 AND 120
        AND name !~ '[[:cntrl:]]' AND strpos(name, U&'\\2028') = 0
        AND strpos(name, U&'\\2029') = 0),
      CONSTRAINT CHK_pipeline_stages_position CHECK (position >= 1)
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_pipeline_stages_active_name_ci
      ON public.pipeline_stages (organization_id, pipeline_id,
        lower(normalize(name, NFC))) WHERE archived_at IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_pipeline_stages_active_position
      ON public.pipeline_stages (organization_id, pipeline_id, position)
      WHERE archived_at IS NULL`);
  }

  private async provisionExistingOrganizations(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`INSERT INTO public.pipelines (
      id, organization_id, name, is_default, revision, created_at, updated_at)
      SELECT gen_random_uuid(), organization.id, 'Pipeline Comercial', true, 0,
        transaction_timestamp(), transaction_timestamp()
      FROM public.organizations organization`);
    await queryRunner.query(`INSERT INTO public.pipeline_stages (
      id, organization_id, pipeline_id, name, position, created_at, updated_at)
      SELECT gen_random_uuid(), pipeline.organization_id, pipeline.id,
        stage.name, stage.position, pipeline.created_at, pipeline.created_at
      FROM public.pipelines pipeline
      CROSS JOIN (VALUES (1, 'Novo'), (2, 'Qualificação'), (3, 'Diagnóstico'),
        (4, 'Proposta'), (5, 'Negociação')) AS stage(position, name)
      WHERE pipeline.is_default`);
  }

  private async expandLifecycle(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.lead_commercial_cycles DISABLE TRIGGER TRG_lead_cycles_protect',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DISABLE TRIGGER TRG_lead_timeline_events_append_only',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events DISABLE TRIGGER TRG_lead_timeline_events_append_only_statement',
    );
    await queryRunner.query(`ALTER TABLE public.leads
      ADD COLUMN pipeline_id uuid,
      ADD COLUMN pipeline_stage_id uuid`);
    await queryRunner.query(`ALTER TABLE public.lead_commercial_cycles
      ADD COLUMN pipeline_id uuid,
      ADD COLUMN pipeline_stage_id uuid,
      ADD COLUMN starting_pipeline_stage_id uuid,
      ADD COLUMN starting_stage_name varchar(120),
      ADD COLUMN stage_at_close_pipeline_stage_id uuid,
      ADD COLUMN stage_at_close_name varchar(120)`);
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD COLUMN previous_pipeline_stage_id uuid,
      ADD COLUMN previous_stage_name varchar(120),
      ADD COLUMN new_pipeline_stage_id uuid,
      ADD COLUMN new_stage_name varchar(120)`);
    await queryRunner.query(`CREATE TABLE public.lead_cycle_start_idempotency (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      actor_membership_id uuid NOT NULL,
      lead_id uuid NOT NULL,
      idempotency_key uuid NOT NULL,
      fingerprint_key_version smallint NOT NULL,
      request_fingerprint char(64) NOT NULL,
      status varchar(16) NOT NULL,
      result_revision bigint,
      response_status smallint,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT FK_cycle_start_idempotency_actor_org
        FOREIGN KEY (actor_membership_id, organization_id)
        REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT FK_cycle_start_idempotency_lead_org
        FOREIGN KEY (lead_id, organization_id)
        REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT UQ_cycle_start_idempotency_scope
        UNIQUE (organization_id, actor_membership_id, idempotency_key),
      CONSTRAINT CHK_cycle_start_idempotency_fingerprint CHECK (
        fingerprint_key_version >= 1 AND request_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT CHK_cycle_start_idempotency_state CHECK (
        (status = 'processing' AND result_revision IS NULL AND response_status IS NULL)
        OR (status = 'completed' AND result_revision IS NOT NULL AND response_status = 204))
    )`);
  }

  private async backfillLifecycle(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`WITH mapped AS (
      SELECT cycle.id AS cycle_id, pipeline.id AS pipeline_id,
        current_stage.id AS current_stage_id,
        starting_stage.id AS starting_stage_id, starting_stage.name AS starting_stage_name,
        close_stage.id AS close_stage_id, close_stage.name AS close_stage_name
      FROM public.lead_commercial_cycles cycle
      JOIN public.leads lead ON lead.id = cycle.lead_id
        AND lead.organization_id = cycle.organization_id
      JOIN public.pipelines pipeline ON pipeline.organization_id = cycle.organization_id
        AND pipeline.is_default
      JOIN public.pipeline_stages starting_stage ON starting_stage.pipeline_id = pipeline.id
        AND starting_stage.name = CASE cycle.starting_stage
          WHEN 'new' THEN 'Novo' WHEN 'qualification' THEN 'Qualificação'
          WHEN 'diagnosis' THEN 'Diagnóstico' WHEN 'proposal' THEN 'Proposta'
          WHEN 'negotiation' THEN 'Negociação' END
      JOIN public.pipeline_stages current_stage ON current_stage.pipeline_id = pipeline.id
        AND current_stage.name = CASE COALESCE(cycle.stage_at_close, lead.stage)
          WHEN 'new' THEN 'Novo' WHEN 'qualification' THEN 'Qualificação'
          WHEN 'diagnosis' THEN 'Diagnóstico' WHEN 'proposal' THEN 'Proposta'
          WHEN 'negotiation' THEN 'Negociação' END
      LEFT JOIN public.pipeline_stages close_stage ON close_stage.pipeline_id = pipeline.id
        AND close_stage.name = CASE cycle.stage_at_close
          WHEN 'new' THEN 'Novo' WHEN 'qualification' THEN 'Qualificação'
          WHEN 'diagnosis' THEN 'Diagnóstico' WHEN 'proposal' THEN 'Proposta'
          WHEN 'negotiation' THEN 'Negociação' END
    ) UPDATE public.lead_commercial_cycles cycle SET
      pipeline_id = mapped.pipeline_id, pipeline_stage_id = mapped.current_stage_id,
      starting_pipeline_stage_id = mapped.starting_stage_id,
      starting_stage_name = mapped.starting_stage_name,
      stage_at_close_pipeline_stage_id = mapped.close_stage_id,
      stage_at_close_name = mapped.close_stage_name
      FROM mapped WHERE cycle.id = mapped.cycle_id`);
    await queryRunner.query(`UPDATE public.leads lead SET
      pipeline_id = CASE WHEN lead.status = 'active' THEN cycle.pipeline_id ELSE NULL END,
      pipeline_stage_id = CASE WHEN lead.status = 'active' THEN cycle.pipeline_stage_id ELSE NULL END,
      next_cycle_number = counts.cycle_count + 1
      FROM (SELECT candidate.lead_id, count(*)::bigint AS cycle_count
        FROM public.lead_commercial_cycles candidate GROUP BY candidate.lead_id) counts
      JOIN public.lead_commercial_cycles cycle ON cycle.lead_id = counts.lead_id
        AND cycle.cycle_number = counts.cycle_count
      WHERE lead.id = counts.lead_id`);
    await queryRunner.query(`UPDATE public.leads lead SET next_cycle_number = 1
      WHERE NOT EXISTS (SELECT 1 FROM public.lead_commercial_cycles cycle
        WHERE cycle.lead_id = lead.id)`);
    await queryRunner.query(`WITH mapped AS (
      SELECT event.id AS event_id, previous_stage.id AS previous_stage_id,
        previous_stage.name AS previous_stage_name, new_stage.id AS new_stage_id,
        new_stage.name AS new_stage_name
      FROM public.lead_timeline_events event
      JOIN public.pipelines pipeline ON pipeline.organization_id = event.organization_id
        AND pipeline.is_default
      LEFT JOIN public.pipeline_stages previous_stage ON previous_stage.pipeline_id = pipeline.id
        AND previous_stage.name = CASE event.previous_stage
          WHEN 'new' THEN 'Novo' WHEN 'qualification' THEN 'Qualificação'
          WHEN 'diagnosis' THEN 'Diagnóstico' WHEN 'proposal' THEN 'Proposta'
          WHEN 'negotiation' THEN 'Negociação' END
      LEFT JOIN public.pipeline_stages new_stage ON new_stage.pipeline_id = pipeline.id
        AND new_stage.name = CASE event.new_stage
          WHEN 'new' THEN 'Novo' WHEN 'qualification' THEN 'Qualificação'
          WHEN 'diagnosis' THEN 'Diagnóstico' WHEN 'proposal' THEN 'Proposta'
          WHEN 'negotiation' THEN 'Negociação' END
      WHERE event.previous_stage IS NOT NULL OR event.new_stage IS NOT NULL
    ) UPDATE public.lead_timeline_events event SET
      previous_pipeline_stage_id = mapped.previous_stage_id,
      previous_stage_name = mapped.previous_stage_name,
      new_pipeline_stage_id = mapped.new_stage_id,
      new_stage_name = mapped.new_stage_name
      FROM mapped WHERE event.id = mapped.event_id`);
    await queryRunner.query(`SET CONSTRAINTS
      trg_leads_cycle_consistency,
      trg_lead_cycles_consistency,
      trg_leads_next_action_consistency IMMEDIATE`);
    await queryRunner.query(`SET CONSTRAINTS
      trg_leads_cycle_consistency,
      trg_lead_cycles_consistency,
      trg_leads_next_action_consistency DEFERRED`);
    await queryRunner.query(
      'ALTER TABLE public.lead_commercial_cycles ENABLE TRIGGER TRG_lead_cycles_protect',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events ENABLE TRIGGER TRG_lead_timeline_events_append_only',
    );
    await queryRunner.query(
      'ALTER TABLE public.lead_timeline_events ENABLE TRIGGER TRG_lead_timeline_events_append_only_statement',
    );
  }

  private async installConstraints(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.leads
      DROP CONSTRAINT CHK_leads_next_cycle_number,
      ADD CONSTRAINT CHK_leads_next_cycle_number CHECK (next_cycle_number >= 1),
      ADD CONSTRAINT CHK_leads_pipeline_snapshot CHECK (
        (pipeline_id IS NULL AND pipeline_stage_id IS NULL)
        OR (pipeline_id IS NOT NULL AND pipeline_stage_id IS NOT NULL)),
      ADD CONSTRAINT FK_leads_pipeline_org FOREIGN KEY (pipeline_id, organization_id)
        REFERENCES public.pipelines(id, organization_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_leads_pipeline_stage_org_pipeline
        FOREIGN KEY (pipeline_stage_id, organization_id, pipeline_id)
        REFERENCES public.pipeline_stages(id, organization_id, pipeline_id)
        ON DELETE RESTRICT`);
    await queryRunner.query(`CREATE INDEX IDX_leads_org_pipeline_stage
      ON public.leads (organization_id, pipeline_id, pipeline_stage_id, created_at DESC, id DESC)
      WHERE pipeline_id IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE public.lead_commercial_cycles
      ALTER COLUMN pipeline_id SET NOT NULL,
      ALTER COLUMN pipeline_stage_id SET NOT NULL,
      ALTER COLUMN starting_pipeline_stage_id SET NOT NULL,
      ALTER COLUMN starting_stage_name SET NOT NULL,
      ADD CONSTRAINT FK_cycles_pipeline_org FOREIGN KEY (pipeline_id, organization_id)
        REFERENCES public.pipelines(id, organization_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_cycles_current_stage_org_pipeline
        FOREIGN KEY (pipeline_stage_id, organization_id, pipeline_id)
        REFERENCES public.pipeline_stages(id, organization_id, pipeline_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_cycles_starting_stage_org_pipeline
        FOREIGN KEY (starting_pipeline_stage_id, organization_id, pipeline_id)
        REFERENCES public.pipeline_stages(id, organization_id, pipeline_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_cycles_close_stage_org_pipeline
        FOREIGN KEY (stage_at_close_pipeline_stage_id, organization_id, pipeline_id)
        REFERENCES public.pipeline_stages(id, organization_id, pipeline_id) ON DELETE RESTRICT,
      ADD CONSTRAINT CHK_cycles_dynamic_close CHECK (
        (closed_at IS NULL AND stage_at_close_pipeline_stage_id IS NULL
          AND stage_at_close_name IS NULL)
        OR (closed_at IS NOT NULL AND stage_at_close_pipeline_stage_id IS NOT NULL
          AND stage_at_close_name IS NOT NULL))`);
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD CONSTRAINT FK_timeline_previous_pipeline_stage_org
        FOREIGN KEY (previous_pipeline_stage_id, organization_id)
        REFERENCES public.pipeline_stages(id, organization_id) ON DELETE RESTRICT,
      ADD CONSTRAINT FK_timeline_new_pipeline_stage_org
        FOREIGN KEY (new_pipeline_stage_id, organization_id)
        REFERENCES public.pipeline_stages(id, organization_id) ON DELETE RESTRICT,
      ADD CONSTRAINT CHK_timeline_previous_stage_snapshot CHECK (
        (previous_pipeline_stage_id IS NULL AND previous_stage_name IS NULL)
        OR (previous_pipeline_stage_id IS NOT NULL AND previous_stage_name IS NOT NULL)),
      ADD CONSTRAINT CHK_timeline_new_stage_snapshot CHECK (
        (new_pipeline_stage_id IS NULL AND new_stage_name IS NULL)
        OR (new_pipeline_stage_id IS NOT NULL AND new_stage_name IS NOT NULL))`);
  }

  private async extendTimelineChecks(queryRunner: QueryRunner): Promise<void> {
    const names = [
      'chk_lead_timeline_events_type',
      'chk_lead_timeline_events_lifecycle_payload',
    ];
    const definitions = new Map<string, string>();
    for (const name of names) {
      const rows = (await queryRunner.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'public.lead_timeline_events'::regclass AND conname = $1`,
        [name],
      )) as Array<{ definition: string }>;
      if (rows[0]?.definition === undefined) {
        throw new Error(`Required timeline constraint is missing: ${name}`);
      }
      definitions.set(name, rows[0].definition.slice('CHECK '.length));
      await queryRunner.query(
        `ALTER TABLE public.lead_timeline_events DROP CONSTRAINT ${name}`,
      );
    }
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
      ADD CONSTRAINT CHK_lead_timeline_events_type CHECK (
        event_type = 'lead.cycle.started' OR ${definitions.get(names[0])}),
      ADD CONSTRAINT CHK_lead_timeline_events_lifecycle_payload CHECK (
        ${definitions.get(names[1])}
        OR (event_type = 'lead.stage.changed' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND previous_pipeline_stage_id IS NOT NULL
          AND new_pipeline_stage_id IS NOT NULL
          AND previous_pipeline_stage_id <> new_pipeline_stage_id)
        OR (event_type = 'lead.reactivated' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND previous_status IN ('won','lost','archived')
          AND new_status = 'active' AND new_pipeline_stage_id IS NOT NULL)
        OR (event_type = 'lead.cycle.started' AND actor_membership_id IS NOT NULL
          AND cycle_id IS NOT NULL AND previous_status = 'active'
          AND new_status = 'active' AND previous_pipeline_stage_id IS NULL
          AND new_pipeline_stage_id IS NOT NULL))`);
  }

  private async installCompatibilityFunctions(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`CREATE FUNCTION app_private.legacy_stage_for_position(
      p_position integer) RETURNS public.lead_stage_enum LANGUAGE sql IMMUTABLE STRICT
      SET search_path = pg_catalog, pg_temp AS $$ SELECT CASE ((p_position - 1) % 5) + 1
        WHEN 1 THEN 'new'::public.lead_stage_enum
        WHEN 2 THEN 'qualification'::public.lead_stage_enum
        WHEN 3 THEN 'diagnosis'::public.lead_stage_enum
        WHEN 4 THEN 'proposal'::public.lead_stage_enum
        ELSE 'negotiation'::public.lead_stage_enum END $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.legacy_position_for_stage(
      p_stage public.lead_stage_enum) RETURNS integer LANGUAGE sql IMMUTABLE STRICT
      SET search_path = pg_catalog, pg_temp AS $$ SELECT CASE p_stage
        WHEN 'new' THEN 1 WHEN 'qualification' THEN 2 WHEN 'diagnosis' THEN 3
        WHEN 'proposal' THEN 4 WHEN 'negotiation' THEN 5 END $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.provision_default_pipeline()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_pipeline_id uuid := gen_random_uuid(); v_now timestamptz := transaction_timestamp();
      BEGIN
        INSERT INTO public.pipelines (id, organization_id, name, is_default,
          revision, created_at, updated_at) VALUES
          (v_pipeline_id, NEW.id, 'Pipeline Comercial', true, 0, v_now, v_now);
        INSERT INTO public.pipeline_stages (id, organization_id, pipeline_id,
          name, position, created_at, updated_at)
          SELECT gen_random_uuid(), NEW.id, v_pipeline_id, stage.name,
            stage.position, v_now, v_now
          FROM (VALUES (1, 'Novo'), (2, 'Qualificação'), (3, 'Diagnóstico'),
            (4, 'Proposta'), (5, 'Negociação')) AS stage(position, name);
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER TRG_organizations_default_pipeline
      AFTER INSERT ON public.organizations FOR EACH ROW
      EXECUTE FUNCTION app_private.provision_default_pipeline()`);

    await queryRunner.query(`CREATE FUNCTION app_private.prepare_lead_pipeline_snapshot()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_selection text := current_setting('app_private.pipeline_selection', true);
        v_pipeline_id uuid; v_stage public.pipeline_stages%ROWTYPE;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF v_selection = 'none' THEN
            NEW.pipeline_id := NULL; NEW.pipeline_stage_id := NULL;
            NEW.next_cycle_number := 1; RETURN NEW;
          END IF;
          IF v_selection = 'pipeline' THEN
            BEGIN
              v_pipeline_id := nullif(current_setting('app_private.pipeline_id', true), '')::uuid;
            EXCEPTION WHEN invalid_text_representation THEN
              RAISE EXCEPTION 'pipeline not found' USING ERRCODE = 'P3002';
            END;
            SELECT stage.* INTO v_stage FROM public.pipeline_stages stage
              JOIN public.pipelines pipeline ON pipeline.id = stage.pipeline_id
                AND pipeline.organization_id = stage.organization_id
              WHERE pipeline.id = v_pipeline_id AND pipeline.organization_id = NEW.organization_id
                AND stage.archived_at IS NULL ORDER BY stage.position LIMIT 1;
            IF NOT FOUND THEN RAISE EXCEPTION 'pipeline not found' USING ERRCODE = 'P3002'; END IF;
          ELSE
            SELECT stage.* INTO v_stage FROM public.pipelines pipeline
              JOIN public.pipeline_stages stage ON stage.pipeline_id = pipeline.id
                AND stage.organization_id = pipeline.organization_id
              WHERE pipeline.organization_id = NEW.organization_id AND pipeline.is_default
                AND stage.archived_at IS NULL
                AND stage.position = app_private.legacy_position_for_stage(NEW.stage);
            IF NOT FOUND THEN RAISE EXCEPTION 'default pipeline unavailable' USING ERRCODE = 'P3007'; END IF;
          END IF;
          NEW.pipeline_id := v_stage.pipeline_id;
          NEW.pipeline_stage_id := v_stage.id;
          NEW.stage := app_private.legacy_stage_for_position(v_stage.position);
          RETURN NEW;
        END IF;

        IF NEW.status <> 'active' THEN
          NEW.pipeline_id := NULL; NEW.pipeline_stage_id := NULL;
        ELSIF OLD.status <> 'active' AND NEW.status = 'active'
          AND NEW.pipeline_id IS NULL THEN
          SELECT stage.* INTO STRICT v_stage FROM public.pipelines pipeline
            JOIN public.pipeline_stages stage ON stage.pipeline_id = pipeline.id
              AND stage.organization_id = pipeline.organization_id
            WHERE pipeline.organization_id = NEW.organization_id AND pipeline.is_default
              AND stage.archived_at IS NULL ORDER BY stage.position LIMIT 1;
          NEW.pipeline_id := v_stage.pipeline_id; NEW.pipeline_stage_id := v_stage.id;
          NEW.stage := app_private.legacy_stage_for_position(v_stage.position);
        ELSIF NEW.status = 'active' AND NEW.pipeline_id IS NOT NULL
          AND NEW.stage IS DISTINCT FROM OLD.stage
          AND NEW.pipeline_stage_id IS NOT DISTINCT FROM OLD.pipeline_stage_id THEN
          SELECT stage.* INTO v_stage FROM public.pipeline_stages stage
            WHERE stage.organization_id = NEW.organization_id
              AND stage.pipeline_id = NEW.pipeline_id AND stage.archived_at IS NULL
              AND stage.position = app_private.legacy_position_for_stage(NEW.stage);
          IF NOT FOUND THEN RAISE EXCEPTION 'lead stage conflict' USING ERRCODE = 'P3004'; END IF;
          NEW.pipeline_stage_id := v_stage.id;
        END IF;
        IF (NEW.pipeline_id IS NULL) <> (NEW.pipeline_stage_id IS NULL) THEN
          RAISE EXCEPTION 'invalid lead pipeline snapshot' USING ERRCODE = 'P3007';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER TRG_leads_pipeline_snapshot
      BEFORE INSERT OR UPDATE ON public.leads FOR EACH ROW
      EXECUTE FUNCTION app_private.prepare_lead_pipeline_snapshot()`);

    await queryRunner.query(`CREATE FUNCTION app_private.sync_open_cycle_from_lead()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF NEW.status = 'active' AND NEW.pipeline_stage_id IS NOT NULL
          AND (NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
            OR NEW.pipeline_stage_id IS DISTINCT FROM OLD.pipeline_stage_id) THEN
          UPDATE public.lead_commercial_cycles cycle SET
            pipeline_id = NEW.pipeline_id, pipeline_stage_id = NEW.pipeline_stage_id
            WHERE cycle.organization_id = NEW.organization_id AND cycle.lead_id = NEW.id
              AND cycle.closed_at IS NULL
              AND (cycle.pipeline_id IS DISTINCT FROM NEW.pipeline_id
                OR cycle.pipeline_stage_id IS DISTINCT FROM NEW.pipeline_stage_id);
        END IF;
        RETURN NULL;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER TRG_leads_sync_open_cycle
      AFTER UPDATE ON public.leads FOR EACH ROW
      EXECUTE FUNCTION app_private.sync_open_cycle_from_lead()`);

    await queryRunner.query(`CREATE FUNCTION app_private.prepare_cycle_pipeline_snapshot()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_stage public.pipeline_stages%ROWTYPE;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF current_setting('app_private.pipeline_selection', true) = 'none' THEN
            RETURN NULL;
          ELSIF NEW.pipeline_id IS NOT NULL AND NEW.pipeline_stage_id IS NOT NULL THEN
            SELECT stage.* INTO v_stage FROM public.pipeline_stages stage
              WHERE stage.id = NEW.pipeline_stage_id AND stage.pipeline_id = NEW.pipeline_id
                AND stage.organization_id = NEW.organization_id AND stage.archived_at IS NULL;
          ELSIF current_setting('app_private.pipeline_selection', true) = 'pipeline' THEN
            SELECT stage.* INTO v_stage FROM public.leads lead
              JOIN public.pipeline_stages stage ON stage.id = lead.pipeline_stage_id
                AND stage.pipeline_id = lead.pipeline_id
                AND stage.organization_id = lead.organization_id
              WHERE lead.id = NEW.lead_id AND lead.organization_id = NEW.organization_id;
          ELSIF NEW.opening_reason = 'reactivated' THEN
            SELECT stage.* INTO v_stage FROM public.pipelines pipeline
              JOIN public.pipeline_stages stage ON stage.pipeline_id = pipeline.id
                AND stage.organization_id = pipeline.organization_id
              WHERE pipeline.organization_id = NEW.organization_id AND pipeline.is_default
                AND stage.archived_at IS NULL ORDER BY stage.position LIMIT 1;
          ELSE
            SELECT stage.* INTO v_stage FROM public.pipelines pipeline
              JOIN public.pipeline_stages stage ON stage.pipeline_id = pipeline.id
                AND stage.organization_id = pipeline.organization_id
              WHERE pipeline.organization_id = NEW.organization_id AND pipeline.is_default
                AND stage.archived_at IS NULL
                AND stage.position = app_private.legacy_position_for_stage(NEW.starting_stage);
          END IF;
          IF NOT FOUND THEN
            IF current_setting('app_private.pipeline_selection', true) = 'none' THEN RETURN NULL; END IF;
            RAISE EXCEPTION 'pipeline stage unavailable' USING ERRCODE = 'P3007';
          END IF;
          NEW.pipeline_id := v_stage.pipeline_id; NEW.pipeline_stage_id := v_stage.id;
          NEW.starting_pipeline_stage_id := v_stage.id;
          NEW.starting_stage_name := v_stage.name;
          NEW.starting_stage := app_private.legacy_stage_for_position(v_stage.position);
          RETURN NEW;
        END IF;
        IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
          SELECT stage.* INTO STRICT v_stage FROM public.pipeline_stages stage
            WHERE stage.id = NEW.pipeline_stage_id AND stage.pipeline_id = NEW.pipeline_id
              AND stage.organization_id = NEW.organization_id;
          NEW.stage_at_close_pipeline_stage_id := v_stage.id;
          NEW.stage_at_close_name := v_stage.name;
          NEW.stage_at_close := app_private.legacy_stage_for_position(v_stage.position);
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER TRG_cycles_pipeline_snapshot
      BEFORE INSERT OR UPDATE ON public.lead_commercial_cycles FOR EACH ROW
      EXECUTE FUNCTION app_private.prepare_cycle_pipeline_snapshot()`);

    await queryRunner.query(`CREATE FUNCTION app_private.prepare_timeline_pipeline_snapshot()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_lead public.leads%ROWTYPE; v_previous public.pipeline_stages%ROWTYPE;
        v_new public.pipeline_stages%ROWTYPE; v_cycle public.lead_commercial_cycles%ROWTYPE;
      BEGIN
        IF NEW.event_type NOT IN ('lead.stage.changed','lead.won','lead.lost',
          'lead.archived','lead.reactivated','lead.cycle.started') THEN RETURN NEW; END IF;
        SELECT lead.* INTO STRICT v_lead FROM public.leads lead
          WHERE lead.id = NEW.lead_id AND lead.organization_id = NEW.organization_id;
        IF NEW.event_type = 'lead.stage.changed' THEN
          SELECT stage.* INTO STRICT v_previous FROM public.pipeline_stages stage
            WHERE stage.id = v_lead.pipeline_stage_id AND stage.organization_id = NEW.organization_id;
          IF NEW.new_pipeline_stage_id IS NULL THEN
            SELECT stage.* INTO v_new FROM public.pipeline_stages stage
              WHERE stage.pipeline_id = v_lead.pipeline_id AND stage.organization_id = NEW.organization_id
                AND stage.archived_at IS NULL
                AND stage.position = app_private.legacy_position_for_stage(NEW.new_stage);
          ELSE
            SELECT stage.* INTO v_new FROM public.pipeline_stages stage
              WHERE stage.id = NEW.new_pipeline_stage_id AND stage.pipeline_id = v_lead.pipeline_id
                AND stage.organization_id = NEW.organization_id;
          END IF;
          IF NOT FOUND THEN RAISE EXCEPTION 'pipeline stage not found' USING ERRCODE = 'P3002'; END IF;
          NEW.previous_pipeline_stage_id := v_previous.id;
          NEW.previous_stage_name := v_previous.name;
          NEW.new_pipeline_stage_id := v_new.id; NEW.new_stage_name := v_new.name;
          NEW.previous_stage := app_private.legacy_stage_for_position(v_previous.position);
          NEW.new_stage := app_private.legacy_stage_for_position(v_new.position);
          IF NEW.previous_stage = NEW.new_stage THEN
            NEW.new_stage := CASE WHEN NEW.previous_stage = 'new' THEN 'qualification'
              ELSE 'new'::public.lead_stage_enum END;
          END IF;
        ELSIF NEW.event_type IN ('lead.won','lead.lost','lead.archived') THEN
          SELECT stage.* INTO STRICT v_previous FROM public.pipeline_stages stage
            WHERE stage.id = v_lead.pipeline_stage_id AND stage.organization_id = NEW.organization_id;
          NEW.previous_pipeline_stage_id := v_previous.id; NEW.previous_stage_name := v_previous.name;
          NEW.new_pipeline_stage_id := v_previous.id; NEW.new_stage_name := v_previous.name;
        ELSE
          SELECT cycle.* INTO STRICT v_cycle FROM public.lead_commercial_cycles cycle
            WHERE cycle.id = NEW.cycle_id AND cycle.organization_id = NEW.organization_id;
          SELECT stage.* INTO STRICT v_new FROM public.pipeline_stages stage
            WHERE stage.id = v_cycle.pipeline_stage_id AND stage.organization_id = NEW.organization_id;
          NEW.new_pipeline_stage_id := v_new.id; NEW.new_stage_name := v_new.name;
          NEW.new_stage := app_private.legacy_stage_for_position(v_new.position);
          IF NEW.event_type = 'lead.reactivated' THEN
            SELECT cycle.stage_at_close_pipeline_stage_id, cycle.stage_at_close_name
              INTO NEW.previous_pipeline_stage_id, NEW.previous_stage_name
              FROM public.lead_commercial_cycles cycle
              WHERE cycle.lead_id = NEW.lead_id AND cycle.organization_id = NEW.organization_id
                AND cycle.closed_at IS NOT NULL ORDER BY cycle.cycle_number DESC LIMIT 1;
          END IF;
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER TRG_timeline_pipeline_snapshot
      BEFORE INSERT ON public.lead_timeline_events FOR EACH ROW
      EXECUTE FUNCTION app_private.prepare_timeline_pipeline_snapshot()`);

    await this.replaceLifecycleIntegrity(queryRunner);
    await this.installCatalogIntegrity(queryRunner);
    for (const name of [
      'legacy_position_for_stage(public.lead_stage_enum)',
      'legacy_stage_for_position(integer)',
      'provision_default_pipeline()',
      'prepare_lead_pipeline_snapshot()',
      'sync_open_cycle_from_lead()',
      'prepare_cycle_pipeline_snapshot()',
      'prepare_timeline_pipeline_snapshot()',
    ]) {
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION app_private.${name} FROM PUBLIC`,
      );
    }
  }

  private async replaceLifecycleIntegrity(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.enforce_lead_state_transition()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'active' OR NEW.next_cycle_number NOT IN (1, 2) THEN
            RAISE EXCEPTION 'invalid initial lead lifecycle' USING ERRCODE = 'P3007';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.next_cycle_number < OLD.next_cycle_number
          OR NEW.next_cycle_number > OLD.next_cycle_number + 1 THEN
          RAISE EXCEPTION 'invalid lead cycle sequence' USING ERRCODE = 'P3007';
        END IF;
        IF NEW.status = OLD.status THEN
          IF NEW.next_cycle_number <> OLD.next_cycle_number
            AND NOT (NEW.status = 'active' AND NEW.next_cycle_number = OLD.next_cycle_number + 1
              AND OLD.pipeline_id IS NULL AND NEW.pipeline_id IS NOT NULL) THEN
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
          IF NEW.next_cycle_number <> OLD.next_cycle_number + 1 THEN
            RAISE EXCEPTION 'invalid lead reactivation' USING ERRCODE = 'P3007';
          END IF;
        ELSE
          RAISE EXCEPTION 'invalid lead status transition' USING ERRCODE = 'P3007';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.protect_lead_cycle_history()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.closed_at IS NOT NULL
          OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
          OR NEW.lead_id <> OLD.lead_id OR NEW.cycle_number <> OLD.cycle_number
          OR NEW.opening_reason <> OLD.opening_reason
          OR NEW.pipeline_id <> OLD.pipeline_id
          OR NEW.starting_pipeline_stage_id <> OLD.starting_pipeline_stage_id
          OR NEW.starting_stage_name <> OLD.starting_stage_name
          OR NEW.starting_stage <> OLD.starting_stage
          OR NEW.opened_by_membership_id IS DISTINCT FROM OLD.opened_by_membership_id
          OR NEW.opened_at <> OLD.opened_at
          OR (NEW.closed_at IS NOT NULL
            AND NEW.expected_value_minor IS DISTINCT FROM OLD.expected_value_minor) THEN
          RAISE EXCEPTION 'commercial cycle history is immutable' USING ERRCODE = 'P3006';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.assert_lead_cycle_consistency()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_lead_id uuid; v_lead public.leads%ROWTYPE; v_count integer;
        v_open public.lead_commercial_cycles%ROWTYPE; v_max bigint;
      BEGIN
        IF TG_TABLE_NAME = 'leads' THEN
          v_lead_id := COALESCE(NEW.id, OLD.id);
        ELSE
          v_lead_id := COALESCE(NEW.lead_id, OLD.lead_id);
        END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead WHERE lead.id = v_lead_id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT count(*)::integer, max(cycle.cycle_number)
          INTO v_count, v_max
          FROM public.lead_commercial_cycles cycle WHERE cycle.lead_id = v_lead_id;
        SELECT cycle.* INTO v_open FROM public.lead_commercial_cycles cycle
          WHERE cycle.lead_id = v_lead_id AND cycle.closed_at IS NULL;
        IF v_count <> v_lead.next_cycle_number - 1
          OR v_max IS DISTINCT FROM (CASE WHEN v_count = 0 THEN NULL ELSE v_count::bigint END)
          OR (v_lead.status = 'active' AND (
            (v_open.id IS NULL AND (v_lead.pipeline_id IS NOT NULL OR v_lead.pipeline_stage_id IS NOT NULL))
            OR (v_open.id IS NOT NULL AND (v_open.pipeline_id IS DISTINCT FROM v_lead.pipeline_id
              OR v_open.pipeline_stage_id IS DISTINCT FROM v_lead.pipeline_stage_id))))
          OR (v_lead.status <> 'active' AND (v_open.id IS NOT NULL
            OR v_lead.pipeline_id IS NOT NULL OR v_lead.pipeline_stage_id IS NOT NULL)) THEN
          RAISE EXCEPTION 'lead and commercial cycle are inconsistent' USING ERRCODE = 'P3007';
        END IF;
        RETURN NULL;
      END; $$`);
    for (const name of [
      'enforce_lead_state_transition()',
      'protect_lead_cycle_history()',
      'assert_lead_cycle_consistency()',
    ]) {
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION app_private.${name} FROM PUBLIC`,
      );
    }
  }

  private async installCatalogIntegrity(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`CREATE FUNCTION app_private.assert_pipeline_invariants()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_organization_id uuid; v_pipeline_id uuid;
      BEGIN
        v_organization_id := COALESCE(NEW.organization_id, OLD.organization_id);
        IF TG_TABLE_NAME = 'pipelines' THEN
          v_pipeline_id := COALESCE(NEW.id, OLD.id);
        ELSE
          v_pipeline_id := COALESCE(NEW.pipeline_id, OLD.pipeline_id);
        END IF;
        IF (SELECT count(*) FROM public.pipelines pipeline
          WHERE pipeline.organization_id = v_organization_id AND pipeline.is_default) <> 1 THEN
          RAISE EXCEPTION 'organization default pipeline invariant' USING ERRCODE = 'P3007';
        END IF;
        IF EXISTS (SELECT 1 FROM public.pipelines pipeline WHERE pipeline.id = v_pipeline_id)
          AND NOT EXISTS (SELECT 1 FROM public.pipeline_stages stage
            WHERE stage.pipeline_id = v_pipeline_id AND stage.organization_id = v_organization_id
              AND stage.archived_at IS NULL) THEN
          RAISE EXCEPTION 'pipeline requires an active stage' USING ERRCODE = 'P3007';
        END IF;
        RETURN NULL;
      END; $$`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_pipelines_invariants
      AFTER INSERT OR UPDATE OR DELETE ON public.pipelines DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION app_private.assert_pipeline_invariants()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER TRG_pipeline_stages_invariants
      AFTER INSERT OR UPDATE OR DELETE ON public.pipeline_stages DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION app_private.assert_pipeline_invariants()`);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.assert_pipeline_invariants() FROM PUBLIC',
    );
  }

  private async installConfigurationFunctions(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`CREATE FUNCTION app_private.assert_pipeline_admin(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active'
          FOR UPDATE OF organization;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM application_user.id FROM public.users application_user
          WHERE application_user.id = p_actor_user_id AND application_user.status = 'active'
          FOR UPDATE OF application_user;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM membership.id FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id AND membership.status = 'active'
            AND membership.role IN ('owner','admin') FOR UPDATE OF membership;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.create_pipeline(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_pipeline_id uuid, p_name text, p_stages jsonb)
      RETURNS TABLE (revision bigint, replayed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_pipeline public.pipelines%ROWTYPE; v_stage jsonb; v_position integer := 0;
        v_stage_id uuid; v_name text; v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_pipeline_id IS NULL OR p_name IS NULL OR p_name <> btrim(p_name)
          OR length(p_name) NOT BETWEEN 1 AND 160 OR p_name ~ '[[:cntrl:]]'
          OR p_stages IS NULL OR jsonb_typeof(p_stages) <> 'array'
          OR jsonb_array_length(p_stages) < 1 THEN
          RAISE EXCEPTION 'invalid pipeline command' USING ERRCODE = '22023';
        END IF;
        PERFORM app_private.assert_pipeline_admin(
          p_actor_user_id, p_actor_membership_id, p_organization_id);
        SELECT pipeline.* INTO v_pipeline FROM public.pipelines pipeline
          WHERE pipeline.id = p_pipeline_id FOR UPDATE;
        IF FOUND THEN
          IF v_pipeline.organization_id <> p_organization_id THEN
            RAISE EXCEPTION 'pipeline not found' USING ERRCODE = 'P3002';
          END IF;
          IF NOT v_pipeline.is_default AND v_pipeline.name = p_name
            AND (SELECT jsonb_agg(jsonb_build_object('id', stage.id, 'name', stage.name)
                ORDER BY stage.position) FROM public.pipeline_stages stage
              WHERE stage.pipeline_id = v_pipeline.id AND stage.organization_id = p_organization_id
                AND stage.archived_at IS NULL) = p_stages THEN
            RETURN QUERY SELECT v_pipeline.revision, true; RETURN;
          END IF;
          RAISE EXCEPTION 'pipeline create conflict' USING ERRCODE = 'P3004';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stages) item
          WHERE jsonb_typeof(item) <> 'object' OR NOT (item ? 'id' AND item ? 'name')
            OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 2)
          OR (SELECT count(*) FROM jsonb_array_elements(p_stages)) <>
             (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(p_stages) item)
          OR (SELECT count(*) FROM jsonb_array_elements(p_stages)) <>
             (SELECT count(DISTINCT lower(normalize(btrim(item->>'name'), NFC)))
                FROM jsonb_array_elements(p_stages) item) THEN
          RAISE EXCEPTION 'invalid pipeline stages' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.pipelines (id, organization_id, name, is_default,
          revision, created_at, updated_at) VALUES
          (p_pipeline_id, p_organization_id, p_name, false, 0, v_now, v_now)
          RETURNING * INTO v_pipeline;
        FOR v_stage IN SELECT value FROM jsonb_array_elements(p_stages) LOOP
          v_position := v_position + 1;
          BEGIN v_stage_id := (v_stage->>'id')::uuid;
          EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'invalid pipeline stage id' USING ERRCODE = '22023'; END;
          v_name := v_stage->>'name';
          IF v_name IS NULL OR v_name <> btrim(v_name) OR length(v_name) NOT BETWEEN 1 AND 120
            OR v_name ~ '[[:cntrl:]]' THEN
            RAISE EXCEPTION 'invalid pipeline stage' USING ERRCODE = '22023';
          END IF;
          INSERT INTO public.pipeline_stages (id, organization_id, pipeline_id,
            name, position, created_at, updated_at) VALUES
            (v_stage_id, p_organization_id, p_pipeline_id, v_name, v_position, v_now, v_now);
        END LOOP;
        RETURN QUERY SELECT v_pipeline.revision, false;
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.rename_pipeline(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_pipeline_id uuid, p_expected_revision bigint, p_name text)
      RETURNS TABLE (revision bigint, replayed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_pipeline public.pipelines%ROWTYPE; v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_expected_revision IS NULL OR p_name IS NULL OR p_name <> btrim(p_name)
          OR length(p_name) NOT BETWEEN 1 AND 160 OR p_name ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'invalid pipeline command' USING ERRCODE = '22023'; END IF;
        PERFORM app_private.assert_pipeline_admin(p_actor_user_id,p_actor_membership_id,p_organization_id);
        SELECT pipeline.* INTO v_pipeline FROM public.pipelines pipeline
          WHERE pipeline.id = p_pipeline_id AND pipeline.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'pipeline not found' USING ERRCODE = 'P3002'; END IF;
        IF v_pipeline.name = p_name THEN RETURN QUERY SELECT v_pipeline.revision, true; RETURN; END IF;
        IF v_pipeline.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'pipeline revision conflict' USING ERRCODE = 'P3003'; END IF;
        UPDATE public.pipelines pipeline SET name = p_name, revision = pipeline.revision + 1,
          updated_at = v_now WHERE pipeline.id = v_pipeline.id RETURNING * INTO v_pipeline;
        RETURN QUERY SELECT v_pipeline.revision, false;
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.create_pipeline_stage(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_pipeline_id uuid, p_stage_id uuid, p_expected_revision bigint, p_name text)
      RETURNS TABLE (revision bigint, replayed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_pipeline public.pipelines%ROWTYPE; v_stage public.pipeline_stages%ROWTYPE;
        v_position integer; v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_stage_id IS NULL OR p_expected_revision IS NULL OR p_name IS NULL
          OR p_name <> btrim(p_name) OR length(p_name) NOT BETWEEN 1 AND 120
          OR p_name ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'invalid pipeline command' USING ERRCODE = '22023'; END IF;
        PERFORM app_private.assert_pipeline_admin(p_actor_user_id,p_actor_membership_id,p_organization_id);
        SELECT pipeline.* INTO v_pipeline FROM public.pipelines pipeline
          WHERE pipeline.id = p_pipeline_id AND pipeline.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'pipeline not found' USING ERRCODE = 'P3002'; END IF;
        IF v_pipeline.is_default THEN
          RAISE EXCEPTION 'default pipeline stages are compatibility-locked' USING ERRCODE = 'P3004';
        END IF;
        SELECT stage.* INTO v_stage FROM public.pipeline_stages stage WHERE stage.id = p_stage_id FOR UPDATE;
        IF FOUND THEN
          IF v_stage.organization_id = p_organization_id AND v_stage.pipeline_id = p_pipeline_id
            AND v_stage.name = p_name AND v_stage.archived_at IS NULL THEN
            RETURN QUERY SELECT v_pipeline.revision, true; RETURN;
          END IF;
          RAISE EXCEPTION 'pipeline stage conflict' USING ERRCODE = 'P3004';
        END IF;
        IF v_pipeline.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'pipeline revision conflict' USING ERRCODE = 'P3003'; END IF;
        SELECT COALESCE(max(stage.position), 0) + 1 INTO v_position
          FROM public.pipeline_stages stage WHERE stage.pipeline_id = p_pipeline_id
            AND stage.organization_id = p_organization_id AND stage.archived_at IS NULL;
        INSERT INTO public.pipeline_stages (id,organization_id,pipeline_id,name,position,
          created_at,updated_at) VALUES
          (p_stage_id,p_organization_id,p_pipeline_id,p_name,v_position,v_now,v_now);
        UPDATE public.pipelines pipeline SET revision = pipeline.revision + 1,
          updated_at = v_now WHERE pipeline.id = p_pipeline_id RETURNING * INTO v_pipeline;
        RETURN QUERY SELECT v_pipeline.revision, false;
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.rename_pipeline_stage(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_pipeline_id uuid, p_stage_id uuid, p_expected_revision bigint, p_name text)
      RETURNS TABLE (revision bigint, replayed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_pipeline public.pipelines%ROWTYPE; v_stage public.pipeline_stages%ROWTYPE;
        v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_expected_revision IS NULL OR p_name IS NULL OR p_name <> btrim(p_name)
          OR length(p_name) NOT BETWEEN 1 AND 120 OR p_name ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'invalid pipeline command' USING ERRCODE = '22023'; END IF;
        PERFORM app_private.assert_pipeline_admin(p_actor_user_id,p_actor_membership_id,p_organization_id);
        SELECT pipeline.* INTO v_pipeline FROM public.pipelines pipeline
          WHERE pipeline.id = p_pipeline_id AND pipeline.organization_id = p_organization_id FOR UPDATE;
        SELECT stage.* INTO v_stage FROM public.pipeline_stages stage
          WHERE stage.id = p_stage_id AND stage.pipeline_id = p_pipeline_id
            AND stage.organization_id = p_organization_id AND stage.archived_at IS NULL FOR UPDATE;
        IF NOT FOUND OR v_pipeline.id IS NULL THEN
          RAISE EXCEPTION 'pipeline stage not found' USING ERRCODE = 'P3002'; END IF;
        IF v_stage.name = p_name THEN RETURN QUERY SELECT v_pipeline.revision, true; RETURN; END IF;
        IF v_pipeline.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'pipeline revision conflict' USING ERRCODE = 'P3003'; END IF;
        UPDATE public.pipeline_stages stage SET name = p_name, updated_at = v_now
          WHERE stage.id = p_stage_id;
        UPDATE public.pipelines pipeline SET revision = pipeline.revision + 1,
          updated_at = v_now WHERE pipeline.id = p_pipeline_id RETURNING * INTO v_pipeline;
        RETURN QUERY SELECT v_pipeline.revision, false;
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.reorder_pipeline_stages(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_pipeline_id uuid, p_expected_revision bigint, p_stage_ids uuid[])
      RETURNS TABLE (revision bigint, replayed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_pipeline public.pipelines%ROWTYPE; v_current uuid[];
        v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_expected_revision IS NULL OR p_stage_ids IS NULL OR cardinality(p_stage_ids) < 1
          OR cardinality(p_stage_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_stage_ids) id) THEN
          RAISE EXCEPTION 'invalid pipeline order' USING ERRCODE = '22023'; END IF;
        PERFORM app_private.assert_pipeline_admin(p_actor_user_id,p_actor_membership_id,p_organization_id);
        SELECT pipeline.* INTO v_pipeline FROM public.pipelines pipeline
          WHERE pipeline.id = p_pipeline_id AND pipeline.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'pipeline not found' USING ERRCODE = 'P3002'; END IF;
        PERFORM stage.id FROM public.pipeline_stages stage
          WHERE stage.pipeline_id = p_pipeline_id
            AND stage.organization_id = p_organization_id
            AND stage.archived_at IS NULL ORDER BY stage.id FOR UPDATE;
        SELECT array_agg(stage.id ORDER BY stage.position) INTO v_current
          FROM public.pipeline_stages stage WHERE stage.pipeline_id = p_pipeline_id
            AND stage.organization_id = p_organization_id AND stage.archived_at IS NULL;
        IF v_current = p_stage_ids THEN RETURN QUERY SELECT v_pipeline.revision, true; RETURN; END IF;
        IF v_pipeline.is_default THEN
          RAISE EXCEPTION 'default pipeline stages are compatibility-locked' USING ERRCODE = 'P3004';
        END IF;
        IF (SELECT array_agg(item.stage_id ORDER BY item.stage_id)
              FROM unnest(v_current) AS item(stage_id)) IS DISTINCT FROM
          (SELECT array_agg(item.stage_id ORDER BY item.stage_id)
              FROM unnest(p_stage_ids) AS item(stage_id)) THEN
          RAISE EXCEPTION 'pipeline order conflicts with active stages' USING ERRCODE = 'P3004'; END IF;
        IF v_pipeline.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'pipeline revision conflict' USING ERRCODE = 'P3003'; END IF;
        UPDATE public.pipeline_stages stage SET position = stage.position + 1000000
          WHERE stage.pipeline_id = p_pipeline_id AND stage.organization_id = p_organization_id
            AND stage.archived_at IS NULL;
        UPDATE public.pipeline_stages stage SET position = requested.position::integer,
          updated_at = v_now FROM unnest(p_stage_ids) WITH ORDINALITY requested(id, position)
          WHERE stage.id = requested.id AND stage.pipeline_id = p_pipeline_id
            AND stage.organization_id = p_organization_id;
        UPDATE public.pipelines pipeline SET revision = pipeline.revision + 1,
          updated_at = v_now WHERE pipeline.id = p_pipeline_id RETURNING * INTO v_pipeline;
        RETURN QUERY SELECT v_pipeline.revision, false;
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.archive_pipeline_stage(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_pipeline_id uuid, p_stage_id uuid, p_expected_revision bigint)
      RETURNS TABLE (revision bigint, replayed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_pipeline public.pipelines%ROWTYPE; v_stage public.pipeline_stages%ROWTYPE;
        v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_expected_revision IS NULL THEN
          RAISE EXCEPTION 'invalid pipeline command' USING ERRCODE = '22023'; END IF;
        PERFORM app_private.assert_pipeline_admin(p_actor_user_id,p_actor_membership_id,p_organization_id);
        SELECT pipeline.* INTO v_pipeline FROM public.pipelines pipeline
          WHERE pipeline.id = p_pipeline_id AND pipeline.organization_id = p_organization_id FOR UPDATE;
        SELECT stage.* INTO v_stage FROM public.pipeline_stages stage
          WHERE stage.id = p_stage_id AND stage.pipeline_id = p_pipeline_id
            AND stage.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND OR v_pipeline.id IS NULL THEN
          RAISE EXCEPTION 'pipeline stage not found' USING ERRCODE = 'P3002'; END IF;
        IF v_stage.archived_at IS NOT NULL THEN RETURN QUERY SELECT v_pipeline.revision, true; RETURN; END IF;
        IF v_pipeline.is_default THEN
          RAISE EXCEPTION 'default pipeline stages are compatibility-locked' USING ERRCODE = 'P3004';
        END IF;
        IF v_pipeline.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'pipeline revision conflict' USING ERRCODE = 'P3003'; END IF;
        IF (SELECT count(*) FROM public.pipeline_stages stage
          WHERE stage.pipeline_id = p_pipeline_id AND stage.organization_id = p_organization_id
            AND stage.archived_at IS NULL) <= 1
          OR EXISTS (SELECT 1 FROM public.lead_commercial_cycles cycle
            WHERE cycle.organization_id = p_organization_id
              AND cycle.pipeline_id = p_pipeline_id AND cycle.pipeline_stage_id = p_stage_id
              AND cycle.closed_at IS NULL) THEN
          RAISE EXCEPTION 'pipeline stage is occupied or last' USING ERRCODE = 'P3004';
        END IF;
        UPDATE public.pipeline_stages stage SET archived_at = v_now, updated_at = v_now
          WHERE stage.id = p_stage_id;
        UPDATE public.pipelines pipeline SET revision = pipeline.revision + 1,
          updated_at = v_now WHERE pipeline.id = p_pipeline_id RETURNING * INTO v_pipeline;
        RETURN QUERY SELECT v_pipeline.revision, false;
      END; $$`);
    for (const name of [
      'assert_pipeline_admin(uuid,uuid,uuid)',
      'create_pipeline(uuid,uuid,uuid,uuid,text,jsonb)',
      'rename_pipeline(uuid,uuid,uuid,uuid,bigint,text)',
      'create_pipeline_stage(uuid,uuid,uuid,uuid,uuid,bigint,text)',
      'rename_pipeline_stage(uuid,uuid,uuid,uuid,uuid,bigint,text)',
      'reorder_pipeline_stages(uuid,uuid,uuid,uuid,bigint,uuid[])',
      'archive_pipeline_stage(uuid,uuid,uuid,uuid,uuid,bigint)',
    ]) {
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION app_private.${name} FROM PUBLIC`,
      );
    }
  }

  private async installDynamicLeadFunctions(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`CREATE FUNCTION app_private.ingest_lead_with_pipeline(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_intake_channel text, p_display_name text, p_primary_phone text,
      p_email text, p_company_name text, p_instagram text, p_city text,
      p_service_interest text, p_requested_responsible_membership_id uuid,
      p_source text, p_source_detail text, p_utm_source text, p_utm_medium text,
      p_utm_campaign text, p_utm_content text, p_utm_term text,
      p_idempotency_key uuid, p_fingerprint_key_version smallint,
      p_request_fingerprint text, p_request_fingerprints jsonb,
      p_selection_kind text, p_pipeline_id uuid)
      RETURNS TABLE (outcome text, lead_id uuid, entry_id uuid, revision bigint,
        replayed boolean, actor_can_view boolean, response_status smallint)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF p_intake_channel <> 'manual' OR p_selection_kind NOT IN ('none','pipeline')
          OR (p_selection_kind = 'none' AND p_pipeline_id IS NOT NULL)
          OR (p_selection_kind = 'pipeline' AND p_pipeline_id IS NULL) THEN
          RAISE EXCEPTION 'invalid pipeline selection' USING ERRCODE = '22023';
        END IF;
        PERFORM set_config('app_private.pipeline_selection', p_selection_kind, true);
        PERFORM set_config('app_private.pipeline_id', COALESCE(p_pipeline_id::text, ''), true);
        RETURN QUERY SELECT * FROM app_private.ingest_lead(
          p_actor_user_id,p_actor_membership_id,p_organization_id,p_intake_channel,
          p_display_name,p_primary_phone,p_email,p_company_name,p_instagram,p_city,
          p_service_interest,p_requested_responsible_membership_id,p_source,p_source_detail,
          p_utm_source,p_utm_medium,p_utm_campaign,p_utm_content,p_utm_term,
          p_idempotency_key,p_fingerprint_key_version,p_request_fingerprint,
          p_request_fingerprints);
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.execute_lead_stage_move_command(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_lead_id uuid, p_expected_revision bigint, p_idempotency_key uuid,
      p_fingerprint_key_version smallint, p_request_fingerprint text,
      p_request_fingerprints jsonb, p_pipeline_stage_id uuid)
      RETURNS TABLE (revision bigint, replayed boolean, response_status smallint)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_actor public.memberships%ROWTYPE; v_lead public.leads%ROWTYPE;
        v_cycle public.lead_commercial_cycles%ROWTYPE; v_target public.pipeline_stages%ROWTYPE;
        v_previous public.pipeline_stages%ROWTYPE; v_claim public.lead_command_idempotency%ROWTYPE;
        v_claim_id uuid; v_legacy public.lead_stage_enum; v_now timestamptz := transaction_timestamp();
        v_changed boolean := true;
      BEGIN
        IF p_actor_user_id IS NULL OR p_actor_membership_id IS NULL OR p_organization_id IS NULL
          OR p_lead_id IS NULL OR p_expected_revision IS NULL OR p_idempotency_key IS NULL
          OR p_pipeline_stage_id IS NULL OR p_fingerprint_key_version IS NULL
          OR p_request_fingerprint !~ '^[0-9a-f]{64}$' OR p_request_fingerprints IS NULL
          OR jsonb_typeof(p_request_fingerprints) <> 'object'
          OR COALESCE(p_request_fingerprints->>p_fingerprint_key_version::text,'') <> p_request_fingerprint THEN
          RAISE EXCEPTION 'invalid lead command' USING ERRCODE = '22023'; END IF;
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM application_user.id FROM public.users application_user
          WHERE application_user.id = p_actor_user_id AND application_user.status = 'active' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        SELECT membership.* INTO v_actor FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id AND membership.status = 'active'
          FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.id = p_lead_id AND lead.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND OR (v_actor.role = 'member'
          AND v_lead.responsible_membership_id IS DISTINCT FROM p_actor_membership_id) THEN
          RAISE EXCEPTION 'lead not found' USING ERRCODE = 'P3002'; END IF;
        INSERT INTO public.lead_command_idempotency (organization_id,actor_membership_id,
          lead_id,command,idempotency_key,fingerprint_key_version,request_fingerprint,status)
          VALUES (p_organization_id,p_actor_membership_id,p_lead_id,'move',p_idempotency_key,
            p_fingerprint_key_version,p_request_fingerprint,'processing')
          ON CONFLICT DO NOTHING RETURNING id INTO v_claim_id;
        IF v_claim_id IS NULL THEN
          SELECT claim.* INTO v_claim FROM public.lead_command_idempotency claim
            WHERE claim.organization_id = p_organization_id
              AND claim.actor_membership_id = p_actor_membership_id
              AND claim.command = 'move' AND claim.idempotency_key = p_idempotency_key FOR UPDATE;
          IF NOT FOUND OR v_claim.lead_id <> p_lead_id OR v_claim.request_fingerprint <>
            COALESCE(p_request_fingerprints->>v_claim.fingerprint_key_version::text,'') THEN
            RAISE EXCEPTION 'idempotency fingerprint conflict' USING ERRCODE = 'P3004'; END IF;
          IF v_claim.status <> 'completed' THEN
            RAISE EXCEPTION 'idempotency result unavailable' USING ERRCODE = 'P3005'; END IF;
          RETURN QUERY SELECT v_claim.result_revision,true,v_claim.response_status; RETURN;
        END IF;
        IF v_lead.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'lead revision conflict' USING ERRCODE = 'P3003'; END IF;
        IF v_lead.status <> 'active' OR v_lead.pipeline_id IS NULL THEN
          RAISE EXCEPTION 'lead state conflict' USING ERRCODE = 'P3004'; END IF;
        SELECT cycle.* INTO STRICT v_cycle FROM public.lead_commercial_cycles cycle
          WHERE cycle.lead_id = p_lead_id AND cycle.organization_id = p_organization_id
            AND cycle.closed_at IS NULL FOR UPDATE;
        SELECT stage.* INTO v_target FROM public.pipeline_stages stage
          WHERE stage.id = p_pipeline_stage_id AND stage.organization_id = p_organization_id
            AND stage.pipeline_id = v_lead.pipeline_id AND stage.archived_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'pipeline stage not found' USING ERRCODE = 'P3002'; END IF;
        IF v_target.id = v_lead.pipeline_stage_id THEN v_changed := false;
        ELSE
          SELECT stage.* INTO STRICT v_previous FROM public.pipeline_stages stage
            WHERE stage.id = v_lead.pipeline_stage_id AND stage.organization_id = p_organization_id;
          v_legacy := app_private.legacy_stage_for_position(v_target.position);
          IF v_legacy = v_lead.stage THEN
            v_legacy := CASE WHEN v_lead.stage = 'new' THEN 'qualification'
              ELSE 'new'::public.lead_stage_enum END;
          END IF;
          UPDATE public.lead_commercial_cycles cycle SET pipeline_stage_id = v_target.id
            WHERE cycle.id = v_cycle.id;
          INSERT INTO public.lead_timeline_events (organization_id,lead_id,sequence,event_type,
            actor_membership_id,cycle_id,previous_status,new_status,previous_stage,new_stage,
            previous_pipeline_stage_id,previous_stage_name,new_pipeline_stage_id,new_stage_name,
            occurred_at) VALUES (p_organization_id,p_lead_id,v_lead.next_event_sequence,
            'lead.stage.changed',p_actor_membership_id,v_cycle.id,'active','active',v_lead.stage,
            v_legacy,v_previous.id,v_previous.name,v_target.id,v_target.name,v_now);
          UPDATE public.leads lead SET pipeline_stage_id = v_target.id, stage = v_legacy,
            revision = lead.revision + 1, next_event_sequence = lead.next_event_sequence + 1,
            updated_at = v_now WHERE lead.id = p_lead_id RETURNING * INTO v_lead;
        END IF;
        UPDATE public.lead_command_idempotency claim SET status='completed',
          result_revision=v_lead.revision,result_changed=v_changed,response_status=204,
          updated_at=v_now WHERE claim.id=v_claim_id;
        RETURN QUERY SELECT v_lead.revision,false,204::smallint;
      EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'lead lifecycle invariant unavailable' USING ERRCODE = 'P3007';
      END; $$`);
    await queryRunner.query(`CREATE FUNCTION app_private.execute_lead_cycle_start_command(
      p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
      p_lead_id uuid, p_expected_revision bigint, p_idempotency_key uuid,
      p_fingerprint_key_version smallint, p_request_fingerprint text,
      p_request_fingerprints jsonb, p_pipeline_id uuid)
      RETURNS TABLE (revision bigint, replayed boolean, response_status smallint)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_actor public.memberships%ROWTYPE; v_lead public.leads%ROWTYPE;
        v_pipeline public.pipelines%ROWTYPE; v_stage public.pipeline_stages%ROWTYPE;
        v_claim public.lead_cycle_start_idempotency%ROWTYPE; v_claim_id uuid;
        v_review public.lead_return_reviews%ROWTYPE; v_cycle_id uuid := gen_random_uuid();
        v_event_type text; v_opening public.lead_cycle_opening_reason_enum;
        v_legacy public.lead_stage_enum; v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_actor_user_id IS NULL OR p_actor_membership_id IS NULL OR p_organization_id IS NULL
          OR p_lead_id IS NULL OR p_expected_revision IS NULL OR p_idempotency_key IS NULL
          OR p_pipeline_id IS NULL OR p_fingerprint_key_version IS NULL
          OR p_request_fingerprint !~ '^[0-9a-f]{64}$' OR p_request_fingerprints IS NULL
          OR jsonb_typeof(p_request_fingerprints) <> 'object'
          OR COALESCE(p_request_fingerprints->>p_fingerprint_key_version::text,'') <> p_request_fingerprint THEN
          RAISE EXCEPTION 'invalid lead command' USING ERRCODE = '22023'; END IF;
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM application_user.id FROM public.users application_user
          WHERE application_user.id = p_actor_user_id AND application_user.status = 'active' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        SELECT membership.* INTO v_actor FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id AND membership.status = 'active'
          FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.id = p_lead_id AND lead.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND OR (v_actor.role = 'member' AND (v_lead.status <> 'active'
          OR v_lead.responsible_membership_id IS DISTINCT FROM p_actor_membership_id)) THEN
          RAISE EXCEPTION 'lead not found' USING ERRCODE = 'P3002'; END IF;
        IF v_lead.status <> 'active' AND v_actor.role = 'member' THEN
          RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        INSERT INTO public.lead_cycle_start_idempotency (organization_id,actor_membership_id,
          lead_id,idempotency_key,fingerprint_key_version,request_fingerprint,status)
          VALUES (p_organization_id,p_actor_membership_id,p_lead_id,p_idempotency_key,
            p_fingerprint_key_version,p_request_fingerprint,'processing')
          ON CONFLICT DO NOTHING RETURNING id INTO v_claim_id;
        IF v_claim_id IS NULL THEN
          SELECT claim.* INTO v_claim FROM public.lead_cycle_start_idempotency claim
            WHERE claim.organization_id=p_organization_id
              AND claim.actor_membership_id=p_actor_membership_id
              AND claim.idempotency_key=p_idempotency_key FOR UPDATE;
          IF NOT FOUND OR v_claim.lead_id<>p_lead_id OR v_claim.request_fingerprint<>
            COALESCE(p_request_fingerprints->>v_claim.fingerprint_key_version::text,'') THEN
            RAISE EXCEPTION 'idempotency fingerprint conflict' USING ERRCODE='P3004'; END IF;
          IF v_claim.status<>'completed' THEN
            RAISE EXCEPTION 'idempotency result unavailable' USING ERRCODE='P3005'; END IF;
          RETURN QUERY SELECT v_claim.result_revision,true,v_claim.response_status; RETURN;
        END IF;
        IF v_lead.revision<>p_expected_revision THEN
          RAISE EXCEPTION 'lead revision conflict' USING ERRCODE='P3003'; END IF;
        IF v_lead.pipeline_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.lead_commercial_cycles cycle
          WHERE cycle.lead_id=p_lead_id AND cycle.closed_at IS NULL) THEN
          RAISE EXCEPTION 'lead state conflict' USING ERRCODE='P3004'; END IF;
        SELECT pipeline.* INTO v_pipeline FROM public.pipelines pipeline
          WHERE pipeline.id=p_pipeline_id AND pipeline.organization_id=p_organization_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'pipeline not found' USING ERRCODE='P3002'; END IF;
        SELECT stage.* INTO v_stage FROM public.pipeline_stages stage
          WHERE stage.pipeline_id=p_pipeline_id AND stage.organization_id=p_organization_id
            AND stage.archived_at IS NULL ORDER BY stage.position LIMIT 1 FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'pipeline has no active stage' USING ERRCODE='P3007'; END IF;
        v_legacy:=app_private.legacy_stage_for_position(v_stage.position);
        v_opening:=CASE WHEN v_lead.status='active' THEN 'created'::public.lead_cycle_opening_reason_enum
          ELSE 'reactivated'::public.lead_cycle_opening_reason_enum END;
        v_event_type:=CASE WHEN v_lead.status='active' THEN 'lead.cycle.started'
          ELSE 'lead.reactivated' END;
        IF v_lead.status<>'active' THEN
          SELECT review.* INTO v_review FROM public.lead_return_reviews review
            WHERE review.lead_id=p_lead_id AND review.organization_id=p_organization_id
              AND review.status='pending' FOR UPDATE;
          IF FOUND THEN UPDATE public.lead_return_reviews review SET status='reactivated',
            resolved_at=v_now,resolved_by_membership_id=p_actor_membership_id,updated_at=v_now
            WHERE review.id=v_review.id; END IF;
        END IF;
        INSERT INTO public.lead_commercial_cycles (id,organization_id,lead_id,cycle_number,
          opening_reason,starting_stage,pipeline_id,pipeline_stage_id,
          starting_pipeline_stage_id,starting_stage_name,opened_by_membership_id,opened_at)
          VALUES (v_cycle_id,p_organization_id,p_lead_id,v_lead.next_cycle_number,v_opening,
            v_legacy,p_pipeline_id,v_stage.id,v_stage.id,v_stage.name,p_actor_membership_id,v_now);
        INSERT INTO public.lead_timeline_events (organization_id,lead_id,sequence,event_type,
          actor_membership_id,cycle_id,return_review_id,previous_status,new_status,
          previous_stage,new_stage,new_pipeline_stage_id,new_stage_name,occurred_at)
          VALUES (p_organization_id,p_lead_id,v_lead.next_event_sequence,v_event_type,
            p_actor_membership_id,v_cycle_id,v_review.id,v_lead.status,'active',
            CASE WHEN v_lead.status='active' THEN NULL ELSE v_lead.stage END,v_legacy,
            v_stage.id,v_stage.name,v_now);
        UPDATE public.leads lead SET status='active',stage=v_legacy,pipeline_id=p_pipeline_id,
          pipeline_stage_id=v_stage.id,next_cycle_number=lead.next_cycle_number+1,
          revision=lead.revision+1,next_event_sequence=lead.next_event_sequence+1,
          updated_at=v_now WHERE lead.id=p_lead_id RETURNING * INTO v_lead;
        UPDATE public.lead_cycle_start_idempotency claim SET status='completed',
          result_revision=v_lead.revision,response_status=204,updated_at=v_now WHERE claim.id=v_claim_id;
        RETURN QUERY SELECT v_lead.revision,false,204::smallint;
      END; $$`);
    for (const name of [
      'ingest_lead_with_pipeline(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb,text,uuid)',
      'execute_lead_stage_move_command(uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,uuid)',
      'execute_lead_cycle_start_command(uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,uuid)',
    ]) {
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION app_private.${name} FROM PUBLIC`,
      );
    }
  }

  private async installGrants(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    await queryRunner.query(
      `GRANT SELECT ON public.pipelines, public.pipeline_stages TO "${runtimeRole}"`,
    );
    for (const signature of this.runtimeSignatures()) {
      await queryRunner.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`,
      );
    }
  }

  private async assertBackfill(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`SELECT
      (SELECT count(*) FROM public.organizations) =
        (SELECT count(*) FROM public.pipelines WHERE is_default) AS default_parity,
      NOT EXISTS (SELECT 1 FROM public.pipelines pipeline WHERE pipeline.is_default
        AND (SELECT count(*) FROM public.pipeline_stages stage
          WHERE stage.pipeline_id=pipeline.id AND stage.archived_at IS NULL) <> 5) AS stage_parity,
      NOT EXISTS (SELECT 1 FROM public.lead_commercial_cycles cycle
        WHERE cycle.pipeline_id IS NULL OR cycle.pipeline_stage_id IS NULL
          OR cycle.starting_pipeline_stage_id IS NULL OR cycle.starting_stage_name IS NULL
          OR (cycle.closed_at IS NULL) <> (cycle.stage_at_close_pipeline_stage_id IS NULL)) AS cycle_parity,
      NOT EXISTS (SELECT 1 FROM public.leads lead WHERE
        (lead.status='active') <> (lead.pipeline_id IS NOT NULL)
        OR (lead.pipeline_id IS NULL) <> (lead.pipeline_stage_id IS NULL)) AS lead_parity,
      NOT EXISTS (SELECT 1 FROM public.leads lead WHERE lead.next_cycle_number < 1
        OR lead.next_cycle_number <> 1 + (SELECT count(*) FROM public.lead_commercial_cycles cycle
          WHERE cycle.lead_id=lead.id)) AS sequence_parity,
      NOT EXISTS (SELECT 1 FROM public.lead_timeline_events event
        WHERE (event.previous_stage IS NOT NULL AND event.previous_pipeline_stage_id IS NULL)
          OR (event.new_stage IS NOT NULL AND event.new_pipeline_stage_id IS NULL)) AS timeline_parity
    `)) as Array<Record<string, boolean>>;
    const result = rows[0];
    if (
      result === undefined ||
      Object.values(result).some((value) => value !== true)
    ) {
      throw new Error(
        `PIPE-V2-06 backfill parity failed: ${JSON.stringify(result)}`,
      );
    }
  }

  private async assertSafeRollback(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`SELECT
      EXISTS (SELECT 1 FROM public.pipelines WHERE NOT is_default)
      OR EXISTS (SELECT 1 FROM public.pipelines WHERE revision <> 0)
      OR EXISTS (SELECT 1 FROM public.pipeline_stages WHERE archived_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM public.lead_cycle_start_idempotency)
      OR EXISTS (SELECT 1 FROM public.leads WHERE next_cycle_number=1)
      OR EXISTS (SELECT 1 FROM public.lead_timeline_events
        WHERE event_type='lead.cycle.started') AS unsafe`)) as Array<{
      unsafe: boolean;
    }>;
    if (rows[0]?.unsafe !== false) {
      throw new Error('Unsafe rollback: custom pipeline state already exists.');
    }
  }

  private async restoreTimelineChecks(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.lead_timeline_events
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
      )`);
  }

  private async restoreLegacyLifecycleIntegrity(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.enforce_lead_state_transition()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
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
      END; $$`);
    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.protect_lead_cycle_history()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.closed_at IS NOT NULL
          OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
          OR NEW.lead_id <> OLD.lead_id OR NEW.cycle_number <> OLD.cycle_number
          OR NEW.opening_reason <> OLD.opening_reason
          OR NEW.starting_stage <> OLD.starting_stage
          OR NEW.opened_by_membership_id IS DISTINCT FROM OLD.opened_by_membership_id
          OR NEW.opened_at <> OLD.opened_at
          OR (NEW.closed_at IS NOT NULL
            AND NEW.expected_value_minor IS DISTINCT FROM OLD.expected_value_minor) THEN
          RAISE EXCEPTION 'commercial cycle history is immutable' USING ERRCODE = 'P3006';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.assert_lead_cycle_consistency()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_lead_id uuid; v_lead public.leads%ROWTYPE;
        v_cycle_count integer; v_open_count integer; v_pending_count integer;
        v_pending_cycle_id uuid; v_max_cycle bigint;
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
      END; $$`);
    for (const name of [
      'enforce_lead_state_transition()',
      'protect_lead_cycle_history()',
      'assert_lead_cycle_consistency()',
    ]) {
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION app_private.${name} FROM PUBLIC`,
      );
    }
    await queryRunner.query(`CREATE TRIGGER TRG_leads_state_transition
      BEFORE INSERT OR UPDATE ON public.leads FOR EACH ROW
      EXECUTE FUNCTION app_private.enforce_lead_state_transition()`);
    await queryRunner.query(`CREATE TRIGGER TRG_lead_cycles_protect
      BEFORE UPDATE OR DELETE ON public.lead_commercial_cycles FOR EACH ROW
      EXECUTE FUNCTION app_private.protect_lead_cycle_history()`);
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
          AND previous_stage IS NOT NULL AND new_stage IS NOT NULL
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

  private runtimeSignatures(): string[] {
    return [
      'app_private.create_pipeline(uuid,uuid,uuid,uuid,text,jsonb)',
      'app_private.rename_pipeline(uuid,uuid,uuid,uuid,bigint,text)',
      'app_private.create_pipeline_stage(uuid,uuid,uuid,uuid,uuid,bigint,text)',
      'app_private.rename_pipeline_stage(uuid,uuid,uuid,uuid,uuid,bigint,text)',
      'app_private.reorder_pipeline_stages(uuid,uuid,uuid,uuid,bigint,uuid[])',
      'app_private.archive_pipeline_stage(uuid,uuid,uuid,uuid,uuid,bigint)',
      'app_private.ingest_lead_with_pipeline(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb,text,uuid)',
      'app_private.execute_lead_stage_move_command(uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,uuid)',
      'app_private.execute_lead_cycle_start_command(uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,uuid)',
    ];
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
      `SELECT role.rolname FROM pg_roles role WHERE role.rolname=$1
       AND role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolbypassrls
       AND role.rolname<>current_user`,
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
