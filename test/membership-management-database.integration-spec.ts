import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, QueryRunner } from 'typeorm';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { OrganizationInvitation } from '../src/modules/invitations/entities/organization-invitation.entity';
import {
  InvitationRevocationReason,
  InvitationRole,
  InvitationStatus,
} from '../src/modules/invitations/enums/invitation.enums';
import { MembershipCommand } from '../src/modules/memberships/enums/membership-command.enum';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { OperationalMembershipReadiness } from '../src/modules/memberships/ports/membership-readiness.port';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

interface Fixture {
  organization: Organization;
  users: User[];
  memberships: Membership[];
}

interface CommandResult {
  outcome: 'changed' | 'no_change' | 'blocked_last_owner';
  targetMembershipId: string;
  role: MembershipRole;
  status: MembershipStatus;
}

interface SettledCommand {
  side: 'A' | 'B';
  result: CommandResult | null;
  error: Error | null;
}

describe('Membership ownership database integration', () => {
  let owner: DataSource;
  let runtime: DataSource;

  beforeAll(async () => {
    owner = createIntegrationDataSource();
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    configureIntegrationRuntimeEnvironment();
    runtime = createIntegrationRuntimeDataSource();
    await runtime.initialize();
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  it('fails the pre-audit closed with only a code and count, then migrates after remediation', async () => {
    await owner.undoLastMigration();
    const legacySearchPaths = await owner.query<
      Array<{ name: string; config: string[] }>
    >(
      `SELECT procedure.proname AS name, procedure.proconfig AS config
       FROM pg_proc AS procedure
       JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.proname IN (
           'revoke_invitations_for_inactive_membership',
           'revoke_invitations_for_inactive_user'
         )
       ORDER BY procedure.proname`,
    );
    expect(legacySearchPaths).toEqual([
      {
        name: 'revoke_invitations_for_inactive_membership',
        config: ['search_path=pg_catalog, public, pg_temp'],
      },
      {
        name: 'revoke_invitations_for_inactive_user',
        config: ['search_path=pg_catalog, public, pg_temp'],
      },
    ]);
    const orphan = await owner.getRepository(Organization).save({
      name: 'Preaudit orphan',
      slug: `preaudit-${randomUUID()}`,
      status: OrganizationStatus.ACTIVE,
    });
    await expect(owner.runMigrations()).rejects.toThrow(
      'M5401 orphaned active organizations; count=1',
    );
    await owner.getRepository(Organization).update(orphan.id, {
      status: OrganizationStatus.INACTIVE,
    });
    await expect(owner.runMigrations()).resolves.toHaveLength(1);
    await owner.getRepository(Organization).delete(orphan.id);
  });

  it('protects the last effective owner from direct membership and user SQL', async () => {
    const fixture = await createFixture('direct-last-owner', 1);
    await expect(
      owner.getRepository(Membership).update(fixture.memberships[0].id, {
        status: MembershipStatus.INACTIVE,
      }),
    ).rejects.toMatchObject({
      driverError: {
        code: '23514',
        constraint: 'CHK_active_organization_effective_owner',
      },
    });
    await expect(
      owner.getRepository(User).update(fixture.users[0].id, {
        status: UserStatus.INACTIVE,
      }),
    ).rejects.toMatchObject({
      driverError: {
        code: '23514',
        constraint: 'CHK_active_organization_effective_owner',
      },
    });
  });

  it('rejects organization reactivation without an effective owner', async () => {
    const organization = await owner.getRepository(Organization).save({
      name: 'Inactive organization',
      slug: `inactive-${randomUUID()}`,
      status: OrganizationStatus.INACTIVE,
    });
    await expect(
      owner.getRepository(Organization).update(organization.id, {
        status: OrganizationStatus.ACTIVE,
      }),
    ).rejects.toMatchObject({
      driverError: {
        code: '23514',
        constraint: 'CHK_active_organization_effective_owner',
      },
    });
  });

  it('covers invariant trigger operations and rejects orphan inserts, owner deletes, and identity rewrites', async () => {
    const triggerRows = await owner.query<
      Array<{ name: string; type: number; functionDefinition: string }>
    >(
      `SELECT trigger.tgname AS name, trigger.tgtype::int AS type,
              pg_get_functiondef(trigger.tgfoid) AS "functionDefinition"
       FROM pg_trigger AS trigger
       WHERE NOT trigger.tgisinternal
         AND trigger.tgname IN (
           'trg_memberships_identity_immutable',
           'trg_memberships_effective_owner',
           'trg_organizations_effective_owner',
           'trg_users_effective_owner'
         ) ORDER BY trigger.tgname`,
    );
    expect(triggerRows.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: 'trg_memberships_effective_owner', type: 29 },
      { name: 'trg_memberships_identity_immutable', type: 19 },
      { name: 'trg_organizations_effective_owner', type: 21 },
      { name: 'trg_users_effective_owner', type: 25 },
    ]);
    const membershipInvariant = triggerRows.find(
      ({ name }) => name === 'trg_memberships_effective_owner',
    )?.functionDefinition;
    expect(membershipInvariant).toContain("TG_OP = 'INSERT'");
    expect(membershipInvariant).toContain("TG_OP = 'DELETE'");
    expect(membershipInvariant).toContain(
      'ARRAY[OLD.organization_id, NEW.organization_id]',
    );

    await expect(
      owner.getRepository(Organization).save({
        name: 'Orphan insert',
        slug: `orphan-insert-${randomUUID()}`,
        status: OrganizationStatus.ACTIVE,
      }),
    ).rejects.toMatchObject({
      driverError: {
        code: '23514',
        constraint: 'CHK_active_organization_effective_owner',
      },
    });

    const fixture = await createFixture('trigger-delete-identity', 2);
    await expect(
      owner.getRepository(Membership).delete(fixture.memberships[0].id),
    ).rejects.toMatchObject({
      driverError: {
        code: '23514',
        constraint: 'CHK_active_organization_effective_owner',
      },
    });
    const otherOrganization = await owner.getRepository(Organization).save({
      name: 'Identity destination',
      slug: `identity-destination-${randomUUID()}`,
      status: OrganizationStatus.INACTIVE,
    });
    const otherUser = await owner.getRepository(User).save({
      email: `identity-${randomUUID()}@example.com`,
      name: 'Identity destination user',
      status: UserStatus.ACTIVE,
    });
    for (const update of [
      { userId: otherUser.id },
      { organizationId: otherOrganization.id },
    ]) {
      await expect(
        owner
          .getRepository(Membership)
          .update(fixture.memberships[1].id, update),
      ).rejects.toMatchObject({
        driverError: {
          code: '23514',
          constraint: 'CHK_membership_identity_immutable',
        },
      });
    }
    await expect(
      owner.getRepository(User).delete(otherUser.id),
    ).resolves.toMatchObject({ affected: 1 });
    await expect(
      owner.getRepository(User).delete(fixture.users[0].id),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('keeps runtime without direct membership DML and exposes only the exact entrypoint', async () => {
    const [row] = await owner.query<
      Array<{
        canUpdate: boolean;
        canExecute: boolean;
        publicCanExecute: boolean;
      }>
    >(
      `SELECT
         has_table_privilege($1, 'public.memberships', 'UPDATE')
           OR has_any_column_privilege($1, 'public.memberships', 'UPDATE') AS "canUpdate",
         has_function_privilege(
           $1,
           'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,public.membership_role_enum,uuid,inet,text)',
           'EXECUTE'
         ) AS "canExecute",
         has_function_privilege(
           'public',
           'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,public.membership_role_enum,uuid,inet,text)',
           'EXECUTE'
         ) AS "publicCanExecute"`,
      [process.env.DATABASE_RUNTIME_ROLE],
    );
    expect(row).toEqual({
      canUpdate: false,
      canExecute: true,
      publicCanExecute: false,
    });
  });

  it('fails readiness closed when a protected trigger is disabled', async () => {
    const readiness = new OperationalMembershipReadiness(1, runtime);
    await expect(readiness.assertReady()).resolves.toBeUndefined();
    await owner.query(
      `ALTER TABLE public.memberships DISABLE TRIGGER TRG_memberships_effective_owner`,
    );
    try {
      await expect(readiness.assertReady()).rejects.toMatchObject({
        status: 503,
        message: 'Membership management is unavailable.',
      });
    } finally {
      await owner.query(
        `ALTER TABLE public.memberships ENABLE TRIGGER TRG_memberships_effective_owner`,
      );
    }
    await expect(readiness.assertReady()).resolves.toBeUndefined();

    await owner.query(
      `ALTER TABLE public.memberships DISABLE TRIGGER TRG_memberships_revoke_pending_invitations`,
    );
    try {
      await expect(readiness.assertReady()).rejects.toMatchObject({
        status: 503,
        message: 'Membership management is unavailable.',
      });
    } finally {
      await owner.query(
        `ALTER TABLE public.memberships ENABLE TRIGGER TRG_memberships_revoke_pending_invitations`,
      );
    }
    await expect(readiness.assertReady()).resolves.toBeUndefined();
  });

  it('blocks self-target and hides a real cross-tenant target', async () => {
    const first = await createFixture('scope-first', 2);
    const second = await createFixture('scope-second', 1);
    await expect(
      execute(first, first.memberships[0].id, MembershipCommand.DEACTIVATE),
    ).rejects.toMatchObject({ driverError: { code: 'P2003' } });
    await expect(
      execute(first, second.memberships[0].id, MembershipCommand.DEACTIVATE),
    ).rejects.toMatchObject({ driverError: { code: 'P2002' } });
  });

  it('does not let an admin affect admin or owner targets', async () => {
    const fixture = await createFixture('admin-matrix', 3);
    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      role: MembershipRole.ADMIN,
    });
    await expect(
      execute(
        {
          ...fixture,
          memberships: [fixture.memberships[1], fixture.memberships[0]],
          users: [fixture.users[1], fixture.users[0]],
        },
        fixture.memberships[0].id,
        MembershipCommand.DEACTIVATE,
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P2002' } });
  });

  it('allows an admin to leave through the dedicated command', async () => {
    const fixture = await createFixture('admin-leave', 2);
    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      role: MembershipRole.ADMIN,
    });
    const result = await execute(
      fixture,
      null,
      MembershipCommand.LEAVE,
      null,
      runtime,
      1,
    );
    expect(result).toMatchObject({
      outcome: 'changed',
      status: MembershipStatus.INACTIVE,
    });
  });

  it('rejects a NULL requested role in typed role commands', async () => {
    const fixture = await createFixture('null-requested-role', 2);
    await expect(
      execute(
        fixture,
        fixture.memberships[1].id,
        MembershipCommand.CHANGE_ROLE,
      ),
    ).rejects.toMatchObject({ driverError: { code: '22023' } });
  });

  it('records one audit for a change and zero for a no-op', async () => {
    const fixture = await createFixture('audit-once', 2);
    const changed = await execute(
      fixture,
      fixture.memberships[1].id,
      MembershipCommand.CHANGE_ROLE,
      MembershipRole.ADMIN,
    );
    expect(changed.outcome).toBe('changed');
    const noChange = await execute(
      fixture,
      fixture.memberships[1].id,
      MembershipCommand.CHANGE_ROLE,
      MembershipRole.ADMIN,
    );
    expect(noChange.outcome).toBe('no_change');
    const [audit] = await owner.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM public.organization_audit_logs
       WHERE organization_id = $1
         AND event_type = 'organization.membership.role_changed'`,
      [fixture.organization.id],
    );
    expect(audit?.count).toBe(1);
  });

  it('normalizes an active owner membership whose user is already inactive', async () => {
    const fixture = await createFixture('inactive-owner-user', 2, true);
    await owner.getRepository(User).update(fixture.users[1].id, {
      status: UserStatus.INACTIVE,
    });

    const result = await execute(
      fixture,
      fixture.memberships[1].id,
      MembershipCommand.DEACTIVATE,
    );
    expect(result).toMatchObject({
      outcome: 'changed',
      role: MembershipRole.OWNER,
      status: MembershipStatus.INACTIVE,
    });
    const [audits] = await owner.query<
      Array<{ blocked: number; deactivated: number }>
    >(
      `SELECT
         count(*) FILTER (WHERE event_type =
           'organization.membership.last_owner_change_blocked')::int AS blocked,
         count(*) FILTER (WHERE event_type =
           'organization.membership.deactivated')::int AS deactivated
       FROM public.organization_audit_logs WHERE organization_id = $1`,
      [fixture.organization.id],
    );
    expect(audits).toEqual({ blocked: 0, deactivated: 1 });
  });

  it('rejects malformed or contradictory membership audit snapshots', async () => {
    const fixture = await createFixture('audit-shape', 2);
    await expect(
      owner.query(
        `INSERT INTO public.organization_audit_logs (
           organization_id, event_type, target_membership_id,
           membership_action, previous_role, new_role,
           previous_membership_status, new_membership_status
         ) VALUES ($1, 'organization.membership.role_changed', $2,
           'change_role', NULL, 'admin', 'active', 'active')`,
        [fixture.organization.id, fixture.memberships[1].id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(
      owner.query(
        `INSERT INTO public.organization_audit_logs (
           organization_id, event_type, target_membership_id,
           membership_action, previous_role, new_role,
           previous_membership_status, new_membership_status
         ) VALUES ($1, 'organization.membership.owner_promoted', $2,
           'deactivate', 'member', 'owner', 'active', 'active')`,
        [fixture.organization.id, fixture.memberships[1].id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  it('serializes two owners leaving and persists the blocked attempt', async () => {
    const fixture = await createFixture('concurrent-leave', 2, true);
    const secondRuntime = createIntegrationRuntimeDataSource();
    await secondRuntime.initialize();
    try {
      const results = await Promise.all([
        execute(fixture, null, MembershipCommand.LEAVE, null, runtime, 0),
        execute(fixture, null, MembershipCommand.LEAVE, null, secondRuntime, 1),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        'blocked_last_owner',
        'changed',
      ]);
      const [state] = await owner.query<
        Array<{
          activeOwners: number;
          blockedAudits: number;
          leaveAudits: number;
        }>
      >(
        `SELECT
           (SELECT count(*)::int FROM public.memberships
            WHERE organization_id = $1 AND role = 'owner' AND status = 'active') AS "activeOwners",
           (SELECT count(*)::int FROM public.organization_audit_logs
            WHERE organization_id = $1
              AND event_type = 'organization.membership.last_owner_change_blocked') AS "blockedAudits",
           (SELECT count(*)::int FROM public.organization_audit_logs
            WHERE organization_id = $1
              AND event_type = 'organization.membership.left') AS "leaveAudits"`,
        [fixture.organization.id],
      );
      expect(state).toEqual({
        activeOwners: 1,
        blockedAudits: 1,
        leaveAudits: 1,
      });
    } finally {
      await secondRuntime.destroy();
    }
  });

  it('serializes owner A demoting B against owner B demoting A', async () => {
    const fixture = await createFixture('cross-demote-owners', 2, true);
    const secondRuntime = createIntegrationRuntimeDataSource();
    await secondRuntime.initialize();
    const transactionA = runtime.createQueryRunner();
    const transactionB = secondRuntime.createQueryRunner();
    const blocker = owner.createQueryRunner();
    await Promise.all([
      transactionA.connect(),
      transactionB.connect(),
      blocker.connect(),
    ]);
    const startedAt = Date.now();
    try {
      await Promise.all([
        transactionA.startTransaction(),
        transactionB.startTransaction(),
      ]);
      const [identityA] = (await transactionA.query(
        `SELECT pg_backend_pid()::int AS pid, txid_current()::text AS txid`,
      )) as Array<{ pid: number; txid: string }>;
      const [identityB] = (await transactionB.query(
        `SELECT pg_backend_pid()::int AS pid, txid_current()::text AS txid`,
      )) as Array<{ pid: number; txid: string }>;
      expect(identityA?.pid).not.toBe(identityB?.pid);
      expect(identityA?.txid).not.toBe(identityB?.txid);

      await blocker.startTransaction();
      await blocker.query(
        `SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE`,
        [fixture.organization.id],
      );

      const commandA = settleCommand(
        'A',
        executeOnRunner(transactionA, fixture, 0, 1, MembershipRole.MEMBER),
      );
      const commandB = settleCommand(
        'B',
        executeOnRunner(transactionB, fixture, 1, 0, MembershipRole.MEMBER),
      );

      await waitForLockWaiters([identityA.pid, identityB.pid], 2);
      await blocker.commitTransaction();

      const first = await Promise.race([commandA, commandB]);
      expect(first.error).toBeNull();
      expect(first.result?.outcome).toBe('changed');
      const secondPid = first.side === 'A' ? identityB.pid : identityA.pid;
      await waitForLockWaiters([secondPid], 1);
      if (first.side === 'A') await transactionA.commitTransaction();
      else await transactionB.commitTransaction();

      const second = first.side === 'A' ? await commandB : await commandA;
      expect(second.result).toBeNull();
      expect(second.error).toBeInstanceOf(QueryFailedError);
      expect(
        (second.error as QueryFailedError & { driverError: { code: string } })
          .driverError.code,
      ).toBe('P2001');
      expect((second.error as Error).message).toBe(
        'organization access denied',
      );
      if (second.side === 'A') await transactionA.rollbackTransaction();
      else await transactionB.rollbackTransaction();

      const terminals = [first, second];
      expect(
        terminals.filter(({ result }) => result?.outcome === 'changed'),
      ).toHaveLength(1);
      expect(
        terminals.filter(
          ({ error }) =>
            error instanceof QueryFailedError &&
            (error.driverError as { code?: string }).code === 'P2001',
        ),
      ).toHaveLength(1);

      const [state] = await owner.query<
        Array<{
          effectiveOwners: number;
          activeMemberships: number;
          ownerDemotedAudits: number;
          blockedAudits: number;
          membershipAudits: number;
          tenantMemberships: number;
          identityMatches: number;
          ownerMemberships: number;
          demotedMemberships: number;
        }>
      >(
        `SELECT
           (SELECT count(*)::int
            FROM public.memberships AS membership
            JOIN public.users AS application_user
              ON application_user.id = membership.user_id
             AND application_user.status = 'active'
            WHERE membership.organization_id = $1
              AND membership.role = 'owner'
              AND membership.status = 'active') AS "effectiveOwners",
           (SELECT count(*)::int FROM public.memberships
            WHERE id = ANY($2::uuid[]) AND status = 'active') AS "activeMemberships",
           (SELECT count(*)::int FROM public.organization_audit_logs
            WHERE organization_id = $1
              AND event_type = 'organization.membership.owner_demoted')
             AS "ownerDemotedAudits",
           (SELECT count(*)::int FROM public.organization_audit_logs
            WHERE organization_id = $1
              AND event_type = 'organization.membership.last_owner_change_blocked')
             AS "blockedAudits",
           (SELECT count(*)::int FROM public.organization_audit_logs
            WHERE organization_id = $1
              AND event_type LIKE 'organization.membership.%')
             AS "membershipAudits",
           (SELECT count(*)::int FROM public.memberships
            WHERE id = ANY($2::uuid[]) AND organization_id = $1)
             AS "tenantMemberships",
           (SELECT count(*)::int
            FROM pg_catalog.unnest($2::uuid[]) WITH ORDINALITY
              AS expected_membership(membership_id, position)
            JOIN pg_catalog.unnest($3::uuid[]) WITH ORDINALITY
              AS expected_user(user_id, position) USING (position)
            JOIN public.memberships AS membership
              ON membership.id = expected_membership.membership_id
             AND membership.user_id = expected_user.user_id
             AND membership.organization_id = $1)
             AS "identityMatches",
           (SELECT count(*)::int FROM public.memberships
            WHERE id = ANY($2::uuid[]) AND role = 'owner' AND status = 'active')
             AS "ownerMemberships",
           (SELECT count(*)::int FROM public.memberships
            WHERE id = ANY($2::uuid[]) AND role = 'member' AND status = 'active')
             AS "demotedMemberships"`,
        [
          fixture.organization.id,
          fixture.memberships.map(({ id }) => id),
          fixture.users.map(({ id }) => id),
        ],
      );
      expect(state).toEqual({
        effectiveOwners: 1,
        activeMemberships: 2,
        ownerDemotedAudits: 1,
        blockedAudits: 0,
        membershipAudits: 1,
        tenantMemberships: 2,
        identityMatches: 2,
        ownerMemberships: 1,
        demotedMemberships: 1,
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      for (const queryRunner of [transactionA, transactionB, blocker]) {
        if (queryRunner.isTransactionActive)
          await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
      await secondRuntime.destroy();
    }
  });

  it('returns no_change to a concurrent leave that was eligible before locking', async () => {
    const fixture = await createFixture('concurrent-same-leave', 2);
    const secondRuntime = createIntegrationRuntimeDataSource();
    await secondRuntime.initialize();
    const blocker = owner.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    try {
      await blocker.query(
        `SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE`,
        [fixture.organization.id],
      );
      const first = execute(
        fixture,
        null,
        MembershipCommand.LEAVE,
        null,
        runtime,
        1,
      );
      const second = execute(
        fixture,
        null,
        MembershipCommand.LEAVE,
        null,
        secondRuntime,
        1,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.commitTransaction();

      const results = await Promise.all([first, second]);
      expect(results.map(({ outcome }) => outcome).sort()).toEqual([
        'changed',
        'no_change',
      ]);
      await expect(
        execute(fixture, null, MembershipCommand.LEAVE, null, runtime, 1),
      ).rejects.toMatchObject({ driverError: { code: 'P2001' } });
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await secondRuntime.destroy();
    }
  });

  it.each([
    {
      command: MembershipCommand.DEMOTE_OWNER,
      requestedRole: MembershipRole.ADMIN,
      expectedRole: MembershipRole.ADMIN,
      expectedStatus: MembershipStatus.ACTIVE,
    },
    {
      command: MembershipCommand.DEACTIVATE,
      requestedRole: null,
      expectedRole: MembershipRole.OWNER,
      expectedStatus: MembershipStatus.INACTIVE,
    },
  ])(
    'serializes duplicate $command commands as changed plus no_change',
    async ({ command, requestedRole, expectedRole, expectedStatus }) => {
      const fixture = await createFixture(`concurrent-${command}`, 3, true);
      const secondRuntime = createIntegrationRuntimeDataSource();
      await secondRuntime.initialize();
      const blocker = owner.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      try {
        await blocker.query(
          `SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE`,
          [fixture.organization.id],
        );
        const operations = [runtime, secondRuntime].map((dataSource) =>
          execute(
            fixture,
            fixture.memberships[1].id,
            command,
            requestedRole,
            dataSource,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await blocker.commitTransaction();
        const results = await Promise.all(operations);
        expect(results.map(({ outcome }) => outcome).sort()).toEqual([
          'changed',
          'no_change',
        ]);
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: expectedRole,
              status: expectedStatus,
            }),
          ]),
        );
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        await blocker.release();
        await secondRuntime.destroy();
      }
    },
  );

  it('rejects forged actor identities and remains safe under a hostile search_path', async () => {
    const fixture = await createFixture('hostile-search-path', 2);
    await expect(
      runtime.query(
        `SELECT * FROM app_private.execute_membership_command(
           $1::uuid, $2::uuid, $3::uuid, 'deactivate', NULL,
           $4::uuid, NULL, NULL)`,
        [
          fixture.users[1].id,
          fixture.memberships[0].id,
          fixture.memberships[1].id,
          randomUUID(),
        ],
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P2001' } });

    const hostile = runtime.createQueryRunner();
    await hostile.connect();
    try {
      await hostile.query(`SET search_path = pg_temp`);
      const [result] = (await hostile.query(
        `SELECT outcome::text AS outcome,
                target_membership_id AS "targetMembershipId",
                role::text AS role, status::text AS status
         FROM app_private.execute_membership_command(
           $1::uuid, $2::uuid, $3::uuid, 'change_role', 'admin',
           $4::uuid, NULL, NULL)`,
        [
          fixture.users[0].id,
          fixture.memberships[0].id,
          fixture.memberships[1].id,
          randomUUID(),
        ],
      )) as CommandResult[];
      expect(result).toMatchObject({ outcome: 'changed', role: 'admin' });
    } finally {
      await hostile.release();
    }
  });

  it('rolls membership state and audit back with its enclosing transaction', async () => {
    const fixture = await createFixture('transaction-rollback', 2);
    const transaction = runtime.createQueryRunner();
    await transaction.connect();
    await transaction.startTransaction();
    try {
      await transaction.query(
        `SELECT * FROM app_private.execute_membership_command(
           $1::uuid, $2::uuid, $3::uuid, 'change_role', 'admin',
           $4::uuid, NULL, NULL)`,
        [
          fixture.users[0].id,
          fixture.memberships[0].id,
          fixture.memberships[1].id,
          randomUUID(),
        ],
      );
      await expect(transaction.query(`SELECT 1 / 0`)).rejects.toMatchObject({
        driverError: { code: '22012' },
      });
      await transaction.rollbackTransaction();
    } finally {
      if (transaction.isTransactionActive)
        await transaction.rollbackTransaction();
      await transaction.release();
    }
    const membership = await owner
      .getRepository(Membership)
      .findOneByOrFail({ id: fixture.memberships[1].id });
    expect(membership.role).toBe(MembershipRole.MEMBER);
    const [audit] = await owner.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM public.organization_audit_logs
       WHERE organization_id = $1`,
      [fixture.organization.id],
    );
    expect(audit?.count).toBe(0);
  });

  it('surfaces lock_timeout without retrying or leaving partial state', async () => {
    const fixture = await createFixture('lock-timeout', 2);
    const blocker = owner.createQueryRunner();
    const contender = runtime.createQueryRunner();
    await blocker.connect();
    await contender.connect();
    await blocker.startTransaction();
    try {
      await blocker.query(
        `SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE`,
        [fixture.organization.id],
      );
      await contender.query(`SET lock_timeout = '50ms'`);
      await expect(
        contender.query(
          `SELECT * FROM app_private.execute_membership_command(
             $1::uuid, $2::uuid, $3::uuid, 'deactivate', NULL,
             $4::uuid, NULL, NULL)`,
          [
            fixture.users[0].id,
            fixture.memberships[0].id,
            fixture.memberships[1].id,
            randomUUID(),
          ],
        ),
      ).rejects.toMatchObject({ driverError: { code: '55P03' } });
    } finally {
      await contender.query(`SET lock_timeout = DEFAULT`);
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await contender.release();
    }
    const target = await owner
      .getRepository(Membership)
      .findOneByOrFail({ id: fixture.memberships[1].id });
    expect(target.status).toBe(MembershipStatus.ACTIVE);
    const [audit] = await owner.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM public.organization_audit_logs
       WHERE organization_id = $1`,
      [fixture.organization.id],
    );
    expect(audit?.count).toBe(0);
  });

  it('preserves invitation revocation compatibility through the command entrypoint', async () => {
    const fixture = await createFixture('invitation-compat', 2);
    const invitation = await owner.getRepository(OrganizationInvitation).save({
      organizationId: fixture.organization.id,
      emailNormalized: `invite-${randomUUID()}@example.com`,
      role: InvitationRole.MEMBER,
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedByMembershipId: fixture.memberships[1].id,
      acceptedByUserId: null,
      resultingMembershipId: null,
      acceptedAt: null,
      revokedByMembershipId: null,
      revokedAt: null,
      revocationReason: null,
      supersededByInvitationId: null,
      tokenKeyVersion: 1,
      tokenVersion: 1,
      tokenNonce: randomUUID().replace(/-/gu, '').padEnd(43, 'A'),
    });
    await execute(
      fixture,
      fixture.memberships[1].id,
      MembershipCommand.DEACTIVATE,
    );
    const revoked = await owner
      .getRepository(OrganizationInvitation)
      .findOneByOrFail({ id: invitation.id });
    expect(revoked).toMatchObject({
      status: InvitationStatus.REVOKED,
      revocationReason: InvitationRevocationReason.ISSUER_MEMBERSHIP_INACTIVE,
    });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
  });

  it('fails rollback closed after real membership audit exists', async () => {
    await expect(owner.undoLastMigration()).rejects.toThrow(
      /M5492 membership ownership audit exists; forward-fix required/u,
    );
  });

  async function createFixture(
    prefix: string,
    count: number,
    allOwners = false,
  ): Promise<Fixture> {
    const slugPrefix = prefix.replace(/[^a-z0-9-]/gu, '-');
    const users: User[] = [];
    for (let index = 0; index < count; index += 1) {
      users.push(
        await owner.getRepository(User).save({
          email: `${prefix}-${index}-${randomUUID()}@example.com`,
          name: `${prefix} ${index}`,
          status: UserStatus.ACTIVE,
        }),
      );
    }
    return owner.transaction(async (manager) => {
      const organization = await manager.getRepository(Organization).save({
        name: prefix,
        slug: `${slugPrefix}-${randomUUID()}`,
        status: OrganizationStatus.ACTIVE,
      });
      const memberships: Membership[] = [];
      for (let index = 0; index < users.length; index += 1) {
        memberships.push(
          await manager.getRepository(Membership).save({
            userId: users[index].id,
            organizationId: organization.id,
            role:
              index === 0 || allOwners
                ? MembershipRole.OWNER
                : MembershipRole.MEMBER,
            status: MembershipStatus.ACTIVE,
          }),
        );
      }
      return { organization, users, memberships };
    });
  }

  async function execute(
    fixture: Fixture,
    targetMembershipId: string | null,
    command: MembershipCommand,
    requestedRole: MembershipRole | null = null,
    connection: DataSource = runtime,
    actorIndex = 0,
  ): Promise<CommandResult> {
    const [result] = await connection.query<CommandResult[]>(
      `SELECT outcome::text AS outcome,
              target_membership_id AS "targetMembershipId",
              role::text AS role, status::text AS status
       FROM app_private.execute_membership_command(
         $1::uuid, $2::uuid, $3::uuid,
         $4::app_private.membership_command_enum,
         $5::public.membership_role_enum,
         $6::uuid, NULL::inet, NULL::text
       )`,
      [
        fixture.users[actorIndex].id,
        fixture.memberships[actorIndex].id,
        targetMembershipId,
        command,
        requestedRole,
        randomUUID(),
      ],
    );
    if (result === undefined) throw new Error('Missing command result.');
    return result;
  }

  async function executeOnRunner(
    queryRunner: QueryRunner,
    fixture: Fixture,
    actorIndex: number,
    targetIndex: number,
    requestedRole: MembershipRole,
  ): Promise<CommandResult> {
    const [result] = (await queryRunner.query(
      `SELECT outcome::text AS outcome,
              target_membership_id AS "targetMembershipId",
              role::text AS role, status::text AS status
       FROM app_private.execute_membership_command(
         $1::uuid, $2::uuid, $3::uuid, 'demote_owner',
         $4::public.membership_role_enum, $5::uuid, NULL::inet, NULL::text
       )`,
      [
        fixture.users[actorIndex].id,
        fixture.memberships[actorIndex].id,
        fixture.memberships[targetIndex].id,
        requestedRole,
        randomUUID(),
      ],
    )) as CommandResult[];
    if (result === undefined) throw new Error('Missing command result.');
    return result;
  }

  async function settleCommand(
    side: 'A' | 'B',
    command: Promise<CommandResult>,
  ): Promise<SettledCommand> {
    try {
      return { side, result: await command, error: null };
    } catch (error) {
      return {
        side,
        result: null,
        error:
          error instanceof Error
            ? error
            : new Error('Non-error membership command rejection.', {
                cause: error,
              }),
      };
    }
  }

  async function waitForLockWaiters(
    backendPids: number[],
    expected: number,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row] = await owner.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count
         FROM pg_catalog.pg_stat_activity
         WHERE pid = ANY($1::int[])
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query LIKE '%execute_membership_command%'`,
        [backendPids],
      );
      if ((row?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${expected} command lock waiters.`);
  }
});
