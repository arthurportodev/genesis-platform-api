import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { hashPassword } from '../../modules/credentials/password-policy';
import { Membership } from '../../modules/memberships/entities/membership.entity';
import { MembershipRole } from '../../modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../../modules/memberships/enums/membership-status.enum';
import { Organization } from '../../modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../../modules/organizations/enums/organization-status.enum';
import { User } from '../../modules/users/entities/user.entity';
import { UserStatus } from '../../modules/users/enums/user-status.enum';
import {
  LeadArchiveReason,
  LeadCommand,
} from '../../modules/leads/enums/lead.enums';
import {
  leadCommandFingerprint,
  LeadCommandFingerprintInput,
} from '../../modules/leads/security/lead-fingerprint';
import { SyntheticPasswordReader } from './masked-password-reader';
import { SyntheticFixtureManifestStore } from './synthetic-fixture-manifest';
import {
  buildSyntheticFixtureFormula,
  SYNTHETIC_FIXTURE_PREFIX,
  SYNTHETIC_FIXTURE_SCHEMA_VERSION,
  SyntheticDatabaseState,
  SyntheticFixtureError,
  SyntheticFixtureFormula,
  SyntheticFixtureManifest,
  SyntheticOrganizationRole,
  SyntheticUserRole,
} from './synthetic-fixture.model';

interface QueryExecutor {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  credentialPresent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface MembershipRow {
  id: string;
  userId: string;
  organizationId: string;
  role: 'owner' | 'admin' | 'member';
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface DatabaseSnapshot {
  organizations: OrganizationRow[];
  users: UserRow[];
  memberships: MembershipRow[];
  externalMemberships: number;
  invitations: number;
  leads: number;
  activeLeads: number;
  nonSyntheticLeads: number;
  pendingNextActions: number;
  activeSessions: number;
  activeRefreshTokens: number;
  formulaOrganizationIds: Array<{ id: string; slug: string }>;
  formulaUserIds: Array<{ id: string; email: string }>;
}

export interface SyntheticFixtureStatusResult {
  runId: string | null;
  state: SyntheticDatabaseState;
  issues: string[];
  counts: {
    organizations: number;
    users: number;
    memberships: number;
    leads: number;
    activeSessions: number;
  };
}

export interface SyntheticFixtureMutationResult {
  runId: string;
  state: 'ACTIVE' | 'DEACTIVATED';
  idempotent: boolean;
  counts: SyntheticFixtureStatusResult['counts'];
}

export type SyntheticFixtureDatabaseStep =
  | 'organizations_created'
  | 'users_created'
  | 'memberships_created'
  | 'manifest_created'
  | 'leads_archived'
  | 'sessions_revoked'
  | 'organizations_deactivated'
  | 'memberships_deactivated'
  | 'users_deactivated'
  | 'manifest_deactivated';

export interface SyntheticFixtureServiceOptions {
  now?: () => Date;
  uuid?: () => string;
  afterStep?: (step: SyntheticFixtureDatabaseStep) => Promise<void>;
  leadIdempotencyCurrentKeyVersion?: number | null;
  leadIdempotencyKeys?: ReadonlyMap<number, Buffer>;
}

export class SyntheticFixtureService {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly afterStep: (
    step: SyntheticFixtureDatabaseStep,
  ) => Promise<void>;
  private readonly leadIdempotencyCurrentKeyVersion: number | null;
  private readonly leadIdempotencyKeys: ReadonlyMap<number, Buffer>;

  constructor(
    private readonly connection: DataSource,
    private readonly manifestStore: SyntheticFixtureManifestStore,
    private readonly passwordReader: SyntheticPasswordReader,
    options: SyntheticFixtureServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.afterStep = options.afterStep ?? (() => Promise.resolve());
    this.leadIdempotencyCurrentKeyVersion =
      options.leadIdempotencyCurrentKeyVersion ?? null;
    this.leadIdempotencyKeys = options.leadIdempotencyKeys ?? new Map();
  }

  async create(runId: string): Promise<SyntheticFixtureMutationResult> {
    const formula = buildSyntheticFixtureFormula(runId);
    if (await this.manifestStore.exists()) {
      const manifest = await this.manifestStore.load();
      if (manifest.runId !== runId) {
        throw new SyntheticFixtureError(
          'MANIFEST_DIVERGED',
          'Existing manifest belongs to a different runId.',
        );
      }
      const current = await this.inspect(manifest, this.connection);
      if (current.state !== 'ACTIVE') {
        throw new SyntheticFixtureError(
          'FIXTURE_NOT_INTACT',
          'Existing fixture is not an intact active fixture.',
        );
      }
      return this.mutationResult(current, true);
    }

    await this.assertNoFormulaConflicts(this.connection, formula);
    const passwordHashes = {
      ownerA: await this.readAndHashPassword('ownerA'),
      memberA: await this.readAndHashPassword('memberA'),
      ownerB: await this.readAndHashPassword('ownerB'),
    };

    let writtenManifest: SyntheticFixtureManifest | null = null;
    try {
      const manifest = await this.connection.transaction(async (manager) => {
        await this.lockRun(manager, runId);
        if (await this.manifestStore.exists()) {
          throw new SyntheticFixtureError(
            'MANIFEST_ALREADY_EXISTS',
            'Manifest appeared during fixture creation.',
          );
        }
        await this.assertNoFormulaConflicts(manager, formula);
        const organizations = await this.createOrganizations(manager, formula);
        await this.afterStep('organizations_created');
        const users = await this.createUsers(manager, formula, passwordHashes);
        await this.afterStep('users_created');
        const memberships = await this.createMemberships(
          manager,
          organizations,
          users,
        );
        await this.afterStep('memberships_created');
        const createdAt = await this.loadPersistedCreationTimestamp(
          manager,
          organizations,
          users,
          memberships,
        );
        const candidate = this.buildManifest(
          formula,
          organizations,
          users,
          memberships,
          createdAt,
        );
        await this.manifestStore.create(candidate);
        writtenManifest = candidate;
        await this.afterStep('manifest_created');
        return candidate;
      });
      writtenManifest = null;
      const current = await this.inspect(manifest, this.connection);
      if (current.state !== 'ACTIVE') {
        throw new SyntheticFixtureError(
          'CREATE_VERIFICATION_FAILED',
          'Created fixture did not pass post-transaction verification.',
        );
      }
      return this.mutationResult(current, false);
    } catch (error) {
      if (writtenManifest !== null) {
        try {
          await this.manifestStore.removeExact(writtenManifest);
        } catch {
          throw new SyntheticFixtureError(
            'MANIFEST_RECOVERY_REQUIRED',
            'Database creation failed and manifest recovery requires review.',
          );
        }
      }
      throw this.safeOperationError(error, 'CREATE_FAILED');
    }
  }

  async status(): Promise<SyntheticFixtureStatusResult> {
    let manifest: SyntheticFixtureManifest;
    try {
      manifest = await this.manifestStore.load();
    } catch (error) {
      if (error instanceof SyntheticFixtureError) {
        return {
          runId: null,
          state: 'INVALID',
          issues: [error.code],
          counts: this.emptyCounts(),
        };
      }
      throw error;
    }
    return this.inspect(manifest, this.connection);
  }

  async deactivate(): Promise<SyntheticFixtureMutationResult> {
    const manifest = await this.manifestStore.load();
    const current = await this.inspect(manifest, this.connection);
    if (current.state === 'DEACTIVATED') {
      return this.mutationResult(current, true);
    }
    if (
      current.state !== 'ACTIVE' &&
      !(await this.isRecoverableDeactivationState(manifest, this.connection))
    ) {
      throw new SyntheticFixtureError(
        'FIXTURE_NOT_INTACT',
        'Fixture state is not an allowlisted synthetic deactivation state.',
      );
    }

    let replacement: SyntheticFixtureManifest | null = null;
    let manifestReplaced = false;
    try {
      const committedReplacement = await this.connection.transaction(
        async (manager) => {
          await this.lockRun(manager, manifest.runId);
          await this.lockFixtureRows(manager, manifest);
          const locked = await this.inspect(manifest, manager);
          if (
            locked.state !== 'ACTIVE' &&
            !(await this.isRecoverableDeactivationState(manifest, manager))
          ) {
            throw new SyntheticFixtureError(
              'FIXTURE_DRIFT',
              'Fixture changed outside the allowlisted synthetic recovery state.',
            );
          }
          const candidate: SyntheticFixtureManifest = {
            ...manifest,
            status: 'deactivated',
            deactivatedAt:
              manifest.deactivatedAt ??
              (await this.loadTransactionTimestamp(manager)),
          };
          await this.archiveActiveLeads(manager, manifest);
          await this.afterStep('leads_archived');
          await this.revokeSessions(manager, manifest);
          await this.afterStep('sessions_revoked');
          await this.deactivateOrganizations(manager, manifest);
          await this.afterStep('organizations_deactivated');
          await this.deactivateMemberships(manager, manifest);
          await this.afterStep('memberships_deactivated');
          await this.deactivateUsers(manager, manifest);
          await this.afterStep('users_deactivated');

          const deactivated = await this.inspect(candidate, manager);
          if (deactivated.state !== 'DEACTIVATED') {
            throw new SyntheticFixtureError(
              'DEACTIVATION_VERIFICATION_FAILED',
              'Deactivated fixture did not pass in-transaction verification.',
            );
          }
          replacement = candidate;
          await this.manifestStore.replace(manifest, candidate);
          manifestReplaced = true;
          await this.afterStep('manifest_deactivated');
          return candidate;
        },
      );
      replacement = committedReplacement;
    } catch (error) {
      if (manifestReplaced && replacement !== null) {
        try {
          await this.manifestStore.replace(replacement, manifest);
        } catch {
          throw new SyntheticFixtureError(
            'MANIFEST_RECOVERY_REQUIRED',
            'Database deactivation failed and manifest recovery requires review.',
          );
        }
      }
      throw this.safeOperationError(error, 'DEACTIVATE_FAILED');
    }

    if (replacement === null) {
      throw new SyntheticFixtureError(
        'DEACTIVATION_VERIFICATION_FAILED',
        'Fixture deactivation did not produce temporal evidence.',
      );
    }

    const finalState = await this.inspect(replacement, this.connection);
    if (finalState.state !== 'DEACTIVATED') {
      throw new SyntheticFixtureError(
        'DEACTIVATION_VERIFICATION_FAILED',
        'Fixture did not pass final deactivation verification.',
      );
    }
    return this.mutationResult(finalState, false);
  }

  private async readAndHashPassword(role: SyntheticUserRole): Promise<string> {
    try {
      return await hashPassword(await this.passwordReader.read(role));
    } catch (error) {
      if (error instanceof SyntheticFixtureError) throw error;
      throw new SyntheticFixtureError(
        'PASSWORD_POLICY_REJECTED',
        `Password for ${role} does not satisfy the existing policy.`,
      );
    }
  }

  private async createOrganizations(
    manager: EntityManager,
    formula: SyntheticFixtureFormula,
  ): Promise<Record<SyntheticOrganizationRole, Organization>> {
    const repository = manager.getRepository(Organization);
    const tenantA = await repository.save(
      repository.create({
        ...formula.organizations.tenantA,
        status: OrganizationStatus.ACTIVE,
      }),
    );
    const tenantB = await repository.save(
      repository.create({
        ...formula.organizations.tenantB,
        status: OrganizationStatus.ACTIVE,
      }),
    );
    return { tenantA, tenantB };
  }

  private async createUsers(
    manager: EntityManager,
    formula: SyntheticFixtureFormula,
    hashes: Record<SyntheticUserRole, string>,
  ): Promise<Record<SyntheticUserRole, User>> {
    const repository = manager.getRepository(User);
    const create = async (role: SyntheticUserRole): Promise<User> =>
      repository.save(
        repository.create({
          ...formula.users[role],
          status: UserStatus.ACTIVE,
          passwordHash: hashes[role],
          passwordChangedAt: this.now(),
          emailVerifiedAt: null,
        }),
      );
    return {
      ownerA: await create('ownerA'),
      memberA: await create('memberA'),
      ownerB: await create('ownerB'),
    };
  }

  private async createMemberships(
    manager: EntityManager,
    organizations: Record<SyntheticOrganizationRole, Organization>,
    users: Record<SyntheticUserRole, User>,
  ): Promise<Record<SyntheticUserRole, Membership>> {
    const repository = manager.getRepository(Membership);
    const create = async (
      role: SyntheticUserRole,
      organization: Organization,
      membershipRole: MembershipRole,
    ): Promise<Membership> =>
      repository.save(
        repository.create({
          userId: users[role].id,
          organizationId: organization.id,
          role: membershipRole,
          status: MembershipStatus.ACTIVE,
        }),
      );
    return {
      ownerA: await create(
        'ownerA',
        organizations.tenantA,
        MembershipRole.OWNER,
      ),
      memberA: await create(
        'memberA',
        organizations.tenantA,
        MembershipRole.MEMBER,
      ),
      ownerB: await create(
        'ownerB',
        organizations.tenantB,
        MembershipRole.OWNER,
      ),
    };
  }

  private buildManifest(
    formula: SyntheticFixtureFormula,
    organizations: Record<SyntheticOrganizationRole, Organization>,
    users: Record<SyntheticUserRole, User>,
    memberships: Record<SyntheticUserRole, Membership>,
    createdAt: string,
  ): SyntheticFixtureManifest {
    return {
      schemaVersion: SYNTHETIC_FIXTURE_SCHEMA_VERSION,
      runId: formula.runId,
      prefix: SYNTHETIC_FIXTURE_PREFIX,
      createdAt,
      deactivatedAt: null,
      organizations: [
        {
          role: 'tenantA',
          id: organizations.tenantA.id,
          slug: formula.organizations.tenantA.slug,
        },
        {
          role: 'tenantB',
          id: organizations.tenantB.id,
          slug: formula.organizations.tenantB.slug,
        },
      ],
      users: [
        {
          role: 'ownerA',
          id: users.ownerA.id,
          email: formula.users.ownerA.email,
        },
        {
          role: 'memberA',
          id: users.memberA.id,
          email: formula.users.memberA.email,
        },
        {
          role: 'ownerB',
          id: users.ownerB.id,
          email: formula.users.ownerB.email,
        },
      ],
      memberships: [
        {
          role: 'ownerA',
          id: memberships.ownerA.id,
          userId: users.ownerA.id,
          organizationId: organizations.tenantA.id,
          membershipRole: 'owner',
        },
        {
          role: 'memberA',
          id: memberships.memberA.id,
          userId: users.memberA.id,
          organizationId: organizations.tenantA.id,
          membershipRole: 'member',
        },
        {
          role: 'ownerB',
          id: memberships.ownerB.id,
          userId: users.ownerB.id,
          organizationId: organizations.tenantB.id,
          membershipRole: 'owner',
        },
      ],
      status: 'active',
    };
  }

  private async inspect(
    manifest: SyntheticFixtureManifest,
    executor: QueryExecutor,
  ): Promise<SyntheticFixtureStatusResult> {
    const formula = buildSyntheticFixtureFormula(manifest.runId);
    const snapshot = await this.loadSnapshot(executor, manifest, formula);
    const issues = this.findIssues(manifest, formula, snapshot);
    const allActive =
      snapshot.organizations.length === 2 &&
      snapshot.organizations.every(
        ({ status }) => status === OrganizationStatus.ACTIVE,
      ) &&
      snapshot.users.length === 3 &&
      snapshot.users.every(({ status }) => status === UserStatus.ACTIVE) &&
      snapshot.memberships.length === 3 &&
      snapshot.memberships.every(
        ({ status }) => status === MembershipStatus.ACTIVE,
      );
    const allDeactivated =
      snapshot.organizations.length === 2 &&
      snapshot.organizations.every(
        ({ status }) => status === OrganizationStatus.INACTIVE,
      ) &&
      snapshot.users.length === 3 &&
      snapshot.users.every(({ status }) => status === UserStatus.INACTIVE) &&
      snapshot.memberships.length === 3 &&
      snapshot.memberships.every(
        ({ status }) => status === MembershipStatus.INACTIVE,
      ) &&
      snapshot.activeLeads === 0 &&
      snapshot.pendingNextActions === 0 &&
      snapshot.activeSessions === 0 &&
      snapshot.activeRefreshTokens === 0;
    let state: SyntheticDatabaseState = 'PARTIAL';
    if (issues.length === 0 && manifest.status === 'active' && allActive) {
      state = 'ACTIVE';
    } else if (
      issues.length === 0 &&
      manifest.status === 'deactivated' &&
      allDeactivated
    ) {
      state = 'DEACTIVATED';
    }
    if (
      (manifest.status === 'active' && !allActive) ||
      (manifest.status === 'deactivated' && !allDeactivated)
    ) {
      issues.push('MANIFEST_DATABASE_STATUS_MISMATCH');
    }
    return {
      runId: manifest.runId,
      state,
      issues: [...new Set(issues)].sort(),
      counts: {
        organizations: snapshot.organizations.length,
        users: snapshot.users.length,
        memberships: snapshot.memberships.length,
        leads: snapshot.leads,
        activeSessions: snapshot.activeSessions,
      },
    };
  }

  private async loadSnapshot(
    executor: QueryExecutor,
    manifest: SyntheticFixtureManifest,
    formula: SyntheticFixtureFormula,
  ): Promise<DatabaseSnapshot> {
    const organizationIds = manifest.organizations.map(({ id }) => id);
    const userIds = manifest.users.map(({ id }) => id);
    const membershipIds = manifest.memberships.map(({ id }) => id);
    const organizations = await executor.query<OrganizationRow[]>(
      `SELECT id, name, slug, status::text AS status,
              date_trunc('milliseconds', created_at) AS "createdAt",
              date_trunc('milliseconds', updated_at) AS "updatedAt"
       FROM public.organizations WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [organizationIds],
    );
    const users = await executor.query<UserRow[]>(
      `SELECT id, name, email, status::text AS status,
              (password_hash IS NOT NULL) AS "credentialPresent",
              date_trunc('milliseconds', created_at) AS "createdAt",
              date_trunc('milliseconds', updated_at) AS "updatedAt"
       FROM public.users WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [userIds],
    );
    const memberships = await executor.query<MembershipRow[]>(
      `SELECT id, user_id AS "userId", organization_id AS "organizationId",
              role::text AS role, status::text AS status,
              date_trunc('milliseconds', created_at) AS "createdAt",
              date_trunc('milliseconds', updated_at) AS "updatedAt"
       FROM public.memberships WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [membershipIds],
    );
    const [counts] = await executor.query<
      Array<{
        externalMemberships: number;
        invitations: number;
        leads: number;
        activeLeads: number;
        nonSyntheticLeads: number;
        pendingNextActions: number;
        activeSessions: number;
        activeRefreshTokens: number;
      }>
    >(
      `SELECT
        (SELECT count(*)::int FROM public.memberships membership
         WHERE (membership.user_id = ANY($1::uuid[])
                OR membership.organization_id = ANY($2::uuid[]))
           AND NOT (membership.id = ANY($3::uuid[]))) AS "externalMemberships",
        (SELECT count(*)::int FROM public.organization_invitations invitation
         WHERE invitation.organization_id = ANY($2::uuid[])) AS invitations,
        (SELECT count(*)::int FROM public.leads lead
         WHERE lead.organization_id = ANY($2::uuid[])) AS leads,
        (SELECT count(*)::int FROM public.leads lead
         WHERE lead.organization_id = ANY($2::uuid[]) AND lead.status = 'active') AS "activeLeads",
        (SELECT count(*)::int FROM public.leads lead
         WHERE lead.organization_id = ANY($2::uuid[])
           AND lead.display_name NOT LIKE $4) AS "nonSyntheticLeads",
        (SELECT count(*)::int FROM public.lead_next_actions action
         WHERE action.organization_id = ANY($2::uuid[]) AND action.status = 'pending') AS "pendingNextActions",
        (SELECT count(*)::int FROM public.auth_sessions session
         WHERE session.user_id = ANY($1::uuid[]) AND session.status = 'active') AS "activeSessions",
        (SELECT count(*)::int FROM public.auth_refresh_tokens token
         JOIN public.auth_sessions session ON session.id = token.session_id
         WHERE session.user_id = ANY($1::uuid[]) AND token.status = 'active') AS "activeRefreshTokens"`,
      [userIds, organizationIds, membershipIds, `${SYNTHETIC_FIXTURE_PREFIX}%`],
    );
    const formulaOrganizationIds = await executor.query<
      Array<{ id: string; slug: string }>
    >(
      `SELECT id, slug FROM public.organizations
       WHERE slug = ANY($1::text[]) ORDER BY slug`,
      [Object.values(formula.organizations).map(({ slug }) => slug)],
    );
    const formulaUserIds = await executor.query<
      Array<{ id: string; email: string }>
    >(
      `SELECT id, email FROM public.users WHERE email = ANY($1::text[]) ORDER BY email`,
      [Object.values(formula.users).map(({ email }) => email)],
    );
    return {
      organizations,
      users,
      memberships,
      externalMemberships: counts?.externalMemberships ?? 0,
      invitations: counts?.invitations ?? 0,
      leads: counts?.leads ?? 0,
      activeLeads: counts?.activeLeads ?? 0,
      nonSyntheticLeads: counts?.nonSyntheticLeads ?? 0,
      pendingNextActions: counts?.pendingNextActions ?? 0,
      activeSessions: counts?.activeSessions ?? 0,
      activeRefreshTokens: counts?.activeRefreshTokens ?? 0,
      formulaOrganizationIds,
      formulaUserIds,
    };
  }

  private findIssues(
    manifest: SyntheticFixtureManifest,
    formula: SyntheticFixtureFormula,
    snapshot: DatabaseSnapshot,
  ): string[] {
    const issues: string[] = [];
    const organizationById = new Map(
      snapshot.organizations.map((row) => [row.id, row]),
    );
    for (const entry of manifest.organizations) {
      const row = organizationById.get(entry.id);
      if (row === undefined) issues.push(`MISSING_ORGANIZATION_${entry.role}`);
      else if (
        row.slug !== formula.organizations[entry.role].slug ||
        row.name !== formula.organizations[entry.role].name
      ) {
        issues.push(`ORGANIZATION_IDENTITY_DRIFT_${entry.role}`);
      }
    }
    const userById = new Map(snapshot.users.map((row) => [row.id, row]));
    for (const entry of manifest.users) {
      const row = userById.get(entry.id);
      if (row === undefined) issues.push(`MISSING_USER_${entry.role}`);
      else {
        if (
          row.email !== formula.users[entry.role].email ||
          row.name !== formula.users[entry.role].name
        ) {
          issues.push(`USER_IDENTITY_DRIFT_${entry.role}`);
        }
        if (!row.credentialPresent)
          issues.push(`MISSING_CREDENTIAL_${entry.role}`);
      }
    }
    const membershipById = new Map(
      snapshot.memberships.map((row) => [row.id, row]),
    );
    for (const entry of manifest.memberships) {
      const row = membershipById.get(entry.id);
      if (row === undefined) issues.push(`MISSING_MEMBERSHIP_${entry.role}`);
      else if (
        row.userId !== entry.userId ||
        row.organizationId !== entry.organizationId ||
        row.role !== entry.membershipRole
      ) {
        issues.push(`MEMBERSHIP_RELATIONSHIP_DRIFT_${entry.role}`);
      }
    }
    const manifestOrganizationIds = new Set(
      manifest.organizations.map(({ id }) => id),
    );
    const manifestUserIds = new Set(manifest.users.map(({ id }) => id));
    if (
      snapshot.formulaOrganizationIds.length !== 2 ||
      snapshot.formulaOrganizationIds.some(
        ({ id }) => !manifestOrganizationIds.has(id),
      )
    ) {
      issues.push('ORGANIZATION_FORMULA_CONFLICT');
    }
    if (
      snapshot.formulaUserIds.length !== 3 ||
      snapshot.formulaUserIds.some(({ id }) => !manifestUserIds.has(id))
    ) {
      issues.push('USER_FORMULA_CONFLICT');
    }
    if (snapshot.externalMemberships > 0) issues.push('EXTERNAL_MEMBERSHIP');
    if (snapshot.invitations > 0) issues.push('UNEXPECTED_INVITATION');
    if (snapshot.nonSyntheticLeads > 0) issues.push('NON_SYNTHETIC_LEAD');
    const fixtureRows = [
      ...snapshot.organizations,
      ...snapshot.users,
      ...snapshot.memberships,
    ];
    if (
      fixtureRows.length !== 8 ||
      fixtureRows.some(
        ({ createdAt }) =>
          normalizeDatabaseTimestamp(createdAt) !== manifest.createdAt,
      )
    ) {
      issues.push('MANIFEST_CREATED_AT_MISMATCH');
    }
    if (
      manifest.status === 'active' &&
      fixtureRows.some(
        ({ createdAt, updatedAt }) =>
          normalizeDatabaseTimestamp(updatedAt) !==
          normalizeDatabaseTimestamp(createdAt),
      )
    ) {
      issues.push('MANIFEST_ACTIVE_TIMESTAMP_MISMATCH');
    }
    if (
      manifest.status === 'deactivated' &&
      fixtureRows.some(
        ({ updatedAt }) =>
          normalizeDatabaseTimestamp(updatedAt) !== manifest.deactivatedAt,
      )
    ) {
      issues.push('MANIFEST_DEACTIVATED_AT_MISMATCH');
    }
    return issues;
  }

  private async loadPersistedCreationTimestamp(
    executor: QueryExecutor,
    organizations: Record<SyntheticOrganizationRole, Organization>,
    users: Record<SyntheticUserRole, User>,
    memberships: Record<SyntheticUserRole, Membership>,
  ): Promise<string> {
    const [evidence] = await executor.query<
      Array<{ rows: number; earliest: Date; latest: Date }>
    >(
      `WITH fixture_creation AS (
         SELECT created_at FROM public.organizations WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT created_at FROM public.users WHERE id = ANY($2::uuid[])
         UNION ALL
         SELECT created_at FROM public.memberships WHERE id = ANY($3::uuid[])
       )
       SELECT count(*)::int AS rows,
              date_trunc('milliseconds', min(created_at)) AS earliest,
              date_trunc('milliseconds', max(created_at)) AS latest
       FROM fixture_creation`,
      [
        Object.values(organizations).map(({ id }) => id),
        Object.values(users).map(({ id }) => id),
        Object.values(memberships).map(({ id }) => id),
      ],
    );
    if (
      evidence?.rows !== 8 ||
      normalizeDatabaseTimestamp(evidence.earliest) !==
        normalizeDatabaseTimestamp(evidence.latest)
    ) {
      throw new SyntheticFixtureError(
        'CREATE_TEMPORAL_EVIDENCE_INVALID',
        'Fixture rows do not share the persisted creation transaction timestamp.',
      );
    }
    return normalizeDatabaseTimestamp(evidence.earliest);
  }

  private async loadTransactionTimestamp(
    executor: QueryExecutor,
  ): Promise<string> {
    const [evidence] = await executor.query<Array<{ timestamp: Date }>>(
      `SELECT date_trunc('milliseconds', transaction_timestamp()) AS timestamp`,
    );
    if (evidence === undefined) {
      throw new SyntheticFixtureError(
        'DEACTIVATION_TEMPORAL_EVIDENCE_INVALID',
        'Deactivation transaction timestamp is unavailable.',
      );
    }
    return normalizeDatabaseTimestamp(evidence.timestamp);
  }

  private async assertNoFormulaConflicts(
    executor: QueryExecutor,
    formula: SyntheticFixtureFormula,
  ): Promise<void> {
    const [row] = await executor.query<Array<{ conflicts: number }>>(
      `SELECT (
        (SELECT count(*) FROM public.organizations
         WHERE slug = ANY($1::text[]) OR name = ANY($2::text[]))
        +
        (SELECT count(*) FROM public.users
         WHERE email = ANY($3::text[]) OR name = ANY($4::text[]))
      )::int AS conflicts`,
      [
        Object.values(formula.organizations).map(({ slug }) => slug),
        Object.values(formula.organizations).map(({ name }) => name),
        Object.values(formula.users).map(({ email }) => email),
        Object.values(formula.users).map(({ name }) => name),
      ],
    );
    if ((row?.conflicts ?? 0) > 0) {
      throw new SyntheticFixtureError(
        'FIXTURE_IDENTITY_CONFLICT',
        'Synthetic identity already exists without the approved intact manifest.',
      );
    }
  }

  private async archiveActiveLeads(
    manager: EntityManager,
    manifest: SyntheticFixtureManifest,
  ): Promise<void> {
    const leads = await manager.query<
      Array<{ id: string; organizationId: string; revision: string }>
    >(
      `SELECT id, organization_id AS "organizationId", revision::text AS revision
       FROM public.leads WHERE organization_id = ANY($1::uuid[])
         AND status = 'active' ORDER BY id FOR UPDATE`,
      [manifest.organizations.map(({ id }) => id)],
    );
    if (leads.length === 0) return;
    const version = this.leadIdempotencyCurrentKeyVersion;
    if (version === null || !this.leadIdempotencyKeys.has(version)) {
      throw new SyntheticFixtureError(
        'LEAD_IDEMPOTENCY_KEYS_REQUIRED',
        'Configured Lead idempotency keys are required to archive active Leads.',
      );
    }
    const ownerByOrganization = new Map(
      manifest.memberships
        .filter(({ role }) => role === 'ownerA' || role === 'ownerB')
        .map((membership) => [membership.organizationId, membership]),
    );
    const userByRole = new Map(manifest.users.map((user) => [user.role, user]));
    for (const lead of leads) {
      const actor = ownerByOrganization.get(lead.organizationId);
      const actorUser =
        actor === undefined ? undefined : userByRole.get(actor.role);
      if (actor === undefined || actorUser === undefined) {
        throw new SyntheticFixtureError(
          'LEAD_OWNER_MISSING',
          'Synthetic Lead has no exact fixture owner.',
        );
      }
      const input: LeadCommandFingerprintInput = {
        organizationId: lead.organizationId,
        actorMembershipId: actor.id,
        leadId: lead.id,
        command: LeadCommand.ARCHIVE,
        expectedRevision: lead.revision,
        stage: null,
        lostReason: null,
        archiveReason: LeadArchiveReason.TEST,
        reasonNote: null,
      };
      const fingerprints = Object.fromEntries(
        [...this.leadIdempotencyKeys.entries()].map(
          ([candidateVersion, key]) => [
            String(candidateVersion),
            leadCommandFingerprint(input, key),
          ],
        ),
      );
      await manager.query(
        `SELECT revision::text AS revision
         FROM app_private.execute_lead_command(
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,
           'archive'::app_private.lead_command_enum,$5::bigint,$6::uuid,$7::smallint,
           $8::text,$9::jsonb,NULL::lead_stage_enum,NULL::lead_lost_reason_enum,
           'test'::lead_archive_reason_enum,NULL::text)`,
        [
          actorUser.id,
          actor.id,
          lead.organizationId,
          lead.id,
          lead.revision,
          this.uuid(),
          version,
          leadCommandFingerprint(
            input,
            this.leadIdempotencyKeys.get(version) as Buffer,
          ),
          JSON.stringify(fingerprints),
        ],
      );
    }
  }

  private async revokeSessions(
    manager: EntityManager,
    manifest: SyntheticFixtureManifest,
  ): Promise<void> {
    const userIds = manifest.users.map(({ id }) => id);
    await manager.query(
      `UPDATE public.auth_refresh_tokens token SET
         status = 'revoked', revoked_at = transaction_timestamp(),
         updated_at = transaction_timestamp()
       FROM public.auth_sessions session
       WHERE token.session_id = session.id
         AND session.user_id = ANY($1::uuid[]) AND token.status = 'active'`,
      [userIds],
    );
    await manager.query(
      `UPDATE public.auth_sessions SET status = 'revoked',
         revoked_at = transaction_timestamp(),
         revoke_reason = 'synthetic_fixture_deactivated',
         updated_at = transaction_timestamp()
       WHERE user_id = ANY($1::uuid[]) AND status = 'active'`,
      [userIds],
    );
  }

  private async deactivateOrganizations(
    manager: EntityManager,
    manifest: SyntheticFixtureManifest,
  ): Promise<void> {
    await manager.query(
      `UPDATE public.organizations SET status = 'inactive',
         updated_at = transaction_timestamp()
       WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [manifest.organizations.map(({ id }) => id)],
    );
  }

  private async deactivateMemberships(
    manager: EntityManager,
    manifest: SyntheticFixtureManifest,
  ): Promise<void> {
    await manager.query(
      `UPDATE public.memberships SET status = 'inactive',
         updated_at = transaction_timestamp()
       WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [manifest.memberships.map(({ id }) => id)],
    );
  }

  private async deactivateUsers(
    manager: EntityManager,
    manifest: SyntheticFixtureManifest,
  ): Promise<void> {
    await manager.query(
      `UPDATE public.users SET status = 'inactive',
         updated_at = transaction_timestamp()
       WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [manifest.users.map(({ id }) => id)],
    );
  }

  private async lockFixtureRows(
    manager: EntityManager,
    manifest: SyntheticFixtureManifest,
  ): Promise<void> {
    await manager.query(
      `SELECT id FROM public.organizations WHERE id = ANY($1::uuid[])
       ORDER BY id FOR UPDATE`,
      [manifest.organizations.map(({ id }) => id)],
    );
    for (const userId of manifest.users.map(({ id }) => id).sort()) {
      await manager.query(
        `SELECT app_private.lock_auth_refresh_user($1::uuid)`,
        [userId],
      );
    }
    await manager.query(
      `SELECT id FROM public.memberships WHERE id = ANY($1::uuid[])
       ORDER BY id FOR UPDATE`,
      [manifest.memberships.map(({ id }) => id)],
    );
  }

  private lockRun(manager: EntityManager, runId: string): Promise<unknown> {
    return manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [runId],
    );
  }

  private async isRecoverableDeactivationState(
    manifest: SyntheticFixtureManifest,
    executor: QueryExecutor,
  ): Promise<boolean> {
    const formula = buildSyntheticFixtureFormula(manifest.runId);
    const snapshot = await this.loadSnapshot(executor, manifest, formula);
    if (this.findIssues(manifest, formula, snapshot).length !== 0) return false;
    return (
      manifest.status === 'deactivated' &&
      snapshot.organizations.length === 2 &&
      snapshot.organizations.every(
        ({ status }) => status === OrganizationStatus.INACTIVE,
      ) &&
      snapshot.users.length === 3 &&
      snapshot.users.every(({ status }) => status === UserStatus.INACTIVE) &&
      snapshot.memberships.length === 3 &&
      snapshot.memberships.every(
        ({ status }) => status === MembershipStatus.INACTIVE,
      )
    );
  }

  private mutationResult(
    status: SyntheticFixtureStatusResult,
    idempotent: boolean,
  ): SyntheticFixtureMutationResult {
    if (
      status.runId === null ||
      (status.state !== 'ACTIVE' && status.state !== 'DEACTIVATED')
    ) {
      throw new SyntheticFixtureError(
        'FIXTURE_NOT_INTACT',
        'Fixture is not in a complete mutation state.',
      );
    }
    return {
      runId: status.runId,
      state: status.state,
      idempotent,
      counts: status.counts,
    };
  }

  private emptyCounts(): SyntheticFixtureStatusResult['counts'] {
    return {
      organizations: 0,
      users: 0,
      memberships: 0,
      leads: 0,
      activeSessions: 0,
    };
  }

  private safeOperationError(error: unknown, code: string): Error {
    if (error instanceof SyntheticFixtureError) return error;
    return new SyntheticFixtureError(
      code,
      'Synthetic fixture operation failed and was rolled back.',
    );
  }
}

function normalizeDatabaseTimestamp(value: Date): string {
  return new Date(value.getTime()).toISOString();
}
