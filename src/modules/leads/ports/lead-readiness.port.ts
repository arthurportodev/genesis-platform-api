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
            AND to_regclass('public.lead_commercial_cycles') IS NOT NULL
            AND to_regclass('public.lead_return_reviews') IS NOT NULL
            AND to_regclass('public.lead_command_idempotency') IS NOT NULL
            AND to_regclass('public.lead_activities') IS NOT NULL
            AND to_regclass('public.lead_notes') IS NOT NULL
            AND to_regclass('public.lead_next_actions') IS NOT NULL
            AND to_regclass('public.lead_follow_up_idempotency') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM public.organizations organization
              WHERE NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_timezone_names timezone
                WHERE timezone.name = organization.crm_time_zone
              )
            )
            AS "tablesReady",
          to_regprocedure('app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb)') IS NOT NULL
            AND to_regprocedure('app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text)') IS NOT NULL
            AND to_regprocedure('app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint)') IS NOT NULL
            AND has_function_privilege(current_user, 'app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb)', 'EXECUTE')
            AND has_function_privilege(current_user, 'app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text)', 'EXECUTE')
            AND has_function_privilege(current_user, 'app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint)', 'EXECUTE')
            AND to_regprocedure('app_private.execute_lead_command(uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,text,jsonb,lead_stage_enum,lead_lost_reason_enum,lead_archive_reason_enum,text)') IS NOT NULL
            AND has_function_privilege(current_user, 'app_private.execute_lead_command(uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,text,jsonb,lead_stage_enum,lead_lost_reason_enum,lead_archive_reason_enum,text)', 'EXECUTE')
            AND to_regprocedure('app_private.required_lead_fingerprint_key_versions()') IS NOT NULL
            AND has_function_privilege(current_user, 'app_private.required_lead_fingerprint_key_versions()', 'EXECUTE')
            AND to_regprocedure('app_private.execute_lead_follow_up_command(uuid,uuid,uuid,uuid,app_private.lead_follow_up_command_enum,bigint,uuid,smallint,text,jsonb,lead_activity_type_enum,timestamptz,text,text,lead_next_action_type_enum,text,timestamptz,text)') IS NOT NULL
            AND has_function_privilege(current_user, 'app_private.execute_lead_follow_up_command(uuid,uuid,uuid,uuid,app_private.lead_follow_up_command_enum,bigint,uuid,smallint,text,jsonb,lead_activity_type_enum,timestamptz,text,text,lead_next_action_type_enum,text,timestamptz,text)', 'EXECUTE')
            AND to_regprocedure('app_private.required_lead_follow_up_fingerprint_key_versions()') IS NOT NULL
            AND has_function_privilege(current_user, 'app_private.required_lead_follow_up_fingerprint_key_versions()', 'EXECUTE')
            AS "functionsReady",
          (SELECT count(*) = 26 FROM pg_trigger AS trigger
            WHERE NOT trigger.tgisinternal AND trigger.tgenabled = 'O'
              AND trigger.tgname IN (
                'trg_lead_entries_append_only',
                'trg_lead_entries_append_only_statement',
                'trg_lead_entries_reject_truncate',
                'trg_lead_timeline_events_append_only',
                'trg_lead_timeline_events_append_only_statement',
                'trg_lead_timeline_events_reject_truncate',
                'trg_memberships_clear_lead_assignments',
                'trg_users_clear_lead_assignments',
                'trg_leads_state_transition',
                'trg_lead_cycles_protect',
                'trg_lead_return_reviews_protect',
                'trg_leads_cycle_consistency',
                'trg_lead_cycles_consistency',
                'trg_lead_return_reviews_consistency'
                ,'trg_organizations_crm_time_zone'
                ,'trg_lead_activities_append_only'
                ,'trg_lead_activities_append_only_statement'
                ,'trg_lead_activities_reject_truncate'
                ,'trg_lead_notes_append_only'
                ,'trg_lead_notes_append_only_statement'
                ,'trg_lead_notes_reject_truncate'
                ,'trg_lead_next_actions_protect'
                ,'trg_leads_next_action_consistency'
                ,'trg_lead_next_actions_consistency'
                ,'trg_lead_activities_next_action_consistency'
                ,'trg_lead_timeline_follow_up_enrichment'
              )) AS "triggersReady",
          has_table_privilege(current_user, 'public.leads', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_entries', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_timeline_events', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_commercial_cycles', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_return_reviews', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_activities', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_notes', 'SELECT')
            AND has_table_privilege(current_user, 'public.lead_next_actions', 'SELECT')
            AND NOT has_table_privilege(current_user, 'public.leads', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.leads', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_entries', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_entries', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_timeline_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_timeline_events', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_ingest_idempotency', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_ingest_idempotency', 'SELECT,INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_commercial_cycles', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_commercial_cycles', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_return_reviews', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_return_reviews', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_command_idempotency', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_command_idempotency', 'SELECT,INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_activities', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_activities', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_notes', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_notes', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_next_actions', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_next_actions', 'INSERT,UPDATE,REFERENCES')
            AND NOT has_table_privilege(current_user, 'public.lead_follow_up_idempotency', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            AND NOT has_any_column_privilege(current_user, 'public.lead_follow_up_idempotency', 'SELECT,INSERT,UPDATE,REFERENCES')
            AND has_schema_privilege(current_user, 'app_private', 'USAGE')
            AND NOT has_schema_privilege(current_user, 'app_private', 'CREATE')
            AS "aclReady",
          ARRAY(
            SELECT DISTINCT version FROM unnest(
              app_private.required_lead_fingerprint_key_versions()
              || app_private.required_lead_follow_up_fingerprint_key_versions()
            ) version ORDER BY version
          ) AS "fingerprintKeyVersions",
          ARRAY(
            SELECT procedure.oid::regprocedure::text
            FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'app_private'
              AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
            ORDER BY procedure.oid::regprocedure::text
          ) AS "executableFunctions",
          (SELECT count(*) = 20
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
             to_regprocedure('app_private.reject_lead_truncate()'),
             to_regprocedure('app_private.execute_lead_command(uuid,uuid,uuid,uuid,app_private.lead_command_enum,bigint,uuid,smallint,text,jsonb,lead_stage_enum,lead_lost_reason_enum,lead_archive_reason_enum,text)'),
             to_regprocedure('app_private.enforce_lead_state_transition()'),
             to_regprocedure('app_private.protect_lead_cycle_history()'),
             to_regprocedure('app_private.protect_lead_return_review_history()'),
             to_regprocedure('app_private.assert_lead_cycle_consistency()')
             ,to_regprocedure('app_private.execute_lead_follow_up_command(uuid,uuid,uuid,uuid,app_private.lead_follow_up_command_enum,bigint,uuid,smallint,text,jsonb,lead_activity_type_enum,timestamptz,text,text,lead_next_action_type_enum,text,timestamptz,text)')
             ,to_regprocedure('app_private.required_lead_follow_up_fingerprint_key_versions()')
             ,to_regprocedure('app_private.validate_organization_crm_time_zone()')
             ,to_regprocedure('app_private.protect_lead_next_action_history()')
             ,to_regprocedure('app_private.assert_lead_next_action_consistency()')
             ,to_regprocedure('app_private.enrich_lead_follow_up_timeline()')
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
                'reject_lead_append_only', 'reject_lead_truncate',
                'execute_lead_command', 'enforce_lead_state_transition',
                'protect_lead_cycle_history', 'protect_lead_return_review_history',
                'assert_lead_cycle_consistency'
                ,'execute_lead_follow_up_command'
                ,'required_lead_follow_up_fingerprint_key_versions'
                ,'validate_organization_crm_time_zone'
                ,'protect_lead_next_action_history'
                ,'assert_lead_next_action_consistency'
                ,'enrich_lead_follow_up_timeline'
              )
              AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'app_private'
              AND procedure.proname IN (
                'ingest_lead', 'update_lead', 'assign_lead',
                'required_lead_fingerprint_key_versions', 'execute_lead_command'
                ,'execute_lead_follow_up_command'
                ,'required_lead_follow_up_fingerprint_key_versions'
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
                'trg_users_clear_lead_assignments',
                'trg_leads_state_transition',
                'trg_lead_cycles_protect',
                'trg_lead_return_reviews_protect',
                'trg_leads_cycle_consistency',
                'trg_lead_cycles_consistency',
                'trg_lead_return_reviews_consistency'
                ,'trg_organizations_crm_time_zone'
                ,'trg_lead_activities_append_only'
                ,'trg_lead_activities_append_only_statement'
                ,'trg_lead_activities_reject_truncate'
                ,'trg_lead_notes_append_only'
                ,'trg_lead_notes_append_only_statement'
                ,'trg_lead_notes_reject_truncate'
                ,'trg_lead_next_actions_protect'
                ,'trg_leads_next_action_consistency'
                ,'trg_lead_next_actions_consistency'
                ,'trg_lead_activities_next_action_consistency'
                ,'trg_lead_timeline_follow_up_enrichment'
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
                OR (trigger.tgname = 'trg_leads_state_transition'
                  AND trigger.tgrelid = 'public.leads'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.enforce_lead_state_transition()')
                  AND trigger.tgtype = 23)
                OR (trigger.tgname = 'trg_lead_cycles_protect'
                  AND trigger.tgrelid = 'public.lead_commercial_cycles'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.protect_lead_cycle_history()')
                  AND trigger.tgtype = 27)
                OR (trigger.tgname = 'trg_lead_return_reviews_protect'
                  AND trigger.tgrelid = 'public.lead_return_reviews'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.protect_lead_return_review_history()')
                  AND trigger.tgtype = 27)
                OR (trigger.tgname = 'trg_leads_cycle_consistency'
                  AND trigger.tgrelid = 'public.leads'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.assert_lead_cycle_consistency()')
                  AND trigger.tgtype = 21)
                OR (trigger.tgname = 'trg_lead_cycles_consistency'
                  AND trigger.tgrelid = 'public.lead_commercial_cycles'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.assert_lead_cycle_consistency()')
                  AND trigger.tgtype = 29)
                OR (trigger.tgname = 'trg_lead_return_reviews_consistency'
                  AND trigger.tgrelid = 'public.lead_return_reviews'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.assert_lead_cycle_consistency()')
                  AND trigger.tgtype = 29)
                OR (trigger.tgname = 'trg_organizations_crm_time_zone'
                  AND trigger.tgrelid = 'public.organizations'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.validate_organization_crm_time_zone()')
                  AND trigger.tgtype = 23)
                OR (trigger.tgname = 'trg_lead_activities_append_only'
                  AND trigger.tgrelid = 'public.lead_activities'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 27)
                OR (trigger.tgname = 'trg_lead_activities_append_only_statement'
                  AND trigger.tgrelid = 'public.lead_activities'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 26)
                OR (trigger.tgname = 'trg_lead_activities_reject_truncate'
                  AND trigger.tgrelid = 'public.lead_activities'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_truncate()')
                  AND trigger.tgtype = 34)
                OR (trigger.tgname = 'trg_lead_notes_append_only'
                  AND trigger.tgrelid = 'public.lead_notes'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 27)
                OR (trigger.tgname = 'trg_lead_notes_append_only_statement'
                  AND trigger.tgrelid = 'public.lead_notes'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_append_only()')
                  AND trigger.tgtype = 26)
                OR (trigger.tgname = 'trg_lead_notes_reject_truncate'
                  AND trigger.tgrelid = 'public.lead_notes'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.reject_lead_truncate()')
                  AND trigger.tgtype = 34)
                OR (trigger.tgname = 'trg_lead_next_actions_protect'
                  AND trigger.tgrelid = 'public.lead_next_actions'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.protect_lead_next_action_history()')
                  AND trigger.tgtype = 27)
                OR (trigger.tgname = 'trg_leads_next_action_consistency'
                  AND trigger.tgrelid = 'public.leads'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.assert_lead_next_action_consistency()')
                  AND trigger.tgtype = 21)
                OR (trigger.tgname = 'trg_lead_next_actions_consistency'
                  AND trigger.tgrelid = 'public.lead_next_actions'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.assert_lead_next_action_consistency()')
                  AND trigger.tgtype = 29)
                OR (trigger.tgname = 'trg_lead_activities_next_action_consistency'
                  AND trigger.tgrelid = 'public.lead_activities'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.assert_lead_next_action_consistency()')
                  AND trigger.tgtype = 29)
                OR (trigger.tgname = 'trg_lead_timeline_follow_up_enrichment'
                  AND trigger.tgrelid = 'public.lead_timeline_events'::regclass
                  AND trigger.tgfoid = to_regprocedure('app_private.enrich_lead_follow_up_timeline()')
                  AND trigger.tgtype = 7)
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
