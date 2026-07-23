import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS,
  RUNTIME_EXECUTABLE_FUNCTIONS,
} from '../../../database/runtime-executable-functions';

export const MEMBERSHIP_READINESS = Symbol('MEMBERSHIP_READINESS');

export interface MembershipReadiness {
  assertReady(): Promise<void>;
}

interface BoundaryRow {
  hasFunction: boolean;
  canExecute: boolean;
  canUseSchema: boolean;
  canCreateSchema: boolean;
  publicCanExecute: boolean;
  canAssumeOwner: boolean;
  canMutateCentralTables: boolean;
  executableFunctions: string[];
  catalogSafe: boolean;
}

export class OperationalMembershipReadiness implements MembershipReadiness {
  private readonly logger = new Logger(OperationalMembershipReadiness.name);

  constructor(
    private readonly publicReplicaCount: number,
    private readonly dataSource: DataSource,
  ) {}

  async assertReady(): Promise<void> {
    if (this.publicReplicaCount !== 1) this.unavailable('replica_count');
    let boundary: BoundaryRow | undefined;
    try {
      [boundary] = await this.dataSource.query<BoundaryRow[]>(`
        WITH executable_functions AS (
          SELECT procedure.oid::regprocedure::text AS signature
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'app_private'
            AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
        )
        SELECT
          to_regprocedure(
            'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,public.membership_role_enum,uuid,inet,text)'
          ) IS NOT NULL AS "hasFunction",
          has_function_privilege(
            current_user,
            'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,public.membership_role_enum,uuid,inet,text)',
            'EXECUTE'
          ) AS "canExecute",
          has_schema_privilege(current_user, 'app_private', 'USAGE') AS "canUseSchema",
          has_schema_privilege(current_user, 'app_private', 'CREATE') AS "canCreateSchema",
          EXISTS (
            SELECT 1
            FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
            ) AS acl
            WHERE namespace.nspname = 'app_private'
              AND procedure.proname = 'execute_membership_command'
              AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          ) AS "publicCanExecute",
          COALESCE((
            SELECT pg_has_role(current_user, procedure.proowner, 'MEMBER')
            FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'app_private'
              AND procedure.proname = 'execute_membership_command'
          ), false) AS "canAssumeOwner",
          EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(ARRAY['users', 'organizations', 'memberships']) AS central(table_name)
            WHERE has_table_privilege(
              current_user, 'public.' || central.table_name,
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
            ) OR has_any_column_privilege(
              current_user, 'public.' || central.table_name,
              'INSERT,UPDATE,REFERENCES'
            )
          ) AS "canMutateCentralTables",
          ARRAY(
            SELECT signature FROM executable_functions ORDER BY signature
          ) AS "executableFunctions",
          (
            SELECT count(*) = 6
            FROM pg_proc AS procedure
            WHERE procedure.oid = ANY(ARRAY[
              to_regprocedure(
                'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,public.membership_role_enum,uuid,inet,text)'
              ),
              to_regprocedure('app_private.assert_active_organization_effective_owner(uuid[])'),
              to_regprocedure('app_private.enforce_membership_identity_immutable()'),
              to_regprocedure('app_private.enforce_effective_owner_from_membership()'),
              to_regprocedure('app_private.enforce_effective_owner_from_organization()'),
              to_regprocedure('app_private.enforce_effective_owner_from_user()')
            ])
              AND procedure.prosecdef
              AND procedure.provolatile = 'v'
              AND procedure.proparallel = 'u'
              AND NOT procedure.proisstrict
              AND procedure.proconfig =
                ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ) AND (
            SELECT count(*) = 2
            FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND procedure.proname IN (
                'revoke_invitations_for_inactive_membership',
                'revoke_invitations_for_inactive_user'
              )
              AND NOT procedure.prosecdef
              AND procedure.provolatile = 'v'
              AND procedure.proparallel = 'u'
              AND NOT procedure.proisstrict
              AND procedure.proconfig =
                ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
          ) AND (
            SELECT count(*) = 6
            FROM pg_trigger AS trigger
            WHERE NOT trigger.tgisinternal
              AND trigger.tgenabled = 'O'
              AND (
                (trigger.tgname = 'trg_memberships_identity_immutable'
                  AND trigger.tgrelid = 'public.memberships'::regclass
                  AND trigger.tgfoid = to_regprocedure(
                    'app_private.enforce_membership_identity_immutable()'
                  )
                  AND trigger.tgtype = 19
                  AND trigger.tgconstraint = 0
                  AND NOT trigger.tgdeferrable
                  AND NOT trigger.tginitdeferred)
                OR (trigger.tgname = 'trg_memberships_effective_owner'
                  AND trigger.tgrelid = 'public.memberships'::regclass
                  AND trigger.tgfoid = to_regprocedure(
                    'app_private.enforce_effective_owner_from_membership()'
                  )
                  AND trigger.tgtype = 29
                  AND trigger.tgconstraint <> 0
                  AND trigger.tgdeferrable AND trigger.tginitdeferred)
                OR (trigger.tgname = 'trg_organizations_effective_owner'
                  AND trigger.tgrelid = 'public.organizations'::regclass
                  AND trigger.tgfoid = to_regprocedure(
                    'app_private.enforce_effective_owner_from_organization()'
                  )
                  AND trigger.tgtype = 21
                  AND trigger.tgconstraint <> 0
                  AND trigger.tgdeferrable AND trigger.tginitdeferred)
                OR (trigger.tgname = 'trg_users_effective_owner'
                  AND trigger.tgrelid = 'public.users'::regclass
                  AND trigger.tgfoid = to_regprocedure(
                    'app_private.enforce_effective_owner_from_user()'
                  )
                  AND trigger.tgtype = 25
                  AND trigger.tgconstraint <> 0
                  AND trigger.tgdeferrable AND trigger.tginitdeferred)
                OR (trigger.tgname = 'trg_memberships_revoke_pending_invitations'
                  AND trigger.tgrelid = 'public.memberships'::regclass
                  AND trigger.tgfoid = to_regprocedure(
                    'public.revoke_invitations_for_inactive_membership()'
                  )
                  AND trigger.tgtype = 17
                  AND trigger.tgconstraint = 0
                  AND NOT trigger.tgdeferrable
                  AND NOT trigger.tginitdeferred
                  AND trigger.tgattr::text = (
                    SELECT attribute.attnum::text
                    FROM pg_attribute AS attribute
                    WHERE attribute.attrelid = 'public.memberships'::regclass
                      AND attribute.attname = 'status'
                      AND NOT attribute.attisdropped
                  ))
                OR (trigger.tgname = 'trg_users_revoke_pending_invitations'
                  AND trigger.tgrelid = 'public.users'::regclass
                  AND trigger.tgfoid = to_regprocedure(
                    'public.revoke_invitations_for_inactive_user()'
                  )
                  AND trigger.tgtype = 17
                  AND trigger.tgconstraint = 0
                  AND NOT trigger.tgdeferrable
                  AND NOT trigger.tginitdeferred
                  AND trigger.tgattr::text = (
                    SELECT attribute.attnum::text
                    FROM pg_attribute AS attribute
                    WHERE attribute.attrelid = 'public.users'::regclass
                      AND attribute.attname = 'status'
                      AND NOT attribute.attisdropped
                  ))
              )
          ) AS "catalogSafe"
      `);
    } catch {
      this.unavailable('database_unavailable');
    }
    if (
      boundary?.hasFunction !== true ||
      boundary.canExecute !== true ||
      boundary.canUseSchema !== true ||
      boundary.canCreateSchema ||
      boundary.publicCanExecute ||
      boundary.canAssumeOwner ||
      boundary.canMutateCentralTables ||
      !boundary.catalogSafe ||
      !this.executableBoundaryMatches(boundary.executableFunctions)
    ) {
      this.unavailable('schema_unavailable');
    }
  }

  private executableBoundaryMatches(actual: string[]): boolean {
    const expected = actual.includes(
      'app_private.required_lead_fingerprint_key_versions()',
    )
      ? CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS
      : [...RUNTIME_EXECUTABLE_FUNCTIONS].sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
  }

  private unavailable(code: string): never {
    this.logger.warn(
      JSON.stringify({ event: 'membership_readiness_failed', code }),
    );
    throw new ServiceUnavailableException(
      'Membership management is unavailable.',
    );
  }
}
