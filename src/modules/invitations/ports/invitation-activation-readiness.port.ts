import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InvitationTokenKeyring } from './invitation-token-keyring.port';

export const INVITATION_ACTIVATION_READINESS = Symbol(
  'INVITATION_ACTIVATION_READINESS',
);

export interface InvitationActivationReadiness {
  assertReady(): Promise<void>;
}

interface ReadinessRow {
  hasColumn: boolean;
  hasFunction: boolean;
  canExecute: boolean;
  canUseSchema: boolean;
  canCreateSchema: boolean;
  publicCanExecute: boolean;
  canAssumeOwner: boolean;
  canMutateUsers: boolean;
  canMutateMemberships: boolean;
  canMutateUserColumn: boolean;
  canMutateMembershipColumn: boolean;
  executableFunctions: string[];
}

const EXPECTED_EXECUTABLE_FUNCTIONS = [
  'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
  'app_private.apply_existing_user_invitation_membership(uuid,uuid)',
  'app_private.lock_auth_refresh_user(uuid)',
  'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
];

export class OperationalInvitationActivationReadiness implements InvitationActivationReadiness {
  private readonly logger = new Logger(
    OperationalInvitationActivationReadiness.name,
  );

  constructor(
    private readonly enabled: boolean,
    private readonly replicaCount: number,
    private readonly keyring: InvitationTokenKeyring,
    private readonly dataSource: DataSource,
  ) {}

  async assertReady(): Promise<void> {
    if (!this.enabled) this.unavailable('disabled');
    if (this.replicaCount !== 1) this.unavailable('replica_count');
    let versions: Array<{ keyVersion: number }>;
    let schema: ReadinessRow | undefined;
    try {
      versions = await this.dataSource.query<Array<{ keyVersion: number }>>(
        `SELECT DISTINCT token_key_version AS "keyVersion"
         FROM public.organization_invitations
         WHERE status = 'pending'
           AND expires_at > transaction_timestamp()
         ORDER BY token_key_version`,
      );
      [schema] = await this.dataSource.query<ReadinessRow[]>(
        `WITH activation AS (
           SELECT procedure.oid, procedure.proowner, procedure.proacl
           FROM pg_proc AS procedure
           JOIN pg_namespace AS namespace
             ON namespace.oid = procedure.pronamespace
           WHERE namespace.nspname = 'app_private'
             AND procedure.oid = to_regprocedure(
               'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)'
             )
         ), executable_functions AS (
           SELECT procedure.oid::regprocedure::text AS signature
           FROM pg_proc AS procedure
           JOIN pg_namespace AS namespace
             ON namespace.oid = procedure.pronamespace
           WHERE namespace.nspname = 'app_private'
             AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
         )
         SELECT
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users'
               AND column_name = 'email_verified_at'
           ) AS "hasColumn",
           to_regprocedure(
             'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)'
           ) IS NOT NULL AS "hasFunction",
           has_function_privilege(
             current_user,
             'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
             'EXECUTE'
           ) AS "canExecute",
           has_schema_privilege(current_user, 'app_private', 'USAGE')
             AS "canUseSchema",
           has_schema_privilege(current_user, 'app_private', 'CREATE')
             AS "canCreateSchema",
           EXISTS (
             SELECT 1 FROM activation
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               COALESCE(activation.proacl, acldefault('f', activation.proowner))
             ) AS acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           ) AS "publicCanExecute",
           COALESCE((
             SELECT pg_has_role(current_user, activation.proowner, 'MEMBER')
             FROM activation
           ), false) AS "canAssumeOwner",
           has_table_privilege(
             current_user, 'public.users',
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
           ) AS "canMutateUsers",
           has_table_privilege(
             current_user, 'public.memberships',
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
           ) AS "canMutateMemberships",
           has_any_column_privilege(
             current_user, 'public.users', 'INSERT,UPDATE,REFERENCES'
           ) AS "canMutateUserColumn",
           has_any_column_privilege(
             current_user, 'public.memberships', 'INSERT,UPDATE,REFERENCES'
           ) AS "canMutateMembershipColumn",
           ARRAY(
             SELECT signature FROM executable_functions ORDER BY signature
           ) AS "executableFunctions"`,
      );
    } catch {
      this.unavailable('database_unavailable');
    }
    if (
      schema?.hasColumn !== true ||
      schema.hasFunction !== true ||
      schema.canExecute !== true ||
      schema.canUseSchema !== true ||
      schema.canCreateSchema ||
      schema.publicCanExecute ||
      schema.canAssumeOwner ||
      schema.canMutateUsers ||
      schema.canMutateMemberships ||
      schema.canMutateUserColumn ||
      schema.canMutateMembershipColumn ||
      JSON.stringify(schema.executableFunctions) !==
        JSON.stringify(EXPECTED_EXECUTABLE_FUNCTIONS)
    ) {
      this.unavailable('schema_unavailable');
    }
    for (const version of versions) {
      try {
        if (this.keyring.keyFor(version.keyVersion).length < 32) {
          this.unavailable('key_unavailable');
        }
      } catch {
        this.unavailable('key_unavailable');
      }
    }
  }

  private unavailable(code: string): never {
    this.logger.warn(
      JSON.stringify({ event: 'invitation_activation_readiness_failed', code }),
    );
    throw new ServiceUnavailableException(
      'Invitation activation is unavailable.',
    );
  }
}
