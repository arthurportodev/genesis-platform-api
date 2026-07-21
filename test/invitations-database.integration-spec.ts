import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OrganizationAuditService } from '../src/modules/organization-audit/services/organization-audit.service';
import {
  InvitationDeliveryStatus,
  InvitationRole,
} from '../src/modules/invitations/enums/invitation.enums';
import { EnabledInvitationIssuanceReadiness } from '../src/modules/invitations/ports/invitation-issuance-readiness.port';
import { InvitationsService } from '../src/modules/invitations/services/invitations.service';
import { InvitationReplacementExecution } from '../src/modules/invitations/types/invitation-api.type';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { Organization } from '../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../src/modules/organizations/enums/organization-status.enum';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';
import {
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

interface Fixture {
  user: User;
  organization: Organization;
  membership: Membership;
  service: InvitationsService;
}

describe('Organization invitations database integration', () => {
  let connection: DataSource;
  let runtimeConnection: DataSource;

  beforeAll(async () => {
    connection = createIntegrationDataSource();
    await connection.initialize();
    await prepareIntegrationRuntimeRole(connection);
    await connection.dropDatabase();
    await connection.runMigrations();
    runtimeConnection = createIntegrationRuntimeDataSource();
    await runtimeConnection.initialize();
  });

  afterAll(async () => {
    if (runtimeConnection.isInitialized) await runtimeConnection.destroy();
    if (connection.isInitialized) {
      await connection.dropDatabase();
      await connection.destroy();
    }
  });

  it('migrates four tables, rolls back, and migrates again', async () => {
    const names = await invitationTableNames();
    expect(names).toEqual([
      'invitation_delivery_outbox',
      'organization_audit_logs',
      'organization_command_idempotency',
      'organization_invitations',
    ]);

    await connection.undoLastMigration();
    expect(await invitationTableNames()).toEqual([]);
    await connection.runMigrations();
    expect(await invitationTableNames()).toHaveLength(4);
  });

  it('rejects an inherited audit TRIGGER grant and rolls the migration back', async () => {
    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;
    if (runtimeRole === undefined) {
      throw new Error('Missing test runtime role.');
    }
    const groupRole = `audit_trigger_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

    await connection.undoLastMigration();
    expect(await invitationTableNames()).toEqual([]);
    await connection.query(
      `CREATE ROLE "${groupRole}" NOLOGIN NOSUPERUSER NOCREATEDB
       NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    try {
      await connection.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT TRIGGER ON TABLES TO "${groupRole}"`,
      );
      await connection.query(
        `GRANT "${groupRole}" TO "${runtimeRole}" WITH INHERIT TRUE`,
      );
      const memberships = await connection.query<
        Array<{
          grantedRole: string;
          memberRole: string;
          inheritOption: boolean;
        }>
      >(
        `SELECT granted.rolname AS "grantedRole",
                member.rolname AS "memberRole",
                membership.inherit_option AS "inheritOption"
         FROM pg_auth_members AS membership
         INNER JOIN pg_roles AS granted ON granted.oid = membership.roleid
         INNER JOIN pg_roles AS member ON member.oid = membership.member
         WHERE granted.rolname = $1 AND member.rolname = $2`,
        [groupRole, runtimeRole],
      );
      expect(memberships).toEqual([
        {
          grantedRole: groupRole,
          memberRole: runtimeRole,
          inheritOption: true,
        },
      ]);

      await expect(connection.runMigrations()).rejects.toThrow(
        'effective privileges outside SELECT/INSERT',
      );
      expect(await invitationTableNames()).toEqual([]);
      const [{ applied }] = await connection.query<Array<{ applied: string }>>(
        `SELECT count(*)::text AS applied FROM migrations
         WHERE name = 'CreateOrganizationInvitations1785004800000'`,
      );
      expect(applied).toBe('0');
    } finally {
      await connection.query(`ALTER ROLE "${runtimeRole}" NOINHERIT`);
      await connection.query(`REVOKE "${groupRole}" FROM "${runtimeRole}"`);
      await connection.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE TRIGGER ON TABLES FROM "${groupRole}"`,
      );
      await connection.query(`DROP OWNED BY "${groupRole}"`);
      await connection.query(`DROP ROLE "${groupRole}"`);
    }

    await connection.runMigrations();
    expect(await invitationTableNames()).toHaveLength(4);
  });

  it('runs invitation services through the login-capable runtime role', async () => {
    const [identity] = await runtimeConnection.query<
      Array<{ currentUser: string; sessionUser: string }>
    >(`SELECT current_user AS "currentUser", session_user AS "sessionUser"`);
    expect(identity).toEqual({
      currentUser: process.env.DATABASE_RUNTIME_ROLE,
      sessionUser: process.env.DATABASE_RUNTIME_ROLE,
    });

    const fixture = await createFixture('runtime-identity');
    await expect(
      fixture.service.create(
        tenant(fixture),
        { email: 'runtime-flow@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: 'runtime identity' },
      ),
    ).resolves.toMatchObject({ state: 'pending' });
  });

  it('hardens the private lock boundary without granting central UPDATE privileges', async () => {
    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;
    if (runtimeRole === undefined) {
      throw new Error('Missing test runtime role.');
    }
    const [boundary] = await connection.query<
      Array<{
        schemaOwner: string;
        functionOwner: string;
        returnType: string;
        isSecurityDefiner: boolean;
        isStrict: boolean;
        volatility: string;
        parallelSafety: string;
        configuration: string[];
        publicCanExecute: boolean;
        definition: string;
      }>
    >(
      `SELECT namespace_owner.rolname AS "schemaOwner",
              function_owner.rolname AS "functionOwner",
              procedure.prorettype::regtype::text AS "returnType",
              procedure.prosecdef AS "isSecurityDefiner",
              procedure.proisstrict AS "isStrict",
              procedure.provolatile AS volatility,
              procedure.proparallel AS "parallelSafety",
              procedure.proconfig AS configuration,
              pg_get_functiondef(procedure.oid) AS definition,
              EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                  procedure.proacl,
                  acldefault('f', procedure.proowner)
                )) AS privilege
                WHERE privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
              ) AS "publicCanExecute"
       FROM pg_proc AS procedure
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = procedure.pronamespace
       INNER JOIN pg_roles AS namespace_owner
         ON namespace_owner.oid = namespace.nspowner
       INNER JOIN pg_roles AS function_owner
         ON function_owner.oid = procedure.proowner
       WHERE namespace.nspname = 'app_private'
         AND procedure.proname = 'lock_invitation_context'
         AND oidvectortypes(procedure.proargtypes) = 'uuid[], uuid[], uuid[]'`,
    );
    expect(boundary).toMatchObject({
      schemaOwner: boundary?.functionOwner,
      functionOwner: boundary?.functionOwner,
      returnType: 'void',
      isSecurityDefiner: true,
      isStrict: true,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: ['search_path=pg_catalog, app_private, pg_temp'],
      publicCanExecute: false,
    });
    expect(boundary?.definition).toContain('FOR UPDATE OF application_user');
    expect(boundary?.definition).not.toContain(
      'FOR NO KEY UPDATE OF application_user',
    );

    const [authBoundary] = await connection.query<
      Array<{
        schemaOwner: string;
        functionOwner: string;
        returnType: string;
        isSecurityDefiner: boolean;
        isStrict: boolean;
        volatility: string;
        parallelSafety: string;
        configuration: string[];
        publicCanExecute: boolean;
        definition: string;
      }>
    >(
      `SELECT namespace_owner.rolname AS "schemaOwner",
              function_owner.rolname AS "functionOwner",
              procedure.prorettype::regtype::text AS "returnType",
              procedure.prosecdef AS "isSecurityDefiner",
              procedure.proisstrict AS "isStrict",
              procedure.provolatile AS volatility,
              procedure.proparallel AS "parallelSafety",
              procedure.proconfig AS configuration,
              pg_get_functiondef(procedure.oid) AS definition,
              EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(
                  procedure.proacl,
                  acldefault('f', procedure.proowner)
                )) AS privilege
                WHERE privilege.grantee = 0
                  AND privilege.privilege_type = 'EXECUTE'
              ) AS "publicCanExecute"
       FROM pg_proc AS procedure
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = procedure.pronamespace
       INNER JOIN pg_roles AS namespace_owner
         ON namespace_owner.oid = namespace.nspowner
       INNER JOIN pg_roles AS function_owner
         ON function_owner.oid = procedure.proowner
       WHERE namespace.nspname = 'app_private'
         AND procedure.proname = 'lock_auth_refresh_user'
         AND oidvectortypes(procedure.proargtypes) = 'uuid'`,
    );
    expect(authBoundary).toMatchObject({
      schemaOwner: authBoundary?.functionOwner,
      functionOwner: authBoundary?.functionOwner,
      returnType: 'void',
      isSecurityDefiner: true,
      isStrict: true,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: ['search_path=pg_catalog, app_private, pg_temp'],
      publicCanExecute: false,
    });
    expect(authBoundary?.definition).toContain(
      'FOR NO KEY UPDATE OF application_user',
    );

    const [privileges] = await connection.query<
      Array<{
        canUseSchema: boolean;
        canCreateInSchema: boolean;
        canExecute: boolean;
        canExecuteAuthRefreshLock: boolean;
        canUpdateOrganizations: boolean;
        canUpdateUsers: boolean;
        canUpdateMemberships: boolean;
        canAssumeOwner: boolean;
      }>
    >(
      `SELECT
         has_schema_privilege($1, 'app_private', 'USAGE') AS "canUseSchema",
         has_schema_privilege($1, 'app_private', 'CREATE') AS "canCreateInSchema",
         has_function_privilege(
           $1,
           'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
           'EXECUTE'
         ) AS "canExecute",
         has_function_privilege(
           $1,
           'app_private.lock_auth_refresh_user(uuid)',
           'EXECUTE'
         ) AS "canExecuteAuthRefreshLock",
         has_table_privilege($1, 'public.organizations', 'UPDATE')
           OR has_any_column_privilege($1, 'public.organizations', 'UPDATE')
           AS "canUpdateOrganizations",
         has_table_privilege($1, 'public.users', 'UPDATE')
           OR has_any_column_privilege($1, 'public.users', 'UPDATE')
           AS "canUpdateUsers",
         has_table_privilege($1, 'public.memberships', 'UPDATE')
           OR has_any_column_privilege($1, 'public.memberships', 'UPDATE')
           AS "canUpdateMemberships",
         pg_has_role($1, $2, 'MEMBER') AS "canAssumeOwner"`,
      [runtimeRole, boundary?.functionOwner],
    );
    expect(privileges).toEqual({
      canUseSchema: true,
      canCreateInSchema: false,
      canExecute: true,
      canExecuteAuthRefreshLock: true,
      canUpdateOrganizations: false,
      canUpdateUsers: false,
      canUpdateMemberships: false,
      canAssumeOwner: false,
    });

    const executableFunctions = await connection.query<
      Array<{ signature: string }>
    >(
      `SELECT procedure.oid::regprocedure::text AS signature
       FROM pg_proc AS procedure
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'app_private'
         AND has_function_privilege($1, procedure.oid, 'EXECUTE')
       ORDER BY signature`,
      [runtimeRole],
    );
    expect(executableFunctions).toEqual([
      {
        signature: 'app_private.lock_auth_refresh_user(uuid)',
      },
      {
        signature: 'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
      },
    ]);

    const fixture = await createFixture('lock-acl');
    for (const [table, id] of [
      ['organizations', fixture.organization.id],
      ['users', fixture.user.id],
      ['memberships', fixture.membership.id],
    ] as const) {
      await expect(
        runtimeConnection.query(
          `SELECT id FROM public.${table} WHERE id = $1 FOR UPDATE`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      runtimeConnection.query(
        `CREATE TABLE app_private.runtime_object(id int)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimeConnection.query(
        `ALTER FUNCTION app_private.lock_invitation_context(uuid[], uuid[], uuid[])
         RENAME TO compromised_lock`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimeConnection.query(
        `CREATE OR REPLACE FUNCTION app_private.lock_invitation_context(uuid[], uuid[], uuid[])
         RETURNS void LANGUAGE plpgsql AS 'BEGIN NULL; END'`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimeConnection.query(
        `ALTER FUNCTION app_private.lock_auth_refresh_user(uuid)
         RENAME TO compromised_auth_refresh_lock`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(boundary.functionOwner)) {
      throw new Error('Unsafe migration owner role name.');
    }
    await expect(
      runtimeConnection.query(`SET ROLE "${boundary.functionOwner}"`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('locks central rows until commit or rollback and releases them afterwards', async () => {
    const fixture = await createFixture('lock-lifetime');
    const locker = runtimeConnection.createQueryRunner();
    await locker.connect();
    try {
      for (const completion of ['commit', 'rollback'] as const) {
        await locker.startTransaction();
        await locker.query(
          `SELECT app_private.lock_invitation_context(
             $1::uuid[], $2::uuid[], $3::uuid[]
           )`,
          [
            [fixture.organization.id],
            [fixture.user.id],
            [fixture.membership.id],
          ],
        );

        for (const [table, id] of [
          ['organizations', fixture.organization.id],
          ['users', fixture.user.id],
          ['memberships', fixture.membership.id],
        ] as const) {
          const contender = connection.createQueryRunner();
          await contender.connect();
          await contender.startTransaction();
          try {
            await contender.query(`SET LOCAL lock_timeout = '100ms'`);
            await expect(
              contender.query(
                `UPDATE public.${table} SET updated_at = updated_at WHERE id = $1`,
                [id],
              ),
            ).rejects.toMatchObject({ code: '55P03' });
          } finally {
            await contender.rollbackTransaction();
            await contender.release();
          }
        }

        if (completion === 'commit') await locker.commitTransaction();
        else await locker.rollbackTransaction();

        for (const [table, id] of [
          ['organizations', fixture.organization.id],
          ['users', fixture.user.id],
          ['memberships', fixture.membership.id],
        ] as const) {
          await expect(
            connection.query(
              `UPDATE public.${table} SET updated_at = updated_at WHERE id = $1`,
              [id],
            ),
          ).resolves.toBeDefined();
        }
      }
    } finally {
      if (locker.isTransactionActive) await locker.rollbackTransaction();
      await locker.release();
    }
  });

  it('holds the auth refresh user lock through commit or rollback without writing', async () => {
    const fixture = await createFixture('auth-refresh-lock-lifetime');
    const locker = runtimeConnection.createQueryRunner();
    await locker.connect();
    try {
      for (const completion of ['commit', 'rollback'] as const) {
        const before = await connection.getRepository(User).findOneByOrFail({
          id: fixture.user.id,
        });
        await locker.startTransaction();
        await locker.query(
          `SELECT app_private.lock_auth_refresh_user($1::uuid)`,
          [fixture.user.id],
        );

        const contender = connection.createQueryRunner();
        await contender.connect();
        await contender.startTransaction();
        try {
          await contender.query(`SET LOCAL lock_timeout = '100ms'`);
          await expect(
            contender.query(
              `UPDATE public.users SET updated_at = updated_at WHERE id = $1`,
              [fixture.user.id],
            ),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await contender.rollbackTransaction();
          await contender.release();
        }

        if (completion === 'commit') await locker.commitTransaction();
        else await locker.rollbackTransaction();

        await expect(
          connection.query(
            `UPDATE public.users SET updated_at = updated_at WHERE id = $1`,
            [fixture.user.id],
          ),
        ).resolves.toBeDefined();
        await expect(
          connection
            .getRepository(User)
            .findOneByOrFail({ id: fixture.user.id }),
        ).resolves.toMatchObject({
          id: before.id,
          email: before.email,
          status: before.status,
        });
      }
    } finally {
      if (locker.isTransactionActive) await locker.rollbackTransaction();
      await locker.release();
    }
  });

  it('allows the auth audit foreign-key KEY SHARE while the refresh user lock is held', async () => {
    const fixture = await createFixture('auth-refresh-key-share');
    const locker = runtimeConnection.createQueryRunner();
    const auditor = runtimeConnection.createQueryRunner();
    await locker.connect();
    await auditor.connect();
    await locker.startTransaction();
    await auditor.startTransaction();
    try {
      await locker.query(
        `SELECT app_private.lock_auth_refresh_user($1::uuid)`,
        [fixture.user.id],
      );
      await auditor.query(`SET LOCAL lock_timeout = '500ms'`);
      const inserted = (await auditor.query(
        `INSERT INTO public.auth_audit_logs (user_id, event_type, metadata)
         VALUES ($1, 'auth.refresh.failed', '{"reason":"key_share_probe"}'::jsonb)
         RETURNING id`,
        [fixture.user.id],
      )) as Array<{ id: string }>;
      expect(inserted).toHaveLength(1);
      const auditId = inserted[0]?.id;
      if (auditId === undefined)
        throw new Error('Audit insert returned no ID.');
      await auditor.commitTransaction();
      const [{ count }] = await connection.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count
         FROM public.auth_audit_logs
         WHERE id = $1 AND user_id = $2`,
        [auditId, fixture.user.id],
      );
      expect(count).toBe('1');
      await locker.rollbackTransaction();
    } finally {
      if (auditor.isTransactionActive) await auditor.rollbackTransaction();
      if (locker.isTransactionActive) await locker.rollbackTransaction();
      await auditor.release();
      await locker.release();
    }
  });

  it('blocks DELETE and user-key changes until refresh lock commit or rollback', async () => {
    for (const operation of ['delete', 'change-key'] as const) {
      for (const completion of ['commit', 'rollback'] as const) {
        const user = await connection.getRepository(User).save(
          connection.getRepository(User).create({
            name: `Lock target ${operation} ${completion}`,
            email: `${operation}-${completion}-${randomUUID()}@example.com`,
            status: UserStatus.ACTIVE,
          }),
        );
        const replacementId = randomUUID();
        const locker = runtimeConnection.createQueryRunner();
        const contender = connection.createQueryRunner();
        await locker.connect();
        await contender.connect();
        await locker.startTransaction();
        await contender.startTransaction();
        try {
          await locker.query(
            `SELECT app_private.lock_auth_refresh_user($1::uuid)`,
            [user.id],
          );
          await contender.query(`SET LOCAL lock_timeout = '100ms'`);
          const blockedCommand =
            operation === 'delete'
              ? contender.query(`DELETE FROM public.users WHERE id = $1`, [
                  user.id,
                ])
              : contender.query(
                  `UPDATE public.users SET id = $2 WHERE id = $1`,
                  [user.id, replacementId],
                );
          await expect(blockedCommand).rejects.toMatchObject({ code: '55P03' });
          await contender.rollbackTransaction();

          if (completion === 'commit') await locker.commitTransaction();
          else await locker.rollbackTransaction();

          if (operation === 'delete') {
            await expect(
              connection.query(`DELETE FROM public.users WHERE id = $1`, [
                user.id,
              ]),
            ).resolves.toBeDefined();
            const [{ count }] = await connection.query<
              Array<{ count: string }>
            >(`SELECT count(*)::text AS count FROM users WHERE id = $1`, [
              user.id,
            ]);
            expect(count).toBe('0');
          } else {
            await expect(
              connection.query(
                `UPDATE public.users SET id = $2 WHERE id = $1`,
                [user.id, replacementId],
              ),
            ).resolves.toBeDefined();
            const [{ count }] = await connection.query<
              Array<{ count: string }>
            >(`SELECT count(*)::text AS count FROM users WHERE id = $1`, [
              replacementId,
            ]);
            expect(count).toBe('1');
          }
        } finally {
          if (contender.isTransactionActive)
            await contender.rollbackTransaction();
          if (locker.isTransactionActive) await locker.rollbackTransaction();
          await contender.release();
          await locker.release();
        }
      }
    }
  });

  it('deduplicates and sorts opposite lock arrays without deadlock', async () => {
    const first = await createFixture('lock-order-first');
    const second = await createFixture('lock-order-second');
    const firstLocker = runtimeConnection.createQueryRunner();
    const secondLocker = runtimeConnection.createQueryRunner();
    await firstLocker.connect();
    await secondLocker.connect();
    await firstLocker.startTransaction();
    await secondLocker.startTransaction();
    try {
      await firstLocker.query(`SET LOCAL lock_timeout = '2s'`);
      await secondLocker.query(`SET LOCAL lock_timeout = '2s'`);
      await firstLocker.query(
        `SELECT app_private.lock_invitation_context(
           $1::uuid[], $2::uuid[], $3::uuid[]
         )`,
        [
          [
            second.organization.id,
            first.organization.id,
            first.organization.id,
          ],
          [second.user.id, first.user.id, first.user.id],
          [second.membership.id, first.membership.id, first.membership.id],
        ],
      );
      const oppositeLock = secondLocker.query(
        `SELECT app_private.lock_invitation_context(
           $1::uuid[], $2::uuid[], $3::uuid[]
         )`,
        [
          [first.organization.id, second.organization.id],
          [first.user.id, second.user.id],
          [first.membership.id, second.membership.id],
        ],
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await firstLocker.commitTransaction();
      await expect(oppositeLock).resolves.toBeDefined();
      await secondLocker.commitTransaction();
    } finally {
      if (firstLocker.isTransactionActive)
        await firstLocker.rollbackTransaction();
      if (secondLocker.isTransactionActive)
        await secondLocker.rollbackTransaction();
      await firstLocker.release();
      await secondLocker.release();
    }
  });

  it('keeps lock calls non-enumerating and immune to caller search_path', async () => {
    const fixture = await createFixture('lock-security');
    const absentId = randomUUID();
    const runner = runtimeConnection.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`CREATE TEMP TABLE organizations(id uuid)`);
      await runner.query(`CREATE TEMP TABLE users(id uuid)`);
      await runner.query(
        `SET search_path = pg_temp, public, app_private, pg_catalog`,
      );
      const found = (await runner.query(
        `SELECT app_private.lock_invitation_context(
           $1::uuid[], $2::uuid[], $3::uuid[]
         ) AS result`,
        [[fixture.organization.id], [fixture.user.id], [fixture.membership.id]],
      )) as Array<{ result: string }>;
      const missing = (await runner.query(
        `SELECT app_private.lock_invitation_context(
           $1::uuid[], $2::uuid[], $3::uuid[]
         ) AS result`,
        [[absentId], [absentId], [absentId]],
      )) as Array<{ result: string }>;
      const empty = (await runner.query(
        `SELECT app_private.lock_invitation_context(
           ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::uuid[]
         ) AS result`,
      )) as Array<{ result: string }>;
      expect(found).toEqual([{ result: '' }]);
      expect(missing).toEqual(found);
      expect(empty).toEqual(found);
      const authFound = (await runner.query(
        `SELECT app_private.lock_auth_refresh_user($1::uuid) AS result`,
        [fixture.user.id],
      )) as Array<{ result: string }>;
      const authMissing = (await runner.query(
        `SELECT app_private.lock_auth_refresh_user($1::uuid) AS result`,
        [absentId],
      )) as Array<{ result: string }>;
      expect(authFound).toEqual(found);
      expect(authMissing).toEqual(authFound);
      await expect(
        runner.query(
          `SELECT app_private.lock_invitation_context(
             ARRAY[$1::uuid, NULL]::uuid[], ARRAY[]::uuid[], ARRAY[]::uuid[]
           )`,
          [fixture.organization.id],
        ),
      ).rejects.toMatchObject({ code: '22004' });
    } finally {
      await runner.query(`RESET search_path`);
      await runner.query(`DROP TABLE IF EXISTS pg_temp.organizations`);
      await runner.query(`DROP TABLE IF EXISTS pg_temp.users`);
      await runner.release();
    }
  });

  it('creates an invitation atomically without exposing or persisting a token', async () => {
    const fixture = await createFixture('create');
    const result = await fixture.service.create(
      tenant(fixture),
      { email: '  MEMBER@Example.COM  ', role: InvitationRole.MEMBER },
      { ipAddress: '127.0.0.1', userAgent: 'integration' },
    );

    expect(result).toMatchObject({
      email: 'member@example.com',
      role: InvitationRole.MEMBER,
      state: 'pending',
      deliveryStatus: InvitationDeliveryStatus.QUEUED,
    });
    const columns = await connection.query<Array<{ column_name: string }>>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN (
        'organization_invitations', 'invitation_delivery_outbox',
        'organization_audit_logs', 'organization_command_idempotency'
      ) AND column_name ~ '(token_hash|raw_token|mac|email_payload|link)'
    `);
    expect(columns).toEqual([]);
    const invitations = await connection.query<
      Array<{ token_nonce: string; token_key_version: number }>
    >(
      `SELECT token_nonce, token_key_version FROM organization_invitations
       WHERE id = $1 AND organization_id = $2`,
      [result.id, fixture.organization.id],
    );
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.token_key_version).toBe(2);
    expect(
      await connection.query(
        `SELECT * FROM invitation_delivery_outbox
         WHERE invitation_id = $1 AND organization_id = $2`,
        [result.id, fixture.organization.id],
      ),
    ).toHaveLength(1);
    expect(
      await connection.query(
        `SELECT * FROM organization_audit_logs
         WHERE invitation_id = $1 AND organization_id = $2
           AND event_type = 'organization.invitation.created'`,
        [result.id, fixture.organization.id],
      ),
    ).toHaveLength(1);
  });

  it('enforces role and token nonce constraints in PostgreSQL', async () => {
    const fixture = await createFixture('constraints');
    await expect(
      connection.query(
        `INSERT INTO organization_invitations (
          organization_id, email_normalized, role, expires_at,
          invited_by_membership_id, token_key_version, token_nonce
        ) VALUES ($1, 'owner@example.com', 'owner', transaction_timestamp() + interval '7 days', $2, 1, $3)`,
        [fixture.organization.id, fixture.membership.id, 'a'.repeat(43)],
      ),
    ).rejects.toThrow();
    await expect(
      connection.query(
        `INSERT INTO organization_invitations (
          organization_id, email_normalized, role, expires_at,
          invited_by_membership_id, token_key_version, token_nonce
        ) VALUES ($1, 'member@example.com', 'member', transaction_timestamp() + interval '7 days', $2, 1, 'short')`,
        [fixture.organization.id, fixture.membership.id],
      ),
    ).rejects.toThrow();
  });

  it('rejects cross-organization invitation references in every dependent table', async () => {
    const first = await createFixture('tenant-integrity-first');
    const second = await createFixture('tenant-integrity-second');
    await expect(
      connection.query(
        `INSERT INTO organization_invitations (
          organization_id, email_normalized, role, expires_at,
          invited_by_membership_id, token_key_version, token_nonce
        ) VALUES ($1, 'cross-issuer@example.com', 'member',
          transaction_timestamp() + interval '7 days', $2, 2, $3)`,
        [
          first.organization.id,
          second.membership.id,
          Buffer.alloc(32, 1).toString('base64url'),
        ],
      ),
    ).rejects.toThrow();

    const invitation = await first.service.create(
      tenant(first),
      { email: 'tenant-integrity@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    await expect(
      connection.query(
        `INSERT INTO invitation_delivery_outbox (
          organization_id, invitation_id, event_type, token_version
         ) VALUES ($1, $2, 'delivery.requested', 2)`,
        [second.organization.id, invitation.id],
      ),
    ).rejects.toThrow();
    await expect(
      connection.query(
        `INSERT INTO organization_audit_logs (
          organization_id, event_type, invitation_id, invited_role
         ) VALUES ($1, 'organization.invitation.created', $2, 'member')`,
        [second.organization.id, invitation.id],
      ),
    ).rejects.toThrow();
    await expect(
      connection.query(
        `INSERT INTO organization_command_idempotency (
          organization_id, actor_membership_id, operation, idempotency_key,
          fingerprint, result_previous_invitation_id, result_invitation_id,
          result_state_at_creation, result_delivery_status_at_creation,
          response_email_normalized, response_invited_role,
          response_invitation_created_at, response_invitation_updated_at,
          response_invitation_expires_at, response_invited_by_membership_id,
          response_status, expires_at
        ) SELECT $1, $2, 'replace', $3, $4, i.id, i.id,
          'pending', 'queued', i.email_normalized, i.role,
          i.created_at, i.updated_at, i.expires_at, $2, 201,
          transaction_timestamp() + interval '1 day'
          FROM organization_invitations i WHERE i.id = $5`,
        [
          second.organization.id,
          second.membership.id,
          randomUUID(),
          'a'.repeat(64),
          invitation.id,
        ],
      ),
    ).rejects.toThrow();
  });

  it('rolls back emission when the active keyring cannot resolve a version', async () => {
    const fixture = await createFixture('keyring-failure');
    const failing = new InvitationsService(
      runtimeConnection,
      new OrganizationAuditService(),
      new EnabledInvitationIssuanceReadiness(),
      {
        currentVersion: () => {
          throw new Error('keyring unavailable');
        },
        keyFor: () => Buffer.alloc(32),
      },
    );
    await expect(
      failing.create(
        tenant(fixture),
        { email: 'keyring-failure@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow('keyring unavailable');
    const [{ invitations, outbox, audit }] = await connection.query<
      Array<{ invitations: string; outbox: string; audit: string }>
    >(
      `SELECT
        (SELECT count(*)::text FROM organization_invitations WHERE organization_id = $1) AS invitations,
        (SELECT count(*)::text FROM invitation_delivery_outbox WHERE organization_id = $1) AS outbox,
        (SELECT count(*)::text FROM organization_audit_logs WHERE organization_id = $1) AS audit`,
      [fixture.organization.id],
    );
    expect({ invitations, outbox, audit }).toEqual({
      invitations: '0',
      outbox: '0',
      audit: '0',
    });
  });

  it('makes organization audit rows append-only in the database', async () => {
    const fixture = await createFixture('audit');
    await fixture.service.create(
      tenant(fixture),
      { email: 'audit@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    await expect(
      connection.query(
        `UPDATE organization_audit_logs SET user_agent = 'changed'`,
      ),
    ).rejects.toThrow('append-only');
    await expect(
      connection.query(`DELETE FROM organization_audit_logs`),
    ).rejects.toThrow('append-only');
    await expect(
      connection.query(`TRUNCATE organization_audit_logs`),
    ).rejects.toThrow('append-only');
    await connection.query(
      `INSERT INTO organization_audit_logs (
        organization_id, event_type, invited_role
       ) VALUES ($1, 'organization.invitation.created', 'member')`,
      [fixture.organization.id],
    );
    expect(
      await connection.query(
        `SELECT id FROM organization_audit_logs WHERE organization_id = $1`,
        [fixture.organization.id],
      ),
    ).toHaveLength(2);

    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;
    if (runtimeRole === undefined)
      throw new Error('Missing test runtime role.');
    const [privileges] = await connection.query<
      Array<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_update_column: boolean;
        can_delete: boolean;
        can_truncate: boolean;
        can_reference: boolean;
        can_reference_column: boolean;
        can_trigger: boolean;
        can_maintain: boolean;
      }>
    >(
      `SELECT
        has_table_privilege($1, 'organization_audit_logs', 'SELECT') AS can_select,
        has_table_privilege($1, 'organization_audit_logs', 'INSERT') AS can_insert,
        has_table_privilege($1, 'organization_audit_logs', 'UPDATE') AS can_update,
        has_any_column_privilege($1, 'organization_audit_logs', 'UPDATE') AS can_update_column,
        has_table_privilege($1, 'organization_audit_logs', 'DELETE') AS can_delete,
        has_table_privilege($1, 'organization_audit_logs', 'TRUNCATE') AS can_truncate,
        has_table_privilege($1, 'organization_audit_logs', 'REFERENCES') AS can_reference,
        has_any_column_privilege($1, 'organization_audit_logs', 'REFERENCES') AS can_reference_column,
        has_table_privilege($1, 'organization_audit_logs', 'TRIGGER') AS can_trigger,
        has_table_privilege($1, 'organization_audit_logs', 'MAINTAIN') AS can_maintain`,
      [runtimeRole],
    );
    expect(privileges).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_update_column: false,
      can_delete: false,
      can_truncate: false,
      can_reference: false,
      can_reference_column: false,
      can_trigger: false,
      can_maintain: false,
    });
    const tablePrivileges = await connection.query<
      Array<{
        table_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>
    >(
      `SELECT table_name,
              has_table_privilege($1, table_name, 'SELECT') AS can_select,
              has_table_privilege($1, table_name, 'INSERT') AS can_insert,
              has_table_privilege($1, table_name, 'UPDATE') AS can_update,
              has_table_privilege($1, table_name, 'DELETE') AS can_delete
       FROM unnest($2::text[]) AS table_name ORDER BY table_name`,
      [
        runtimeRole,
        [
          'auth_audit_logs',
          'auth_refresh_tokens',
          'auth_sessions',
          'invitation_delivery_outbox',
          'memberships',
          'organization_audit_logs',
          'organization_command_idempotency',
          'organization_invitations',
          'organizations',
          'users',
        ],
      ],
    );
    expect(tablePrivileges).toEqual([
      acl('auth_audit_logs', true, true, false, false),
      acl('auth_refresh_tokens', true, true, true, false),
      acl('auth_sessions', true, true, true, false),
      acl('invitation_delivery_outbox', true, true, true, false),
      acl('memberships', true, false, false, false),
      acl('organization_audit_logs', true, true, false, false),
      acl('organization_command_idempotency', true, true, false, true),
      acl('organization_invitations', true, true, true, false),
      acl('organizations', true, false, false, false),
      acl('users', true, false, false, false),
    ]);

    const runtime = connection.createQueryRunner();
    await runtime.connect();
    try {
      await runtime.query(`SET ROLE "${runtimeRole}"`);
      await runtime.query(
        `INSERT INTO organization_audit_logs (
          organization_id, event_type, invited_role
         ) VALUES ($1, 'organization.invitation.created', 'member')`,
        [fixture.organization.id],
      );
      expect(
        await runtime.query(
          `SELECT id FROM organization_audit_logs WHERE organization_id = $1`,
          [fixture.organization.id],
        ),
      ).toHaveLength(3);
      await expect(
        runtime.query(`UPDATE organization_audit_logs SET reason = NULL`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query(`DELETE FROM organization_audit_logs`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query(`TRUNCATE organization_audit_logs`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtime.query('RESET ROLE');
      await runtime.release();
    }
  });

  it('revokes pending invitations exactly once when the issuer membership becomes inactive', async () => {
    const fixture = await createFixture('membership-trigger');
    const invitation = await fixture.service.create(
      tenant(fixture),
      { email: 'trigger@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    await connection.query(
      `UPDATE invitation_delivery_outbox SET status = 'dead'
       WHERE invitation_id = $1 AND organization_id = $2`,
      [invitation.id, fixture.organization.id],
    );
    await connection.getRepository(Membership).update(fixture.membership.id, {
      status: MembershipStatus.INACTIVE,
    });
    await connection.getRepository(Membership).update(fixture.membership.id, {
      status: MembershipStatus.INACTIVE,
    });

    const [row] = await connection.query<
      Array<{ status: string; revocation_reason: string }>
    >(
      `SELECT status, revocation_reason FROM organization_invitations WHERE id = $1`,
      [invitation.id],
    );
    expect(row).toEqual({
      status: 'revoked',
      revocation_reason: 'issuer_membership_inactive',
    });
    const [delivery] = await connection.query<Array<{ status: string }>>(
      `SELECT status FROM invitation_delivery_outbox
       WHERE invitation_id = $1 AND organization_id = $2`,
      [invitation.id, fixture.organization.id],
    );
    expect(delivery?.status).toBe('cancelled');
    const [audit] = await connection.query<
      Array<{
        count: string;
        actor_user_id: string | null;
        actor_membership_id: string | null;
        correlation_id: string | null;
      }>
    >(
      `SELECT count(*)::text AS count,
              min(actor_user_id::text) AS actor_user_id,
              min(actor_membership_id::text) AS actor_membership_id,
              min(correlation_id::text) AS correlation_id
       FROM organization_audit_logs
       WHERE invitation_id = $1
         AND event_type = 'organization.invitation.revoked_issuer_membership_inactive'`,
      [invitation.id],
    );
    expect(audit).toEqual({
      count: '1',
      actor_user_id: null,
      actor_membership_id: null,
      correlation_id: null,
    });
  });

  it('revokes pending invitations across organizations exactly once when the issuer user becomes inactive', async () => {
    const fixture = await createFixture('user-trigger');
    const secondOrganization = await connection
      .getRepository(Organization)
      .save(
        connection.getRepository(Organization).create({
          name: 'Invitation user trigger second',
          slug: `user-trigger-second-${randomUUID()}`,
          status: OrganizationStatus.ACTIVE,
        }),
      );
    const secondMembership = await connection.getRepository(Membership).save(
      connection.getRepository(Membership).create({
        userId: fixture.user.id,
        organizationId: secondOrganization.id,
        role: MembershipRole.OWNER,
        status: MembershipStatus.ACTIVE,
      }),
    );
    const secondFixture: Fixture = {
      ...fixture,
      organization: secondOrganization,
      membership: secondMembership,
    };
    const invitations = await Promise.all([
      fixture.service.create(
        tenant(fixture),
        { email: 'user-trigger-one@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
      fixture.service.create(
        tenant(secondFixture),
        { email: 'user-trigger-two@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ]);

    await connection.getRepository(User).update(fixture.user.id, {
      status: UserStatus.INACTIVE,
    });
    await connection.getRepository(User).update(fixture.user.id, {
      status: UserStatus.INACTIVE,
    });

    const rows = await connection.query<
      Array<{ id: string; status: string; revocation_reason: string }>
    >(
      `SELECT id, status, revocation_reason
       FROM organization_invitations WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [invitations.map((invitation) => invitation.id)],
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        invitations.map((invitation) => ({
          id: invitation.id,
          status: 'revoked',
          revocation_reason: 'issuer_user_inactive',
        })),
      ),
    );
    const [{ count }] = await connection.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM organization_audit_logs
       WHERE invitation_id = ANY($1::uuid[])
         AND event_type = 'organization.invitation.revoked_issuer_user_inactive'`,
      [invitations.map((invitation) => invitation.id)],
    );
    expect(count).toBe('2');
  });

  it('keeps the application revoker and database trigger idempotent in one transaction', async () => {
    const fixture = await createFixture('revoker-port');
    const invitation = await fixture.service.create(
      tenant(fixture),
      { email: 'revoker-port@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );

    const revokedCount = await connection.transaction(async (manager) => {
      const revoked = await fixture.service.revokeByIssuerMembership(
        fixture.membership.id,
        {
          actorUserId: fixture.user.id,
          actorMembershipId: fixture.membership.id,
          correlationId: randomUUID(),
          ipAddress: '127.0.0.1',
          userAgent: 'integration revoker',
        },
        manager,
      );
      await manager.getRepository(Membership).update(fixture.membership.id, {
        status: MembershipStatus.INACTIVE,
      });
      return revoked;
    });

    expect(revokedCount).toBe(1);
    const [audit] = await connection.query<
      Array<{
        count: string;
        actor_user_id: string;
        actor_membership_id: string;
        correlation_id: string;
        ip_address: string;
        ip_mask_length: number;
        user_agent: string;
      }>
    >(
      `SELECT count(*)::text AS count,
                min(actor_user_id::text) AS actor_user_id,
                min(actor_membership_id::text) AS actor_membership_id,
                min(correlation_id::text) AS correlation_id,
                min(host(ip_address)) AS ip_address,
                min(masklen(ip_address)) AS ip_mask_length,
                min(user_agent) AS user_agent
       FROM organization_audit_logs
       WHERE invitation_id = $1
         AND event_type = 'organization.invitation.revoked_issuer_membership_inactive'`,
      [invitation.id],
    );
    expect(audit).toMatchObject({
      count: '1',
      actor_user_id: fixture.user.id,
      actor_membership_id: fixture.membership.id,
      ip_address: '127.0.0.1',
      ip_mask_length: 32,
      user_agent: 'integration revoker',
    });
    expect(audit?.correlation_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('preserves D7 without deadlock during concurrent issuance and inactivation', async () => {
    const fixture = await createFixture('d7-race');
    const secondConnection = createIntegrationRuntimeDataSource();
    await secondConnection.initialize();
    const secondService = new InvitationsService(
      secondConnection,
      new OrganizationAuditService(),
      new EnabledInvitationIssuanceReadiness(),
      { currentVersion: () => 2, keyFor: () => Buffer.alloc(32, 10) },
    );
    try {
      const results = await Promise.allSettled([
        secondService.create(
          tenant(fixture),
          { email: 'd7-race@example.com', role: InvitationRole.MEMBER },
          { ipAddress: null, userAgent: null },
        ),
        connection.transaction(async (manager) => {
          await fixture.service.revokeByIssuerMembership(
            fixture.membership.id,
            {
              actorUserId: fixture.user.id,
              actorMembershipId: fixture.membership.id,
              correlationId: randomUUID(),
              ipAddress: null,
              userAgent: 'd7 race',
            },
            manager,
          );
          await manager
            .getRepository(Membership)
            .update(fixture.membership.id, {
              status: MembershipStatus.INACTIVE,
            });
        }),
      ]);
      expect(results[1]?.status).toBe('fulfilled');
      const [{ count }] = await connection.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM organization_invitations
         WHERE invited_by_membership_id = $1 AND status = 'pending'`,
        [fixture.membership.id],
      );
      expect(count).toBe('0');
    } finally {
      await secondConnection.destroy();
    }
  });

  it('avoids reciprocal-invitation deadlocks across two tenants and connections', async () => {
    const first = await createFixture('reciprocal-first');
    const second = await createFixture('reciprocal-second');
    const secondConnection = createIntegrationRuntimeDataSource();
    await secondConnection.initialize();
    const secondService = new InvitationsService(
      secondConnection,
      new OrganizationAuditService(),
      new EnabledInvitationIssuanceReadiness(),
      { currentVersion: () => 2, keyFor: () => Buffer.alloc(32, 12) },
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
      const operations = Promise.all([
        first.service.create(
          tenant(first),
          { email: second.user.email, role: InvitationRole.MEMBER },
          { ipAddress: null, userAgent: null },
        ),
        secondService.create(
          tenant(second),
          { email: first.user.email, role: InvitationRole.MEMBER },
          { ipAddress: null, userAgent: null },
        ),
      ]);
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('reciprocal invitation lock timeout')),
          5_000,
        );
      });
      const results = await Promise.race([operations, timeoutFailure]);
      expect(results).toHaveLength(2);
      expect(results.map(({ state }) => state)).toEqual(['pending', 'pending']);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await secondConnection.destroy();
    }
  });

  it('restarts create when recipient identity appears after pre-resolution', async () => {
    const fixture = await createFixture('recipient-race');
    const recipientUserId = randomUUID();
    const recipientMembershipId = randomUUID();
    const recipientEmail = `recipient-race-${randomUUID()}@example.com`;
    const inserter = connection.createQueryRunner();
    await inserter.connect();
    await inserter.startTransaction();
    let operation: Promise<unknown> | undefined;
    try {
      await inserter.query(
        `INSERT INTO users (id, email, name, status)
         VALUES ($1, $2, 'Racing recipient', 'active')`,
        [recipientUserId, recipientEmail],
      );
      await inserter.query(
        `INSERT INTO memberships (
           id, user_id, organization_id, role, status
         ) VALUES ($1, $2, $3, 'member', 'active')`,
        [recipientMembershipId, recipientUserId, fixture.organization.id],
      );

      operation = fixture.service.create(
        tenant(fixture),
        { email: recipientEmail, role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: 'recipient race' },
      );
      await waitForRuntimeOrganizationLock();
      await inserter.commitTransaction();

      await expect(operation).rejects.toMatchObject({ status: 409 });
      const [{ count }] = await connection.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM organization_invitations
         WHERE organization_id = $1 AND email_normalized = $2`,
        [fixture.organization.id, recipientEmail],
      );
      expect(count).toBe('0');
    } finally {
      if (inserter.isTransactionActive) await inserter.rollbackTransaction();
      await inserter.release();
      if (operation !== undefined) await Promise.allSettled([operation]);
    }
  });

  it('does not revoke invitations for a role change', async () => {
    const fixture = await createFixture('role-change');
    const invitation = await fixture.service.create(
      tenant(fixture),
      { email: 'role@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    await connection.getRepository(Membership).update(fixture.membership.id, {
      role: MembershipRole.ADMIN,
    });
    const [row] = await connection.query<Array<{ status: string }>>(
      `SELECT status FROM organization_invitations WHERE id = $1`,
      [invitation.id],
    );
    expect(row?.status).toBe('pending');
  });

  it('does not let an admin supersede an expired admin invitation', async () => {
    const fixture = await createFixture('admin-preserves-admin');
    const invitation = await fixture.service.create(
      tenant(fixture),
      { email: 'preserved-admin@example.com', role: InvitationRole.ADMIN },
      { ipAddress: null, userAgent: null },
    );
    await connection.query(
      `UPDATE organization_invitations
       SET expires_at = created_at + interval '1 millisecond'
       WHERE id = $1`,
      [invitation.id],
    );
    const adminUser = await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email: `preserving-admin-${randomUUID()}@example.com`,
        name: 'Preserving admin',
        status: UserStatus.ACTIVE,
      }),
    );
    const adminMembership = await connection.getRepository(Membership).save(
      connection.getRepository(Membership).create({
        userId: adminUser.id,
        organizationId: fixture.organization.id,
        role: MembershipRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
    );
    const before = await invitationPersistenceSnapshot(
      fixture.organization.id,
      invitation.id,
    );
    await expect(
      fixture.service.create(
        {
          userId: adminUser.id,
          organizationId: fixture.organization.id,
          membershipId: adminMembership.id,
          role: MembershipRole.ADMIN,
        },
        { email: 'preserved-admin@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await invitationPersistenceSnapshot(
        fixture.organization.id,
        invitation.id,
      ),
    ).toEqual(before);
  });

  it('cancels queued, processing and dead outbox rows while preserving sent and cancelled rows', async () => {
    const fixture = await createFixture('outbox-states');
    const states = [
      'queued',
      'processing',
      'dead',
      'sent',
      'cancelled',
    ] as const;
    const invitations = [] as Array<{
      id: string;
      state: (typeof states)[number];
    }>;
    for (const state of states) {
      const invitation = await fixture.service.create(
        tenant(fixture),
        {
          email: `outbox-${state}@example.com`,
          role: InvitationRole.MEMBER,
        },
        { ipAddress: null, userAgent: null },
      );
      invitations.push({ id: invitation.id, state });
      if (state === 'processing') {
        await connection.query(
          `UPDATE invitation_delivery_outbox
           SET status = 'processing', locked_by = 'worker',
               locked_at = transaction_timestamp(),
               lease_until = transaction_timestamp() + interval '1 minute'
           WHERE invitation_id = $1`,
          [invitation.id],
        );
      } else if (state === 'sent') {
        await connection.query(
          `UPDATE invitation_delivery_outbox
           SET status = 'sent', sent_at = transaction_timestamp()
           WHERE invitation_id = $1`,
          [invitation.id],
        );
      } else if (state === 'cancelled') {
        await connection.query(
          `UPDATE invitation_delivery_outbox
           SET status = 'cancelled', cancelled_at = transaction_timestamp()
           WHERE invitation_id = $1`,
          [invitation.id],
        );
      } else if (state === 'dead') {
        await connection.query(
          `UPDATE invitation_delivery_outbox SET status = 'dead'
           WHERE invitation_id = $1`,
          [invitation.id],
        );
      }
    }

    for (const invitation of invitations) {
      await fixture.service.revoke(tenant(fixture), invitation.id, {
        ipAddress: null,
        userAgent: null,
      });
    }
    const rows = await connection.query<
      Array<{
        invitation_id: string;
        status: string;
        locked_by: string | null;
        locked_at: Date | null;
        lease_until: Date | null;
      }>
    >(
      `SELECT invitation_id, status, locked_by, locked_at, lease_until
       FROM invitation_delivery_outbox
       WHERE invitation_id = ANY($1::uuid[])`,
      [invitations.map((invitation) => invitation.id)],
    );
    for (const row of rows) {
      const original = invitations.find(
        (invitation) => invitation.id === row.invitation_id,
      )?.state;
      expect(row.status).toBe(
        original === 'sent' || original === 'cancelled'
          ? original
          : 'cancelled',
      );
      if (!['sent', 'cancelled'].includes(original ?? '')) {
        expect({
          locked_by: row.locked_by,
          locked_at: row.locked_at,
          lease_until: row.lease_until,
        }).toEqual({ locked_by: null, locked_at: null, lease_until: null });
      }
    }
  });

  it('serializes concurrent actor quota checks without overshoot', async () => {
    const fixture = await createFixture('quota');
    const secondConnection = createIntegrationRuntimeDataSource();
    await secondConnection.initialize();
    const secondService = new InvitationsService(
      secondConnection,
      new OrganizationAuditService(),
      new EnabledInvitationIssuanceReadiness(),
      { currentVersion: () => 2, keyFor: () => Buffer.alloc(32, 8) },
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 11 }, (_, index) =>
        (index % 2 === 0 ? fixture.service : secondService).create(
          tenant(fixture),
          {
            email: `quota-${index}@example.com`,
            role: InvitationRole.MEMBER,
          },
          { ipAddress: null, userAgent: null },
        ),
      ),
    ).finally(() => secondConnection.destroy());
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(10);
    expect(
      attempts.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const [{ count }] = await connection.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM organization_invitations
       WHERE organization_id = $1`,
      [fixture.organization.id],
    );
    expect(count).toBe('10');
    const otherUser = await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email: `quota-other-${randomUUID()}@example.com`,
        name: 'Quota other actor',
        status: UserStatus.ACTIVE,
      }),
    );
    const otherMembership = await connection.getRepository(Membership).save(
      connection.getRepository(Membership).create({
        userId: otherUser.id,
        organizationId: fixture.organization.id,
        role: MembershipRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
    );
    await expect(
      fixture.service.create(
        {
          userId: otherUser.id,
          organizationId: fixture.organization.id,
          membershipId: otherMembership.id,
          role: MembershipRole.ADMIN,
        },
        { email: 'quota-other-actor@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).resolves.toMatchObject({ state: 'pending' });
  });

  it('enforces the 3-per-email window, counts revoked rows, and isolates organizations', async () => {
    const first = await createFixture('email-quota-first');
    const second = await createFixture('email-quota-second');
    for (let index = 0; index < 3; index += 1) {
      const invitation = await first.service.create(
        tenant(first),
        { email: 'same@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      );
      await first.service.revoke(tenant(first), invitation.id, {
        ipAddress: null,
        userAgent: null,
      });
    }
    await expect(
      first.service.create(
        tenant(first),
        { email: 'same@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      second.service.create(
        tenant(second),
        { email: 'same@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).resolves.toMatchObject({ email: 'same@example.com' });
  });

  it('combines create and replace in the actor 10-per-15-minute quota', async () => {
    const fixture = await createFixture('combined-quota');
    const invitations = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        fixture.service.create(
          tenant(fixture),
          {
            email: `combined-${index}@example.com`,
            role: InvitationRole.MEMBER,
          },
          { ipAddress: null, userAgent: null },
        ),
      ),
    );
    await expect(
      fixture.service.replace(
        tenant(fixture),
        invitations[0].id,
        randomUUID(),
        { ipAddress: null, userAgent: null },
      ),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      fixture.service.create(
        tenant(fixture),
        { email: 'combined-over@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('enforces the organization 100-per-day quota independently of pending state', async () => {
    const fixture = await createFixture('organization-quota');
    await insertGeneratedInvitations(fixture, 100, {
      prefix: 'organization-window',
      status: 'revoked',
      createdInterval: '16 minutes',
      expiresInterval: '7 days',
    });
    await expect(
      fixture.service.create(
        tenant(fixture),
        { email: 'organization-over@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('enforces 100 nonexpired pending invitations and lets revoke bypass quotas', async () => {
    const fixture = await createFixture('pending-quota');
    const ids = await insertGeneratedInvitations(fixture, 100, {
      prefix: 'pending-window',
      status: 'pending',
      createdInterval: '25 hours',
      expiresInterval: '1 day',
    });
    await expect(
      fixture.service.create(
        tenant(fixture),
        { email: 'pending-over@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      fixture.service.revoke(tenant(fixture), ids[0], {
        ipAddress: null,
        userAgent: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('uses transaction_timestamp inclusively at quota boundaries', async () => {
    const fixture = await createFixture('quota-boundary');
    const [row] = await connection.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO organization_invitations (
          organization_id, email_normalized, role, status, expires_at,
          invited_by_membership_id, token_key_version, token_nonce, created_at,
          revoked_at, revocation_reason
        ) VALUES
          ($1, 'boundary-before@example.com', 'member', 'revoked',
            transaction_timestamp() + interval '1 day', $2, 2, $3,
            transaction_timestamp() - interval '15 minutes' - interval '1 millisecond',
            transaction_timestamp(), 'manual'),
          ($1, 'boundary-exact@example.com', 'member', 'revoked',
            transaction_timestamp() + interval '1 day', $2, 2, $4,
            transaction_timestamp() - interval '15 minutes',
            transaction_timestamp(), 'manual'),
          ($1, 'boundary-after@example.com', 'member', 'revoked',
            transaction_timestamp() + interval '1 day', $2, 2, $5,
            transaction_timestamp() - interval '15 minutes' + interval '1 millisecond',
            transaction_timestamp(), 'manual')`,
        [
          fixture.organization.id,
          fixture.membership.id,
          Buffer.alloc(32, 21).toString('base64url'),
          Buffer.alloc(32, 22).toString('base64url'),
          Buffer.alloc(32, 23).toString('base64url'),
        ],
      );
      return manager.query<Array<{ actor_count: string }>>(
        `SELECT count(*)::text AS actor_count
         FROM organization_invitations
         WHERE organization_id = $1 AND invited_by_membership_id = $2
           AND created_at >= transaction_timestamp() - interval '15 minutes'`,
        [fixture.organization.id, fixture.membership.id],
      );
    });
    expect(row?.actor_count).toBe('2');
    const [otherBoundaries] = await connection.transaction((manager) =>
      manager.query<Array<{ day_count: string; pending_count: string }>>(
        `SELECT
          (SELECT count(*)::text FROM unnest(ARRAY[
            transaction_timestamp() - interval '24 hours' - interval '1 millisecond',
            transaction_timestamp() - interval '24 hours',
            transaction_timestamp() - interval '24 hours' + interval '1 millisecond'
          ]) AS created_at
          WHERE created_at >= transaction_timestamp() - interval '24 hours') AS day_count,
          (SELECT count(*)::text FROM unnest(ARRAY[
            transaction_timestamp() - interval '1 millisecond',
            transaction_timestamp(),
            transaction_timestamp() + interval '1 millisecond'
          ]) AS expires_at
          WHERE expires_at > transaction_timestamp()) AS pending_count`,
      ),
    );
    expect(otherBoundaries).toEqual({ day_count: '2', pending_count: '1' });
  });

  it('excludes expired rows from pending quota while retaining them in time windows', async () => {
    const fixture = await createFixture('expired-window');
    await connection.query(
      `INSERT INTO organization_invitations (
        organization_id, email_normalized, role, status, expires_at,
        invited_by_membership_id, token_key_version, token_nonce, created_at
      ) VALUES ($1, 'expired-window@example.com', 'member', 'pending',
        transaction_timestamp() - interval '1 minute', $2, 2, $3,
        transaction_timestamp() - interval '1 hour')`,
      [
        fixture.organization.id,
        fixture.membership.id,
        Buffer.alloc(32, 31).toString('base64url'),
      ],
    );
    const [before] = await connection.query<
      Array<{ window_count: string; pending_count: string }>
    >(
      `SELECT
        count(*) FILTER (WHERE created_at >= transaction_timestamp() - interval '24 hours')::text AS window_count,
        count(*) FILTER (WHERE status = 'pending' AND expires_at > transaction_timestamp())::text AS pending_count
       FROM organization_invitations WHERE organization_id = $1`,
      [fixture.organization.id],
    );
    expect(before).toEqual({ window_count: '1', pending_count: '0' });
    await expect(
      fixture.service.create(
        tenant(fixture),
        { email: 'expired-window@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).resolves.toMatchObject({ state: 'pending' });
  });

  it('derives effective state from PostgreSQL rather than the application clock', async () => {
    const fixture = await createFixture('database-clock');
    const invitation = await fixture.service.create(
      tenant(fixture),
      { email: 'database-clock@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    await connection.query(
      `UPDATE organization_invitations
       SET expires_at = created_at + interval '1 millisecond'
       WHERE id = $1`,
      [invitation.id],
    );
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    try {
      await expect(
        fixture.service.get(tenant(fixture), invitation.id),
      ).resolves.toMatchObject({ state: 'expired' });
    } finally {
      now.mockRestore();
    }
  });

  it('replays replacement responses without duplicate invitation, audit, or outbox rows', async () => {
    const fixture = await createFixture('idempotency');
    const invitation = await fixture.service.create(
      tenant(fixture),
      { email: 'idempotency@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const key = randomUUID();

    const first = await fixture.service.replace(
      tenant(fixture),
      invitation.id,
      key,
      { ipAddress: null, userAgent: null },
    );
    const replay = await fixture.service.replace(
      tenant(fixture),
      invitation.id,
      key,
      { ipAddress: null, userAgent: null },
    );

    expect(first.replayed).toBe(false);
    expect(Object.keys(first.result).sort()).toEqual([
      'deliveryStatusAtCreation',
      'invitationId',
      'previousInvitationId',
      'stateAtCreation',
    ]);
    await connection.query(
      `UPDATE organization_invitations
       SET updated_at = transaction_timestamp() + interval '1 hour'
       WHERE id = $1`,
      [first.view.id],
    );
    await connection.query(
      `UPDATE invitation_delivery_outbox SET status = 'dead'
       WHERE invitation_id = $1`,
      [first.view.id],
    );
    const replayAfterMutation = await fixture.service.replace(
      tenant(fixture),
      invitation.id,
      key,
      { ipAddress: null, userAgent: null },
    );
    expect(replay).toEqual({
      view: first.view,
      result: first.result,
      replayed: true,
    });
    expect(replayAfterMutation).toEqual({
      view: first.view,
      result: first.result,
      replayed: true,
    });
    const [persistedResult] = await connection.query<
      Array<{
        previousInvitationId: string;
        invitationId: string;
        stateAtCreation: string;
        deliveryStatusAtCreation: string;
      }>
    >(
      `SELECT
        result_previous_invitation_id AS "previousInvitationId",
        result_invitation_id AS "invitationId",
        result_state_at_creation AS "stateAtCreation",
        result_delivery_status_at_creation AS "deliveryStatusAtCreation"
       FROM organization_command_idempotency
       WHERE organization_id = $1 AND idempotency_key = $2`,
      [fixture.organization.id, key],
    );
    expect(persistedResult).toEqual(first.result);
    const [{ invitations, outbox, replacements, idempotency }] =
      await connection.query<
        Array<{
          invitations: string;
          outbox: string;
          replacements: string;
          idempotency: string;
        }>
      >(
        `SELECT
          (SELECT count(*)::text FROM organization_invitations
           WHERE organization_id = $1 AND email_normalized = $2) AS invitations,
          (SELECT count(*)::text FROM invitation_delivery_outbox o
           JOIN organization_invitations i
             ON i.id = o.invitation_id AND i.organization_id = o.organization_id
           WHERE i.organization_id = $1 AND i.email_normalized = $2) AS outbox,
          (SELECT count(*)::text FROM organization_audit_logs
           WHERE organization_id = $1
             AND event_type = 'organization.invitation.replaced') AS replacements,
          (SELECT count(*)::text FROM organization_command_idempotency
           WHERE organization_id = $1 AND idempotency_key = $3) AS idempotency`,
        [fixture.organization.id, 'idempotency@example.com', key],
      );
    expect({ invitations, outbox, replacements, idempotency }).toEqual({
      invitations: '2',
      outbox: '2',
      replacements: '1',
      idempotency: '1',
    });
  });

  it('serializes same-organization replay on the organization lock with exactly one replacement', async () => {
    const fixture = await createFixture('idempotency-concurrent-replay');
    const invitation = await fixture.service.create(
      tenant(fixture),
      {
        email: 'idempotency-concurrent-replay@example.com',
        role: InvitationRole.MEMBER,
      },
      { ipAddress: null, userAgent: null },
    );
    const before = await replacementArtifactCounts(fixture.organization.id);
    const key = randomUUID();
    const gate = connection.createQueryRunner();
    await gate.connect();
    await gate.startTransaction();
    let operations: Promise<InvitationReplacementExecution[]> | undefined;
    try {
      await gate.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [fixture.organization.id],
      );
      operations = Promise.all([
        fixture.service.replace(tenant(fixture), invitation.id, key, {
          ipAddress: null,
          userAgent: 'concurrent replay first',
        }),
        fixture.service.replace(tenant(fixture), invitation.id, key, {
          ipAddress: null,
          userAgent: 'concurrent replay second',
        }),
      ]);
      await waitForRuntimeOrganizationLock(2);
      await gate.commitTransaction();
      const results = await operations;
      expect(results.map(({ replayed }) => replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(new Set(results.map(({ view }) => view.id)).size).toBe(1);
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
      if (operations !== undefined) await Promise.allSettled([operations]);
    }
    expect(
      artifactDelta(
        before,
        await replacementArtifactCounts(fixture.organization.id),
      ),
    ).toEqual({ invitations: 1, outbox: 1, audit: 1, idempotency: 1 });
  });

  it('serializes a reused key with a different fingerprint and leaves no losing effects', async () => {
    const fixture = await createFixture('idempotency-concurrent-conflict');
    const firstInvitation = await fixture.service.create(
      tenant(fixture),
      { email: 'concurrent-first@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const secondInvitation = await fixture.service.create(
      tenant(fixture),
      { email: 'concurrent-second@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const before = await replacementArtifactCounts(fixture.organization.id);
    const key = randomUUID();
    const gate = connection.createQueryRunner();
    await gate.connect();
    await gate.startTransaction();
    let operations:
      PromiseSettledResult<InvitationReplacementExecution>[] | undefined;
    try {
      await gate.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [fixture.organization.id],
      );
      const pending = [
        fixture.service.replace(tenant(fixture), firstInvitation.id, key, {
          ipAddress: null,
          userAgent: 'concurrent conflict first',
        }),
        fixture.service.replace(tenant(fixture), secondInvitation.id, key, {
          ipAddress: null,
          userAgent: 'concurrent conflict second',
        }),
      ];
      await waitForRuntimeOrganizationLock(2);
      await gate.commitTransaction();
      operations = await Promise.allSettled(pending);
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
    }
    if (operations === undefined) {
      throw new Error('Concurrent replacements did not complete.');
    }
    const fulfilled = operations.filter(
      (
        result,
      ): result is PromiseFulfilledResult<InvitationReplacementExecution> =>
        result.status === 'fulfilled',
    );
    const rejected = operations.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.replayed).toBe(false);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409 });
    expect(
      artifactDelta(
        before,
        await replacementArtifactCounts(fixture.organization.id),
      ),
    ).toEqual({ invitations: 1, outbox: 1, audit: 1, idempotency: 1 });
  });

  it('does not serialize the same idempotency key across organizations', async () => {
    const first = await createFixture('idempotency-independent-first');
    const second = await createFixture('idempotency-independent-second');
    const firstInvitation = await first.service.create(
      tenant(first),
      { email: 'independent-first@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const secondInvitation = await second.service.create(
      tenant(second),
      { email: 'independent-second@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const firstBefore = await replacementArtifactCounts(first.organization.id);
    const secondBefore = await replacementArtifactCounts(
      second.organization.id,
    );
    const key = randomUUID();
    const gate = connection.createQueryRunner();
    await gate.connect();
    await gate.startTransaction();
    let firstOperation: Promise<InvitationReplacementExecution> | undefined;
    let secondOperation: Promise<InvitationReplacementExecution> | undefined;
    try {
      await gate.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [first.organization.id],
      );
      firstOperation = first.service.replace(
        tenant(first),
        firstInvitation.id,
        key,
        { ipAddress: null, userAgent: 'blocked organization' },
      );
      await waitForRuntimeOrganizationLock();
      secondOperation = second.service.replace(
        tenant(second),
        secondInvitation.id,
        key,
        { ipAddress: null, userAgent: 'independent organization' },
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutFailure = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('independent organization was serialized')),
            5_000,
          );
        });
        await expect(
          Promise.race([secondOperation, timeoutFailure]),
        ).resolves.toMatchObject({ replayed: false });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      await gate.commitTransaction();
      await expect(firstOperation).resolves.toMatchObject({ replayed: false });
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
      await Promise.allSettled(
        [firstOperation, secondOperation].filter(
          (operation): operation is Promise<InvitationReplacementExecution> =>
            operation !== undefined,
        ),
      );
    }
    expect(
      artifactDelta(
        firstBefore,
        await replacementArtifactCounts(first.organization.id),
      ),
    ).toEqual({ invitations: 1, outbox: 1, audit: 1, idempotency: 1 });
    expect(
      artifactDelta(
        secondBefore,
        await replacementArtifactCounts(second.organization.id),
      ),
    ).toEqual({ invitations: 1, outbox: 1, audit: 1, idempotency: 1 });
  });

  it('revalidates replay visibility after owner demotion without rereading mutable results', async () => {
    const fixture = await createFixture('replay-demotion');
    const member = await fixture.service.create(
      tenant(fixture),
      { email: 'replay-member@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const admin = await fixture.service.create(
      tenant(fixture),
      { email: 'replay-admin@example.com', role: InvitationRole.ADMIN },
      { ipAddress: null, userAgent: null },
    );
    const memberKey = randomUUID();
    const adminKey = randomUUID();
    const memberFirst = await fixture.service.replace(
      tenant(fixture),
      member.id,
      memberKey,
      { ipAddress: null, userAgent: null },
    );
    await fixture.service.replace(tenant(fixture), admin.id, adminKey, {
      ipAddress: null,
      userAgent: null,
    });
    await connection.getRepository(Membership).update(fixture.membership.id, {
      role: MembershipRole.ADMIN,
    });

    await expect(
      fixture.service.replace(tenant(fixture), admin.id, adminKey, {
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      fixture.service.replace(tenant(fixture), member.id, memberKey, {
        ipAddress: null,
        userAgent: null,
      }),
    ).resolves.toEqual({
      view: memberFirst.view,
      result: memberFirst.result,
      replayed: true,
    });
  });

  it('cleans expired idempotency rows only inside the actor tenant', async () => {
    const first = await createFixture('idempotency-cleanup-first');
    const second = await createFixture('idempotency-cleanup-second');
    const firstInvitation = await first.service.create(
      tenant(first),
      { email: 'cleanup-first@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const secondInvitation = await second.service.create(
      tenant(second),
      { email: 'cleanup-second@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    await first.service.replace(tenant(first), firstInvitation.id, firstKey, {
      ipAddress: null,
      userAgent: null,
    });
    await second.service.replace(
      tenant(second),
      secondInvitation.id,
      secondKey,
      { ipAddress: null, userAgent: null },
    );
    await connection.query(
      `UPDATE organization_command_idempotency
       SET created_at = transaction_timestamp() - interval '31 days',
           expires_at = transaction_timestamp() - interval '1 day'
       WHERE idempotency_key = ANY($1::uuid[])`,
      [[firstKey, secondKey]],
    );
    const trigger = await first.service.create(
      tenant(first),
      { email: 'cleanup-trigger@example.com', role: InvitationRole.MEMBER },
      { ipAddress: null, userAgent: null },
    );
    await first.service.replace(tenant(first), trigger.id, randomUUID(), {
      ipAddress: null,
      userAgent: null,
    });
    const rows = await connection.query<Array<{ idempotency_key: string }>>(
      `SELECT idempotency_key FROM organization_command_idempotency
       WHERE idempotency_key = ANY($1::uuid[]) ORDER BY idempotency_key`,
      [[firstKey, secondKey]],
    );
    expect(rows.map(({ idempotency_key }) => idempotency_key)).toEqual([
      secondKey,
    ]);
  });

  it('roundtrips PostgreSQL epoch milliseconds used by the token codec', async () => {
    const [row] = await connection.query<
      Array<{ value: Date; epoch_ms: string }>
    >(
      `SELECT value,
              trunc(extract(epoch FROM value) * 1000)::bigint::text AS epoch_ms
       FROM (VALUES (
         date_trunc('milliseconds', transaction_timestamp()) + interval '7 days'
       )) AS timestamp_value(value)`,
    );
    expect(row?.value.getTime().toString()).toBe(row?.epoch_ms);
  });

  async function invitationTableNames(): Promise<string[]> {
    const rows = await connection.query<Array<{ name: string }>>(`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN (
        'organization_invitations', 'organization_audit_logs',
        'organization_command_idempotency', 'invitation_delivery_outbox'
      ) ORDER BY tablename
    `);
    return rows.map((row) => row.name);
  }

  async function replacementArtifactCounts(organizationId: string): Promise<{
    invitations: number;
    outbox: number;
    audit: number;
    idempotency: number;
  }> {
    const [row] = await connection.query<
      Array<{
        invitations: number;
        outbox: number;
        audit: number;
        idempotency: number;
      }>
    >(
      `SELECT
         (SELECT count(*)::int FROM organization_invitations
          WHERE organization_id = $1) AS invitations,
         (SELECT count(*)::int FROM invitation_delivery_outbox
          WHERE organization_id = $1) AS outbox,
         (SELECT count(*)::int FROM organization_audit_logs
          WHERE organization_id = $1
            AND event_type = 'organization.invitation.replaced') AS audit,
         (SELECT count(*)::int FROM organization_command_idempotency
          WHERE organization_id = $1) AS idempotency`,
      [organizationId],
    );
    if (row === undefined) throw new Error('Missing replacement count row.');
    return row;
  }

  function artifactDelta(
    before: Awaited<ReturnType<typeof replacementArtifactCounts>>,
    after: Awaited<ReturnType<typeof replacementArtifactCounts>>,
  ): Awaited<ReturnType<typeof replacementArtifactCounts>> {
    return {
      invitations: after.invitations - before.invitations,
      outbox: after.outbox - before.outbox,
      audit: after.audit - before.audit,
      idempotency: after.idempotency - before.idempotency,
    };
  }

  async function invitationPersistenceSnapshot(
    organizationId: string,
    invitationId: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await connection.query<Array<Record<string, unknown>>>(
      `SELECT i.status, i.revoked_at::text, i.revocation_reason,
              i.superseded_by_invitation_id, i.updated_at::text,
              o.status AS outbox_status, o.cancelled_at::text,
              (SELECT count(*)::text FROM organization_audit_logs a
               WHERE a.organization_id = i.organization_id) AS audit_count,
              (SELECT count(*)::text FROM organization_invitations same_email
               WHERE same_email.organization_id = i.organization_id
                 AND same_email.email_normalized = i.email_normalized) AS invitation_count
       FROM organization_invitations i
       JOIN invitation_delivery_outbox o
         ON o.invitation_id = i.id AND o.organization_id = i.organization_id
       WHERE i.organization_id = $1 AND i.id = $2`,
      [organizationId, invitationId],
    );
    if (row === undefined) throw new Error('Missing invitation snapshot.');
    return row;
  }

  async function insertGeneratedInvitations(
    fixture: Fixture,
    count: number,
    options: {
      prefix: string;
      status: 'pending' | 'revoked';
      createdInterval: string;
      expiresInterval: string;
    },
  ): Promise<string[]> {
    const rows = await connection.query<Array<{ id: string }>>(
      `INSERT INTO organization_invitations (
        organization_id, email_normalized, role, status, expires_at,
        invited_by_membership_id, token_key_version, token_nonce,
        created_at, updated_at, revoked_at, revocation_reason
      ) SELECT $1, $3 || '-' || series || '@example.com', 'member',
        $6::organization_invitation_status_enum,
        transaction_timestamp() + $5::interval, $2, 2,
        rtrim(translate(encode(digest($3 || series::text, 'sha256'), 'base64'), '+/', '-_'), '='),
        transaction_timestamp() - $4::interval, transaction_timestamp(),
        CASE WHEN $6 = 'revoked' THEN transaction_timestamp() ELSE NULL END,
        CASE WHEN $6 = 'revoked'
          THEN 'manual'::organization_invitation_revocation_reason_enum ELSE NULL END
      FROM generate_series(1, $7::integer) AS series
      RETURNING id`,
      [
        fixture.organization.id,
        fixture.membership.id,
        `${options.prefix}-${randomUUID()}`,
        options.createdInterval,
        options.expiresInterval,
        options.status,
        count,
      ],
    );
    return rows.map((row) => row.id);
  }

  async function createFixture(suffix: string): Promise<Fixture> {
    const user = await connection.getRepository(User).save(
      connection.getRepository(User).create({
        email: `${suffix}-${randomUUID()}@example.com`,
        name: `Invitation ${suffix}`,
        status: UserStatus.ACTIVE,
      }),
    );
    const organization = await connection.getRepository(Organization).save(
      connection.getRepository(Organization).create({
        name: `Invitation ${suffix}`,
        slug: `${suffix}-${randomUUID()}`,
        status: OrganizationStatus.ACTIVE,
      }),
    );
    const membership = await connection.getRepository(Membership).save(
      connection.getRepository(Membership).create({
        userId: user.id,
        organizationId: organization.id,
        role: MembershipRole.OWNER,
        status: MembershipStatus.ACTIVE,
      }),
    );
    return {
      user,
      organization,
      membership,
      service: new InvitationsService(
        runtimeConnection,
        new OrganizationAuditService(),
        new EnabledInvitationIssuanceReadiness(),
        {
          currentVersion: () => 2,
          keyFor: () => Buffer.alloc(32, 7),
        },
      ),
    };
  }

  async function waitForRuntimeOrganizationLock(
    expectedBlocked = 1,
  ): Promise<void> {
    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE;
    if (runtimeRole === undefined) {
      throw new Error('Missing test runtime role.');
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [{ blocked }] = await connection.query<Array<{ blocked: number }>>(
        `SELECT count(*)::int AS blocked
         FROM pg_stat_activity
         WHERE usename = $1 AND wait_event_type = 'Lock'
           AND query LIKE '%app_private.lock_invitation_context%'`,
        [runtimeRole],
      );
      if (blocked >= expectedBlocked) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('runtime create did not reach the organization lock');
  }

  function acl(
    table_name: string,
    can_select: boolean,
    can_insert: boolean,
    can_update: boolean,
    can_delete: boolean,
  ) {
    return { table_name, can_select, can_insert, can_update, can_delete };
  }

  function tenant(fixture: Fixture) {
    return {
      userId: fixture.user.id,
      organizationId: fixture.organization.id,
      membershipId: fixture.membership.id,
      role: fixture.membership.role,
    };
  }
});
