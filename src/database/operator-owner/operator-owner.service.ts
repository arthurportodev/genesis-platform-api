import { DataSource, EntityManager } from 'typeorm';
import {
  hashPassword,
  validatePasswordPolicy,
} from '../../modules/credentials/password-policy';
import {
  OperatorOwnerCreateResult,
  OperatorOwnerError,
  OperatorOwnerIdentifiers,
  OperatorOwnerStatusResult,
  PreparedOperatorOwnerInput,
} from './operator-owner.model';

interface QueryExecutor {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

export type OperatorOwnerDatabaseStep =
  'organization_created' | 'user_created' | 'membership_created';

export interface OperatorOwnerServiceOptions {
  afterStep?: (step: OperatorOwnerDatabaseStep) => Promise<void>;
}

interface ScopedStatusRow {
  organizationId: string;
  userId: string;
  membershipId: string;
  organization: string;
  organizationSlug: string;
  emailNormalized: string;
  organizationActive: boolean;
  userActive: boolean;
  membershipActive: boolean;
  ownerRole: boolean;
  credentialPresent: boolean;
  leads: number;
  sessions: number;
  refreshTokens: number;
  effectiveOwners: number;
  checkedAt: Date;
}

export class OperatorOwnerService {
  private readonly afterStep: (
    step: OperatorOwnerDatabaseStep,
  ) => Promise<void>;

  constructor(
    private readonly connection: DataSource,
    options: OperatorOwnerServiceOptions = {},
  ) {
    this.afterStep = options.afterStep ?? (() => Promise.resolve());
  }

  async preflight(identity: PreparedOperatorOwnerInput): Promise<void> {
    await assertOperatorOwnerOperationalRole(this.connection);
    await assertOperatorOwnerSchema(this.connection);
    await this.assertNoIdentityConflict(this.connection, identity);
  }

  async create(
    identity: PreparedOperatorOwnerInput,
    passwordBytes: Buffer,
  ): Promise<OperatorOwnerCreateResult> {
    const secret: { password: string | null } = {
      password: passwordBytes.toString('utf8'),
    };
    try {
      try {
        validatePasswordPolicy(secret.password ?? '');
      } catch {
        throw new OperatorOwnerError(
          'INVALID_PASSWORD',
          'Password does not satisfy the configured policy.',
        );
      }

      await this.preflight(identity);
      return await this.connection.transaction(
        'SERIALIZABLE',
        async (manager) =>
          this.createInTransaction(manager, identity, secret.password ?? ''),
      );
    } catch (error) {
      throw sanitizeDatabaseFailure(error);
    } finally {
      secret.password = null;
      passwordBytes.fill(0);
    }
  }

  async status(
    identifiers: OperatorOwnerIdentifiers,
  ): Promise<OperatorOwnerStatusResult> {
    await assertOperatorOwnerOperationalRole(this.connection);
    await assertOperatorOwnerSchema(this.connection);
    const row = await this.loadScopedStatus(this.connection, identifiers);
    if (row === undefined) {
      return {
        ...identifiers,
        status: 'NOT_FOUND',
        organizationActive: false,
        userActive: false,
        membershipActive: false,
        leads: 0,
        sessions: 0,
        refreshTokens: 0,
        effectiveOwners: 0,
        invariantsValid: false,
        issues: ['TARGET_NOT_FOUND'],
        checkedAt: new Date().toISOString(),
      };
    }
    return this.toStatusResult(row);
  }

  private async createInTransaction(
    manager: EntityManager,
    identity: PreparedOperatorOwnerInput,
    password: string,
  ): Promise<OperatorOwnerCreateResult> {
    await this.lockIdentity(manager, identity);
    await manager.query(
      'LOCK TABLE public.organizations, public.users, public.memberships IN ROW EXCLUSIVE MODE',
    );
    await assertOperatorOwnerSchema(manager, this.connection);
    await this.assertNoIdentityConflict(manager, identity);

    const credential: { hash: string | null } = { hash: null };
    try {
      credential.hash = await hashPassword(password);
      const [organization] = await manager.query<
        Array<{ id: string; createdAt: Date }>
      >(
        `INSERT INTO public.organizations (name, slug, status)
         VALUES ($1, $2, 'active')
         RETURNING id, created_at AS "createdAt"`,
        [identity.organizationName, identity.organizationSlug],
      );
      if (organization === undefined) throwInvariant();
      await this.afterStep('organization_created');

      const [user] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO public.users
           (email, name, status, password_hash, password_changed_at, email_verified_at)
         VALUES ($1, $2, 'active', $3, transaction_timestamp(), transaction_timestamp())
         RETURNING id`,
        [identity.emailNormalized, identity.ownerName, credential.hash],
      );
      if (user === undefined) throwInvariant();
      await this.afterStep('user_created');

      const [membership] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO public.memberships
           (user_id, organization_id, role, status)
         VALUES ($1, $2, 'owner', 'active')
         RETURNING id`,
        [user.id, organization.id],
      );
      if (membership === undefined) throwInvariant();
      await this.afterStep('membership_created');

      const identifiers = {
        organizationId: organization.id,
        userId: user.id,
        membershipId: membership.id,
      };
      const status = await this.loadScopedStatus(manager, identifiers);
      if (status === undefined || !this.statusInvariantsHold(status)) {
        throwInvariant();
      }
      return {
        ...identifiers,
        status: 'CREATED',
        organization: status.organization,
        organizationSlug: status.organizationSlug,
        emailNormalized: status.emailNormalized,
        role: 'OWNER',
        organizationActive: true,
        userActive: true,
        membershipActive: true,
        initialLeads: 0,
        initialSessions: 0,
        initialRefreshTokens: 0,
        createdAt: organization.createdAt.toISOString(),
        loginInstruction:
          'Open https://app.agenciagenesismkt.com.br and enter the credentials directly in the browser.',
      };
    } finally {
      credential.hash = null;
    }
  }

  private async assertNoIdentityConflict(
    executor: QueryExecutor,
    identity: PreparedOperatorOwnerInput,
  ): Promise<void> {
    const [row] = await executor.query<Array<{ conflict: boolean }>>(
      `SELECT
         EXISTS (
           SELECT 1 FROM public.users
           WHERE lower(btrim(email)) = $1
         ) OR EXISTS (
           SELECT 1 FROM public.organizations
           WHERE slug = $2 OR lower(btrim(name)) = lower($3)
         ) AS conflict`,
      [
        identity.emailNormalized,
        identity.organizationSlug,
        identity.organizationName,
      ],
    );
    if (row?.conflict) {
      throw new OperatorOwnerError(
        'CONFLICT',
        'The requested production identity is unavailable.',
      );
    }
  }

  private async lockIdentity(
    manager: EntityManager,
    identity: PreparedOperatorOwnerInput,
  ): Promise<void> {
    const keys = [
      `operator-owner:email:${identity.emailNormalized}`,
      `operator-owner:name:${identity.organizationName.toLowerCase()}`,
      `operator-owner:slug:${identity.organizationSlug}`,
    ].sort();
    for (const key of keys) {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      );
    }
  }

  private async loadScopedStatus(
    executor: QueryExecutor,
    identifiers: OperatorOwnerIdentifiers,
  ): Promise<ScopedStatusRow | undefined> {
    const [row] = await executor.query<ScopedStatusRow[]>(
      `SELECT organization.id AS "organizationId",
              application_user.id AS "userId",
              membership.id AS "membershipId",
              organization.name AS organization,
              organization.slug AS "organizationSlug",
              application_user.email AS "emailNormalized",
              organization.status = 'active' AS "organizationActive",
              application_user.status = 'active' AS "userActive",
              membership.status = 'active' AS "membershipActive",
              membership.role = 'owner' AS "ownerRole",
              application_user.password_hash IS NOT NULL AS "credentialPresent",
              (SELECT count(*)::int FROM public.leads lead
                WHERE lead.organization_id = organization.id) AS leads,
              (SELECT count(*)::int FROM public.auth_sessions session
                WHERE session.user_id = application_user.id) AS sessions,
              (SELECT count(*)::int FROM public.auth_refresh_tokens token
                JOIN public.auth_sessions session ON session.id = token.session_id
                WHERE session.user_id = application_user.id) AS "refreshTokens",
              (SELECT count(*)::int FROM public.memberships candidate
                JOIN public.users owner_user ON owner_user.id = candidate.user_id
                 AND owner_user.status = 'active'
                WHERE candidate.organization_id = organization.id
                  AND candidate.status = 'active' AND candidate.role = 'owner')
                AS "effectiveOwners",
              clock_timestamp() AS "checkedAt"
       FROM public.organizations organization
       JOIN public.memberships membership
         ON membership.id = $3 AND membership.organization_id = organization.id
       JOIN public.users application_user
         ON application_user.id = $2 AND application_user.id = membership.user_id
       WHERE organization.id = $1`,
      [
        identifiers.organizationId,
        identifiers.userId,
        identifiers.membershipId,
      ],
    );
    return row;
  }

  private statusInvariantsHold(row: ScopedStatusRow): boolean {
    return (
      row.organizationActive &&
      row.userActive &&
      row.membershipActive &&
      row.ownerRole &&
      row.credentialPresent &&
      row.effectiveOwners === 1 &&
      row.leads === 0 &&
      row.sessions === 0 &&
      row.refreshTokens === 0
    );
  }

  private toStatusResult(row: ScopedStatusRow): OperatorOwnerStatusResult {
    const issues: string[] = [];
    if (!row.organizationActive) issues.push('ORGANIZATION_INACTIVE');
    if (!row.userActive) issues.push('USER_INACTIVE');
    if (!row.membershipActive) issues.push('MEMBERSHIP_INACTIVE');
    if (!row.ownerRole) issues.push('ROLE_NOT_OWNER');
    if (!row.credentialPresent) issues.push('CREDENTIAL_MISSING');
    if (row.effectiveOwners !== 1) issues.push('OWNER_INVARIANT_FAILED');
    if (row.leads !== 0) issues.push('INITIAL_LEADS_NOT_ZERO');
    if (row.sessions !== 0) issues.push('INITIAL_SESSIONS_NOT_ZERO');
    if (row.refreshTokens !== 0) issues.push('INITIAL_REFRESH_TOKENS_NOT_ZERO');
    return {
      organizationId: row.organizationId,
      userId: row.userId,
      membershipId: row.membershipId,
      status: issues.length === 0 ? 'READY' : 'INVALID',
      organization: row.organization,
      organizationSlug: row.organizationSlug,
      emailNormalized: row.emailNormalized,
      role: row.ownerRole ? 'OWNER' : undefined,
      organizationActive: row.organizationActive,
      userActive: row.userActive,
      membershipActive: row.membershipActive,
      leads: row.leads,
      sessions: row.sessions,
      refreshTokens: row.refreshTokens,
      effectiveOwners: row.effectiveOwners,
      invariantsValid: issues.length === 0,
      issues,
      checkedAt: row.checkedAt.toISOString(),
    };
  }
}

export async function assertOperatorOwnerOperationalRole(
  connection: QueryExecutor,
): Promise<void> {
  const [role] = await connection.query<
    Array<{
      canLogin: boolean;
      superuser: boolean;
      createDatabase: boolean;
      createRole: boolean;
      inherit: boolean;
      bypassRls: boolean;
      ownsDatabase: boolean;
      ownsPublicSchema: boolean;
      memberships: number;
    }>
  >(
    `SELECT role.rolcanlogin AS "canLogin", role.rolsuper AS superuser,
            role.rolcreatedb AS "createDatabase",
            role.rolcreaterole AS "createRole", role.rolinherit AS inherit,
            role.rolbypassrls AS "bypassRls",
            pg_get_userbyid(database.datdba) = current_user AS "ownsDatabase",
            pg_get_userbyid(namespace.nspowner) = current_user AS "ownsPublicSchema",
            (SELECT count(*)::int FROM pg_auth_members membership
             WHERE membership.member = role.oid OR membership.roleid = role.oid)
              AS memberships
       FROM pg_roles role
       JOIN pg_database database ON database.datname = current_database()
       JOIN pg_namespace namespace ON namespace.nspname = 'public'
      WHERE role.rolname = current_user`,
  );
  if (
    role === undefined ||
    !role.canLogin ||
    role.superuser ||
    role.createDatabase ||
    role.createRole ||
    role.inherit ||
    role.bypassRls ||
    !role.ownsDatabase ||
    !role.ownsPublicSchema ||
    role.memberships !== 0
  ) {
    throw new OperatorOwnerError(
      'UNSAFE_DATABASE_ROLE',
      'Owner onboarding requires the approved migration-owner role.',
    );
  }
}

export async function assertOperatorOwnerSchema(
  executor: QueryExecutor,
  source?: DataSource,
): Promise<void> {
  const dataSource = source ?? (executor as DataSource);
  if (
    typeof dataSource.showMigrations !== 'function' ||
    (await dataSource.showMigrations())
  ) {
    throwSchemaAttestation();
  }
  const expectedMigrations = dataSource.migrations
    .map(({ name }) => name)
    .sort();
  const applied = await executor.query<Array<{ name: string }>>(
    'SELECT name FROM public.migrations ORDER BY name',
  );
  if (
    expectedMigrations.length === 0 ||
    JSON.stringify(applied.map(({ name }) => name).sort()) !==
      JSON.stringify(expectedMigrations)
  ) {
    throwSchemaAttestation();
  }
  const [schema] = await executor.query<
    Array<{
      organizations: boolean;
      users: boolean;
      memberships: boolean;
      leads: boolean;
      sessions: boolean;
      refreshTokens: boolean;
      passwordHash: boolean;
      emailVerifiedAt: boolean;
      emailUnique: boolean;
      slugUnique: boolean;
      ownershipGuard: boolean;
    }>
  >(
    `SELECT
       to_regclass('public.organizations') IS NOT NULL AS organizations,
       to_regclass('public.users') IS NOT NULL AS users,
       to_regclass('public.memberships') IS NOT NULL AS memberships,
       to_regclass('public.leads') IS NOT NULL AS leads,
       to_regclass('public.auth_sessions') IS NOT NULL AS sessions,
       to_regclass('public.auth_refresh_tokens') IS NOT NULL AS "refreshTokens",
       EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='users' AND column_name='password_hash'
           AND data_type='character varying' AND character_maximum_length=255)
         AS "passwordHash",
       EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='users' AND column_name='email_verified_at'
           AND data_type='timestamp with time zone') AS "emailVerifiedAt",
       EXISTS (SELECT 1 FROM pg_constraint
         WHERE conrelid='public.users'::regclass AND conname='UQ_users_email'
           AND contype='u') AS "emailUnique",
       EXISTS (SELECT 1 FROM pg_constraint
         WHERE conrelid='public.organizations'::regclass AND conname='UQ_organizations_slug'
           AND contype='u') AS "slugUnique",
       to_regprocedure('app_private.assert_active_organization_effective_owner(uuid[])')
         IS NOT NULL AS "ownershipGuard"`,
  );
  if (schema === undefined || Object.values(schema).some((value) => !value)) {
    throwSchemaAttestation();
  }
}

function sanitizeDatabaseFailure(error: unknown): OperatorOwnerError {
  if (error instanceof OperatorOwnerError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
  if (code === '23505' || code === '40001') {
    return new OperatorOwnerError(
      'CONFLICT',
      'The requested production identity is unavailable.',
    );
  }
  return new OperatorOwnerError(
    'UNEXPECTED_FAILURE',
    'Owner onboarding failed and the transaction was rolled back.',
  );
}

function throwInvariant(): never {
  throw new OperatorOwnerError(
    'INVARIANT_VIOLATION',
    'Owner onboarding invariants were not satisfied.',
  );
}

function throwSchemaAttestation(): never {
  throw new OperatorOwnerError(
    'SCHEMA_ATTESTATION_FAILED',
    'Database schema does not match the approved owner-onboarding contract.',
  );
}
