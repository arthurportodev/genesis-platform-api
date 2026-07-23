import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLeadFoundation1785346800000 implements MigrationInterface {
  name = 'CreateLeadFoundation1785346800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await queryRunner.query(`
      CREATE TABLE public.leads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        display_name varchar(160) NOT NULL,
        primary_phone varchar(16) NOT NULL,
        email varchar(320),
        company_name varchar(160),
        instagram varchar(64),
        city varchar(120),
        service_interest varchar(160),
        responsible_membership_id uuid,
        created_by_membership_id uuid,
        revision bigint NOT NULL DEFAULT 0,
        next_entry_sequence bigint NOT NULL DEFAULT 1,
        next_event_sequence bigint NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT UQ_leads_id_organization UNIQUE (id, organization_id),
        CONSTRAINT UQ_leads_organization_phone UNIQUE (organization_id, primary_phone),
        CONSTRAINT FK_leads_organization FOREIGN KEY (organization_id)
          REFERENCES public.organizations(id) ON DELETE RESTRICT,
        CONSTRAINT FK_leads_responsible_membership_org
          FOREIGN KEY (responsible_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_leads_created_by_membership_org
          FOREIGN KEY (created_by_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_leads_display_name CHECK (
          display_name = btrim(display_name) AND length(display_name) > 0
        ),
        CONSTRAINT CHK_leads_primary_phone CHECK (
          primary_phone ~ '^\\+[1-9][0-9]{7,14}$'
        ),
        CONSTRAINT CHK_leads_email CHECK (
          email IS NULL OR (email = lower(btrim(email)) AND length(email) > 0)
        ),
        CONSTRAINT CHK_leads_optional_text CHECK (
          (company_name IS NULL OR (company_name = btrim(company_name) AND length(company_name) > 0))
          AND (instagram IS NULL OR (instagram = btrim(instagram) AND length(instagram) > 0))
          AND (city IS NULL OR (city = btrim(city) AND length(city) > 0))
          AND (service_interest IS NULL OR (service_interest = btrim(service_interest) AND length(service_interest) > 0))
        ),
        CONSTRAINT CHK_leads_counters CHECK (
          revision >= 0 AND next_entry_sequence >= 1 AND next_event_sequence >= 1
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_leads_organization_responsible
      ON public.leads (organization_id, responsible_membership_id, created_at DESC, id DESC)`);
    await queryRunner.query(`CREATE INDEX IDX_leads_organization_created
      ON public.leads (organization_id, created_at DESC, id DESC)`);

    await queryRunner.query(`
      CREATE TABLE public.lead_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        sequence bigint NOT NULL,
        intake_channel varchar(32) NOT NULL,
        source varchar(32) NOT NULL,
        source_detail varchar(120),
        utm_source varchar(255),
        utm_medium varchar(255),
        utm_campaign varchar(255),
        utm_content varchar(255),
        utm_term varchar(255),
        actor_membership_id uuid,
        received_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT UQ_lead_entries_id_organization UNIQUE (id, organization_id),
        CONSTRAINT UQ_lead_entries_lead_sequence UNIQUE (lead_id, sequence),
        CONSTRAINT FK_lead_entries_lead_org FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_entries_actor_membership_org
          FOREIGN KEY (actor_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_entries_sequence CHECK (sequence >= 1),
        CONSTRAINT CHK_lead_entries_channel CHECK (
          intake_channel IN ('manual', 'genesis_form')
          AND ((intake_channel = 'manual' AND actor_membership_id IS NOT NULL)
            OR (intake_channel = 'genesis_form' AND actor_membership_id IS NULL))
        ),
        CONSTRAINT CHK_lead_entries_source CHECK (
          source IN ('manual', 'landing_page', 'campaign', 'lead_magnet', 'other')
          AND ((source = 'other' AND source_detail IS NOT NULL
                AND source_detail = btrim(source_detail) AND length(source_detail) > 0)
            OR (source <> 'other' AND source_detail IS NULL))
          AND NOT (intake_channel = 'genesis_form' AND source = 'manual')
        ),
        CONSTRAINT CHK_lead_entries_utms CHECK (
          (utm_source IS NULL OR (utm_source = btrim(utm_source) AND length(utm_source) > 0))
          AND (utm_medium IS NULL OR (utm_medium = btrim(utm_medium) AND length(utm_medium) > 0))
          AND (utm_campaign IS NULL OR (utm_campaign = btrim(utm_campaign) AND length(utm_campaign) > 0))
          AND (utm_content IS NULL OR (utm_content = btrim(utm_content) AND length(utm_content) > 0))
          AND (utm_term IS NULL OR (utm_term = btrim(utm_term) AND length(utm_term) > 0))
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_lead_entries_lead_sequence
      ON public.lead_entries (organization_id, lead_id, sequence DESC)`);

    await queryRunner.query(`
      CREATE TABLE public.lead_timeline_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        lead_id uuid NOT NULL,
        sequence bigint NOT NULL,
        event_type varchar(64) NOT NULL,
        actor_membership_id uuid,
        lead_entry_id uuid,
        previous_responsible_membership_id uuid,
        new_responsible_membership_id uuid,
        changed_fields text[],
        occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT UQ_lead_timeline_events_lead_sequence UNIQUE (lead_id, sequence),
        CONSTRAINT FK_lead_timeline_events_lead_org
          FOREIGN KEY (lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_timeline_events_actor_org
          FOREIGN KEY (actor_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_timeline_events_entry_org
          FOREIGN KEY (lead_entry_id, organization_id)
          REFERENCES public.lead_entries(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_timeline_events_previous_responsible_org
          FOREIGN KEY (previous_responsible_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_timeline_events_new_responsible_org
          FOREIGN KEY (new_responsible_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_timeline_events_sequence CHECK (sequence >= 1),
        CONSTRAINT CHK_lead_timeline_events_type CHECK (event_type IN (
          'lead.created', 'lead.entry.received', 'lead.basic_data.updated',
          'lead.assignment.changed', 'lead.assignment.cleared'
        )),
        CONSTRAINT CHK_lead_timeline_events_changed_fields CHECK (
          changed_fields IS NULL OR (
            cardinality(changed_fields) > 0
            AND changed_fields <@ ARRAY[
              'displayName', 'primaryPhone', 'email', 'companyName',
              'instagram', 'city', 'serviceInterest'
            ]::text[]
          )
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_lead_timeline_lead_sequence
      ON public.lead_timeline_events (organization_id, lead_id, sequence DESC)`);

    await queryRunner.query(`
      CREATE TABLE public.lead_ingest_idempotency (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        scope_type varchar(16) NOT NULL,
        actor_membership_id uuid,
        intake_channel varchar(32) NOT NULL,
        idempotency_key uuid NOT NULL,
        fingerprint_key_version smallint NOT NULL,
        request_fingerprint char(64) NOT NULL,
        status varchar(16) NOT NULL,
        result_lead_id uuid,
        result_entry_id uuid,
        result_outcome varchar(32),
        response_status smallint,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT FK_lead_idempotency_organization FOREIGN KEY (organization_id)
          REFERENCES public.organizations(id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_idempotency_actor_org
          FOREIGN KEY (actor_membership_id, organization_id)
          REFERENCES public.memberships(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_idempotency_result_lead_org
          FOREIGN KEY (result_lead_id, organization_id)
          REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT FK_lead_idempotency_result_entry_org
          FOREIGN KEY (result_entry_id, organization_id)
          REFERENCES public.lead_entries(id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT CHK_lead_idempotency_scope CHECK (
          (scope_type = 'manual' AND intake_channel = 'manual' AND actor_membership_id IS NOT NULL)
          OR (scope_type = 'form' AND intake_channel = 'genesis_form' AND actor_membership_id IS NULL)
        ),
        CONSTRAINT CHK_lead_idempotency_fingerprint CHECK (
          fingerprint_key_version >= 1 AND request_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT CHK_lead_idempotency_status CHECK (
          (status = 'processing' AND result_lead_id IS NULL AND result_entry_id IS NULL
            AND result_outcome IS NULL AND response_status IS NULL)
          OR (status = 'completed' AND result_lead_id IS NOT NULL AND result_entry_id IS NOT NULL
            AND result_outcome IN ('created', 'entry_added')
            AND response_status IN (200, 201, 204))
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_lead_idempotency_manual
      ON public.lead_ingest_idempotency
      (organization_id, actor_membership_id, idempotency_key)
      WHERE scope_type = 'manual'`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_lead_idempotency_form
      ON public.lead_ingest_idempotency
      (organization_id, intake_channel, idempotency_key)
      WHERE scope_type = 'form'`);
    await queryRunner.query(`CREATE INDEX IDX_lead_idempotency_key_version
      ON public.lead_ingest_idempotency (fingerprint_key_version)`);

    await this.createAppendOnlyBoundary(queryRunner);
    await this.createIngestFunction(queryRunner);
    await this.createUpdateFunction(queryRunner);
    await this.createAssignmentFunction(queryRunner);
    await this.createOffboardingBoundary(queryRunner);
    await this.createKeyInventoryBoundary(queryRunner);
    await this.grantRuntime(queryRunner, runtimeRole);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT
        (SELECT count(*)::int FROM public.leads) AS leads,
        (SELECT count(*)::int FROM public.lead_entries) AS entries,
        (SELECT count(*)::int FROM public.lead_timeline_events) AS events,
        (SELECT count(*)::int FROM public.lead_ingest_idempotency) AS idempotency
    `)) as Array<{
      leads: number;
      entries: number;
      events: number;
      idempotency: number;
    }>;
    const counts = rows[0];
    if (
      counts === undefined ||
      counts.leads !== 0 ||
      counts.entries !== 0 ||
      counts.events !== 0 ||
      counts.idempotency !== 0
    ) {
      throw new Error(
        'Cannot revert lead foundation migration while CRM data exists.',
      );
    }
    const runtimeRole = await this.validatedRuntimeRole(queryRunner);
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint) FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION app_private.required_lead_fingerprint_key_versions() FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      `REVOKE SELECT ON public.leads, public.lead_entries, public.lead_timeline_events FROM "${runtimeRole}"`,
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_users_clear_lead_assignments ON public.users',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS TRG_memberships_clear_lead_assignments ON public.memberships',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.clear_lead_assignments_for_inactive_user()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.clear_lead_assignments_for_inactive_membership()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.clear_lead_assignments(uuid[])',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint)',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.required_lead_fingerprint_key_versions()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text)',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb)',
    );
    for (const table of ['lead_timeline_events', 'lead_entries']) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS TRG_${table}_reject_truncate ON public.${table}`,
      );
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS TRG_${table}_append_only_statement ON public.${table}`,
      );
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS TRG_${table}_append_only ON public.${table}`,
      );
    }
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.reject_lead_append_only()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS app_private.reject_lead_truncate()',
    );
    await queryRunner.query('DROP TABLE public.lead_ingest_idempotency');
    await queryRunner.query('DROP TABLE public.lead_timeline_events');
    await queryRunner.query('DROP TABLE public.lead_entries');
    await queryRunner.query('DROP TABLE public.leads');
  }

  private async createAppendOnlyBoundary(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.reject_lead_append_only() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN RAISE EXCEPTION 'lead history is append-only' USING ERRCODE = 'P3006'; END; $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_private.reject_lead_truncate() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN RAISE EXCEPTION 'lead history cannot be truncated' USING ERRCODE = 'P3006'; END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.reject_lead_append_only() FROM PUBLIC',
    );
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.reject_lead_truncate() FROM PUBLIC',
    );
    for (const table of ['lead_entries', 'lead_timeline_events']) {
      await queryRunner.query(
        `CREATE TRIGGER TRG_${table}_append_only BEFORE UPDATE OR DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION app_private.reject_lead_append_only()`,
      );
      await queryRunner.query(
        `CREATE TRIGGER TRG_${table}_append_only_statement BEFORE UPDATE OR DELETE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_lead_append_only()`,
      );
      await queryRunner.query(
        `CREATE TRIGGER TRG_${table}_reject_truncate BEFORE TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_lead_truncate()`,
      );
    }
  }

  private async createIngestFunction(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.ingest_lead(
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
            SELECT membership.* INTO v_target
              FROM public.memberships membership
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
          SELECT membership.* INTO v_actor
            FROM public.memberships membership
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
                    AND claim.intake_channel = 'genesis_form'))
            FOR UPDATE;
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
          v_response := CASE
            WHEN p_intake_channel = 'genesis_form' OR v_actor_role = 'member' THEN 204
            ELSE 200 END;
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
        UPDATE public.leads lead SET
          revision = lead.revision + 1,
          next_entry_sequence = v_entry_sequence + 1,
          next_event_sequence = v_event_sequence,
          updated_at = v_now
          WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        v_response := CASE
          WHEN p_intake_channel = 'genesis_form' OR v_actor_role = 'member' THEN 204
          WHEN v_outcome = 'created' THEN 201 ELSE 200 END;
        v_visible := p_intake_channel = 'manual'
          AND (v_actor_role IN ('owner', 'admin') OR v_lead.responsible_membership_id = p_actor_membership_id);
        UPDATE public.lead_ingest_idempotency claim SET
          status = 'completed', result_lead_id = v_lead.id,
          result_entry_id = v_entry_id, result_outcome = v_outcome,
          response_status = v_response, updated_at = v_now
          WHERE claim.id = v_claim_id;
        RETURN QUERY SELECT v_outcome, v_lead.id, v_entry_id, v_lead.revision,
          false, v_visible, v_response;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb) FROM PUBLIC',
    );
  }

  private async createUpdateFunction(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.update_lead(
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

  private async createAssignmentFunction(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.assign_lead(
        p_actor_user_id uuid, p_actor_membership_id uuid, p_organization_id uuid,
        p_lead_id uuid, p_responsible_membership_id uuid, p_expected_revision bigint
      ) RETURNS TABLE (lead_id uuid, revision bigint, changed boolean)
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_actor public.memberships%ROWTYPE; v_target public.memberships%ROWTYPE;
        v_target_user_id uuid; v_lead public.leads%ROWTYPE; v_now timestamptz := transaction_timestamp();
      BEGIN
        SELECT membership.* INTO v_actor FROM public.memberships membership
          WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        IF p_responsible_membership_id IS NOT NULL THEN
          SELECT membership.* INTO v_target
            FROM public.memberships membership WHERE membership.id = p_responsible_membership_id
              AND membership.organization_id = p_organization_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'responsible member not found' USING ERRCODE = 'P3002'; END IF;
          v_target_user_id := v_target.user_id;
        END IF;
        PERFORM organization.id FROM public.organizations organization
          WHERE organization.id = p_organization_id AND organization.status = 'active' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        PERFORM application_user.id FROM public.users application_user
          WHERE application_user.id = ANY(array_remove(ARRAY[p_actor_user_id, v_target_user_id]::uuid[], NULL))
          ORDER BY application_user.id FOR UPDATE;
        PERFORM membership.id FROM public.memberships membership
          WHERE membership.id = ANY(array_remove(ARRAY[p_actor_membership_id, p_responsible_membership_id]::uuid[], NULL))
          ORDER BY membership.id FOR UPDATE;
        SELECT membership.* INTO v_actor FROM public.memberships membership
          JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
          WHERE membership.id = p_actor_membership_id AND membership.user_id = p_actor_user_id
            AND membership.organization_id = p_organization_id AND membership.status = 'active'
            AND membership.role IN ('owner', 'admin');
        IF NOT FOUND THEN RAISE EXCEPTION 'organization access denied' USING ERRCODE = 'P3001'; END IF;
        IF p_responsible_membership_id IS NOT NULL THEN
          SELECT membership.* INTO v_target FROM public.memberships membership
            JOIN public.users application_user ON application_user.id = membership.user_id AND application_user.status = 'active'
            WHERE membership.id = p_responsible_membership_id
              AND membership.organization_id = p_organization_id AND membership.status = 'active';
          IF NOT FOUND THEN RAISE EXCEPTION 'responsible member not found' USING ERRCODE = 'P3002'; END IF;
        END IF;
        SELECT lead.* INTO v_lead FROM public.leads lead
          WHERE lead.id = p_lead_id AND lead.organization_id = p_organization_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'lead not found' USING ERRCODE = 'P3002'; END IF;
        IF v_lead.revision <> p_expected_revision THEN
          RAISE EXCEPTION 'lead revision conflict' USING ERRCODE = 'P3003';
        END IF;
        IF v_lead.responsible_membership_id IS NOT DISTINCT FROM p_responsible_membership_id THEN
          RETURN QUERY SELECT v_lead.id, v_lead.revision, false; RETURN;
        END IF;
        INSERT INTO public.lead_timeline_events (
          organization_id, lead_id, sequence, event_type, actor_membership_id,
          previous_responsible_membership_id, new_responsible_membership_id, occurred_at
        ) VALUES (p_organization_id, v_lead.id, v_lead.next_event_sequence,
          CASE WHEN p_responsible_membership_id IS NULL THEN 'lead.assignment.cleared' ELSE 'lead.assignment.changed' END,
          p_actor_membership_id, v_lead.responsible_membership_id, p_responsible_membership_id, v_now);
        UPDATE public.leads lead SET responsible_membership_id = p_responsible_membership_id,
          revision = lead.revision + 1, next_event_sequence = lead.next_event_sequence + 1,
          updated_at = v_now WHERE lead.id = v_lead.id RETURNING * INTO v_lead;
        RETURN QUERY SELECT v_lead.id, v_lead.revision, true;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint) FROM PUBLIC',
    );
  }

  private async createOffboardingBoundary(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.clear_lead_assignments(p_membership_ids uuid[]) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER CALLED ON NULL INPUT VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_lead public.leads%ROWTYPE; v_now timestamptz := transaction_timestamp();
      BEGIN
        IF p_membership_ids IS NULL OR cardinality(p_membership_ids) = 0 THEN RETURN; END IF;
        FOR v_lead IN SELECT lead.* FROM public.leads lead
          WHERE lead.responsible_membership_id = ANY(p_membership_ids)
          ORDER BY lead.id FOR UPDATE LOOP
          INSERT INTO public.lead_timeline_events (
            organization_id, lead_id, sequence, event_type,
            previous_responsible_membership_id, occurred_at
          ) VALUES (v_lead.organization_id, v_lead.id, v_lead.next_event_sequence,
            'lead.assignment.cleared', v_lead.responsible_membership_id, v_now);
          UPDATE public.leads lead SET responsible_membership_id = NULL,
            revision = lead.revision + 1,
            next_event_sequence = lead.next_event_sequence + 1,
            updated_at = v_now WHERE lead.id = v_lead.id
              AND lead.responsible_membership_id = v_lead.responsible_membership_id;
        END LOOP;
      END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.clear_lead_assignments(uuid[]) FROM PUBLIC',
    );
    await queryRunner.query(`
      CREATE FUNCTION app_private.clear_lead_assignments_for_inactive_membership() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN PERFORM app_private.clear_lead_assignments(ARRAY[NEW.id]::uuid[]); RETURN NEW; END; $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_private.clear_lead_assignments_for_inactive_user() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
      SET search_path = pg_catalog, pg_temp AS $$
      DECLARE v_memberships uuid[];
      BEGIN SELECT array_agg(membership.id ORDER BY membership.id) INTO v_memberships
        FROM public.memberships membership WHERE membership.user_id = NEW.id;
        PERFORM app_private.clear_lead_assignments(v_memberships); RETURN NEW; END; $$
    `);
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.clear_lead_assignments_for_inactive_membership() FROM PUBLIC',
    );
    await queryRunner.query(
      'REVOKE ALL ON FUNCTION app_private.clear_lead_assignments_for_inactive_user() FROM PUBLIC',
    );
    await queryRunner.query(`CREATE TRIGGER TRG_memberships_clear_lead_assignments
      AFTER UPDATE OF status ON public.memberships FOR EACH ROW
      WHEN (OLD.status = 'active' AND NEW.status = 'inactive')
      EXECUTE FUNCTION app_private.clear_lead_assignments_for_inactive_membership()`);
    await queryRunner.query(`CREATE TRIGGER TRG_users_clear_lead_assignments
      AFTER UPDATE OF status ON public.users FOR EACH ROW
      WHEN (OLD.status = 'active' AND NEW.status = 'inactive')
      EXECUTE FUNCTION app_private.clear_lead_assignments_for_inactive_user()`);
  }

  private async grantRuntime(
    queryRunner: QueryRunner,
    runtimeRole: string,
  ): Promise<void> {
    await queryRunner.query(
      `REVOKE ALL ON public.leads, public.lead_entries, public.lead_timeline_events, public.lead_ingest_idempotency FROM PUBLIC, "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT SELECT ON public.leads, public.lead_entries, public.lead_timeline_events TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb) TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text) TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint) TO "${runtimeRole}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_private.required_lead_fingerprint_key_versions() TO "${runtimeRole}"`,
    );
  }

  private async createKeyInventoryBoundary(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION app_private.required_lead_fingerprint_key_versions()
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
