import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import { CreateAuthSessions1784486400000 } from '../../src/database/migrations/1784486400000-CreateAuthSessions';
import { CreateMultiTenantCore1784400000000 } from '../../src/database/migrations/1784400000000-CreateMultiTenantCore';
import { CreateOrganizationInvitations1785004800000 } from '../../src/database/migrations/1785004800000-CreateOrganizationInvitations';
import { DeliverInvitationAcceptance1785087600000 } from '../../src/database/migrations/1785087600000-DeliverInvitationAcceptance';
import { ActivateNewInvitationUser1785174000000 } from '../../src/database/migrations/1785174000000-ActivateNewInvitationUser';
import { ManageMembershipOwnership1785260400000 } from '../../src/database/migrations/1785260400000-ManageMembershipOwnership';
import { CreateLeadFoundation1785346800000 } from '../../src/database/migrations/1785346800000-CreateLeadFoundation';
import { ManageLeadCommercialPipeline1785433200000 } from '../../src/database/migrations/1785433200000-ManageLeadCommercialPipeline';
import { ManageLeadActivitiesFollowUp1785519600000 } from '../../src/database/migrations/1785519600000-ManageLeadActivitiesFollowUp';
import { AddLeadOperationalReadIndexes1785606000000 } from '../../src/database/migrations/1785606000000-AddLeadOperationalReadIndexes';
import { createBasePostgresOptions } from '../../src/database/typeorm-base.options';
import { assertSyntheticFixtureOperationalRole } from '../../src/database/synthetic-fixtures/cli';
import { FileSyntheticFixtureManifestStore } from '../../src/database/synthetic-fixtures/synthetic-fixture-manifest';
import {
  buildSyntheticFixtureFormula,
  SyntheticFixtureManifest,
} from '../../src/database/synthetic-fixtures/synthetic-fixture.model';
import { SyntheticFixtureService } from '../../src/database/synthetic-fixtures/synthetic-fixture.service';
import { AuthAuditLog } from '../../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthRefreshToken } from '../../src/modules/auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthAuditEventType } from '../../src/modules/auth-sessions/enums/auth-audit-event-type.enum';
import { AuthService } from '../../src/modules/auth/auth.service';
import { AuthAuditService } from '../../src/modules/auth/services/auth-audit.service';
import { LoginRateLimiter } from '../../src/modules/auth/services/login-rate-limiter.port';
import { TokenService } from '../../src/modules/auth/services/token.service';
import { verifyPassword } from '../../src/modules/credentials/password-policy';
import { PasswordLoginVerifier } from '../../src/modules/credentials/ports/password-login-verifier.port';
import { InvitationDeliveryOutbox } from '../../src/modules/invitations/entities/invitation-delivery-outbox.entity';
import { OrganizationCommandIdempotency } from '../../src/modules/invitations/entities/organization-command-idempotency.entity';
import { OrganizationInvitation } from '../../src/modules/invitations/entities/organization-invitation.entity';
import {
  LeadNextActionType,
  LeadSource,
} from '../../src/modules/leads/enums/lead.enums';
import { LeadReadiness } from '../../src/modules/leads/ports/lead-readiness.port';
import { LeadsService } from '../../src/modules/leads/services/leads.service';
import { Membership } from '../../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../../src/modules/memberships/enums/membership-status.enum';
import { OrganizationAuditLog } from '../../src/modules/organization-audit/entities/organization-audit-log.entity';
import { Organization } from '../../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../../src/modules/organizations/enums/organization-status.enum';
import { User } from '../../src/modules/users/entities/user.entity';
import { UserStatus } from '../../src/modules/users/enums/user-status.enum';
import { prepareIntegrationRuntimeRole } from '../support/integration-data-source';

jest.setTimeout(120_000);

const TEST_KEY = Buffer.alloc(32, 0x19);
const TEST_KEYRING = new Map([[1, TEST_KEY]]);
const MIGRATION_ROLE = 'genesis_migration_fixture_test';
const MIGRATION_PASSWORD = 'migration-fixture-test-only';

class TestPasswordReader {
  readonly calls: string[] = [];
  readonly values: string[] = [];

  read(role: 'ownerA' | 'memberA' | 'ownerB'): Promise<string> {
    this.calls.push(role);
    const value = `test-only-${role}-${randomUUID()}`;
    this.values.push(value);
    return Promise.resolve(value);
  }
}

describe('Synthetic fixture tooling database integration', () => {
  let bootstrap: DataSource;
  let owner: DataSource;
  let runtime: DataSource;
  let temporaryDirectory: string;

  beforeAll(async () => {
    process.env.DATABASE_RUNTIME_ROLE = 'genesis_runtime_test';
    process.env.DATABASE_MIGRATION_USER = MIGRATION_ROLE;
    process.env.DATABASE_MIGRATION_PASSWORD = MIGRATION_PASSWORD;
    bootstrap = createBootstrapDataSource();
    await bootstrap.initialize();
    await resetDisposableDatabase(bootstrap);
    await prepareIntegrationRuntimeRole(bootstrap);
    await prepareMigrationOwner(bootstrap);
    owner = createOwnerDataSource();
    await owner.initialize();
    await owner.runMigrations();
    runtime = createRuntimeDataSource();
    await runtime.initialize();
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'genesis-mvp09-integration-'),
    );
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (owner?.isInitialized) {
      await resetDisposableDatabase(owner);
      await owner.destroy();
    }
    if (bootstrap?.isInitialized) {
      await restoreBootstrapOwnership(bootstrap);
      await bootstrap.destroy();
    }
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('runs the full lifecycle as the approved non-superuser migration owner', async () => {
    const [role] = await owner.query<
      Array<{
        name: string;
        canLogin: boolean;
        superuser: boolean;
        createDatabase: boolean;
        createRole: boolean;
        inherit: boolean;
        bypassRls: boolean;
      }>
    >(
      `SELECT current_user AS name, rolcanlogin AS "canLogin",
              rolsuper AS superuser, rolcreatedb AS "createDatabase",
              rolcreaterole AS "createRole", rolinherit AS inherit,
              rolbypassrls AS "bypassRls"
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({
      name: MIGRATION_ROLE,
      canLogin: true,
      superuser: false,
      createDatabase: false,
      createRole: false,
      inherit: false,
      bypassRls: false,
    });
    await expect(
      assertSyntheticFixtureOperationalRole(owner),
    ).resolves.toBeUndefined();
    await expect(
      assertSyntheticFixtureOperationalRole(bootstrap),
    ).rejects.toMatchObject({
      code: 'UNSAFE_DATABASE_ROLE',
    });
    await expect(
      assertSyntheticFixtureOperationalRole(runtime),
    ).rejects.toMatchObject({
      code: 'UNSAFE_DATABASE_ROLE',
    });

    const fixture = createService(
      'MVP09-20260815-01a2b3c4',
      new TestPasswordReader(),
    );
    await expect(
      fixture.service.create('MVP09-20260815-01a2b3c4'),
    ).resolves.toMatchObject({
      state: 'ACTIVE',
    });
    await expect(fixture.service.status()).resolves.toMatchObject({
      state: 'ACTIVE',
    });
    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
    });
  });

  it('creates the exact fixture, verifies credentials, stays idempotent and keeps status read-only', async () => {
    const runId = 'MVP09-20260815-a1b2c3d4';
    const reader = new TestPasswordReader();
    const { service, path } = createService(runId, reader);
    const preservedUser = await owner.getRepository(User).save({
      email: 'preserved-non-synthetic@example.invalid',
      name: 'Preserved non synthetic user',
      status: UserStatus.ACTIVE,
      passwordHash: null,
      passwordChangedAt: null,
      emailVerifiedAt: null,
    });

    const created = await service.create(runId);
    expect(created).toMatchObject({
      runId,
      state: 'ACTIVE',
      idempotent: false,
      counts: { organizations: 2, users: 3, memberships: 3 },
    });
    expect(reader.calls).toEqual(['ownerA', 'memberA', 'ownerB']);

    const manifest = JSON.parse(
      await readFile(path, 'utf8'),
    ) as SyntheticFixtureManifest;
    const users = await owner.query<
      Array<{ id: string; passwordHash: string; status: string }>
    >(
      `SELECT id, password_hash AS "passwordHash", status::text AS status
       FROM public.users WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [manifest.users.map(({ id }) => id)],
    );
    expect(users).toHaveLength(3);
    for (const user of users)
      expect(user.passwordHash).toMatch(/^\$argon2id\$/u);
    for (const [index, role] of ['ownerA', 'memberA', 'ownerB'].entries()) {
      const manifestUser = manifest.users.find((user) => user.role === role);
      const databaseUser = users.find((user) => user.id === manifestUser?.id);
      await expect(
        verifyPassword(databaseUser?.passwordHash ?? '', reader.values[index]),
      ).resolves.toBe(true);
    }
    const manifestText = await readFile(path, 'utf8');
    for (const password of reader.values)
      expect(manifestText).not.toContain(password);
    expect(manifestText).not.toMatch(/passwordHash|argon2|tokenHash/iu);
    expect(JSON.stringify(created)).not.toMatch(/password|argon2|token|hash/iu);

    const before = await readFixtureState(owner, manifest);
    const manifestBefore = await readFile(path, 'utf8');
    await expect(service.status()).resolves.toMatchObject({ state: 'ACTIVE' });
    expect(await readFixtureState(owner, manifest)).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(manifestBefore);

    await expect(service.create(runId)).resolves.toMatchObject({
      state: 'ACTIVE',
      idempotent: true,
    });
    expect(reader.calls).toHaveLength(3);
    await expect(
      owner.getRepository(User).findOneByOrFail({ id: preservedUser.id }),
    ).resolves.toMatchObject({
      status: UserStatus.ACTIVE,
    });
  });

  it('rejects active manifest timestamp or status tampering before database mutation', async () => {
    const runId = 'MVP09-20260815-a2b3c4d5';
    const fixture = createService(runId, new TestPasswordReader());
    await fixture.service.create(runId);
    const intact = await readManifest(fixture.path);
    await expect(fixture.service.status()).resolves.toMatchObject({
      state: 'ACTIVE',
      issues: [],
    });

    const tamperedManifests: Array<{
      manifest: SyntheticFixtureManifest;
      issue: string;
    }> = [
      {
        manifest: {
          ...intact,
          createdAt: shiftIso(intact.createdAt, 1_000),
        },
        issue: 'MANIFEST_CREATED_AT_MISMATCH',
      },
      {
        manifest: {
          ...intact,
          status: 'deactivated',
          deactivatedAt: shiftIso(intact.createdAt, 1_000),
        },
        issue: 'MANIFEST_DATABASE_STATUS_MISMATCH',
      },
    ];

    for (const tampering of tamperedManifests) {
      await writeManifest(fixture.path, tampering.manifest);
      const databaseBefore = await readFixtureState(owner, intact);
      const manifestBefore = await readFile(fixture.path, 'utf8');
      const status = await fixture.service.status();
      expect(status.state).toBe('PARTIAL');
      expect(status.issues).toContain(tampering.issue);
      await expect(fixture.service.deactivate()).rejects.toMatchObject({
        code: 'FIXTURE_NOT_INTACT',
      });
      expect(await readFixtureState(owner, intact)).toEqual(databaseBefore);
      expect(await readFile(fixture.path, 'utf8')).toBe(manifestBefore);
      await writeManifest(fixture.path, intact);
    }

    await expect(fixture.service.status()).resolves.toMatchObject({
      state: 'ACTIVE',
      issues: [],
    });
  });

  it('rejects deactivated manifest timestamp or status tampering and preserves convergence', async () => {
    const runId = 'MVP09-20260815-a3b4c5d6';
    const fixture = createService(runId, new TestPasswordReader());
    await fixture.service.create(runId);
    await fixture.service.deactivate();
    const intact = await readManifest(fixture.path);
    if (intact.deactivatedAt === null) {
      throw new Error('deactivated manifest must contain deactivatedAt');
    }
    await expect(fixture.service.status()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      issues: [],
    });

    const tamperedManifests: Array<{
      manifest: SyntheticFixtureManifest;
      issue: string;
    }> = [
      {
        manifest: {
          ...intact,
          createdAt: shiftIso(intact.createdAt, 1_000),
        },
        issue: 'MANIFEST_CREATED_AT_MISMATCH',
      },
      {
        manifest: {
          ...intact,
          deactivatedAt: shiftIso(intact.deactivatedAt, 1_000),
        },
        issue: 'MANIFEST_DEACTIVATED_AT_MISMATCH',
      },
      {
        manifest: { ...intact, status: 'active', deactivatedAt: null },
        issue: 'MANIFEST_DATABASE_STATUS_MISMATCH',
      },
    ];

    for (const tampering of tamperedManifests) {
      await writeManifest(fixture.path, tampering.manifest);
      const databaseBefore = await readFixtureState(owner, intact);
      const manifestBefore = await readFile(fixture.path, 'utf8');
      const status = await fixture.service.status();
      expect(status.state).toBe('PARTIAL');
      expect(status.issues).toContain(tampering.issue);
      await expect(fixture.service.deactivate()).rejects.toMatchObject({
        code: 'FIXTURE_NOT_INTACT',
      });
      expect(await readFixtureState(owner, intact)).toEqual(databaseBefore);
      expect(await readFile(fixture.path, 'utf8')).toBe(manifestBefore);
      await writeManifest(fixture.path, intact);
    }

    await expect(fixture.service.status()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      issues: [],
    });
    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      idempotent: true,
    });
  });

  it('rejects a partial formula conflict without changing the conflicting record', async () => {
    const runId = 'MVP09-20260815-b1c2d3e4';
    const formula = buildSyntheticFixtureFormula(runId);
    const conflict = await owner.getRepository(User).save({
      ...formula.users.ownerA,
      status: UserStatus.ACTIVE,
      passwordHash: null,
      passwordChangedAt: null,
      emailVerifiedAt: null,
    });
    const reader = new TestPasswordReader();
    const { service } = createService(runId, reader);
    await expect(service.create(runId)).rejects.toMatchObject({
      code: 'FIXTURE_IDENTITY_CONFLICT',
    });
    expect(reader.calls).toHaveLength(0);
    await expect(
      owner.getRepository(User).findOneByOrFail({ id: conflict.id }),
    ).resolves.toMatchObject({
      email: formula.users.ownerA.email,
      status: UserStatus.ACTIVE,
    });
  });

  it('rolls back all database rows after an injected intermediate create failure', async () => {
    const runId = 'MVP09-20260815-c1d2e3f4';
    const reader = new TestPasswordReader();
    const { service, path } = createService(runId, reader, {
      afterStep: (step) =>
        step === 'users_created'
          ? Promise.reject(new Error('injected-test-failure'))
          : Promise.resolve(),
    });
    await expect(service.create(runId)).rejects.toMatchObject({
      code: 'CREATE_FAILED',
    });
    const formula = buildSyntheticFixtureFormula(runId);
    const [remaining] = await owner.query<Array<{ count: number }>>(
      `SELECT (
        (SELECT count(*) FROM public.organizations WHERE slug = ANY($1::text[])) +
        (SELECT count(*) FROM public.users WHERE email = ANY($2::text[]))
       )::int AS count`,
      [
        Object.values(formula.organizations).map(({ slug }) => slug),
        Object.values(formula.users).map(({ email }) => email),
      ],
    );
    expect(remaining?.count).toBe(0);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('archives synthetic Leads, cancels next actions, revokes sessions and deactivates idempotently', async () => {
    const runId = 'MVP09-20260815-d1e2f3a4';
    const reader = new TestPasswordReader();
    const fixture = createService(runId, reader);
    await fixture.service.create(runId);
    const manifest = JSON.parse(
      await readFile(fixture.path, 'utf8'),
    ) as SyntheticFixtureManifest;
    const ownerA = manifest.users.find(({ role }) => role === 'ownerA');
    const membershipA = manifest.memberships.find(
      ({ role }) => role === 'ownerA',
    );
    const tenantA = manifest.organizations.find(
      ({ role }) => role === 'tenantA',
    );
    if (
      ownerA === undefined ||
      membershipA === undefined ||
      tenantA === undefined
    ) {
      throw new Error('integration fixture missing expected roles');
    }
    const leadService = createLeadService();
    const leadResult = await leadService.createManual(
      {
        userId: ownerA.id,
        membershipId: membershipA.id,
        organizationId: tenantA.id,
        role: MembershipRole.OWNER,
      },
      {
        displayName: '[MVP09-SYNTHETIC] Central Lead',
        primaryPhone: '+12025550123',
        source: LeadSource.MANUAL,
        responsibleMembershipId: membershipA.id,
      },
      randomUUID(),
    );
    const lead = leadResult.lead;
    if (lead === null) throw new Error('owner must see the created Lead');
    await leadService.createNextAction(
      {
        userId: ownerA.id,
        membershipId: membershipA.id,
        organizationId: tenantA.id,
        role: MembershipRole.OWNER,
      },
      lead.id,
      lead.revision,
      randomUUID(),
      {
        type: LeadNextActionType.FOLLOW_UP,
        description: '[MVP09-SYNTHETIC] Follow up',
        dueAt: '2026-08-16T12:00:00.000Z',
      },
    );
    const sessionId = randomUUID();
    await owner.query(
      `INSERT INTO public.auth_sessions
        (id,user_id,status,expires_at,revoked_at,revoke_reason)
       VALUES ($1,$2,'active',transaction_timestamp() + interval '1 day',NULL,NULL)`,
      [sessionId, ownerA.id],
    );
    await owner.query(
      `INSERT INTO public.auth_refresh_tokens
        (id,session_id,token_hash,status,expires_at,consumed_at,revoked_at)
       VALUES ($1,$2,$3,'active',transaction_timestamp() + interval '1 day',NULL,NULL)`,
      [randomUUID(), sessionId, 'a'.repeat(64)],
    );

    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      idempotent: false,
      counts: { leads: 1, activeSessions: 0 },
    });
    const [state] = await owner.query<
      Array<{
        activeOrganizations: number;
        activeUsers: number;
        activeMemberships: number;
        archivedLeads: number;
        pendingNextActions: number;
        activeSessions: number;
        activeTokens: number;
      }>
    >(
      `SELECT
        (SELECT count(*)::int FROM public.organizations WHERE id = ANY($1::uuid[]) AND status='active') AS "activeOrganizations",
        (SELECT count(*)::int FROM public.users WHERE id = ANY($2::uuid[]) AND status='active') AS "activeUsers",
        (SELECT count(*)::int FROM public.memberships WHERE id = ANY($3::uuid[]) AND status='active') AS "activeMemberships",
        (SELECT count(*)::int FROM public.leads WHERE organization_id = ANY($1::uuid[]) AND status='archived') AS "archivedLeads",
        (SELECT count(*)::int FROM public.lead_next_actions WHERE organization_id = ANY($1::uuid[]) AND status='pending') AS "pendingNextActions",
        (SELECT count(*)::int FROM public.auth_sessions WHERE user_id = ANY($2::uuid[]) AND status='active') AS "activeSessions",
        (SELECT count(*)::int FROM public.auth_refresh_tokens token JOIN public.auth_sessions session ON session.id=token.session_id WHERE session.user_id = ANY($2::uuid[]) AND token.status='active') AS "activeTokens"`,
      [
        manifest.organizations.map(({ id }) => id),
        manifest.users.map(({ id }) => id),
        manifest.memberships.map(({ id }) => id),
      ],
    );
    expect(state).toEqual({
      activeOrganizations: 0,
      activeUsers: 0,
      activeMemberships: 0,
      archivedLeads: 1,
      pendingNextActions: 0,
      activeSessions: 0,
      activeTokens: 0,
    });
    await expect(fixture.service.status()).resolves.toMatchObject({
      state: 'DEACTIVATED',
    });
    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      idempotent: true,
    });

    const externalOrganization = await owner.getRepository(Organization).save({
      name: 'Disposable external link detector',
      slug: `external-${randomUUID()}`,
      status: OrganizationStatus.INACTIVE,
    });
    await owner.getRepository(Membership).save({
      userId: ownerA.id,
      organizationId: externalOrganization.id,
      role: MembershipRole.MEMBER,
      status: MembershipStatus.INACTIVE,
    });
    const drifted = await fixture.service.status();
    expect(drifted.state).toBe('PARTIAL');
    expect(drifted.issues).toContain('EXTERNAL_MEMBERSHIP');
    await expect(fixture.service.deactivate()).rejects.toMatchObject({
      code: 'FIXTURE_NOT_INTACT',
    });
  });

  it('revokes a real login that commits before deactivation and converges', async () => {
    const runId = 'MVP09-20260815-f1a2b3c4';
    const reader = new TestPasswordReader();
    const fixture = createService(runId, reader);
    await fixture.service.create(runId);
    const manifest = JSON.parse(
      await readFile(fixture.path, 'utf8'),
    ) as SyntheticFixtureManifest;
    const ownerA = manifest.users.find(({ role }) => role === 'ownerA');
    if (ownerA === undefined) throw new Error('ownerA missing');

    const auditReached = deferred<void>();
    const releaseAudit = deferred<void>();
    let loginBackendPid = 0;
    const audit = {
      record: async (
        event: { eventType: AuthAuditEventType },
        manager?: { query: (sql: string) => Promise<Array<{ pid: number }>> },
      ) => {
        if (
          event.eventType === AuthAuditEventType.LOGIN_SUCCEEDED &&
          manager !== undefined
        ) {
          loginBackendPid =
            (await manager.query('SELECT pg_backend_pid()::int AS pid'))[0]
              ?.pid ?? 0;
          auditReached.resolve();
          await releaseAudit.promise;
        }
      },
    } as unknown as AuthAuditService;
    const auth = createAuthService(audit);
    const loginPromise = auth.login(
      { email: ownerA.email, password: reader.values[0] },
      { ipAddress: '127.0.0.1', userAgent: 'fixture-login-first' },
    );
    await auditReached.promise;
    const deactivation = fixture.service.deactivate();
    await waitForBlockedApplication(
      bootstrap,
      'fixture-migration-owner',
      loginBackendPid,
    );
    releaseAudit.resolve();
    await loginPromise;
    await expect(deactivation).resolves.toMatchObject({ state: 'DEACTIVATED' });
    await expectNoActiveAuth(manifest);
    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      idempotent: true,
    });
  });

  it('rejects a real login when deactivation owns the User lock first', async () => {
    const runId = 'MVP09-20260815-f2a3b4c5';
    const reader = new TestPasswordReader();
    const locked = deferred<void>();
    const release = deferred<void>();
    const fixture = createService(runId, reader, {
      afterStep: async (step) => {
        if (step === 'sessions_revoked') {
          locked.resolve();
          await release.promise;
        }
      },
    });
    await fixture.service.create(runId);
    const manifest = JSON.parse(
      await readFile(fixture.path, 'utf8'),
    ) as SyntheticFixtureManifest;
    const ownerA = manifest.users.find(({ role }) => role === 'ownerA');
    if (ownerA === undefined) throw new Error('ownerA missing');
    const deactivation = fixture.service.deactivate();
    await locked.promise;
    const auth = createAuthService();
    const login = expect(
      auth.login(
        { email: ownerA.email, password: reader.values[0] },
        { ipAddress: '127.0.0.1', userAgent: 'fixture-deactivate-first' },
      ),
    ).rejects.toThrow('Invalid email or password.');
    await waitForBlockedApplication(bootstrap, 'fixture-runtime-auth');
    release.resolve();
    await expect(deactivation).resolves.toMatchObject({ state: 'DEACTIVATED' });
    await login;
    await expectNoActiveAuth(manifest);
    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      idempotent: true,
    });
  });

  it('recovers exact late auth residue but still rejects external drift', async () => {
    const runId = 'MVP09-20260815-f3a4b5c6';
    const fixture = createService(runId, new TestPasswordReader());
    await fixture.service.create(runId);
    await fixture.service.deactivate();
    const manifest = JSON.parse(
      await readFile(fixture.path, 'utf8'),
    ) as SyntheticFixtureManifest;
    const sessionId = randomUUID();
    await owner.query(
      `INSERT INTO public.auth_sessions (id,user_id,status,expires_at)
       VALUES ($1,$2,'active',transaction_timestamp() + interval '1 day')`,
      [sessionId, manifest.users[0].id],
    );
    await owner.query(
      `INSERT INTO public.auth_refresh_tokens
         (id,session_id,token_hash,status,expires_at)
       VALUES ($1,$2,$3,'active',transaction_timestamp() + interval '1 day')`,
      [randomUUID(), sessionId, 'c'.repeat(64)],
    );
    await expect(fixture.service.status()).resolves.toMatchObject({
      state: 'PARTIAL',
    });
    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
      idempotent: false,
    });
    await expectNoActiveAuth(manifest);
  });

  it('rolls back database and manifest after an injected deactivation failure', async () => {
    const runId = 'MVP09-20260815-e1f2a3b4';
    const reader = new TestPasswordReader();
    const fixture = createService(runId, reader);
    await fixture.service.create(runId);
    const failing = createService(runId, new TestPasswordReader(), {
      path: fixture.path,
      afterStep: (step) =>
        step === 'manifest_deactivated'
          ? Promise.reject(new Error('injected-test-failure'))
          : Promise.resolve(),
    });
    await expect(failing.service.deactivate()).rejects.toMatchObject({
      code: 'DEACTIVATE_FAILED',
    });
    const rolledBackStatus = await fixture.service.status();
    expect(rolledBackStatus).toMatchObject({ state: 'ACTIVE', issues: [] });
    expect(JSON.parse(await readFile(fixture.path, 'utf8'))).toMatchObject({
      status: 'active',
      deactivatedAt: null,
    });
    await expect(fixture.service.deactivate()).resolves.toMatchObject({
      state: 'DEACTIVATED',
    });
  });

  function createService(
    runId: string,
    reader: TestPasswordReader,
    options: {
      path?: string;
      afterStep?: (step: string) => Promise<void>;
    } = {},
  ): { service: SyntheticFixtureService; path: string } {
    const path = options.path ?? join(temporaryDirectory, `${runId}.json`);
    const store = new FileSyntheticFixtureManifestStore(path, process.cwd());
    return {
      path,
      service: new SyntheticFixtureService(owner, store, reader, {
        leadIdempotencyCurrentKeyVersion: 1,
        leadIdempotencyKeys: TEST_KEYRING,
        afterStep: options.afterStep,
      }),
    };
  }

  function createAuthService(
    auditService: AuthAuditService = {
      record: () => Promise.resolve(),
    } as unknown as AuthAuditService,
  ): AuthService {
    const passwordVerifier: PasswordLoginVerifier = {
      verifyForLogin: (hash: string | null, password: string) =>
        verifyPassword(hash ?? '', password),
    };
    const tokenService = new TokenService(
      new JwtService(),
      new ConfigService({
        auth: {
          accessTokenSecret: 'fixture-access-test-only-'.repeat(4),
          accessTokenExpiresInSeconds: 900,
          refreshTokenPepper: 'fixture-refresh-test-only-'.repeat(4),
          refreshTokenExpiresInDays: 30,
        },
      }),
    );
    const rateLimiter = {
      assertAllowed: () => undefined,
      recordFailure: () => undefined,
      resetCredential: () => undefined,
    } as LoginRateLimiter;
    return new AuthService(
      runtime.getRepository(User),
      runtime.getRepository(Membership),
      runtime,
      passwordVerifier,
      tokenService,
      auditService,
      rateLimiter,
    );
  }

  async function expectNoActiveAuth(
    manifest: SyntheticFixtureManifest,
  ): Promise<void> {
    const [counts] = await owner.query<
      Array<{ sessions: number; tokens: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM public.auth_sessions
          WHERE user_id = ANY($1::uuid[]) AND status='active') AS sessions,
         (SELECT count(*)::int FROM public.auth_refresh_tokens token
          JOIN public.auth_sessions session ON session.id=token.session_id
          WHERE session.user_id = ANY($1::uuid[]) AND token.status='active') AS tokens`,
      [manifest.users.map(({ id }) => id)],
    );
    expect(counts).toEqual({ sessions: 0, tokens: 0 });
  }

  function createLeadService(): LeadsService {
    const config: LeadConfig = {
      formReadiness: false,
      formOrganizationId: null,
      formCurrentKeyVersion: null,
      formKeys: new Map(),
      idempotencyCurrentKeyVersion: 1,
      idempotencyKeys: TEST_KEYRING,
      publicReplicaCount: 1,
      rateLimitWindowSeconds: 900,
      formIpMaxAttempts: 30,
      formKeyMaxAttempts: 300,
      rateLimitMaxBuckets: 10_000,
      readRateLimitWindowSeconds: 60,
      readMembershipMaxAttempts: 120,
      readIpMaxAttempts: 300,
      metricsMembershipMaxAttempts: 30,
      readRateLimitMaxBuckets: 10_000,
      readStatementTimeoutMs: 3_000,
    };
    const readiness: LeadReadiness = {
      assertManualReady: () => Promise.resolve(),
      assertFormReady: () => Promise.resolve(),
      assertOperationalReadReady: () => Promise.resolve(),
    };
    return new LeadsService(
      owner,
      new ConfigService({ lead: config }),
      readiness,
    );
  }
});

function createOwnerDataSource(): DataSource {
  return new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test',
      user: process.env.DATABASE_MIGRATION_USER ?? MIGRATION_ROLE,
      password: process.env.DATABASE_MIGRATION_PASSWORD ?? MIGRATION_PASSWORD,
    }),
    applicationName: 'fixture-migration-owner',
    entities: [
      User,
      Organization,
      Membership,
      AuthSession,
      AuthRefreshToken,
      AuthAuditLog,
      OrganizationInvitation,
      InvitationDeliveryOutbox,
      OrganizationCommandIdempotency,
      OrganizationAuditLog,
    ],
    migrations: [
      CreateMultiTenantCore1784400000000,
      CreateAuthSessions1784486400000,
      CreateOrganizationInvitations1785004800000,
      DeliverInvitationAcceptance1785087600000,
      ActivateNewInvitationUser1785174000000,
      ManageMembershipOwnership1785260400000,
      CreateLeadFoundation1785346800000,
      ManageLeadCommercialPipeline1785433200000,
      ManageLeadActivitiesFollowUp1785519600000,
      AddLeadOperationalReadIndexes1785606000000,
    ],
    migrationsTableName: 'migrations',
    logging: false,
  });
}

function createBootstrapDataSource(): DataSource {
  return new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test',
      user: process.env.TEST_DATABASE_USER ?? 'genesis_test',
      password: process.env.TEST_DATABASE_PASSWORD ?? 'test-only',
    }),
    applicationName: 'fixture-bootstrap',
  });
}

function createRuntimeDataSource(): DataSource {
  return new DataSource({
    ...createBasePostgresOptions({
      host: process.env.TEST_DATABASE_HOST ?? 'localhost',
      port: Number(process.env.TEST_DATABASE_PORT ?? 5433),
      name: process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test',
      user: process.env.DATABASE_RUNTIME_ROLE ?? 'genesis_runtime_test',
      password: 'runtime-test-only',
    }),
    applicationName: 'fixture-runtime-auth',
    entities: [
      User,
      Organization,
      Membership,
      AuthSession,
      AuthRefreshToken,
      AuthAuditLog,
      OrganizationInvitation,
      InvitationDeliveryOutbox,
      OrganizationCommandIdempotency,
      OrganizationAuditLog,
    ],
  });
}

async function prepareMigrationOwner(connection: DataSource): Promise<void> {
  const database = process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
  if (!database.endsWith('_test')) throw new Error('Unsafe test database.');
  const [{ exists }] = await connection.query<Array<{ exists: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists`,
    [MIGRATION_ROLE],
  );
  await connection.query(
    `${exists ? 'ALTER' : 'CREATE'} ROLE "${MIGRATION_ROLE}"
     LOGIN PASSWORD '${MIGRATION_PASSWORD}' NOSUPERUSER NOCREATEDB
     NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await connection.query(
    `ALTER DATABASE "${database}" OWNER TO "${MIGRATION_ROLE}"`,
  );
  await connection.query(`ALTER SCHEMA public OWNER TO "${MIGRATION_ROLE}"`);
  await connection.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await connection.query(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${database}" TO "${MIGRATION_ROLE}"`,
  );
  await connection.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO "${MIGRATION_ROLE}"`,
  );
}

async function restoreBootstrapOwnership(
  connection: DataSource,
): Promise<void> {
  const database = process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
  const bootstrapRole = process.env.TEST_DATABASE_USER ?? 'genesis_test';
  await connection.query(`ALTER SCHEMA public OWNER TO "${bootstrapRole}"`);
  await connection.query(
    `ALTER DATABASE "${database}" OWNER TO "${bootstrapRole}"`,
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
} {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = (value) => done(value as T);
  });
  return { promise, resolve };
}

async function waitForBlockedApplication(
  connection: DataSource,
  applicationName: string,
  blockerPid?: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const [row] = await connection.query<Array<{ blocked: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity activity
          WHERE activity.application_name=$1
            AND activity.wait_event_type='Lock'
            AND ($2::int IS NULL OR $2::int = ANY(pg_blocking_pids(activity.pid)))
       ) AS blocked`,
      [applicationName, blockerPid ?? null],
    );
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected blocked database activity for ${applicationName}.`);
}

async function resetDisposableDatabase(connection: DataSource): Promise<void> {
  const [identity] = await connection.query<Array<{ name: string }>>(
    `SELECT current_database() AS name`,
  );
  if (identity?.name === undefined || !identity.name.endsWith('_test')) {
    throw new Error('Refusing to reset a non-test database.');
  }
  await connection.query(`DROP SCHEMA IF EXISTS app_private CASCADE`);
  await connection.query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await connection.query(`CREATE SCHEMA public`);
}

async function readFixtureState(
  connection: DataSource,
  manifest: SyntheticFixtureManifest,
): Promise<unknown> {
  const [state] = await connection.query<Array<{ snapshot: unknown }>>(
    `SELECT jsonb_build_object(
      'organizations', (SELECT jsonb_agg(jsonb_build_array(id,status,updated_at) ORDER BY id) FROM public.organizations WHERE id = ANY($1::uuid[])),
      'users', (SELECT jsonb_agg(jsonb_build_array(id,status,updated_at) ORDER BY id) FROM public.users WHERE id = ANY($2::uuid[])),
      'memberships', (SELECT jsonb_agg(jsonb_build_array(id,status,updated_at) ORDER BY id) FROM public.memberships WHERE id = ANY($3::uuid[])),
      'sessions', (SELECT jsonb_agg(jsonb_build_array(id,status,updated_at) ORDER BY id) FROM public.auth_sessions WHERE user_id = ANY($2::uuid[])),
      'leads', (SELECT jsonb_agg(jsonb_build_array(id,status,revision,updated_at) ORDER BY id) FROM public.leads WHERE organization_id = ANY($1::uuid[]))
    ) AS snapshot`,
    [
      manifest.organizations.map(({ id }) => id),
      manifest.users.map(({ id }) => id),
      manifest.memberships.map(({ id }) => id),
    ],
  );
  return state?.snapshot;
}

async function readManifest(path: string): Promise<SyntheticFixtureManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as SyntheticFixtureManifest;
}

async function writeManifest(
  path: string,
  manifest: SyntheticFixtureManifest,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function shiftIso(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}
