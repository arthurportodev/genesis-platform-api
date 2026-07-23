import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LeadConfig } from '../../../config/lead.config';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../../../database/runtime-executable-functions';

export const LEAD_READINESS = Symbol('LEAD_READINESS');

export interface LeadReadiness {
  assertManualReady(): Promise<void>;
  assertFormReady(): Promise<void>;
}

interface BoundaryRow {
  tablesReady: boolean;
  functionsReady: boolean;
  triggersReady: boolean;
  aclReady: boolean;
  fingerprintKeyVersions: number[];
  executableFunctions: string[];
  catalogSafe: boolean;
}

export class OperationalLeadReadiness implements LeadReadiness {
  private readonly logger = new Logger(OperationalLeadReadiness.name);

  constructor(
    private readonly config: LeadConfig,
    private readonly dataSource: DataSource,
  ) {}

  async assertManualReady(): Promise<void> {
    if (
      this.config.publicReplicaCount !== 1 ||
      this.config.idempotencyCurrentKeyVersion === null ||
      !this.config.idempotencyKeys.has(this.config.idempotencyCurrentKeyVersion)
    ) {
      this.unavailable('configuration');
    }
    await this.assertDatabaseBoundary();
  }

  async assertFormReady(): Promise<void> {
    if (
      !this.config.formReadiness ||
      this.config.formOrganizationId === null ||
      this.config.formCurrentKeyVersion === null ||
      !this.config.formKeys.has(this.config.formCurrentKeyVersion)
    ) {
      this.unavailable('form_configuration');
    }
    await this.assertManualReady();
  }

  private async assertDatabaseBoundary(): Promise<void> {
    let boundary: BoundaryRow | undefined;
    try {
      [boundary] = await this.dataSource.query<BoundaryRow[]>(`
        SELECT
          to_regclass('public.leads') IS NOT NULL
            AND to_regclass('public.lead_entries') IS NOT NULL
            AND to_regclass('public.lead_timeline_events') IS NOT NULL
            AND to_regclass('public.lead_ingest_idempotency') IS NOT NULL
            AS "tablesReady",
          to_regprocedure('app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb)') IS NOT NULL
            AND to_regprocedure('app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text)') IS NOT NULL
            AND to_regprocedure('app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint)') IS NOT NULL
            AND has_function_privilege(current_user, 'app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb)', 'EXECUTE')
            AND has_function_privilege(current_user, 'app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text)', 'EXECUTE')
            AND has_function_privilege(current_user, 'app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint)', 'EXECUTE')
            AND to_regprocedure('app_private.required_lead_fingerprint_key_versions()') IS NOT NULL
            AND has_function_privilege(current_user, 'app_private.required_lead_fingerprint_key_versions()', 'EXECUTE')
            AS "functionsReady",
          (SELECT count(*) = 8 FROM pg_trigger AS trigger
            WHERE NOT trigger.tgisinternal AND trigger.tgenabled = 'O'
              AND trigger.tgname IN (
                'trg_lead_entries_append_only',
                'trg_lead_entries_append_only_statement',
                'trg_lead_entries_reject_truncate',
                'trg_lead_timeline_events_append_only',
                'trg_lead_timeline_events_append_only_statement',
                'trg_lead_timeline_events_reject_truncate',
                'trg_memberships_clear_lead_assignments',
                'trg_users_clear_lead_assignments'
              )) AS "triggersReady",
          has_table_privilege(current_user, 'public.leads', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_entries', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_timeline_events', 'SELECT')
            AND NOT has_table_privilege(current_user, 'public.leads', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.leads', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_entries', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_entries', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_timeline_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_timeline_events', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_ingest_idempotency', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_ingest_idempotency', 'SELECT,INSERT,UPDATE,REFERENCES')
            AND has_schema_privilege(current_user, 'app_private', 'USAGE')
            AND NOT has_schema_privilege(current_user, 'app_private', 'CREATE')
            AS "aclReady",
          app_private.required_lead_fingerprint_key_versions()
            AS "fingerprintKeyVersions",
          ARRAY(
            SELECT procedure.oid::regprocedure::text
            FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'app_private'
              AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
            ORDER BY procedure.oid::regprocedure::text
          ) AS "executableFunctions",
          (SELECT count(*) = 9
           FROM pg_proc AS procedure
           WHERE procedure.oid = ANY(ARRAY[
              to_regprocedure('app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb)'),
             to_regprocedure('app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text)'),
             to_regprocedure('app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint)'),
             to_regprocedure('app_private.required_lead_fingerprint_key_versions()'),
             to_regprocedure('app_private.clear_lead_assignments(uuid[])'),
             to_regprocedure('app_private.clear_lead_assignments_for_inactive_membership()'),
             to_regprocedure('app_private.clear_lead_assignments_for_inactive_user()'),
             to_regprocedure('app_private.reject_lead_append_only()'),
             to_regprocedure('app_private.reject_lead_truncate()')
           ])
             AND procedure.prosecdef
             AND procedure.proparallel = 'u'
             AND procedure.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
            ) AS acl
            WHERE namespace.nspname = 'app_private'
              AND procedure.proname IN (
                'ingest_lead', 'update_lead', 'assign_lead',
                'required_lead_fingerprint_key_versions',
                'clear_lead_assignments',
                'clear_lead_assignments_for_inactive_membership',
                'clear_lead_assignments_for_inactive_user',
                'reject_lead_append_only', 'reject_lead_truncate'
              )
              AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'app_private'
              AND procedure.proname IN (
                'ingest_lead', 'update_lead', 'assign_lead',
                'required_lead_fingerprint_key_versions'
              )
              AND pg_has_role(current_user, procedure.proowner, 'MEMBER')
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_trigger AS trigger
            WHERE NOT trigger.tgisinternal
              AND trigger.tgname IN (
                'trg_lead_entries_append_only',
                'trg_lead_entries_append_only_statement',
                'trg_lead_entries_reject_truncate',
                'trg_lead_timeline_events_append_only',
                'trg_lead_timeline_events_append_only_statement',
                'trg_lead_timeline_events_reject_truncate',
                'trg_memberships_clear_lead_assignments',
                'trg_users_clear_lead_assignments'
              ) AND NOT (
                (trigger.tgname = 'trg_lead_entries_append_only'
                  AND trigger.tgrelid = 'public.lead_entries'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 27)
                OR (trigger.tgname = 'trg_lead_entries_append_only_statement'
                  AND trigger.tgrelid = 'public.lead_entries'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 26)
                OR (trigger.tgname = 'trg_lead_entries_reject_truncate'
                  AND trigger.tgrelid = 'public.lead_entries'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_truncate()')
                  AND trigger.tgtype = 34)
                OR (trigger.tgname = 'trg_lead_timeline_events_append_only'
                  AND trigger.tgrelid = 'public.lead_timeline_events'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 27)
                OR (trigger.tgname = 'trg_lead_timeline_events_append_only_statement'
                  AND trigger.tgrelid = 'public.lead_timeline_events'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 26)
                OR (trigger.tgname = 'trg_lead_timeline_events_reject_truncate'
                  AND trigger.tgrelid = 'public.lead_timeline_events'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_truncate()')
                  AND trigger.tgtype = 34)
                OR (trigger.tgname = 'trg_memberships_clear_lead_assignments'
                  AND trigger.tgrelid = 'public.memberships'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.clear_lead_assignments_for_inactive_membership()')
                  AND trigger.tgtype = 17)
                OR (trigger.tgname = 'trg_users_clear_lead_assignments'
                  AND trigger.tgrelid = 'public.users'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.clear_lead_assignments_for_inactive_user()')
                  AND trigger.tgtype = 17)
              )
          ) AS "catalogSafe"
      `);
    } catch {
      this.unavailable('database');
    }
    if (
      boundary?.tablesReady !== true ||
      !boundary.functionsReady ||
      !boundary.triggersReady ||
      !boundary.aclReady ||
      !boundary.catalogSafe ||
      JSON.stringify(boundary.executableFunctions) !==
        JSON.stringify(CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS) ||
      boundary.fingerprintKeyVersions.some(
        (version) => !this.config.idempotencyKeys.has(version),
      )
    ) {
      this.unavailable('schema');
    }
  }

  private unavailable(code: string): never {
    this.logger.warn(JSON.stringify({ event: 'lead_readiness_failed', code }));
    throw new ServiceUnavailableException('Lead intake is unavailable.');
  }
}
