import { MigrationInterface, QueryRunner } from 'typeorm';

const PREVIOUS_ORGANIZATION_AUDIT_EVENTS = [
  'organization.invitation.created',
  'organization.invitation.replaced',
  'organization.invitation.revoked',
  'organization.invitation.revoked_issuer_membership_inactive',
  'organization.invitation.revoked_issuer_user_inactive',
  'organization.invitation.accepted',
  'organization.invitation.activated',
  'organization.membership.role_changed',
  'organization.membership.owner_promoted',
  'organization.membership.owner_demoted',
  'organization.membership.deactivated',
  'organization.membership.reactivated',
  'organization.membership.left',
  'organization.membership.last_owner_change_blocked',
  'organization.ownership.remediated',
] as const;

const ORGANIZATION_CREATED_EVENT = 'organization.created';
const CREATION_SIGNATURE =
  'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)';

export class CreateSelfServiceOrganizations1789245600000 implements MigrationInterface {
  name = 'CreateSelfServiceOrganizations1789245600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    await queryRunner.query(`
      CREATE TABLE public.organization_creation_idempotency (
        id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
        actor_user_id uuid NOT NULL,
        idempotency_key uuid NOT NULL,
        request_fingerprint char(64) NOT NULL,
        result_organization_id uuid,
        result_membership_id uuid,
        response_name varchar(160),
        response_slug varchar(120),
        response_role public.membership_role_enum,
        response_status smallint,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT UQ_organization_creation_actor_key
          UNIQUE (actor_user_id, idempotency_key),
        CONSTRAINT FK_organization_creation_actor
          FOREIGN KEY (actor_user_id) REFERENCES public.users(id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_creation_result_organization
          FOREIGN KEY (result_organization_id)
          REFERENCES public.organizations(id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT FK_organization_creation_result_membership
          FOREIGN KEY (
            result_membership_id, actor_user_id, result_organization_id
          ) REFERENCES public.memberships(id, user_id, organization_id)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT CHK_organization_creation_fingerprint
          CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
        CONSTRAINT CHK_organization_creation_snapshot CHECK (
          (
            result_organization_id IS NULL
            AND result_membership_id IS NULL
            AND response_name IS NULL
            AND response_slug IS NULL
            AND response_role IS NULL
            AND response_status IS NULL
          ) OR (
            result_organization_id IS NOT NULL
            AND result_membership_id IS NOT NULL
            AND response_name IS NOT NULL
            AND response_slug IS NOT NULL
            AND response_role = 'owner'
            AND response_status = 201
          )
        )
      )
    `);
    await queryRunner.query(`
      REVOKE ALL ON TABLE public.organization_creation_idempotency
      FROM PUBLIC, "${runtime}"
    `);

    await this.auditConstraint(queryRunner, [
      ...PREVIOUS_ORGANIZATION_AUDIT_EVENTS,
      ORGANIZATION_CREATED_EVENT,
    ]);

    await queryRunner.query(`
      CREATE FUNCTION app_private.create_self_service_organization(
        p_actor_user_id uuid,
        p_idempotency_key uuid,
        p_request_fingerprint text,
        p_organization_name text,
        p_slug_base text,
        p_ip_address inet,
        p_user_agent text,
        p_create_permitted boolean
      )
      RETURNS TABLE (
        organization_id uuid,
        organization_name text,
        organization_slug text,
        membership_id uuid,
        membership_role public.membership_role_enum,
        replayed boolean
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      CALLED ON NULL INPUT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      DECLARE
        application_user public.users%ROWTYPE;
        claim public.organization_creation_idempotency%ROWTYPE;
        created_organization_id uuid := pg_catalog.gen_random_uuid();
        created_membership_id uuid := pg_catalog.gen_random_uuid();
        candidate_slug text;
        slug_attempt integer := 1;
        claimed_rows integer := 0;
        failed_constraint text;
        database_now timestamptz := pg_catalog.transaction_timestamp();
      BEGIN
        IF p_actor_user_id IS NULL
           OR p_idempotency_key IS NULL
           OR p_request_fingerprint IS NULL
           OR p_organization_name IS NULL
           OR p_slug_base IS NULL THEN
          RAISE EXCEPTION 'organization creation arguments unavailable'
            USING ERRCODE = '22004';
        END IF;
        IF p_request_fingerprint !~ '^[a-f0-9]{64}$'
           OR p_organization_name <> pg_catalog.btrim(p_organization_name)
           OR pg_catalog.char_length(p_organization_name) < 1
           OR pg_catalog.char_length(p_organization_name) > 160
           OR p_organization_name IS DISTINCT FROM
                pg_catalog.normalize(p_organization_name, 'NFC')
           OR p_organization_name ~ '[[:cntrl:]]'
           OR EXISTS (
             SELECT 1
             FROM pg_catalog.unnest(ARRAY[
               1564, 8206, 8207, 8232, 8233, 8234, 8235, 8236,
               8237, 8238, 8294, 8295, 8296, 8297
             ]) AS forbidden(code_point)
             WHERE pg_catalog.strpos(
               p_organization_name,
               pg_catalog.chr(forbidden.code_point)
             ) > 0
           )
           OR p_slug_base !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
           OR pg_catalog.char_length(p_slug_base) > 114
           OR pg_catalog.char_length(p_slug_base) < 1
           OR (p_user_agent IS NOT NULL
             AND pg_catalog.char_length(p_user_agent) > 512) THEN
          RAISE EXCEPTION 'organization creation arguments invalid'
            USING ERRCODE = '22023';
        END IF;

        SELECT application_user_row.* INTO application_user
        FROM public.users AS application_user_row
        WHERE application_user_row.id = p_actor_user_id
        FOR UPDATE;
        IF NOT FOUND
           OR application_user.status <> 'active'
           OR application_user.email_verified_at IS NULL THEN
          RAISE EXCEPTION 'organization creation actor unavailable'
            USING ERRCODE = 'P4001';
        END IF;

        INSERT INTO public.organization_creation_idempotency (
          actor_user_id, idempotency_key, request_fingerprint, created_at
        ) VALUES (
          p_actor_user_id, p_idempotency_key, p_request_fingerprint, database_now
        ) ON CONFLICT ON CONSTRAINT UQ_organization_creation_actor_key
          DO NOTHING;
        GET DIAGNOSTICS claimed_rows = ROW_COUNT;

        IF claimed_rows = 0 THEN
          SELECT stored_claim.* INTO claim
          FROM public.organization_creation_idempotency AS stored_claim
          WHERE stored_claim.actor_user_id = p_actor_user_id
            AND stored_claim.idempotency_key = p_idempotency_key
          FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'organization creation claim unavailable'
              USING ERRCODE = 'P4003';
          END IF;
          IF claim.request_fingerprint <> p_request_fingerprint THEN
            RAISE EXCEPTION 'organization creation idempotency conflict'
              USING ERRCODE = 'P4002';
          END IF;
          IF claim.result_organization_id IS NULL
             OR claim.result_membership_id IS NULL
             OR claim.response_name IS NULL
             OR claim.response_slug IS NULL
             OR claim.response_role IS NULL
             OR claim.response_status <> 201 THEN
            RAISE EXCEPTION 'organization creation claim incomplete'
              USING ERRCODE = 'P4003';
          END IF;
          RETURN QUERY SELECT
            claim.result_organization_id,
            claim.response_name::text,
            claim.response_slug::text,
            claim.result_membership_id,
            claim.response_role,
            true;
          RETURN;
        END IF;

        IF p_create_permitted IS DISTINCT FROM true THEN
          RAISE EXCEPTION 'organization creation rate limited'
            USING ERRCODE = 'P4005';
        END IF;

        LOOP
          candidate_slug := CASE
            WHEN slug_attempt = 1 THEN p_slug_base
            ELSE p_slug_base || '-' || slug_attempt::text
          END;
          BEGIN
            INSERT INTO public.organizations (
              id, name, slug, status, created_at, updated_at
            ) VALUES (
              created_organization_id, p_organization_name, candidate_slug,
              'active', database_now, database_now
            );
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS failed_constraint = CONSTRAINT_NAME;
            IF failed_constraint <> 'UQ_organizations_slug' THEN
              RAISE;
            END IF;
            slug_attempt := slug_attempt + 1;
            IF slug_attempt > 10000 THEN
              RAISE EXCEPTION 'organization slug allocation unavailable'
                USING ERRCODE = 'P4004';
            END IF;
          END;
        END LOOP;

        INSERT INTO public.memberships (
          id, user_id, organization_id, role, status, created_at, updated_at
        ) VALUES (
          created_membership_id, p_actor_user_id, created_organization_id,
          'owner', 'active', database_now, database_now
        );

        INSERT INTO public.organization_audit_logs (
          organization_id, event_type, actor_user_id, actor_membership_id,
          correlation_id, ip_address, user_agent, occurred_at
        ) VALUES (
          created_organization_id, 'organization.created', p_actor_user_id,
          created_membership_id, p_idempotency_key, p_ip_address,
          p_user_agent, database_now
        );

        PERFORM app_private.assert_active_organization_effective_owner(
          ARRAY[created_organization_id]::uuid[]
        );

        UPDATE public.organization_creation_idempotency AS stored_claim
        SET result_organization_id = created_organization_id,
            result_membership_id = created_membership_id,
            response_name = p_organization_name,
            response_slug = candidate_slug,
            response_role = 'owner',
            response_status = 201
        WHERE stored_claim.actor_user_id = p_actor_user_id
          AND stored_claim.idempotency_key = p_idempotency_key;

        RETURN QUERY SELECT
          created_organization_id,
          p_organization_name,
          candidate_slug,
          created_membership_id,
          'owner'::public.membership_role_enum,
          false;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION ${CREATION_SIGNATURE} FROM PUBLIC, "${runtime}"`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION ${CREATION_SIGNATURE} TO "${runtime}"`,
    );
    await this.assertLeastPrivilege(queryRunner, runtime);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const runtime = await this.runtimeRole(queryRunner);
    const [state] = (await queryRunner.query(`
      SELECT
        EXISTS(
          SELECT 1 FROM public.organization_creation_idempotency
        ) OR EXISTS(
          SELECT 1 FROM public.organization_audit_logs
          WHERE event_type = '${ORGANIZATION_CREATED_EVENT}'
        ) AS populated
    `)) as Array<{ populated: boolean }>;
    if (state?.populated !== false) {
      throw new Error(
        'Self-service organization rollback requires empty creation data.',
      );
    }
    await queryRunner.query(
      `REVOKE EXECUTE ON FUNCTION ${CREATION_SIGNATURE} FROM "${runtime}"`,
    );
    await queryRunner.query(`DROP FUNCTION ${CREATION_SIGNATURE}`);
    await queryRunner.query(
      'DROP TABLE public.organization_creation_idempotency',
    );
    await this.auditConstraint(queryRunner, PREVIOUS_ORGANIZATION_AUDIT_EVENTS);
  }

  private async auditConstraint(
    queryRunner: QueryRunner,
    events: readonly string[],
  ): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE public.organization_audit_logs DROP CONSTRAINT CHK_organization_audit_logs_event',
    );
    await queryRunner.query(`
      ALTER TABLE public.organization_audit_logs
      ADD CONSTRAINT CHK_organization_audit_logs_event
      CHECK (event_type IN (${events.map((event) => `'${event}'`).join(',')}))
    `);
  }

  private async runtimeRole(queryRunner: QueryRunner): Promise<string> {
    const role = process.env.DATABASE_RUNTIME_ROLE;
    if (!role || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role)) {
      throw new Error('Invalid runtime role.');
    }
    const rows = (await queryRunner.query(
      `SELECT current_user <> rolname
        AND NOT rolsuper AND NOT rolbypassrls AND rolcanlogin
        AND NOT pg_has_role($1, current_user, 'MEMBER')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.unnest(ARRAY[
            'organizations', 'memberships', 'pipelines', 'pipeline_stages'
          ]) AS central(table_name)
          WHERE has_table_privilege(
            $1, 'public.' || central.table_name,
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
          ) OR has_any_column_privilege(
            $1, 'public.' || central.table_name,
            'INSERT,UPDATE,REFERENCES'
          )
        ) AS safe
       FROM pg_roles WHERE rolname = $1`,
      [role],
    )) as Array<{ safe: boolean }>;
    if (rows[0]?.safe !== true) {
      throw new Error(
        'Runtime role violates self-service organization boundary.',
      );
    }
    return role;
  }

  private async assertLeastPrivilege(
    queryRunner: QueryRunner,
    runtime: string,
  ): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT
        has_function_privilege($1, '${CREATION_SIGNATURE}', 'EXECUTE')
          AS "canCreate",
        has_schema_privilege($1, 'app_private', 'CREATE')
          AS "canCreateSchema",
        pg_has_role($1, current_user, 'MEMBER') AS "canAssumeOwner",
        EXISTS (
          SELECT 1 FROM pg_catalog.unnest(ARRAY[
            'organizations', 'memberships', 'pipelines', 'pipeline_stages',
            'organization_creation_idempotency'
          ]) AS central(table_name)
          WHERE has_table_privilege(
            $1, 'public.' || central.table_name,
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
          ) OR has_any_column_privilege(
            $1, 'public.' || central.table_name,
            'INSERT,UPDATE,REFERENCES'
          )
        ) AS "canMutateCentral",
        EXISTS (
          SELECT 1
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
          ) AS acl
          WHERE procedure.oid = to_regprocedure('${CREATION_SIGNATURE}')
            AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS "publicCanExecute"`,
      [runtime],
    )) as Array<{
      canCreate: boolean;
      canCreateSchema: boolean;
      canAssumeOwner: boolean;
      canMutateCentral: boolean;
      publicCanExecute: boolean;
    }>;
    if (
      row?.canCreate !== true ||
      row.canCreateSchema ||
      row.canAssumeOwner ||
      row.canMutateCentral ||
      row.publicCanExecute
    ) {
      throw new Error(
        'Runtime self-service organization boundary is not least-privilege.',
      );
    }
  }
}
