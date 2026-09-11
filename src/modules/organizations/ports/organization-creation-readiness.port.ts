import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../../../database/runtime-executable-functions';

export const ORGANIZATION_CREATION_READINESS = Symbol(
  'ORGANIZATION_CREATION_READINESS',
);

export interface OrganizationCreationReadiness {
  assertReady(): Promise<void>;
}

interface ReadinessRow {
  ready: boolean;
  executableFunctions: string[];
}

const CREATION_SIGNATURE =
  'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)';
const TRIGGER_FUNCTION_SIGNATURE =
  'app_private.execute_organization_creation_command()';
const COMMAND_VIEW = 'public.organization_creation_commands';
const COMMAND_TRIGGER = 'trg_organization_creation_commands_insert';

export class OperationalOrganizationCreationReadiness implements OrganizationCreationReadiness {
  private readonly logger = new Logger(
    OperationalOrganizationCreationReadiness.name,
  );

  constructor(
    private readonly publicReplicaCount: number,
    private readonly dataSource: DataSource,
  ) {}

  async assertReady(): Promise<void> {
    if (this.publicReplicaCount !== 1) this.unavailable();
    try {
      const [row] = await this.dataSource.query<ReadinessRow[]>(`
        WITH target_functions AS (
          SELECT procedure.*
          FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.oid = ANY(ARRAY[
            pg_catalog.to_regprocedure('${CREATION_SIGNATURE}'),
            pg_catalog.to_regprocedure('${TRIGGER_FUNCTION_SIGNATURE}')
          ])
        ), creation_constraints AS (
          SELECT constraint_row.conname AS name,
                 constraint_row.contype AS type,
                 constraint_row.convalidated AS validated,
                 constraint_row.confrelid AS referenced_table,
                 pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition,
                 COALESCE(index_row.indisvalid AND index_row.indisready, false)
                   AS valid_index,
                 COALESCE(index_row.indisunique, false) AS unique_index
          FROM pg_catalog.pg_constraint AS constraint_row
          LEFT JOIN pg_catalog.pg_index AS index_row
            ON index_row.indexrelid = constraint_row.conindid
          WHERE constraint_row.conrelid = pg_catalog.to_regclass(
            'public.organization_creation_idempotency'
          )
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
        ), executable_functions AS (
          SELECT procedure.oid::regprocedure::text AS signature
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'app_private'
            AND pg_catalog.has_function_privilege(
              current_user, procedure.oid, 'EXECUTE'
            )
        )
        SELECT
          pg_catalog.to_regclass('public.organization_creation_idempotency')
            IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM creation_constraints
            WHERE type = 'p' AND validated AND valid_index AND unique_index
          )
          AND EXISTS (
            SELECT 1 FROM creation_constraints
            WHERE name = 'uq_organization_creation_actor_key'
              AND type = 'u' AND validated AND valid_index AND unique_index
              AND definition = 'UNIQUE (actor_user_id, idempotency_key)'
          )
          AND EXISTS (
            SELECT 1 FROM creation_constraints
            WHERE name = 'fk_organization_creation_actor'
              AND type = 'f' AND validated
              AND referenced_table = 'public.users'::regclass
          )
          AND EXISTS (
            SELECT 1 FROM creation_constraints
            WHERE name = 'fk_organization_creation_result_organization'
              AND type = 'f' AND validated
              AND referenced_table = 'public.organizations'::regclass
          )
          AND EXISTS (
            SELECT 1 FROM creation_constraints
            WHERE name = 'fk_organization_creation_result_membership'
              AND type = 'f' AND validated
              AND referenced_table = 'public.memberships'::regclass
          )
          AND EXISTS (
            SELECT 1 FROM creation_constraints
            WHERE name = 'chk_organization_creation_fingerprint'
              AND type = 'c' AND validated
              AND pg_catalog.strpos(definition, 'request_fingerprint') > 0
              AND pg_catalog.strpos(definition, '[a-f0-9]{64}') > 0
          )
          AND EXISTS (
            SELECT 1 FROM creation_constraints
            WHERE name = 'chk_organization_creation_snapshot'
              AND type = 'c' AND validated
              AND pg_catalog.strpos(definition, 'result_organization_id') > 0
              AND pg_catalog.strpos(definition, 'result_membership_id') > 0
              AND pg_catalog.strpos(definition, 'response_status') > 0
          )
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint AS audit_constraint
            WHERE audit_constraint.conrelid =
                    'public.organization_audit_logs'::regclass
              AND audit_constraint.conname =
                    'chk_organization_audit_logs_event'
              AND audit_constraint.contype = 'c'
              AND audit_constraint.convalidated
              AND pg_catalog.strpos(
                pg_catalog.pg_get_constraintdef(audit_constraint.oid),
                'organization.created'
              ) > 0
          )
          AND (SELECT count(*) = 2 FROM target_functions)
          AND NOT EXISTS (
            SELECT 1 FROM target_functions
            WHERE NOT prosecdef OR provolatile <> 'v' OR proparallel <> 'u'
              OR proconfig <> ARRAY[
                'search_path=pg_catalog, app_private, pg_temp'
              ]::text[]
              OR pg_catalog.pg_has_role(current_user, proowner, 'MEMBER')
              OR pg_catalog.has_function_privilege(
                current_user, oid, 'EXECUTE'
              )
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
                 AND NOT pg_catalog.pg_has_role(
                   current_user, relowner, 'MEMBER'
                 ))
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
            WHERE acl.grantee IN (
              0,
              (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
            )
          )
          AND (SELECT count(*) = 14
               FROM command_columns
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 COALESCE(attacl, '{}'::aclitem[])
               ) AS acl
               WHERE acl.grantee = (
                   SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
                 )
                 AND NOT acl.is_grantable
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
            WHERE acl.grantee <> (
                    SELECT oid FROM pg_catalog.pg_roles
                    WHERE rolname = current_user
                  )
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
            current_user, '${COMMAND_VIEW}',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
          )
          AND NOT pg_catalog.has_any_column_privilege(
            current_user, '${COMMAND_VIEW}', 'UPDATE,REFERENCES'
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.unnest(ARRAY[
              'actor_user_id','idempotency_key','request_fingerprint',
              'organization_name','slug_base','ip_address','user_agent',
              'create_permitted'
            ]) AS input(column_name)
            WHERE NOT pg_catalog.has_column_privilege(
              current_user, '${COMMAND_VIEW}', input.column_name, 'INSERT'
            ) OR pg_catalog.has_column_privilege(
              current_user, '${COMMAND_VIEW}', input.column_name, 'SELECT'
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.unnest(ARRAY[
              'result_organization_id','result_organization_name',
              'result_organization_slug','result_membership_id',
              'result_membership_role','result_replayed'
            ]) AS output(column_name)
            WHERE NOT pg_catalog.has_column_privilege(
              current_user, '${COMMAND_VIEW}', output.column_name, 'SELECT'
            ) OR pg_catalog.has_column_privilege(
              current_user, '${COMMAND_VIEW}', output.column_name, 'INSERT'
            )
          )
          AND NOT EXISTS (
            SELECT result_organization_id FROM ${COMMAND_VIEW}
          )
          AND (SELECT count(*) = 1
               FROM pg_catalog.pg_trigger AS command_trigger
               WHERE command_trigger.tgrelid =
                       pg_catalog.to_regclass('${COMMAND_VIEW}')
                 AND NOT command_trigger.tgisinternal
                 AND command_trigger.tgname = '${COMMAND_TRIGGER}'
                 AND command_trigger.tgfoid = pg_catalog.to_regprocedure(
                   '${TRIGGER_FUNCTION_SIGNATURE}'
                 )
                 AND command_trigger.tgtype = 69
                 AND command_trigger.tgenabled = 'O')
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_trigger AS extra_trigger
            WHERE extra_trigger.tgrelid =
                    pg_catalog.to_regclass('${COMMAND_VIEW}')
              AND NOT extra_trigger.tgisinternal
              AND extra_trigger.tgname <> '${COMMAND_TRIGGER}'
          )
          AND pg_catalog.has_schema_privilege(
            current_user, 'app_private', 'USAGE'
          )
          AND NOT pg_catalog.has_schema_privilege(
            current_user, 'app_private', 'CREATE'
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.unnest(ARRAY[
              'organizations', 'memberships', 'pipelines', 'pipeline_stages',
              'organization_creation_idempotency'
            ]) AS central(table_name)
            WHERE pg_catalog.has_table_privilege(
              current_user, 'public.' || central.table_name,
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
            ) OR pg_catalog.has_any_column_privilege(
              current_user, 'public.' || central.table_name,
              'INSERT,UPDATE,REFERENCES'
            )
          ) AS ready,
          ARRAY(
            SELECT signature FROM executable_functions ORDER BY signature
          ) AS "executableFunctions"
      `);
      if (
        row?.ready !== true ||
        JSON.stringify(row.executableFunctions) !==
          JSON.stringify(CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS)
      ) {
        this.unavailable();
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.unavailable();
    }
  }

  private unavailable(): never {
    this.logger.error('Organization creation boundary is unavailable.');
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'ORGANIZATION_CREATION_UNAVAILABLE',
      message: 'Organization creation is unavailable.',
    });
  }
}
