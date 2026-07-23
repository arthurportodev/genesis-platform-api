import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import { ConfigService } from '@nestjs/config';
import { CreateLeadFoundation1785346800000 } from '../../src/database/migrations/1785346800000-CreateLeadFoundation';
import { OperationalInvitationActivationReadiness } from '../../src/modules/invitations/ports/invitation-activation-readiness.port';
import { Membership } from '../../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../../src/modules/memberships/enums/membership-status.enum';
import { LeadSource } from '../../src/modules/leads/enums/lead.enums';
import { OperationalLeadReadiness } from '../../src/modules/leads/ports/lead-readiness.port';
import { LeadsService } from '../../src/modules/leads/services/leads.service';
import { Organization } from '../../src/modules/organizations/entities/organization.entity';
import { OrganizationStatus } from '../../src/modules/organizations/enums/organization-status.enum';
import { User } from '../../src/modules/users/entities/user.entity';
import { UserStatus } from '../../src/modules/users/enums/user-status.enum';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from '../support/integration-data-source';

interface Fixture {
  organization: Organization;
  users: User[];
  memberships: Membership[];
}

interface IngestResult {
  outcome: string;
  leadId: string;
  revision: string;
  replayed: boolean;
  actorCanView: boolean;
  responseStatus: number;
}

describe('Lead foundation database integration', () => {
  let owner: DataSource;
  let runtime: DataSource;
  let migrationRunner: QueryRunner;

  beforeAll(async () => {
    owner = createIntegrationDataSource();
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    migrationRunner = owner.createQueryRunner();
    await new CreateLeadFoundation1785346800000().up(migrationRunner);
    configureIntegrationRuntimeEnvironment();
    runtime = createIntegrationRuntimeDataSource();
    await runtime.initialize();
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (migrationRunner?.isReleased === false) await migrationRunner.release();
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  it('deduplicates by tenant phone, appends attribution, and replays idempotently', async () => {
    const fixture = await createFixture();
    const key = randomUUID();
    const first = await ingest(fixture, key, 'a'.repeat(64), 'campaign');
    expect(first).toMatchObject({
      outcome: 'created',
      revision: '1',
      replayed: false,
      actorCanView: true,
      responseStatus: 201,
    });

    const replay = await ingest(fixture, key, 'a'.repeat(64), 'campaign');
    expect(replay).toMatchObject({
      leadId: first.leadId,
      revision: '1',
      replayed: true,
      responseStatus: 200,
    });

    const duplicate = await ingest(
      fixture,
      randomUUID(),
      'b'.repeat(64),
      'lead_magnet',
    );
    expect(duplicate).toMatchObject({
      outcome: 'entry_added',
      leadId: first.leadId,
      revision: '2',
      responseStatus: 200,
    });
    const [counts] = await owner.query<
      Array<{ leads: string; entries: string; events: string }>
    >(`SELECT (SELECT count(*) FROM public.leads)::text AS leads,
              (SELECT count(*) FROM public.lead_entries)::text AS entries,
              (SELECT count(*) FROM public.lead_timeline_events)::text AS events`);
    expect(counts).toEqual({ leads: '1', entries: '2', events: '3' });
    const [versions] = await runtime.query<
      Array<{ requiredVersions: number[] }>
    >(
      `SELECT app_private.required_lead_fingerprint_key_versions()
        AS "requiredVersions"`,
    );
    expect(versions?.requiredVersions).toEqual([1]);
    await expect(
      new CreateLeadFoundation1785346800000().down(migrationRunner),
    ).rejects.toThrow(
      'Cannot revert lead foundation migration while CRM data exists.',
    );
    const [boundary] = await owner.query<Array<{ tablePresent: boolean }>>(
      `SELECT to_regclass('public.leads') IS NOT NULL AS "tablePresent"`,
    );
    expect(boundary?.tablePresent).toBe(true);
  });

  it('opens readiness only for the installed least-privilege catalog', async () => {
    await expect(
      new OperationalLeadReadiness(leadConfig(), runtime).assertManualReady(),
    ).resolves.toBeUndefined();
    await expect(
      new OperationalInvitationActivationReadiness(
        true,
        1,
        { currentVersion: () => 1, keyFor: () => Buffer.alloc(32, 1) },
        runtime,
      ).assertReady(),
    ).resolves.toBeUndefined();
  });

  it('replays an old claim after fingerprint key rotation', async () => {
    const fixture = await createFixture();
    const idempotencyKey = randomUUID();
    const oldConfig = leadConfig(1, new Map([[1, Buffer.alloc(32, 1)]]));
    const rotatedConfig = leadConfig(
      2,
      new Map([
        [1, Buffer.alloc(32, 1)],
        [2, Buffer.alloc(32, 2)],
      ]),
    );
    const tenant = {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const dto = {
      displayName: 'Rotating lead',
      primaryPhone: '+5562988887777',
      source: LeadSource.CAMPAIGN,
    };
    const oldService = new LeadsService(
      runtime,
      { getOrThrow: () => oldConfig } as unknown as ConfigService,
      new OperationalLeadReadiness(oldConfig, runtime),
    );
    const first = await oldService.createManual(tenant, dto, idempotencyKey);
    const rotatedService = new LeadsService(
      runtime,
      { getOrThrow: () => rotatedConfig } as unknown as ConfigService,
      new OperationalLeadReadiness(rotatedConfig, runtime),
    );
    const replay = await rotatedService.createManual(
      tenant,
      dto,
      idempotencyKey,
    );
    expect(first).toMatchObject({ responseStatus: 201, replayed: false });
    expect(replay).toMatchObject({ responseStatus: 200, replayed: true });
    expect(replay.lead?.id).toBe(first.lead?.id);
  });

  it('exposes derived Source attribution and a tenant-scoped unassigned inbox', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      '3'.repeat(64),
      'campaign',
    );
    const readiness = new OperationalLeadReadiness(leadConfig(), runtime);
    const service = new LeadsService(
      runtime,
      { getOrThrow: () => leadConfig() } as unknown as ConfigService,
      readiness,
    );
    const ownerTenant = {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const inbox = await service.list(ownerTenant, {
      limit: 25,
      unassigned: 'true',
    });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      id: created.leadId,
      initialAttribution: { source: 'campaign' },
      lastAttribution: { source: 'campaign' },
    });
    const memberInbox = await service.list(
      {
        ...ownerTenant,
        role: MembershipRole.MEMBER,
        membershipId: fixture.memberships[1].id,
      },
      { limit: 25, unassigned: 'true' },
    );
    expect(memberInbox.items).toEqual([]);
  });

  it('denies runtime DML, keeps history append-only, and clears assignment on offboarding', async () => {
    const fixture = await createFixture();
    const result = await ingest(
      fixture,
      randomUUID(),
      'c'.repeat(64),
      'manual',
      fixture.memberships[1].id,
    );
    await expect(
      runtime.query(
        `UPDATE public.leads SET display_name = 'Bypass' WHERE id = $1`,
        [result.leadId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
    await expect(
      owner.query(`DELETE FROM public.lead_entries WHERE lead_id = $1`, [
        result.leadId,
      ]),
    ).rejects.toMatchObject({ driverError: { code: 'P3006' } });

    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      status: MembershipStatus.INACTIVE,
    });
    const [lead] = await owner.query<
      Array<{ responsibleMembershipId: string | null; revision: string }>
    >(
      `SELECT responsible_membership_id AS "responsibleMembershipId",
              revision::text AS revision FROM public.leads WHERE id = $1`,
      [result.leadId],
    );
    expect(lead).toEqual({ responsibleMembershipId: null, revision: '2' });
  });

  it('repeatedly serializes concurrent ingestion of the same tenant phone', async () => {
    const fixture = await createFixture();
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const phone = `+55629888888${iteration}`;
      const results = await Promise.all([
        ingest(fixture, randomUUID(), 'd'.repeat(64), 'campaign', null, phone),
        ingest(
          fixture,
          randomUUID(),
          'e'.repeat(64),
          'lead_magnet',
          null,
          phone,
        ),
      ]);
      expect(results.map(({ outcome }) => outcome).sort()).toEqual([
        'created',
        'entry_added',
      ]);
      expect(new Set(results.map(({ leadId }) => leadId))).toHaveProperty(
        'size',
        1,
      );
      expect(results.map(({ revision }) => revision).sort()).toEqual([
        '1',
        '2',
      ]);
    }
  });

  it('updates and assigns with optimistic concurrency enforced by PostgreSQL', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      '9'.repeat(64),
      'manual',
    );
    const config = leadConfig();
    const service = new LeadsService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      new OperationalLeadReadiness(config, runtime),
    );
    const tenant = {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const updated = await service.update(tenant, created.leadId, '1', {
      displayName: 'Maria updated',
    });
    expect(updated).toMatchObject({
      displayName: 'Maria updated',
      revision: '2',
    });
    await expect(
      service.update(tenant, created.leadId, '1', { displayName: 'Stale' }),
    ).rejects.toMatchObject({ status: 412 });
    const assigned = await service.assign(
      tenant,
      created.leadId,
      '2',
      fixture.memberships[1].id,
    );
    expect(assigned).toMatchObject({
      responsibleMembershipId: fixture.memberships[1].id,
      revision: '3',
    });
    const assignmentNoOp = await service.assign(
      tenant,
      created.leadId,
      '3',
      fixture.memberships[1].id,
    );
    expect(assignmentNoOp.revision).toBe('3');
    const unassigned = await service.assign(tenant, created.leadId, '3', null);
    expect(unassigned).toMatchObject({
      responsibleMembershipId: null,
      revision: '4',
    });
    await expect(
      service.assign(tenant, created.leadId, '3', null),
    ).rejects.toMatchObject({ status: 412 });

    const updateNoOp = await service.update(tenant, created.leadId, '4', {});
    expect(updateNoOp.revision).toBe('4');
    await expect(
      service.assign(
        {
          ...tenant,
          userId: fixture.users[1].id,
          membershipId: fixture.memberships[1].id,
          role: MembershipRole.MEMBER,
        },
        created.leadId,
        '4',
        fixture.memberships[1].id,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const secondLead = await ingest(
      fixture,
      randomUUID(),
      '8'.repeat(64),
      'manual',
      null,
      '+5562977777777',
    );
    expect(secondLead.leadId).not.toBe(created.leadId);
    await expect(
      service.update(tenant, created.leadId, '4', {
        primaryPhone: '+5562977777777',
      }),
    ).rejects.toMatchObject({ status: 409 });

    const otherTenant = await createFixture();
    await expect(
      service.assign(
        tenant,
        created.leadId,
        '4',
        otherTenant.memberships[1].id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      status: MembershipStatus.INACTIVE,
    });
    await expect(
      service.assign(tenant, created.leadId, '4', fixture.memberships[1].id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('fails closed for fingerprint reuse, cross-tenant resources, and inactive organizations', async () => {
    const firstTenant = await createFixture();
    const secondTenant = await createFixture();
    const key = randomUUID();
    const created = await ingest(firstTenant, key, 'f'.repeat(64), 'manual');
    await expect(
      ingest(firstTenant, key, '0'.repeat(64), 'manual'),
    ).rejects.toMatchObject({ driverError: { code: 'P3004' } });

    await expect(
      runtime.query(
        `SELECT * FROM app_private.update_lead(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,1::bigint,
          'Cross tenant','+5562999999999',NULL,NULL,NULL,NULL,NULL)`,
        [
          secondTenant.users[0].id,
          secondTenant.memberships[0].id,
          secondTenant.organization.id,
          created.leadId,
        ],
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P3002' } });

    await owner
      .getRepository(Organization)
      .update(firstTenant.organization.id, {
        status: OrganizationStatus.INACTIVE,
      });
    await expect(
      runtime.query(
        `SELECT * FROM app_private.update_lead(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,1::bigint,
          'Inactive tenant','+5562999999999',NULL,NULL,NULL,NULL,NULL)`,
        [
          firstTenant.users[0].id,
          firstTenant.memberships[0].id,
          firstTenant.organization.id,
          created.leadId,
        ],
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P3001' } });
  });

  it('keeps member duplicate responses opaque when the lead belongs to another member', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      '1'.repeat(64),
      'manual',
      fixture.memberships[0].id,
    );
    const [duplicate] = await runtime.query<
      Array<{ leadId: string; actorCanView: boolean; responseStatus: number }>
    >(
      `SELECT lead_id AS "leadId", actor_can_view AS "actorCanView",
              response_status AS "responseStatus"
       FROM app_private.ingest_lead(
         $1::uuid,$2::uuid,$3::uuid,'manual','Discarded name','+5562999999999',
         'discarded@example.com',NULL,NULL,NULL,NULL,NULL,'manual',NULL,NULL,
         NULL,NULL,NULL,NULL,$4::uuid,1::smallint,$5::text,$6::jsonb)`,
      [
        fixture.users[1].id,
        fixture.memberships[1].id,
        fixture.organization.id,
        randomUUID(),
        '2'.repeat(64),
        JSON.stringify({ 1: '2'.repeat(64) }),
      ],
    );
    expect(duplicate).toEqual({
      leadId: created.leadId,
      actorCanView: false,
      responseStatus: 204,
    });
    const [lead] = await owner.query<
      Array<{ displayName: string; email: string | null }>
    >(
      `SELECT display_name AS "displayName", email FROM public.leads WHERE id = $1`,
      [created.leadId],
    );
    expect(lead).toEqual({ displayName: 'Maria', email: null });
  });

  async function createFixture(): Promise<Fixture> {
    const suffix = randomUUID();
    const organization = await owner.getRepository(Organization).save({
      name: `Lead org ${suffix}`,
      slug: `lead-${suffix}`,
      status: OrganizationStatus.INACTIVE,
    });
    const users = await owner.getRepository(User).save([
      {
        email: `lead-owner-${suffix}@example.com`,
        name: 'Lead owner',
        status: UserStatus.ACTIVE,
      },
      {
        email: `lead-member-${suffix}@example.com`,
        name: 'Lead member',
        status: UserStatus.ACTIVE,
      },
    ]);
    const memberships = await owner.getRepository(Membership).save([
      {
        userId: users[0].id,
        organizationId: organization.id,
        role: MembershipRole.OWNER,
        status: MembershipStatus.ACTIVE,
      },
      {
        userId: users[1].id,
        organizationId: organization.id,
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
      },
    ]);
    await owner.getRepository(Organization).update(organization.id, {
      status: OrganizationStatus.ACTIVE,
    });
    return { organization, users, memberships };
  }

  async function ingest(
    fixture: Fixture,
    idempotencyKey: string,
    fingerprint: string,
    source: string,
    responsibleMembershipId: string | null = null,
    phone = '+5562999999999',
  ): Promise<IngestResult> {
    const rows = await runtime.query<IngestResult[]>(
      `SELECT outcome, lead_id AS "leadId", revision::text AS revision,
              replayed, actor_can_view AS "actorCanView",
              response_status AS "responseStatus"
       FROM app_private.ingest_lead(
         $1::uuid,$2::uuid,$3::uuid,'manual','Maria',$8::text,NULL,
         NULL,NULL,NULL,NULL,$4::uuid,$5::text,NULL,NULL,NULL,NULL,NULL,NULL,
          $6::uuid,1::smallint,$7::text,$9::jsonb)`,
      [
        fixture.users[0].id,
        fixture.memberships[0].id,
        fixture.organization.id,
        responsibleMembershipId,
        source,
        idempotencyKey,
        fingerprint,
        phone,
        JSON.stringify({ 1: fingerprint }),
      ],
    );
    const result = rows[0];
    if (result === undefined) throw new Error('Lead ingest returned no row.');
    return result;
  }

  function leadConfig(
    currentVersion = 1,
    keys: ReadonlyMap<number, Buffer> = new Map([[1, Buffer.alloc(32, 1)]]),
  ): LeadConfig {
    return {
      formReadiness: false,
      formOrganizationId: null,
      formCurrentKeyVersion: null,
      formKeys: new Map(),
      idempotencyCurrentKeyVersion: currentVersion,
      idempotencyKeys: keys,
      publicReplicaCount: 1,
      rateLimitWindowSeconds: 900,
      formIpMaxAttempts: 30,
      formKeyMaxAttempts: 300,
      rateLimitMaxBuckets: 10_000,
    };
  }
});
