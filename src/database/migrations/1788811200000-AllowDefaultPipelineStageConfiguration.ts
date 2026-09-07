import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowDefaultPipelineStageConfiguration1788811200000 implements MigrationInterface {
  name = 'AllowDefaultPipelineStageConfiguration1788811200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.installFunctions(queryRunner, false);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.installFunctions(queryRunner, true);
  }

  private async installFunctions(
    queryRunner: QueryRunner,
    lockDefaultPipeline: boolean,
  ): Promise<void> {
    const compatibilityLock = lockDefaultPipeline
      ? `IF v_pipeline.is_default THEN
          RAISE EXCEPTION 'default pipeline stages are compatibility-locked' USING ERRCODE = 'P3004';
        END IF;`
      : '';

    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.create_pipeline_stage(
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
        ${compatibilityLock}
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

    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.reorder_pipeline_stages(
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
        ${compatibilityLock}
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

    await queryRunner.query(`CREATE OR REPLACE FUNCTION app_private.archive_pipeline_stage(
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
        ${compatibilityLock}
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
  }
}
