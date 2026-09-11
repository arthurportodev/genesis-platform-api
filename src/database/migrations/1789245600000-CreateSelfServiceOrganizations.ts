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
const COMMAND_TRIGGER_FUNCTION_SIGNATURE =
  'app_private.execute_organization_creation_command()';
const COMMAND_VIEW = 'public.organization_creation_commands';
const COMMAND_TRIGGER = 'trg_organization_creation_commands_insert';

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
      `
        CREATE VIEW ${COMMAND_VIEW} AS
        SELECT
          NULL::uuid AS actor_user_id,
          NULL::uuid AS idempotency_key,
          NULL::text AS request_fingerprint,
          NULL::text AS organization_name,
          NULL::text AS slug_base,
          NULL::inet AS ip_address,
          NULL::text AS user_agent,
          NULL::boolean AS create_permitted,
          NULL::uuid AS result_organization_id,
          NULL::text AS result_organization_name,
          NULL::text AS result_organization_slug,
          NULL::uuid AS result_membership_id,
          NULL::public.membership_role_enum AS result_membership_role,
          NULL::boolean AS result_replayed
        WHERE false
      `,
    );
    await queryRunner.query(
      `REVOKE ALL ON TABLE ${COMMAND_VIEW} FROM PUBLIC, "${runtime}"`,
    );
    await queryRunner.query(`
      CREATE FUNCTION ${COMMAND_TRIGGER_FUNCTION_SIGNATURE}
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      CALLED ON NULL INPUT
      VOLATILE
      PARALLEL UNSAFE
      SET search_path = pg_catalog, app_private, pg_temp
      AS $$
      DECLARE
        creation_result record;
      BEGIN
        SELECT result.* INTO STRICT creation_result
        FROM app_private.create_self_service_organization(
          NEW.actor_user_id,
          NEW.idempotency_key,
          NEW.request_fingerprint,
          NEW.organization_name,
          NEW.slug_base,
          NEW.ip_address,
          NEW.user_agent,
          NEW.create_permitted
        ) AS result;

        NEW.result_organization_id := creation_result.organization_id;
        NEW.result_organization_name := creation_result.organization_name;
        NEW.result_organization_slug := creation_result.organization_slug;
        NEW.result_membership_id := creation_result.membership_id;
        NEW.result_membership_role := creation_result.membership_role;
        NEW.result_replayed := creation_result.replayed;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION ${COMMAND_TRIGGER_FUNCTION_SIGNATURE} FROM PUBLIC, "${runtime}"`,
    );
    await queryRunner.query(`
      CREATE TRIGGER ${COMMAND_TRIGGER}
      INSTEAD OF INSERT ON ${COMMAND_VIEW}
      FOR EACH ROW
      EXECUTE FUNCTION ${COMMAND_TRIGGER_FUNCTION_SIGNATURE}
    `);
    await queryRunner.query(
      `GRANT INSERT (
        actor_user_id, idempotency_key, request_fingerprint, organization_name,
        slug_base, ip_address, user_agent, create_permitted
      ) ON ${COMMAND_VIEW} TO "${runtime}"`,
    );
    await queryRunner.query(
      `GRANT SELECT (
        result_organization_id, result_organization_name,
        result_organization_slug, result_membership_id,
        result_membership_role, result_replayed
      ) ON ${COMMAND_VIEW} TO "${runtime}"`,
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
      `REVOKE ALL ON TABLE ${COMMAND_VIEW} FROM PUBLIC, "${runtime}"`,
    );
    await queryRunner.query(
      `DROP TRIGGER ${COMMAND_TRIGGER} ON ${COMMAND_VIEW}`,
    );
    await queryRunner.query(`DROP VIEW ${COMMAND_VIEW}`);
    await queryRunner.query(
      `DROP FUNCTION ${COMMAND_TRIGGER_FUNCTION_SIGNATURE}`,
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
      `WITH runtime_role AS (
         SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
       ), target_functions AS (
         SELECT procedure.*
         FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid = ANY(ARRAY[
           pg_catalog.to_regprocedure('${CREATION_SIGNATURE}'),
           pg_catalog.to_regprocedure('${COMMAND_TRIGGER_FUNCTION_SIGNATURE}')
         ])
       ), command_relation AS (
         SELECT relation.*,
                pg_catalog.pg_get_viewdef(relation.oid, false) AS definition
         FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = pg_catalog.to_regclass('${COMMAND_VIEW}')
       ), command_columns AS (
         SELECT attribute.attname, attribute.attacl
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = pg_catalog.to_regclass('${COMMAND_VIEW}')
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
       )
       SELECT
         (SELECT count(*) = 2 FROM target_functions)
         AND NOT EXISTS (
           SELECT 1 FROM target_functions
           WHERE NOT prosecdef OR provolatile <> 'v' OR proparallel <> 'u'
             OR proconfig <> ARRAY[
               'search_path=pg_catalog, app_private, pg_temp'
             ]::text[]
             OR pg_catalog.pg_has_role($1, proowner, 'MEMBER')
             OR pg_catalog.has_function_privilege($1, oid, 'EXECUTE')
         )
         AND NOT EXISTS (
           SELECT 1 FROM target_functions
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(proacl, pg_catalog.acldefault('f', proowner))
           ) AS acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         )
         AND (SELECT count(*) = 1 FROM command_relation
              WHERE relkind = 'v'
                AND pg_catalog.strpos(definition, 'WHERE false') > 0
                AND NOT pg_catalog.pg_has_role($1, relowner, 'MEMBER'))
         AND (SELECT ARRAY(
           SELECT attribute.attname
           FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid = pg_catalog.to_regclass('${COMMAND_VIEW}')
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
           ORDER BY attribute.attnum
         )) = ARRAY[
           'actor_user_id','idempotency_key','request_fingerprint',
           'organization_name','slug_base','ip_address','user_agent',
           'create_permitted','result_organization_id',
           'result_organization_name','result_organization_slug',
           'result_membership_id','result_membership_role','result_replayed'
         ]::name[]
         AND NOT EXISTS (
           SELECT 1 FROM command_relation
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(relacl, '{}'::aclitem[])
           ) AS acl
           JOIN runtime_role ON true
           WHERE acl.grantee IN (0, runtime_role.oid)
         )
         AND (SELECT count(*) = 14
              FROM command_columns
              CROSS JOIN LATERAL pg_catalog.aclexplode(
                COALESCE(attacl, '{}'::aclitem[])
              ) AS acl
              JOIN runtime_role ON acl.grantee = runtime_role.oid
              WHERE NOT acl.is_grantable
                AND (
                  (attname = ANY(ARRAY[
                    'actor_user_id','idempotency_key','request_fingerprint',
                    'organization_name','slug_base','ip_address','user_agent',
                    'create_permitted'
                  ]::name[]) AND acl.privilege_type = 'INSERT')
                  OR
                  (attname = ANY(ARRAY[
                    'result_organization_id','result_organization_name',
                    'result_organization_slug','result_membership_id',
                    'result_membership_role','result_replayed'
                  ]::name[]) AND acl.privilege_type = 'SELECT')
                ))
         AND NOT EXISTS (
           SELECT 1 FROM command_columns
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(attacl, '{}'::aclitem[])
           ) AS acl
           CROSS JOIN runtime_role
           WHERE acl.grantee = 0 OR acl.grantee <> runtime_role.oid
             OR acl.is_grantable
             OR NOT (
               (attname = ANY(ARRAY[
                 'actor_user_id','idempotency_key','request_fingerprint',
                 'organization_name','slug_base','ip_address','user_agent',
                 'create_permitted'
               ]::name[]) AND acl.privilege_type = 'INSERT')
               OR
               (attname = ANY(ARRAY[
                 'result_organization_id','result_organization_name',
                 'result_organization_slug','result_membership_id',
                 'result_membership_role','result_replayed'
               ]::name[]) AND acl.privilege_type = 'SELECT')
             )
         )
         AND NOT pg_catalog.has_table_privilege(
           $1, '${COMMAND_VIEW}',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
         )
         AND NOT pg_catalog.has_any_column_privilege(
           $1, '${COMMAND_VIEW}', 'UPDATE,REFERENCES'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.unnest(ARRAY[
             'actor_user_id','idempotency_key','request_fingerprint',
             'organization_name','slug_base','ip_address','user_agent',
             'create_permitted'
           ]) AS input(column_name)
           WHERE NOT pg_catalog.has_column_privilege(
             $1, '${COMMAND_VIEW}', input.column_name, 'INSERT'
           ) OR pg_catalog.has_column_privilege(
             $1, '${COMMAND_VIEW}', input.column_name, 'SELECT'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.unnest(ARRAY[
             'result_organization_id','result_organization_name',
             'result_organization_slug','result_membership_id',
             'result_membership_role','result_replayed'
           ]) AS output(column_name)
           WHERE NOT pg_catalog.has_column_privilege(
             $1, '${COMMAND_VIEW}', output.column_name, 'SELECT'
           ) OR pg_catalog.has_column_privilege(
             $1, '${COMMAND_VIEW}', output.column_name, 'INSERT'
           )
         )
         AND (SELECT count(*) = 1
              FROM pg_catalog.pg_trigger AS command_trigger
              WHERE command_trigger.tgrelid =
                      pg_catalog.to_regclass('${COMMAND_VIEW}')
                AND NOT command_trigger.tgisinternal
                AND command_trigger.tgname = '${COMMAND_TRIGGER}'
                AND command_trigger.tgfoid = pg_catalog.to_regprocedure(
                  '${COMMAND_TRIGGER_FUNCTION_SIGNATURE}'
                )
                AND command_trigger.tgtype = 69
                AND command_trigger.tgenabled = 'O')
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger AS extra_trigger
           WHERE extra_trigger.tgrelid = pg_catalog.to_regclass('${COMMAND_VIEW}')
             AND NOT extra_trigger.tgisinternal
             AND extra_trigger.tgname <> '${COMMAND_TRIGGER}'
         )
         AND NOT pg_catalog.has_schema_privilege($1, 'app_private', 'CREATE')
         AND NOT pg_catalog.pg_has_role($1, current_user, 'MEMBER')
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.unnest(ARRAY[
             'organizations', 'memberships', 'pipelines', 'pipeline_stages',
             'organization_creation_idempotency'
           ]) AS central(table_name)
           WHERE pg_catalog.has_table_privilege(
             $1, 'public.' || central.table_name,
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
           ) OR pg_catalog.has_any_column_privilege(
             $1, 'public.' || central.table_name,
             'INSERT,UPDATE,REFERENCES'
           )
         ) AS ready`,
      [runtime],
    )) as Array<{ ready: boolean }>;
    if (row?.ready !== true) {
      throw new Error(
        'Runtime self-service organization boundary is not least-privilege.',
      );
    }
  }
}
