/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PasswordCredentialsService } from '../src/modules/credentials/services/password-credentials.service';
import { InvitationDeliveryWorkerService } from '../src/modules/invitations/delivery/invitation-delivery-worker.service';
import { InvitationEmailDeliveryPort } from '../src/modules/invitations/delivery/invitation-email-delivery.port';
import { InvitationEmailV1Renderer } from '../src/modules/invitations/delivery/invitation-email-v1.renderer';
import { InvitationWorkerObservability } from '../src/modules/invitations/delivery/invitation-worker-observability.service';
import { InvitationDeliveryOutbox } from '../src/modules/invitations/entities/invitation-delivery-outbox.entity';
import { OrganizationInvitation } from '../src/modules/invitations/entities/organization-invitation.entity';
import {
  InvitationDeliveryEventType,
  InvitationDeliveryStatus,
  InvitationRole,
  InvitationStatus,
} from '../src/modules/invitations/enums/invitation.enums';
import { ConfiguredInvitationAcceptanceReadiness } from '../src/modules/invitations/ports/invitation-acceptance-readiness.port';
import { OperationalInvitationAcceptanceReadiness } from '../src/modules/invitations/ports/invitation-acceptance-readiness.port';
import { OperationalInvitationActivationReadiness } from '../src/modules/invitations/ports/invitation-activation-readiness.port';
import { EnabledInvitationIssuanceReadiness } from '../src/modules/invitations/ports/invitation-issuance-readiness.port';
import { InvitationTokenKeyring } from '../src/modules/invitations/ports/invitation-token-keyring.port';
import { InvitationAcceptanceService } from '../src/modules/invitations/services/invitation-acceptance.service';
import { InvitationActivationHashCapacity } from '../src/modules/invitations/services/invitation-activation-hash-capacity.service';
import { InvitationActivationService } from '../src/modules/invitations/services/invitation-activation.service';
import { InvitationActivationObservability } from '../src/modules/invitations/services/invitation-activation-observability.service';
import { InvitationAcceptanceRateLimiter } from '../src/modules/invitations/services/invitation-acceptance-rate-limiter.service';
import { InvitationTokenCodec } from '../src/modules/invitations/services/invitation-token-codec.service';
import { InvitationsService } from '../src/modules/invitations/services/invitations.service';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { OrganizationAuditService } from '../src/modules/organization-audit/services/organization-audit.service';
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

describe('Invitation acceptance and delivery database smoke', () => {
  let owner: DataSource;
  let runtime: DataSource;
  let secondRuntime: DataSource;
  const keyring: InvitationTokenKeyring = {
    currentVersion: () => 2,
    keyFor: (version) => {
      if (version !== 2) throw new Error('missing test key');
      return Buffer.alloc(32, 0x27);
    },
  };
  const codec = new InvitationTokenCodec(keyring);

  beforeAll(async () => {
    configureIntegrationRuntimeEnvironment();
    owner = createIntegrationDataSource();
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    runtime = createIntegrationRuntimeDataSource();
    await runtime.initialize();
    secondRuntime = createIntegrationRuntimeDataSource();
    await secondRuntime.initialize();
  });

  afterAll(async () => {
    if (secondRuntime?.isInitialized) await secondRuntime.destroy();
    if (runtime?.isInitialized) await runtime.destroy();
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  it('installs the hardened membership function and preserves runtime least privilege', async () => {
    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE as string;
    const [row] = await owner.query<
      Array<{
        securityDefiner: boolean;
        config: string[];
        canExecute: boolean;
        canInsert: boolean;
        canUpdate: boolean;
      }>
    >(
      `SELECT routine.prosecdef AS "securityDefiner",
              routine.proconfig AS config,
              has_function_privilege(
                $1,
                'app_private.apply_existing_user_invitation_membership(uuid,uuid)',
                'EXECUTE'
              ) AS "canExecute",
              has_table_privilege($1, 'memberships', 'INSERT') AS "canInsert",
              has_table_privilege($1, 'memberships', 'UPDATE') AS "canUpdate"
       FROM pg_proc AS routine
       WHERE routine.oid =
         'app_private.apply_existing_user_invitation_membership(uuid,uuid)'::regprocedure`,
      [runtimeRole],
    );
    expect(row).toMatchObject({
      securityDefiner: true,
      canExecute: true,
      canInsert: false,
      canUpdate: false,
    });
    expect(row?.config).toContain(
      'search_path=pg_catalog, app_private, pg_temp',
    );
  });

  it('requires only distinct key versions from pending unexpired invitations', async () => {
    await owner.query(
      `UPDATE organization_invitations
       SET status = 'revoked', revoked_at = transaction_timestamp(),
           revocation_reason = 'manual', updated_at = transaction_timestamp()
       WHERE status = 'pending'`,
    );
    const fixture = await createFixture('readiness');
    const pending = await createInvitation(fixture, 'pending-key@example.com');
    const secondPending = await createInvitation(
      fixture,
      'second-pending-key@example.com',
    );
    const revoked = await createInvitation(fixture, 'revoked-key@example.com');
    const expired = await createInvitation(fixture, 'expired-key@example.com');
    const accepted = await createInvitation(fixture, fixture.user.email);
    const acceptedMembership = await owner.getRepository(Membership).save(
      owner.getRepository(Membership).create({
        userId: fixture.user.id,
        organizationId: fixture.organization.id,
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
      }),
    );
    await owner.query(
      `UPDATE organization_invitations SET token_key_version = 7 WHERE id = $1`,
      [pending.id],
    );
    await owner.query(
      `UPDATE organization_invitations SET token_key_version = 8 WHERE id = $1`,
      [secondPending.id],
    );
    await owner.query(
      `UPDATE organization_invitations
       SET token_key_version = 91, status = 'revoked',
           revoked_at = transaction_timestamp(), revocation_reason = 'manual'
       WHERE id = $1`,
      [revoked.id],
    );
    await owner.query(
      `UPDATE organization_invitations
       SET token_key_version = 92,
           created_at = transaction_timestamp() - interval '8 days',
           expires_at = transaction_timestamp() - interval '1 day'
       WHERE id = $1`,
      [expired.id],
    );
    await owner.query(
      `UPDATE organization_invitations
       SET token_key_version = 93, status = 'accepted',
           accepted_by_user_id = $2, resulting_membership_id = $3,
           accepted_at = transaction_timestamp()
       WHERE id = $1`,
      [accepted.id, fixture.user.id, acceptedMembership.id],
    );
    const keys = new Map<number, Buffer>([[7, Buffer.alloc(32, 7)]]);
    const readiness = new OperationalInvitationAcceptanceReadiness(
      true,
      1,
      {
        currentVersion: () => 999,
        keyFor: (version) => {
          const key = keys.get(version);
          if (key === undefined) throw new Error('missing');
          return key;
        },
      },
      runtime,
    );
    await expect(readiness.assertReady()).rejects.toMatchObject({
      status: 503,
    });
    keys.set(8, Buffer.alloc(32, 8));
    await expect(readiness.assertReady()).resolves.toBeUndefined();
  });

  it('accepts atomically, records one allowlisted result, and replays without writes', async () => {
    const fixture = await createFixture('atomic');
    const invitation = await createInvitation(fixture, fixture.user.email);
    const token = issue(invitation);
    const service = acceptanceService();

    const first = await service.accept(token, fixture.user.id, {
      ipAddress: null,
      userAgent: 'integration',
    });
    const replay = await service.accept(token, fixture.user.id, {
      ipAddress: null,
      userAgent: 'integration replay',
    });

    expect(replay).toEqual(first);
    const [state] = await owner.query<
      Array<{ status: string; membershipResult: string; auditCount: number }>
    >(
      `SELECT invitation.status,
              max(audit.membership_result) AS "membershipResult",
              count(audit.id)::int AS "auditCount"
       FROM organization_invitations AS invitation
       LEFT JOIN organization_audit_logs AS audit
         ON audit.invitation_id = invitation.id
        AND audit.event_type = 'organization.invitation.accepted'
       WHERE invitation.id = $1
       GROUP BY invitation.status`,
      [invitation.id],
    );
    expect(state).toEqual({
      status: 'accepted',
      membershipResult: 'membership_created',
      auditCount: 1,
    });
  });

  it('validates HMAC before replay and rejects unavailable tokens without scoped writes', async () => {
    const fixture = await createFixture('replay-hmac');
    const otherUser = await createFixture('replay-hmac-other');
    const invitation = await createInvitation(fixture, fixture.user.email);
    const token = issue(invitation);
    const service = acceptanceService();
    const accepted = await service.accept(token, fixture.user.id, {
      ipAddress: null,
      userAgent: 'integration first acceptance',
    });
    const userIds = [fixture.user.id, otherUser.user.id];
    const baseline = await acceptanceState(invitation, userIds);

    await expect(
      service.accept(token, fixture.user.id, {
        ipAddress: null,
        userAgent: 'integration valid replay',
      }),
    ).resolves.toEqual(accepted);
    await expect(acceptanceState(invitation, userIds)).resolves.toEqual(
      baseline,
    );

    const [invitationId, , , mac] = token.split('.');
    const invalidTokens = [
      `${invitationId}.2.1.${tamperMac(mac)}`,
      `${invitationId}.3.1.${mac}`,
      `${invitationId}.2.2.${mac}`,
      new InvitationTokenCodec({
        currentVersion: () => 2,
        keyFor: () => Buffer.alloc(32, 0x71),
      }).issue(tokenFields(invitation)),
    ];
    const unavailableKeyService = acceptanceService({
      currentVersion: () => 2,
      keyFor: () => {
        throw new Error('missing accepted invitation key');
      },
    });

    for (const invalidToken of invalidTokens) {
      await expectUnavailable(
        service,
        invalidToken,
        fixture.user.id,
        invitation,
        userIds,
        baseline,
      );
    }
    await expectUnavailable(
      unavailableKeyService,
      token,
      fixture.user.id,
      invitation,
      userIds,
      baseline,
    );

    for (const invalidToken of [token, ...invalidTokens.slice(0, 3)]) {
      await expectUnavailable(
        service,
        invalidToken,
        otherUser.user.id,
        invitation,
        userIds,
        baseline,
      );
    }
  });

  it('serializes accept x accept and leaves exactly one audit event', async () => {
    const fixture = await createFixture('concurrent');
    const invitation = await createInvitation(fixture, fixture.user.email);
    const token = issue(invitation);
    const firstService = acceptanceService();
    const secondService = acceptanceService();
    const results = await Promise.all([
      firstService.accept(token, fixture.user.id, {
        ipAddress: null,
        userAgent: null,
      }),
      secondService.accept(token, fixture.user.id, {
        ipAddress: null,
        userAgent: null,
      }),
    ]);
    expect(results[0]).toEqual(results[1]);
    const [count] = await owner.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM organization_audit_logs
       WHERE invitation_id = $1
         AND event_type = 'organization.invitation.accepted'`,
      [invitation.id],
    );
    expect(count?.count).toBe(1);
  });

  it('rejects a different user and cannot create a cross-tenant membership', async () => {
    const recipient = await createFixture('recipient');
    const attacker = await createFixture('attacker');
    const invitation = await createInvitation(recipient, recipient.user.email);
    await expect(
      acceptanceService().accept(issue(invitation), attacker.user.id, {
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const [row] = await owner.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM memberships
       WHERE user_id = $1 AND organization_id = $2`,
      [attacker.user.id, recipient.organization.id],
    );
    expect(row?.count).toBe(0);
  });

  it('installs a non-strict hardened activation function with exact runtime execute', async () => {
    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE as string;
    const [row] = await owner.query<
      Array<{
        securityDefiner: boolean;
        isStrict: boolean;
        config: string[];
        runtimeExecute: boolean;
        publicExecute: boolean;
        insertUsers: boolean;
        insertMemberships: boolean;
      }>
    >(
      `SELECT routine.prosecdef AS "securityDefiner",
              routine.proisstrict AS "isStrict", routine.proconfig AS config,
              has_function_privilege(
                $1,
                'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
                'EXECUTE'
              ) AS "runtimeExecute",
              COALESCE((
                SELECT bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')
                FROM aclexplode(routine.proacl) AS acl
              ), false) AS "publicExecute",
              has_table_privilege($1, 'users', 'INSERT') AS "insertUsers",
              has_table_privilege($1, 'memberships', 'INSERT') AS "insertMemberships"
       FROM pg_proc AS routine
       WHERE routine.oid =
         'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)'::regprocedure`,
      [runtimeRole],
    );
    expect(row).toMatchObject({
      securityDefiner: true,
      isStrict: false,
      runtimeExecute: true,
      publicExecute: false,
      insertUsers: false,
      insertMemberships: false,
    });
    expect(row?.config).toContain(
      'search_path=pg_catalog, app_private, pg_temp',
    );
  });

  it('passes activation readiness only with the real exact runtime ACL boundary', async () => {
    await expect(
      new OperationalInvitationActivationReadiness(
        true,
        1,
        {
          currentVersion: () => 2,
          keyFor: () => Buffer.alloc(32, 0x27),
        },
        runtime,
      ).assertReady(),
    ).resolves.toBeUndefined();
  });

  it('serializes activate x activate with one user, membership, and audit', async () => {
    const fixture = await createFixture('activate-race');
    const email = `activate-${randomUUID()}@example.com`;
    const invitation = await createInvitation(fixture, email);
    const input = {
      token: issue(invitation),
      name: 'New User',
      password: 'Strong activation password 1!',
    };
    const attempts = await Promise.allSettled([
      activationService().activate(input, {
        ipAddress: '127.0.0.1',
        userAgent: 'integration race a',
      }),
      activationService().activate(input, {
        ipAddress: '127.0.0.2',
        userAgent: 'integration race b',
      }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      (
        attempts.find(
          (attempt) => attempt.status === 'rejected',
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ status: 404 });

    const [state] = await owner.query<
      Array<{
        users: number;
        memberships: number;
        audits: number;
        status: string;
      }>
    >(
      `SELECT
         (SELECT count(*)::int FROM users WHERE email = $1) AS users,
         (SELECT count(*)::int FROM memberships AS membership
          JOIN users AS application_user ON application_user.id = membership.user_id
          WHERE application_user.email = $1 AND membership.organization_id = $2)
           AS memberships,
         (SELECT count(*)::int FROM organization_audit_logs
          WHERE invitation_id = $3
            AND event_type = 'organization.invitation.activated') AS audits,
         (SELECT status FROM organization_invitations WHERE id = $3) AS status`,
      [email, fixture.organization.id, invitation.id],
    );
    expect(state).toEqual({
      users: 1,
      memberships: 1,
      audits: 1,
      status: 'accepted',
    });
  });

  it('serializes activate x authenticated accept on separate runtime connections', async () => {
    const fixture = await createFixture('activate-accept-race');
    const invitation = await createInvitation(fixture, fixture.user.email);
    const operations = await Promise.allSettled([
      activationService(undefined, runtime).activate(
        {
          token: issue(invitation),
          name: 'Must Not Duplicate',
          password: 'Strong activation password 1!',
        },
        { ipAddress: '127.0.0.3', userAgent: 'activate contender' },
      ),
      acceptanceService(keyring, secondRuntime).accept(
        issue(invitation),
        fixture.user.id,
        { ipAddress: '127.0.0.4', userAgent: 'accept contender' },
      ),
    ]);
    expect(operations[0]).toMatchObject({ status: 'rejected' });
    expect(operations[1]).toMatchObject({ status: 'fulfilled' });
    const [state] = await owner.query<
      Array<{
        status: string;
        acceptedBy: string;
        users: number;
        memberships: number;
        acceptanceAudits: number;
        activationAudits: number;
      }>
    >(
      `SELECT invitation.status, invitation.accepted_by_user_id AS "acceptedBy",
              (SELECT count(*)::int FROM users WHERE email = $2) AS users,
              (SELECT count(*)::int FROM memberships
               WHERE user_id = $3 AND organization_id = $4) AS memberships,
              (SELECT count(*)::int FROM organization_audit_logs
               WHERE invitation_id = $1
                 AND event_type = 'organization.invitation.accepted')
                AS "acceptanceAudits",
              (SELECT count(*)::int FROM organization_audit_logs
               WHERE invitation_id = $1
                 AND event_type = 'organization.invitation.activated')
                AS "activationAudits"
       FROM organization_invitations AS invitation WHERE invitation.id = $1`,
      [
        invitation.id,
        fixture.user.email,
        fixture.user.id,
        fixture.organization.id,
      ],
    );
    expect(state).toEqual({
      status: 'accepted',
      acceptedBy: fixture.user.id,
      users: 1,
      memberships: 1,
      acceptanceAudits: 1,
      activationAudits: 0,
    });
  });

  it('serializes activate x revoke on separate runtime connections', async () => {
    const fixture = await createFixture('activate-revoke-race');
    const email = `activate-revoke-${randomUUID()}@example.com`;
    const invitation = await createInvitation(fixture, email);
    const operations = await Promise.allSettled([
      activationService(undefined, runtime).activate(
        {
          token: issue(invitation),
          name: 'Activation Contender',
          password: 'Strong activation password 1!',
        },
        { ipAddress: '127.0.0.5', userAgent: 'activate contender' },
      ),
      invitationAdminService(secondRuntime).revoke(
        tenant(fixture),
        invitation.id,
        { ipAddress: '127.0.0.6', userAgent: 'revoke contender' },
      ),
    ]);
    expect(
      operations.filter((item) => item.status === 'fulfilled'),
    ).toHaveLength(1);
    const state = await activationCompetitionState(invitation.id, email);
    expect(['accepted', 'revoked']).toContain(state.status);
    expect(state).toMatchObject(
      state.status === 'accepted'
        ? { users: 1, memberships: 1, activationAudits: 1, revokeAudits: 0 }
        : { users: 0, memberships: 0, activationAudits: 0, revokeAudits: 1 },
    );
  });

  it('serializes activate x replace on separate runtime connections', async () => {
    const fixture = await createFixture('activate-replace-race');
    const email = `activate-replace-${randomUUID()}@example.com`;
    const invitation = await createInvitation(fixture, email);
    const operations = await Promise.allSettled([
      activationService(undefined, runtime).activate(
        {
          token: issue(invitation),
          name: 'Activation Contender',
          password: 'Strong activation password 1!',
        },
        { ipAddress: '127.0.0.7', userAgent: 'activate contender' },
      ),
      invitationAdminService(secondRuntime).replace(
        tenant(fixture),
        invitation.id,
        randomUUID(),
        { ipAddress: '127.0.0.8', userAgent: 'replace contender' },
      ),
    ]);
    expect(
      operations.filter((item) => item.status === 'fulfilled'),
    ).toHaveLength(1);
    const [state] = await owner.query<
      Array<{
        status: string;
        users: number;
        memberships: number;
        activationAudits: number;
        replacementAudits: number;
        replacementInvitations: number;
      }>
    >(
      `SELECT invitation.status,
              (SELECT count(*)::int FROM users WHERE email = $2) AS users,
              (SELECT count(*)::int FROM memberships AS membership
               JOIN users AS application_user ON application_user.id = membership.user_id
               WHERE application_user.email = $2
                 AND membership.organization_id = invitation.organization_id)
                AS memberships,
              (SELECT count(*)::int FROM organization_audit_logs
               WHERE invitation_id = $1
                 AND event_type = 'organization.invitation.activated')
                AS "activationAudits",
              (SELECT count(*)::int FROM organization_audit_logs
               WHERE invitation_id = $1
                 AND event_type = 'organization.invitation.replaced')
                AS "replacementAudits",
              (SELECT count(*)::int FROM organization_invitations
               WHERE email_normalized = $2 AND id <> $1) AS "replacementInvitations"
       FROM organization_invitations AS invitation WHERE invitation.id = $1`,
      [invitation.id, email],
    );
    expect(['accepted', 'revoked']).toContain(state?.status);
    expect(state).toMatchObject(
      state?.status === 'accepted'
        ? {
            users: 1,
            memberships: 1,
            activationAudits: 1,
            replacementAudits: 0,
            replacementInvitations: 0,
          }
        : {
            users: 0,
            memberships: 0,
            activationAudits: 0,
            replacementAudits: 1,
            replacementInvitations: 1,
          },
    );
  });

  it('serializes activate x organization inactivation with the canonical organization lock', async () => {
    const fixture = await createFixture('activate-organization-race');
    const email = `activate-organization-${randomUUID()}@example.com`;
    const invitation = await createInvitation(fixture, email);
    const operations = await Promise.allSettled([
      activationService(undefined, runtime).activate(
        {
          token: issue(invitation),
          name: 'Activation Contender',
          password: 'Strong activation password 1!',
        },
        { ipAddress: '127.0.0.9', userAgent: 'activate contender' },
      ),
      owner.transaction(async (manager) => {
        await manager.query(
          `SELECT app_private.lock_invitation_context(
             $1::uuid[], $2::uuid[], $3::uuid[]
           )`,
          [[fixture.organization.id], [], []],
        );
        await manager.query(
          `UPDATE organizations SET status = 'inactive',
                  updated_at = transaction_timestamp() WHERE id = $1`,
          [fixture.organization.id],
        );
      }),
    ]);
    expect(operations[1]).toMatchObject({ status: 'fulfilled' });
    const state = await activationCompetitionState(invitation.id, email);
    expect(state.organizationStatus).toBe('inactive');
    expect(['accepted', 'pending']).toContain(state.status);
    expect(state).toMatchObject(
      state.status === 'accepted'
        ? { users: 1, memberships: 1, activationAudits: 1 }
        : { users: 0, memberships: 0, activationAudits: 0 },
    );
  });

  it('checks HMAC before spending password hashing capacity', async () => {
    const fixture = await createFixture('activate-mac');
    const invitation = await createInvitation(
      fixture,
      `activate-mac-${randomUUID()}@example.com`,
    );
    const valid = issue(invitation);
    const [, , , mac] = valid.split('.');
    const hash = jest.fn();
    const service = activationService({ hash });

    await expect(
      service.activate(
        {
          token: `${invitation.id}.2.1.${tamperMac(mac)}`,
          name: 'New User',
          password: 'Strong activation password 1!',
        },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects adversarial direct SECURITY DEFINER calls without partial writes', async () => {
    const fixture = await createFixture('activate-direct-invalid');
    const email = `activate-direct-invalid-${randomUUID()}@example.com`;
    const invitation = await createInvitation(fixture, email);
    await expect(
      secondRuntime.query(
        `SELECT * FROM app_private.activate_new_user_invitation(
           $1::uuid, $2::text, $3::text, $4::uuid, $5::inet, $6::text
         )`,
        [
          invitation.id,
          ' name with forbidden boundary ',
          'forged-credential',
          randomUUID(),
          null,
          null,
        ],
      ),
    ).rejects.toMatchObject({ driverError: { code: '22023' } });
    await expect(
      activationCompetitionState(invitation.id, email),
    ).resolves.toMatchObject({
      status: 'pending',
      users: 0,
      memberships: 0,
      activationAudits: 0,
    });
  });

  it('executes the exact direct function contract under an adversarial caller search_path', async () => {
    const fixture = await createFixture('activate-direct-search-path');
    const email = `activate-direct-search-path-${randomUUID()}@example.com`;
    const invitation = await createInvitation(fixture, email);
    const passwordHash = await new PasswordCredentialsService().hash(
      'Strong direct activation password 1!',
    );
    const [result] = await secondRuntime.transaction(async (manager) => {
      await manager.query(`SET LOCAL search_path = pg_temp, public`);
      return manager.query<
        Array<{
          organization_id: string;
          user_id: string;
          membership_id: string;
        }>
      >(
        `SELECT * FROM app_private.activate_new_user_invitation(
           $1::uuid, $2::text, $3::text, $4::uuid, $5::inet, $6::text
         )`,
        [
          invitation.id,
          'Direct User',
          passwordHash,
          randomUUID(),
          '127.0.0.10',
          'direct adversarial search path',
        ],
      );
    });
    expect(Object.keys(result ?? {}).sort()).toEqual([
      'membership_id',
      'organization_id',
      'user_id',
    ]);
    await expect(
      activationCompetitionState(invitation.id, email),
    ).resolves.toMatchObject({
      status: 'accepted',
      users: 1,
      memberships: 1,
      activationAudits: 1,
    });
  });

  it.each([
    ['user insert', 'users', 'BEFORE INSERT'],
    ['membership insert', 'memberships', 'BEFORE INSERT'],
    ['invitation terminal update', 'organization_invitations', 'BEFORE UPDATE'],
    ['outbox cancellation', 'invitation_delivery_outbox', 'BEFORE UPDATE'],
    ['audit insert', 'organization_audit_logs', 'BEFORE INSERT'],
  ] as const)(
    'rolls back every earlier stage when %s fails',
    async (_stage, table, event) => {
      const fixture = await createFixture('act-fault');
      const email = `activate-fault-${table}-${randomUUID()}@example.com`;
      const invitation = await createInvitation(fixture, email);
      await owner.query(`
        CREATE OR REPLACE FUNCTION public.fail_activation_stage()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced activation stage failure'
            USING ERRCODE = 'P0001';
        END;
        $$
      `);
      await owner.query(
        `CREATE TRIGGER fail_activation_stage ${event} ON public.${table}
         FOR EACH ROW EXECUTE FUNCTION public.fail_activation_stage()`,
      );
      try {
        await expect(
          activationService(undefined, secondRuntime).activate(
            {
              token: issue(invitation),
              name: 'Rollback User',
              password: 'Strong activation password 1!',
            },
            { ipAddress: null, userAgent: 'forced rollback' },
          ),
        ).rejects.toMatchObject({ driverError: { code: 'P0001' } });
        const state = await activationCompetitionState(invitation.id, email);
        expect(state).toMatchObject({
          status: 'pending',
          users: 0,
          memberships: 0,
          activationAudits: 0,
          outboxStatus: 'queued',
        });
      } finally {
        await owner.query(
          `DROP TRIGGER IF EXISTS fail_activation_stage ON public.${table}`,
        );
        await owner.query(
          `DROP FUNCTION IF EXISTS public.fail_activation_stage()`,
        );
      }
    },
  );

  it('maps only the real email unique race and rolls activation back fully', async () => {
    const fixture = await createFixture('activate-email-race');
    const email = `activate-email-race-${randomUUID()}@example.com`;
    const invitation = await createInvitation(fixture, email);
    const blocker = owner.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query(
      `INSERT INTO users (id, email, name, status)
       VALUES ($1, $2, 'Concurrent User', 'active')`,
      [randomUUID(), email],
    );

    const activation = activationService().activate(
      {
        token: issue(invitation),
        name: 'Activation Loser',
        password: 'Strong activation password 1!',
      },
      { ipAddress: null, userAgent: 'email race' },
    );
    try {
      await waitForRuntimeFunctionWait();
      await blocker.commitTransaction();
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
    }
    await expect(activation).rejects.toMatchObject({ status: 404 });

    const [state] = await owner.query<
      Array<{
        invitationStatus: string;
        acceptedBy: string | null;
        membershipCount: number;
        auditCount: number;
      }>
    >(
      `SELECT invitation.status AS "invitationStatus",
              invitation.accepted_by_user_id AS "acceptedBy",
              (SELECT count(*)::int FROM memberships AS membership
               JOIN users AS application_user ON application_user.id = membership.user_id
               WHERE application_user.email = $2
                 AND membership.organization_id = invitation.organization_id)
                AS "membershipCount",
              (SELECT count(*)::int FROM organization_audit_logs AS audit
               WHERE audit.invitation_id = invitation.id
                 AND audit.event_type = 'organization.invitation.activated')
                AS "auditCount"
       FROM organization_invitations AS invitation WHERE invitation.id = $1`,
      [invitation.id, email],
    );
    expect(state).toEqual({
      invitationStatus: 'pending',
      acceptedBy: null,
      membershipCount: 0,
      auditCount: 0,
    });
  });

  it('claims one outbox row only once across concurrent workers', async () => {
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET status = 'cancelled', cancelled_at = transaction_timestamp(),
           locked_by = NULL, locked_at = NULL, lease_until = NULL
       WHERE status IN ('queued', 'processing', 'dead')`,
    );
    const fixture = await createFixture('claim');
    const invitation = await createInvitation(
      fixture,
      'claim-target@example.com',
    );
    const sent: string[] = [];
    const provider: InvitationEmailDeliveryPort = {
      send: async (message) => {
        sent.push(message.idempotencyKey);
        return { kind: 'sent', providerMessageId: randomUUID() };
      },
    };
    const renderer = new InvitationEmailV1Renderer({
      acceptanceUrl: 'https://app.example.com/invitations/accept',
      from: 'Genesis <invitations@example.com>',
    });
    const workers = [
      new InvitationDeliveryWorkerService(
        runtime,
        codec,
        keyring,
        provider,
        renderer,
      ),
      new InvitationDeliveryWorkerService(
        runtime,
        codec,
        keyring,
        provider,
        renderer,
      ),
    ];
    const processed = await Promise.all(
      workers.map((worker) => worker.processOnce()),
    );
    expect(processed.sort()).toEqual(['idle', 'sent']);
    expect(sent).toEqual([
      `genesis-invitation-delivery/v1/${invitation.outboxId}`,
    ]);
  });

  it('retries a missing persisted key without provider fallback and recovers stably', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('key-recovery');
    const invitation = await createInvitation(
      fixture,
      'key-recovery-target@example.com',
    );
    const keys = new Map<number, Buffer>();
    const mutableKeyring: InvitationTokenKeyring = {
      currentVersion: () => 999,
      keyFor: (version) => {
        const key = keys.get(version);
        if (key === undefined) throw new Error('key unavailable');
        return key;
      },
    };
    const messages: Array<{ idempotencyKey: string; payload: string }> = [];
    const provider: InvitationEmailDeliveryPort = {
      send: jest
        .fn()
        .mockImplementationOnce(async (message) => {
          messages.push({
            idempotencyKey: message.idempotencyKey,
            payload: JSON.stringify(message),
          });
          return { kind: 'retry', errorCode: 'provider_unavailable' } as const;
        })
        .mockImplementationOnce(async (message) => {
          messages.push({
            idempotencyKey: message.idempotencyKey,
            payload: JSON.stringify(message),
          });
          return {
            kind: 'sent',
            providerMessageId: 'recovered-message',
          } as const;
        }),
    };
    const observability = new InvitationWorkerObservability();
    const worker = deliveryWorker(mutableKeyring, provider, observability);

    await expect(worker.isKeyringReady()).resolves.toBe(false);
    await expect(worker.processOnce()).resolves.toBe('retry_scheduled');
    expect(provider.send).not.toHaveBeenCalled();
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'queued',
      attempts: 1,
      lastErrorCode: 'key_version_unavailable',
    });

    keys.set(2, Buffer.alloc(32, 0x27));
    await expect(worker.isKeyringReady()).resolves.toBe(true);
    await makeDue(invitation.outboxId);
    await expect(worker.processOnce()).resolves.toBe('retry_scheduled');
    await makeDue(invitation.outboxId);
    await expect(worker.processOnce()).resolves.toBe('sent');
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(messages[0]).toEqual(messages[1]);
    expect(messages[0]?.idempotencyKey).toBe(
      `genesis-invitation-delivery/v1/${invitation.outboxId}`,
    );
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'sent',
      providerMessageId: 'recovered-message',
    });
    expect(observability.snapshot().counters).toMatchObject({
      provider_call: 2,
      provider_5xx: 1,
    });
    expect(
      Object.keys(observability.snapshot().counters).some((key) =>
        key.includes('provider_unavailable'),
      ),
    ).toBe(false);
  });

  it('moves persistent key unavailability to dead only at the frozen deadline', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('key-deadline');
    const invitation = await createInvitation(
      fixture,
      'key-deadline-target@example.com',
    );
    const provider: InvitationEmailDeliveryPort = { send: jest.fn() };
    const unavailableKeyring: InvitationTokenKeyring = {
      currentVersion: () => 999,
      keyFor: () => {
        throw new Error('key unavailable');
      },
    };
    const observability = new InvitationWorkerObservability();
    const worker = deliveryWorker(unavailableKeyring, provider, observability);
    await worker.processOnce();
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET created_at = transaction_timestamp() - interval '24 hours',
           next_attempt_at = transaction_timestamp() - interval '1 second'
       WHERE id = $1`,
      [invitation.outboxId],
    );
    await expect(worker.processOnce()).resolves.toBe('idle');
    expect(provider.send).not.toHaveBeenCalled();
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'dead',
      lastErrorCode: 'key_version_unavailable_deadline_exceeded',
    });
    expect(observability.snapshot().counters.dead).toBe(1);
  });

  it('keeps a missing persisted key queued beyond the provider attempt ceiling', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('key-attempt-ceiling');
    const invitation = await createInvitation(
      fixture,
      'key-attempt-ceiling-target@example.com',
    );
    const keys = new Map<number, Buffer>();
    const mutableKeyring: InvitationTokenKeyring = {
      currentVersion: () => 999,
      keyFor: (version) => {
        const key = keys.get(version);
        if (key === undefined) throw new Error('key unavailable');
        return key;
      },
    };
    const provider: InvitationEmailDeliveryPort = {
      send: jest.fn().mockResolvedValue({
        kind: 'sent',
        providerMessageId: 'after-key-restored',
      }),
    };
    const worker = deliveryWorker(mutableKeyring, provider);
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET attempts = 8, last_error_code = 'key_version_unavailable',
           next_attempt_at = transaction_timestamp() - interval '1 second'
       WHERE id = $1`,
      [invitation.outboxId],
    );

    await expect(worker.processOnce()).resolves.toBe('retry_scheduled');
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'queued',
      attempts: 9,
      lastErrorCode: 'key_version_unavailable',
    });
    expect(provider.send).not.toHaveBeenCalled();

    keys.set(2, Buffer.alloc(32, 0x27));
    await makeDue(invitation.outboxId);
    await expect(worker.processOnce()).resolves.toBe('sent');
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'sent',
      attempts: 10,
      providerMessageId: 'after-key-restored',
    });
  });

  it('limits a missing-key retry to the remaining delivery window', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('key-remaining-window');
    const invitation = await createInvitation(
      fixture,
      'key-remaining-window-target@example.com',
    );
    const provider: InvitationEmailDeliveryPort = { send: jest.fn() };
    const unavailableKeyring: InvitationTokenKeyring = {
      currentVersion: () => 999,
      keyFor: () => {
        throw new Error('key unavailable');
      },
    };
    const worker = deliveryWorker(unavailableKeyring, provider);
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET created_at = transaction_timestamp() - interval '22 hours 59 minutes',
           attempts = 8, last_error_code = 'key_version_unavailable',
           next_attempt_at = transaction_timestamp() - interval '1 second'
       WHERE id = $1`,
      [invitation.outboxId],
    );
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.999999);
    const processClock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2099-01-01T00:00:00.000Z').getTime());
    try {
      await expect(worker.processOnce()).resolves.toBe('retry_scheduled');
    } finally {
      random.mockRestore();
      processClock.mockRestore();
    }
    const state = await outboxState(invitation.outboxId);
    expect(state).toMatchObject({
      status: 'queued',
      attempts: 9,
      lastErrorCode: 'key_version_unavailable',
    });
    expect(state.nextAttemptAt?.getTime()).toBeLessThanOrEqual(
      state.deliveryDeadline.getTime(),
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('anchors an HTTP-date retry to the database clock under process-clock skew', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('http-date-clock');
    const invitation = await createInvitation(
      fixture,
      'http-date-clock-target@example.com',
    );
    const [clock] = await owner.query<Array<{ retryAt: Date }>>(
      `SELECT transaction_timestamp() + interval '1 minute' AS "retryAt"`,
    );
    if (clock === undefined) throw new Error('missing database clock');
    const worker = deliveryWorker(keyring, {
      send: jest.fn().mockResolvedValue({
        kind: 'retry',
        errorCode: 'provider_rate_limited',
        retryAfterAtMs: clock.retryAt.getTime(),
      }),
    });
    const processClock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2099-01-01T00:00:00.000Z').getTime());
    try {
      await expect(worker.processOnce()).resolves.toBe('retry_scheduled');
    } finally {
      processClock.mockRestore();
    }
    const state = await outboxState(invitation.outboxId);
    expect(state.nextAttemptAt?.getTime()).toBe(clock.retryAt.getTime());
  });

  it('does not let an old claim finalize after losing its fencing token', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('fencing');
    const invitation = await createInvitation(
      fixture,
      'fencing-target@example.com',
    );
    let releaseProvider: (() => void) | undefined;
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const provider: InvitationEmailDeliveryPort = {
      send: async () => {
        providerStarted?.();
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        return { kind: 'sent', providerMessageId: 'must-not-win' };
      },
    };
    const processing = deliveryWorker(keyring, provider).processOnce();
    await started;
    const replacementClaim = randomUUID();
    await owner.query(
      `UPDATE invitation_delivery_outbox SET locked_by = $2 WHERE id = $1`,
      [invitation.outboxId, replacementClaim],
    );
    releaseProvider?.();
    await expect(processing).resolves.toBe('fenced_out');
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'processing',
      lockedBy: replacementClaim,
      providerMessageId: null,
    });
  });

  it('fences finalization when the lease expired even with the same lock owner', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('expired-fence');
    const invitation = await createInvitation(
      fixture,
      'expired-fence-target@example.com',
    );
    let releaseProvider: (() => void) | undefined;
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const provider: InvitationEmailDeliveryPort = {
      send: async () => {
        providerStarted?.();
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        return { kind: 'sent', providerMessageId: 'must-not-win-expired' };
      },
    };
    const processing = deliveryWorker(keyring, provider).processOnce();
    await started;
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET lease_until = transaction_timestamp() - interval '1 second'
       WHERE id = $1`,
      [invitation.outboxId],
    );
    releaseProvider?.();
    await expect(processing).resolves.toBe('fenced_out');
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'processing',
      providerMessageId: null,
    });
  });

  it('reports recovery when it reclaims an expired processing lease', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('lease-recovery');
    const invitation = await createInvitation(
      fixture,
      'lease-recovery-target@example.com',
    );
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET status = 'processing', attempts = 1, locked_by = $2,
           locked_at = transaction_timestamp() - interval '2 minutes',
           lease_until = transaction_timestamp() - interval '1 minute'
       WHERE id = $1`,
      [invitation.outboxId, randomUUID()],
    );
    const provider: InvitationEmailDeliveryPort = {
      send: jest.fn().mockResolvedValue({
        kind: 'sent',
        providerMessageId: 'recovered-lease',
      }),
    };
    await expect(deliveryWorker(keyring, provider).processOnce()).resolves.toBe(
      'recovered',
    );
    await expect(outboxState(invitation.outboxId)).resolves.toMatchObject({
      status: 'sent',
      attempts: 2,
      providerMessageId: 'recovered-lease',
    });
  });

  it('counts a maintenance cancellation exactly once without a claim', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('cancel-metric');
    const invitation = await createInvitation(
      fixture,
      'cancel-metric-target@example.com',
    );
    await owner.query(
      `UPDATE organization_invitations
       SET status = 'revoked', revoked_at = transaction_timestamp(),
           revocation_reason = 'manual'
       WHERE id = $1`,
      [invitation.id],
    );
    const observability = new InvitationWorkerObservability();
    const worker = deliveryWorker(keyring, { send: jest.fn() }, observability);
    await expect(worker.processOnce()).resolves.toBe('cancelled');
    expect(observability.snapshot().counters).toMatchObject({
      cancelled: 1,
      iteration: 1,
    });
  });

  it('refreshes the PostgreSQL operational gauges used by worker health', async () => {
    await cancelRetryableOutbox();
    const observability = new InvitationWorkerObservability();
    const worker = deliveryWorker(keyring, { send: jest.fn() }, observability);

    await expect(worker.refreshOperationalGauges()).resolves.toBeUndefined();
    expect(observability.snapshot().gauges).toMatchObject({
      backlogDue: 0,
      oldestDueAgeSeconds: 0,
      activeLeases: 0,
      expiredLeases: 0,
    });
  });

  it('clears stale delivery errors on a direct dead-to-cancelled transition', async () => {
    await cancelRetryableOutbox();
    const fixture = await createFixture('cancel-clear');
    const invitation = await createInvitation(
      fixture,
      'cancel-clear-target@example.com',
    );
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET status = 'dead', last_error_code = 'provider_unavailable',
           next_attempt_at = transaction_timestamp() + interval '1 hour'
       WHERE id = $1`,
      [invitation.outboxId],
    );
    await owner.query(
      `UPDATE invitation_delivery_outbox SET status = 'cancelled',
           cancelled_at = transaction_timestamp()
       WHERE id = $1`,
      [invitation.outboxId],
    );
    const state = await outboxState(invitation.outboxId);
    expect(state.lastErrorCode).toBeNull();
    expect(state.nextAttemptAt).toBeNull();
  });

  it('fails migration rollback before removing activation objects with real data', async () => {
    await owner.undoLastMigration();
    await expect(owner.undoLastMigration()).rejects.toThrow(
      'Cannot revert invitation activation migration while activation data exists.',
    );
    const [state] = await owner.query<
      Array<{ hasColumn: boolean; hasFunction: boolean }>
    >(
      `SELECT
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users'
             AND column_name = 'email_verified_at'
         ) AS "hasColumn",
         to_regprocedure(
           'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)'
         ) IS NOT NULL AS "hasFunction"`,
    );
    expect(state).toEqual({ hasColumn: true, hasFunction: true });
  });

  function acceptanceService(
    serviceKeyring: InvitationTokenKeyring = keyring,
    serviceDataSource: DataSource = runtime,
  ): InvitationAcceptanceService {
    return new InvitationAcceptanceService(
      serviceDataSource,
      new InvitationTokenCodec(serviceKeyring),
      new OrganizationAuditService(),
      new ConfiguredInvitationAcceptanceReadiness(true),
    );
  }

  function activationService(
    passwordHasher: {
      hash(password: string): Promise<string>;
    } = new PasswordCredentialsService(),
    serviceDataSource: DataSource = runtime,
  ): InvitationActivationService {
    return new InvitationActivationService(
      serviceDataSource,
      codec,
      { consume: jest.fn() } as unknown as InvitationAcceptanceRateLimiter,
      {
        run: <T>(operation: () => Promise<T>) => operation(),
      } as InvitationActivationHashCapacity,
      passwordHasher,
      { assertReady: async () => undefined },
      new InvitationActivationObservability(),
    );
  }

  function invitationAdminService(
    serviceDataSource: DataSource,
  ): InvitationsService {
    return new InvitationsService(
      serviceDataSource,
      new OrganizationAuditService(),
      new EnabledInvitationIssuanceReadiness(),
      keyring,
    );
  }

  function tenant(fixture: Awaited<ReturnType<typeof createFixture>>): {
    userId: string;
    organizationId: string;
    membershipId: string;
    role: MembershipRole;
  } {
    return {
      userId: fixture.issuer.userId,
      organizationId: fixture.organization.id,
      membershipId: fixture.issuer.id,
      role: MembershipRole.OWNER,
    };
  }

  async function activationCompetitionState(
    invitationId: string,
    email: string,
  ): Promise<{
    status: string;
    organizationStatus: string;
    users: number;
    memberships: number;
    activationAudits: number;
    revokeAudits: number;
    outboxStatus: string;
  }> {
    const [state] = await owner.query<
      Array<{
        status: string;
        organizationStatus: string;
        users: number;
        memberships: number;
        activationAudits: number;
        revokeAudits: number;
        outboxStatus: string;
      }>
    >(
      `SELECT invitation.status,
              organization.status AS "organizationStatus",
              (SELECT count(*)::int FROM users WHERE email = $2) AS users,
              (SELECT count(*)::int FROM memberships AS membership
               JOIN users AS application_user ON application_user.id = membership.user_id
               WHERE application_user.email = $2
                 AND membership.organization_id = invitation.organization_id)
                AS memberships,
              (SELECT count(*)::int FROM organization_audit_logs
               WHERE invitation_id = $1
                 AND event_type = 'organization.invitation.activated')
                AS "activationAudits",
              (SELECT count(*)::int FROM organization_audit_logs
               WHERE invitation_id = $1
                 AND event_type = 'organization.invitation.revoked')
                AS "revokeAudits",
              (SELECT status FROM invitation_delivery_outbox
               WHERE invitation_id = $1 ORDER BY created_at LIMIT 1)
                AS "outboxStatus"
       FROM organization_invitations AS invitation
       JOIN organizations AS organization
         ON organization.id = invitation.organization_id
       WHERE invitation.id = $1`,
      [invitationId, email],
    );
    if (state === undefined)
      throw new Error('missing activation competition state');
    return state;
  }

  async function expectUnavailable(
    service: InvitationAcceptanceService,
    presentedToken: string,
    userId: string,
    invitation: OrganizationInvitation & { outboxId: string },
    scopedUserIds: string[],
    baseline: Awaited<ReturnType<typeof acceptanceState>>,
  ): Promise<void> {
    let failure: unknown;
    try {
      await service.accept(presentedToken, userId, {
        ipAddress: null,
        userAgent: 'integration rejected replay',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      status: 404,
      response: {
        statusCode: 404,
        message: 'Invitation unavailable.',
        error: 'Not Found',
      },
    });
    expect(JSON.stringify(failure)).not.toContain(invitation.organizationId);
    expect(JSON.stringify(failure)).not.toContain(
      baseline.resultingMembershipId,
    );
    await expect(acceptanceState(invitation, scopedUserIds)).resolves.toEqual(
      baseline,
    );
  }

  async function acceptanceState(
    invitation: OrganizationInvitation & { outboxId: string },
    scopedUserIds: string[],
  ): Promise<{
    invitation: string;
    memberships: string;
    audits: string;
    outbox: string;
    resultingMembershipId: string;
  }> {
    const [row] = await owner.query<
      Array<{
        invitation: string;
        memberships: string;
        audits: string;
        outbox: string;
        resultingMembershipId: string;
      }>
    >(
      `SELECT to_jsonb(invitation)::text AS invitation,
              invitation.resulting_membership_id AS "resultingMembershipId",
              COALESCE((
                SELECT jsonb_agg(to_jsonb(membership) ORDER BY membership.id)::text
                FROM memberships AS membership
                WHERE membership.organization_id = invitation.organization_id
                  AND membership.user_id = ANY($2::uuid[])
              ), '[]') AS memberships,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.id)::text
                FROM organization_audit_logs AS audit
                WHERE audit.organization_id = invitation.organization_id
                  AND audit.invitation_id = invitation.id
              ), '[]') AS audits,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(outbox) ORDER BY outbox.id)::text
                FROM invitation_delivery_outbox AS outbox
                WHERE outbox.organization_id = invitation.organization_id
                  AND outbox.invitation_id = invitation.id
                  AND outbox.id = $3
              ), '[]') AS outbox
       FROM organization_invitations AS invitation
       WHERE invitation.id = $1 AND invitation.organization_id = $4`,
      [
        invitation.id,
        scopedUserIds,
        invitation.outboxId,
        invitation.organizationId,
      ],
    );
    if (row === undefined || row.resultingMembershipId === null) {
      throw new Error('missing accepted invitation test state');
    }
    return row;
  }

  function tamperMac(mac: string): string {
    return `${mac.slice(0, -1)}${mac.at(-1) === 'A' ? 'B' : 'A'}`;
  }

  function deliveryWorker(
    workerKeyring: InvitationTokenKeyring,
    provider: InvitationEmailDeliveryPort,
    observability?: InvitationWorkerObservability,
  ): InvitationDeliveryWorkerService {
    return new InvitationDeliveryWorkerService(
      runtime,
      new InvitationTokenCodec(workerKeyring),
      workerKeyring,
      provider,
      new InvitationEmailV1Renderer({
        acceptanceUrl: 'https://app.example.com/invitations/accept',
        from: 'Genesis <invitations@example.com>',
      }),
      observability,
    );
  }

  async function cancelRetryableOutbox(): Promise<void> {
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET status = 'cancelled', cancelled_at = transaction_timestamp(),
           locked_by = NULL, locked_at = NULL, lease_until = NULL
       WHERE status IN ('queued', 'processing', 'dead')`,
    );
  }

  async function waitForRuntimeFunctionWait(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await owner.query<Array<{ waiting: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE usename = $1
             AND query LIKE '%activate_new_user_invitation%'
             AND wait_event IS NOT NULL
         ) AS waiting`,
        [process.env.DATABASE_RUNTIME_ROLE],
      );
      if (row?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('activation did not reach the expected unique-key wait');
  }

  async function makeDue(outboxId: string): Promise<void> {
    await owner.query(
      `UPDATE invitation_delivery_outbox
       SET next_attempt_at = transaction_timestamp() - interval '1 second'
       WHERE id = $1`,
      [outboxId],
    );
  }

  async function outboxState(outboxId: string): Promise<{
    status: string;
    attempts: number;
    lastErrorCode: string | null;
    lockedBy: string | null;
    providerMessageId: string | null;
    nextAttemptAt: Date | null;
    deliveryDeadline: Date;
  }> {
    const [row] = await owner.query<
      Array<{
        status: string;
        attempts: number;
        lastErrorCode: string | null;
        lockedBy: string | null;
        providerMessageId: string | null;
        nextAttemptAt: Date | null;
        deliveryDeadline: Date;
      }>
    >(
      `SELECT status, attempts, last_error_code AS "lastErrorCode",
              locked_by AS "lockedBy", provider_message_id AS "providerMessageId",
              next_attempt_at AS "nextAttemptAt",
              created_at + interval '23 hours' AS "deliveryDeadline"
       FROM invitation_delivery_outbox WHERE id = $1`,
      [outboxId],
    );
    if (row === undefined) throw new Error('missing outbox test row');
    return row;
  }

  async function createFixture(suffix: string): Promise<{
    user: User;
    organization: Organization;
    issuer: Membership;
  }> {
    const user = await owner.getRepository(User).save(
      owner.getRepository(User).create({
        email: `${suffix}-${randomUUID()}@example.com`,
        name: `User ${suffix}`,
        status: UserStatus.ACTIVE,
      }),
    );
    const issuerUser = await owner.getRepository(User).save(
      owner.getRepository(User).create({
        email: `issuer-${suffix}-${randomUUID()}@example.com`,
        name: `Issuer ${suffix}`,
        status: UserStatus.ACTIVE,
      }),
    );
    const { organization, issuer } = await owner.transaction(
      async (manager) => {
        const organization = await manager.getRepository(Organization).save({
          name: `Organization ${suffix}`,
          slug: `${suffix}-${randomUUID()}`,
          status: OrganizationStatus.ACTIVE,
        });
        const issuer = await manager.getRepository(Membership).save({
          userId: issuerUser.id,
          organizationId: organization.id,
          role: MembershipRole.OWNER,
          status: MembershipStatus.ACTIVE,
        });
        return { organization, issuer };
      },
    );
    return { user, organization, issuer };
  }

  async function createInvitation(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    email: string,
  ): Promise<OrganizationInvitation & { outboxId: string }> {
    const invitation = await owner.getRepository(OrganizationInvitation).save(
      owner.getRepository(OrganizationInvitation).create({
        organizationId: fixture.organization.id,
        emailNormalized: email,
        role: InvitationRole.MEMBER,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedByMembershipId: fixture.issuer.id,
        acceptedByUserId: null,
        resultingMembershipId: null,
        acceptedAt: null,
        revokedByMembershipId: null,
        revokedAt: null,
        revocationReason: null,
        supersededByInvitationId: null,
        tokenKeyVersion: 2,
        tokenVersion: 1,
        tokenNonce: randomBytes(32).toString('base64url'),
      }),
    );
    const outbox = await owner.getRepository(InvitationDeliveryOutbox).save(
      owner.getRepository(InvitationDeliveryOutbox).create({
        organizationId: fixture.organization.id,
        invitationId: invitation.id,
        eventType: InvitationDeliveryEventType.REQUESTED,
        tokenVersion: 1,
        status: InvitationDeliveryStatus.QUEUED,
        attempts: 0,
        nextAttemptAt: null,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        providerMessageId: null,
        lastErrorCode: null,
        sentAt: null,
        cancelledAt: null,
      }),
    );
    return Object.assign(invitation, { outboxId: outbox.id });
  }

  function issue(invitation: OrganizationInvitation): string {
    return codec.issue(tokenFields(invitation));
  }

  function tokenFields(invitation: OrganizationInvitation) {
    return {
      invitationId: invitation.id,
      keyVersion: invitation.tokenKeyVersion,
      tokenVersion: invitation.tokenVersion,
      organizationId: invitation.organizationId,
      emailNormalized: invitation.emailNormalized,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      nonce: invitation.tokenNonce,
    };
  }
});
