import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import { ConfigService } from '@nestjs/config';
import { CreateLeadFoundation1785346800000 } from '../../src/database/migrations/1785346800000-CreateLeadFoundation';
import { ManageLeadCommercialPipeline1785433200000 } from '../../src/database/migrations/1785433200000-ManageLeadCommercialPipeline';
import { ManageLeadActivitiesFollowUp1785519600000 } from '../../src/database/migrations/1785519600000-ManageLeadActivitiesFollowUp';
import { AddLeadOperationalReadIndexes1785606000000 } from '../../src/database/migrations/1785606000000-AddLeadOperationalReadIndexes';
import { ManageLeadCommercialCycleExpectedValue1788289200000 } from '../../src/database/migrations/1788289200000-ManageLeadCommercialCycleExpectedValue';
import { OperationalInvitationActivationReadiness } from '../../src/modules/invitations/ports/invitation-activation-readiness.port';
import { Membership } from '../../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../../src/modules/memberships/enums/membership-status.enum';
import {
  LeadArchiveReason,
  LeadActivityType,
  LeadListSort,
  LeadLostReason,
  LeadNextActionType,
  LeadSource,
  LeadStage,
  LeadStatus,
} from '../../src/modules/leads/enums/lead.enums';
import { OperationalLeadReadiness } from '../../src/modules/leads/ports/lead-readiness.port';
import { leadExpectedValueFingerprint } from '../../src/modules/leads/security/lead-fingerprint';
import { LeadsService } from '../../src/modules/leads/services/leads.service';
import { LeadOperationalReadService } from '../../src/modules/leads/services/lead-operational-read.service';
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
    await new ManageLeadCommercialPipeline1785433200000().up(migrationRunner);
    await new ManageLeadActivitiesFollowUp1785519600000().up(migrationRunner);
    await new AddLeadOperationalReadIndexes1785606000000().up(migrationRunner);
    await new ManageLeadCommercialCycleExpectedValue1788289200000().up(
      migrationRunner,
    );
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

  it('reverts and reapplies exactly the nine operational indexes on UTF8', async () => {
    const migration = new AddLeadOperationalReadIndexes1785606000000();
    await migrationRunner.startTransaction();
    try {
      await migration.down(migrationRunner);
      const [removed] = (await migrationRunner.query(
        `SELECT count(*)::int AS count FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN (
          'idx_leads_org_display_name_search',
          'idx_leads_org_company_name_search',
          'idx_leads_org_email_search',
          'idx_lead_entries_org_received',
          'idx_lead_entries_org_initial_source',
          'idx_lead_next_actions_org_pending_due',
          'idx_lead_next_actions_org_responsible_pending_due',
          'idx_lead_return_reviews_org_pending_opened',
          'idx_lead_cycles_org_closed_status'
        )`,
      )) as Array<{ count: number }>;
      expect(removed?.count).toBe(0);

      await migration.up(migrationRunner);
      const [restored] = (await migrationRunner.query(
        `SELECT current_setting('server_encoding') AS encoding,
          count(*)::int AS count FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN (
          'idx_leads_org_display_name_search',
          'idx_leads_org_company_name_search',
          'idx_leads_org_email_search',
          'idx_lead_entries_org_received',
          'idx_lead_entries_org_initial_source',
          'idx_lead_next_actions_org_pending_due',
          'idx_lead_next_actions_org_responsible_pending_due',
          'idx_lead_return_reviews_org_pending_opened',
          'idx_lead_cycles_org_closed_status'
        ) GROUP BY current_setting('server_encoding')`,
      )) as Array<{ encoding: string; count: number }>;
      expect(restored).toEqual({ encoding: 'UTF8', count: 9 });

      const planOrganizationId = randomUUID();
      await migrationRunner.query(
        `INSERT INTO public.organizations (id, name, slug, status)
         VALUES ($1::uuid, 'Plan fixture', 'plan-' || $1::uuid::text, 'inactive')`,
        [planOrganizationId],
      );
      await migrationRunner.query(
        `INSERT INTO public.leads
          (organization_id, display_name, primary_phone)
         SELECT $1::uuid,
           CASE WHEN sequence <= 5 THEN 'Ágata ' || sequence::text
                ELSE 'Zulu ' || sequence::text END,
           '+5562' || lpad(sequence::text, 10, '0')
         FROM generate_series(1, 5000) AS sequence`,
        [planOrganizationId],
      );
      await migrationRunner.query('ANALYZE public.leads');
      const plan: unknown = await migrationRunner.query(
        `EXPLAIN (FORMAT JSON)
         SELECT lead.id FROM public.leads lead
         WHERE lead.organization_id = $1::uuid
           AND lower(normalize(lead.display_name, NFC)) LIKE 'ágata%'
         ORDER BY lead.created_at DESC, lead.id DESC LIMIT 25`,
        [planOrganizationId],
      );
      expect(JSON.stringify(plan)).toContain(
        'idx_leads_org_display_name_search',
      );
    } finally {
      await migrationRunner.rollbackTransaction();
    }
  });

  it('reverts and reapplies the additive pipeline migration before lifecycle data exists', async () => {
    const migration = new ManageLeadCommercialPipeline1785433200000();
    const followUpMigration = new ManageLeadActivitiesFollowUp1785519600000();
    const financialMigration =
      new ManageLeadCommercialCycleExpectedValue1788289200000();
    await migrationRunner.startTransaction();
    try {
      await expect(
        financialMigration.down(migrationRunner),
      ).resolves.toBeUndefined();
      await expect(
        followUpMigration.down(migrationRunner),
      ).resolves.toBeUndefined();
      await expect(migration.down(migrationRunner)).resolves.toBeUndefined();
      const [rolledBack] = (await migrationRunner.query(
        `SELECT to_regclass('public.lead_commercial_cycles') IS NOT NULL AS "cyclesPresent",
          EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'leads'
              AND column_name = 'status') AS "leadStatusPresent"`,
      )) as Array<{ cyclesPresent: boolean; leadStatusPresent: boolean }>;
      expect(rolledBack).toEqual({
        cyclesPresent: false,
        leadStatusPresent: false,
      });

      const organizationId = randomUUID();
      const userId = randomUUID();
      const membershipId = randomUUID();
      const key = randomUUID();
      await migrationRunner.query(
        `INSERT INTO public.organizations (id,name,slug,status)
         VALUES ($1::uuid,'Legacy CRM','legacy-crm-' || $1::text,'inactive')`,
        [organizationId],
      );
      await migrationRunner.query(
        `INSERT INTO public.users (id,email,name,status)
         VALUES ($1,$2,'Legacy owner','active')`,
        [userId, `legacy-${userId}@example.com`],
      );
      await migrationRunner.query(
        `INSERT INTO public.memberships
          (id,user_id,organization_id,role,status)
         VALUES ($1,$2,$3,'owner','active')`,
        [membershipId, userId, organizationId],
      );
      await migrationRunner.query(
        `UPDATE public.organizations SET status = 'active' WHERE id = $1`,
        [organizationId],
      );
      const [legacy] = (await migrationRunner.query(
        `SELECT lead_id AS "leadId" FROM app_private.ingest_lead(
          $1::uuid,$2::uuid,$3::uuid,'manual','Legacy Lead','+5562666666666',
          NULL,NULL,NULL,NULL,NULL,NULL,'manual',NULL,NULL,NULL,NULL,NULL,NULL,
          $4::uuid,1::smallint,$5::text,$6::jsonb)`,
        [
          userId,
          membershipId,
          organizationId,
          key,
          '8'.repeat(64),
          JSON.stringify({ 1: '8'.repeat(64) }),
        ],
      )) as Array<{ leadId: string }>;
      await expect(migration.up(migrationRunner)).resolves.toBeUndefined();
      await migrationRunner.query('SET CONSTRAINTS ALL IMMEDIATE');
      await expect(
        followUpMigration.up(migrationRunner),
      ).resolves.toBeUndefined();
      await expect(
        financialMigration.up(migrationRunner),
      ).resolves.toBeUndefined();
      const [backfilled] = (await migrationRunner.query(
        `SELECT lead.status, lead.stage, lead.revision::text AS revision,
          cycle.cycle_number::text AS "cycleNumber",
          cycle.opening_reason AS "openingReason",
          cycle.opened_at = lead.created_at AS "openedAtMatches"
         FROM public.leads lead
         JOIN public.lead_commercial_cycles cycle ON cycle.lead_id = lead.id
         WHERE lead.id = $1`,
        [legacy?.leadId],
      )) as Array<{
        status: string;
        stage: string;
        revision: string;
        cycleNumber: string;
        openingReason: string;
        openedAtMatches: boolean;
      }>;
      expect(backfilled).toEqual({
        status: 'active',
        stage: 'new',
        revision: '1',
        cycleNumber: '1',
        openingReason: 'created',
        openedAtMatches: true,
      });
    } finally {
      await migrationRunner.rollbackTransaction();
    }
  });

  it('reverts and reapplies the financial migration before financial data exists', async () => {
    const migration = new ManageLeadCommercialCycleExpectedValue1788289200000();
    await migrationRunner.startTransaction();
    try {
      await expect(migration.down(migrationRunner)).resolves.toBeUndefined();
      const [removed] = (await migrationRunner.query(
        `SELECT
          EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'lead_commercial_cycles'
              AND column_name = 'expected_value_minor') AS "cycleColumn",
          EXISTS (SELECT 1 FROM pg_enum value
            JOIN pg_type type ON type.oid = value.enumtypid
            JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
            WHERE namespace.nspname = 'app_private'
              AND type.typname = 'lead_command_enum'
              AND value.enumlabel = 'set_expected_value') AS "commandValue",
          to_regprocedure('app_private.execute_lead_expected_value_command(uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,bigint)') IS NOT NULL AS "commandFunction"`,
      )) as Array<{
        cycleColumn: boolean;
        commandValue: boolean;
        commandFunction: boolean;
      }>;
      expect(removed).toEqual({
        cycleColumn: false,
        commandValue: false,
        commandFunction: false,
      });

      await expect(migration.up(migrationRunner)).resolves.toBeUndefined();
      const [restored] = (await migrationRunner.query(
        `SELECT current_setting('server_encoding') AS encoding,
          EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'lead_commercial_cycles'
              AND column_name = 'expected_value_minor' AND data_type = 'bigint'
              AND is_nullable = 'YES') AS "cycleColumn",
          to_regprocedure('app_private.execute_lead_expected_value_command(uuid,uuid,uuid,uuid,bigint,uuid,smallint,text,jsonb,bigint)') IS NOT NULL AS "commandFunction"`,
      )) as Array<{
        encoding: string;
        cycleColumn: boolean;
        commandFunction: boolean;
      }>;
      expect(restored).toEqual({
        encoding: 'UTF8',
        cycleColumn: true,
        commandFunction: true,
      });
    } finally {
      await migrationRunner.rollbackTransaction();
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

  it('replays the original intake after the lead phone changes without creating an orphan', async () => {
    const fixture = await createFixture();
    const key = randomUUID();
    const fingerprint = 'c'.repeat(64);
    const created = await ingest(fixture, key, fingerprint, 'manual');
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

    await expect(
      service.update(tenant, created.leadId, created.revision, {
        primaryPhone: '+5562888777666',
      }),
    ).resolves.toMatchObject({ revision: '2' });
    await expect(
      ingest(fixture, key, fingerprint, 'manual'),
    ).resolves.toMatchObject({
      leadId: created.leadId,
      revision: '2',
      replayed: true,
      responseStatus: 200,
    });

    const [counts] = await owner.query<
      Array<{ leads: string; cycles: string; entries: string }>
    >(
      `SELECT count(DISTINCT lead.id)::text AS leads,
              count(DISTINCT cycle.id)::text AS cycles,
              count(DISTINCT entry.id)::text AS entries
       FROM public.leads lead
       LEFT JOIN public.lead_commercial_cycles cycle ON cycle.lead_id = lead.id
       LEFT JOIN public.lead_entries entry ON entry.lead_id = lead.id
       WHERE lead.organization_id = $1`,
      [fixture.organization.id],
    );
    expect(counts).toEqual({ leads: '1', cycles: '1', entries: '1' });
  });

  it('rejects Unicode line separators at the database command boundary', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      'e'.repeat(64),
      'manual',
    );
    const fingerprint = 'f'.repeat(64);

    for (const separator of ['\u2028', '\u2029']) {
      await expect(
        runtime.query(
          `SELECT * FROM app_private.execute_lead_command(
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,'lose',$5::bigint,$6::uuid,
            1::smallint,$7::text,$8::jsonb,NULL,'other',NULL,$9::text)`,
          [
            fixture.users[0].id,
            fixture.memberships[0].id,
            fixture.organization.id,
            created.leadId,
            created.revision,
            randomUUID(),
            fingerprint,
            JSON.stringify({ 1: fingerprint }),
            `linha${separator}seguinte`,
          ],
        ),
      ).rejects.toMatchObject({ code: '22023' });
    }
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

    const activityKey = randomUUID();
    const performedAt = await databaseNow();
    const activity = await oldService.createActivity(
      tenant,
      first.lead?.id as string,
      '1',
      activityKey,
      {
        type: LeadActivityType.CALL,
        performedAt,
        outcome: 'Contato sob chave anterior',
      },
    );
    await expect(
      rotatedService.createActivity(
        tenant,
        first.lead?.id as string,
        '1',
        activityKey,
        {
          type: LeadActivityType.CALL,
          performedAt,
          outcome: 'Contato sob chave anterior',
        },
      ),
    ).resolves.toMatchObject({
      id: activity.id,
      revision: '2',
      replayed: true,
      responseStatus: 201,
    });
    const missingOldKeyConfig = leadConfig(
      2,
      new Map([[2, Buffer.alloc(32, 2)]]),
    );
    await expect(
      new OperationalLeadReadiness(
        missingOldKeyConfig,
        runtime,
      ).assertManualReady(),
    ).rejects.toMatchObject({ status: 503 });
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
      sort: LeadListSort.CREATED_AT_DESC,
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
      {
        limit: 25,
        unassigned: 'true',
        sort: LeadListSort.CREATED_AT_DESC,
      },
    );
    expect(memberInbox.items).toEqual([]);
  });

  it('serves operational projections from one authorized PostgreSQL snapshot', async () => {
    const fixture = await createFixture();
    const tenant = ownerTenant(fixture);
    const commands = createLeadService();
    const reads = createReadService();
    const assigned = await ingest(
      fixture,
      randomUUID(),
      '7'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      uniquePhone(),
    );
    const unassigned = await ingest(
      fixture,
      randomUUID(),
      '8'.repeat(64),
      'campaign',
      null,
      uniquePhone(),
    );
    await commands.update(tenant, assigned.leadId, '1', {
      displayName: 'Ágata Prime',
      companyName: 'Clínica Ágata',
      email: 'agata@example.com',
    });
    await commands.createNextAction(
      tenant,
      assigned.leadId,
      '2',
      randomUUID(),
      {
        type: LeadNextActionType.CALL,
        description: 'Confirmar proposta',
        dueAt: '2099-07-27T12:00:00.000Z',
      },
    );

    await owner.query(
      `UPDATE public.leads
       SET created_at = CASE id
         WHEN $1::uuid THEN '2026-07-27T10:00:00.000999Z'::timestamptz
         WHEN $2::uuid THEN '2026-07-27T10:00:00.000123Z'::timestamptz
       END
       WHERE organization_id = $3 AND id IN ($1::uuid, $2::uuid)`,
      [assigned.leadId, unassigned.leadId, fixture.organization.id],
    );
    const microsecondFirstPage = await reads.list(tenant, {
      limit: 1,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(microsecondFirstPage.items.map(({ id }) => id)).toEqual([
      assigned.leadId,
    ]);
    expect(microsecondFirstPage.page.nextCursor).toEqual(expect.any(String));
    const microsecondSecondPage = await reads.list(tenant, {
      limit: 1,
      sort: LeadListSort.CREATED_AT_DESC,
      cursor: microsecondFirstPage.page.nextCursor as string,
    });
    expect(microsecondSecondPage.items.map(({ id }) => id)).toEqual([
      unassigned.leadId,
    ]);

    const prefix = await reads.list(tenant, {
      q: 'ágata',
      limit: 25,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(prefix.items).toHaveLength(1);
    expect(prefix.items[0]).toMatchObject({
      id: assigned.leadId,
      displayName: 'Ágata Prime',
      temporalState: 'future',
    });
    expect(prefix.page).toMatchObject({ total: 1, nextCursor: null });

    const phone = await reads.list(tenant, {
      q: prefix.items[0]?.primaryPhone,
      limit: 25,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(phone.items.map(({ id }) => id)).toEqual([assigned.leadId]);

    const memberTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const memberVisible = await reads.list(memberTenant, {
      limit: 25,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(memberVisible.items.map(({ id }) => id)).toEqual([assigned.leadId]);

    // The complete operational query legitimately has multiple plans depending
    // on statistics and cardinality. Prove the index contract directly instead
    // of requiring PostgreSQL to choose one exact plan for that larger query.
    const [nextActionIndex] = await owner.query<
      Array<{
        schemaName: string;
        tableName: string;
        indexName: string;
        accessMethod: string;
        isValid: boolean;
        isReady: boolean;
        isUnique: boolean;
        keyColumns: string[];
        predicate: string;
        definition: string;
      }>
    >(
      `SELECT table_namespace.nspname AS "schemaName",
        table_relation.relname AS "tableName",
        index_relation.relname AS "indexName",
        access_method.amname AS "accessMethod",
        index_catalog.indisvalid AS "isValid",
        index_catalog.indisready AS "isReady",
        index_catalog.indisunique AS "isUnique",
        ARRAY(
          SELECT pg_get_indexdef(
            index_catalog.indexrelid,
            position.key_position,
            true
          )
          FROM generate_series(1, index_catalog.indnkeyatts)
            AS position(key_position)
          ORDER BY position.key_position
        ) AS "keyColumns",
        pg_get_expr(
          index_catalog.indpred,
          index_catalog.indrelid,
          true
        ) AS predicate,
        pg_get_indexdef(index_catalog.indexrelid) AS definition
       FROM pg_index index_catalog
       JOIN pg_class index_relation
         ON index_relation.oid = index_catalog.indexrelid
       JOIN pg_class table_relation
         ON table_relation.oid = index_catalog.indrelid
       JOIN pg_namespace table_namespace
         ON table_namespace.oid = table_relation.relnamespace
       JOIN pg_am access_method
         ON access_method.oid = index_relation.relam
       WHERE table_namespace.nspname = 'public'
         AND table_relation.relname = 'lead_next_actions'
         AND index_relation.relname =
           'idx_lead_next_actions_org_responsible_pending_due'`,
    );
    expect(nextActionIndex).toEqual({
      schemaName: 'public',
      tableName: 'lead_next_actions',
      indexName: 'idx_lead_next_actions_org_responsible_pending_due',
      accessMethod: 'btree',
      isValid: true,
      isReady: true,
      isUnique: false,
      keyColumns: [
        'organization_id',
        'responsible_membership_id',
        'due_at',
        'lead_id',
      ],
      predicate: "status = 'pending'::lead_next_action_status_enum",
      definition:
        "CREATE INDEX idx_lead_next_actions_org_responsible_pending_due ON public.lead_next_actions USING btree (organization_id, responsible_membership_id, due_at, lead_id) WHERE (status = 'pending'::lead_next_action_status_enum)",
    });

    const myActions = await reads.myActions(memberTenant, { limit: 25 });
    expect(myActions.items.map(({ id }) => id)).toEqual([assigned.leadId]);
    const queue = await reads.unassigned(tenant, { limit: 25 });
    expect(queue.items.map(({ id }) => id)).toEqual([unassigned.leadId]);
    const board = await reads.kanban(tenant, { limit: 20 });
    expect(board.columns).toHaveLength(5);
    expect(board.columns.reduce((sum, column) => sum + column.total, 0)).toBe(
      2,
    );
    const firstBoardPage = await reads.kanban(tenant, { limit: 1 });
    const newColumn = firstBoardPage.columns.find(
      ({ stage }) => stage === LeadStage.NEW,
    );
    expect(newColumn?.items.map(({ id }) => id)).toEqual([assigned.leadId]);
    expect(newColumn?.page.nextCursor).toEqual(expect.any(String));
    const secondBoardPage = await reads.kanban(tenant, {
      stage: LeadStage.NEW,
      cursor: newColumn?.page.nextCursor as string,
      limit: 1,
    });
    expect(secondBoardPage.columns[0]?.items.map(({ id }) => id)).toEqual([
      unassigned.leadId,
    ]);

    const detail = await reads.detail(tenant, assigned.leadId);
    expect(detail).toMatchObject({
      id: assigned.leadId,
      counts: { cycles: 1, activities: 0, notes: 0 },
      nextAction: { description: 'Confirmar proposta' },
    });
    const metrics = await reads.metrics(tenant, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(metrics.snapshot).toMatchObject({ active: 2, unassigned: 1 });
    expect(metrics.period.created).toBe(2);
    await expect(
      reads.metrics(memberTenant, { from: '2026-07-27', to: '2026-07-27' }),
    ).rejects.toMatchObject({ status: 403 });

    await commands.win(tenant, assigned.leadId, '3', randomUUID());
    const assignedPhone = prefix.items[0]?.primaryPhone;
    if (assignedPhone === undefined) throw new Error('Assigned phone missing.');
    await ingest(
      fixture,
      randomUUID(),
      '9'.repeat(64),
      'campaign',
      null,
      assignedPhone,
    );
    const reviews = await reads.returnReviews(tenant, { limit: 25 });
    expect(reviews.items).toHaveLength(1);
    expect(reviews.items[0]?.lead.id).toBe(assigned.leadId);

    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      status: MembershipStatus.INACTIVE,
    });
    await expect(
      reads.list(memberTenant, {
        limit: 25,
        sort: LeadListSort.CREATED_AT_DESC,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('aggregates the complete authorized Kanban snapshot with exact financial precision', async () => {
    const fixture = await createFixture();
    const otherFixture = await createFixture();
    const commands = createLeadService();
    const reads = createReadService();
    const ownerView = ownerTenant(fixture);
    const assigned = await ingest(
      fixture,
      randomUUID(),
      '1'.repeat(64),
      LeadSource.MANUAL,
      fixture.memberships[1].id,
      uniquePhone(),
    );
    await ingest(
      fixture,
      randomUUID(),
      '2'.repeat(64),
      LeadSource.CAMPAIGN,
      null,
      uniquePhone(),
    );
    const explicitZero = await ingest(
      fixture,
      randomUUID(),
      '3'.repeat(64),
      LeadSource.LEAD_MAGNET,
      null,
      uniquePhone(),
    );
    const proposalMaximum = await ingest(
      fixture,
      randomUUID(),
      '4'.repeat(64),
      LeadSource.MANUAL,
      null,
      uniquePhone(),
    );
    const negotiationMaximum = await ingest(
      fixture,
      randomUUID(),
      '5'.repeat(64),
      LeadSource.MANUAL,
      null,
      uniquePhone(),
    );
    const otherTenantMaximum = await ingest(
      otherFixture,
      randomUUID(),
      '6'.repeat(64),
      LeadSource.MANUAL,
      null,
      uniquePhone(),
    );

    await owner.query(
      `UPDATE public.lead_commercial_cycles cycle
       SET expected_value_minor = CASE cycle.lead_id
         WHEN $1::uuid THEN 7::bigint
         WHEN $2::uuid THEN 0::bigint
         WHEN $3::uuid THEN 9223372036854775807::bigint
         WHEN $4::uuid THEN 9223372036854775807::bigint
         ELSE cycle.expected_value_minor
       END
       WHERE cycle.organization_id = $5
         AND cycle.lead_id = ANY($6::uuid[])`,
      [
        assigned.leadId,
        explicitZero.leadId,
        proposalMaximum.leadId,
        negotiationMaximum.leadId,
        fixture.organization.id,
        [
          assigned.leadId,
          explicitZero.leadId,
          proposalMaximum.leadId,
          negotiationMaximum.leadId,
        ],
      ],
    );
    await owner.query(
      `UPDATE public.lead_commercial_cycles
       SET expected_value_minor = 9223372036854775807::bigint
       WHERE organization_id = $1 AND lead_id = $2`,
      [otherFixture.organization.id, otherTenantMaximum.leadId],
    );
    await commands.move(
      ownerView,
      explicitZero.leadId,
      explicitZero.revision,
      randomUUID(),
      LeadStage.PROPOSAL,
    );
    await commands.move(
      ownerView,
      proposalMaximum.leadId,
      proposalMaximum.revision,
      randomUUID(),
      LeadStage.PROPOSAL,
    );
    await commands.move(
      ownerView,
      negotiationMaximum.leadId,
      negotiationMaximum.revision,
      randomUUID(),
      LeadStage.NEGOTIATION,
    );
    const [proposalLead] = await owner.query<Array<{ phone: string }>>(
      `SELECT primary_phone AS phone FROM public.leads WHERE id = $1`,
      [proposalMaximum.leadId],
    );
    if (proposalLead === undefined) throw new Error('Proposal lead missing.');
    await ingest(
      fixture,
      randomUUID(),
      '7'.repeat(64),
      LeadSource.CAMPAIGN,
      null,
      proposalLead.phone,
    );

    const board = await reads.kanban(ownerView, { limit: 20 });
    expect(board).toMatchObject({
      currency: 'BRL',
      expectedValueTotalMinor: '18446744073709551621',
      withoutExpectedValue: 1,
    });
    expect(board.columns).toHaveLength(5);
    expect(board.columns.reduce((sum, column) => sum + column.total, 0)).toBe(
      5,
    );
    expect(
      board.columns.find(({ stage }) => stage === LeadStage.NEW),
    ).toMatchObject({
      total: 2,
      expectedValueTotalMinor: '7',
      withoutExpectedValue: 1,
    });
    expect(
      board.columns.find(({ stage }) => stage === LeadStage.PROPOSAL),
    ).toMatchObject({
      total: 2,
      expectedValueTotalMinor: '9223372036854775807',
      withoutExpectedValue: 0,
    });
    expect(
      board.columns.find(({ stage }) => stage === LeadStage.NEGOTIATION),
    ).toMatchObject({
      total: 1,
      expectedValueTotalMinor: '9223372036854775807',
      withoutExpectedValue: 0,
    });
    expect(
      board.columns.find(({ stage }) => stage === LeadStage.DIAGNOSIS),
    ).toMatchObject({
      total: 0,
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 0,
    });

    const firstPage = await reads.kanban(ownerView, { limit: 1 });
    expect(firstPage).toMatchObject({
      expectedValueTotalMinor: board.expectedValueTotalMinor,
      withoutExpectedValue: board.withoutExpectedValue,
    });
    const newColumn = firstPage.columns.find(
      ({ stage }) => stage === LeadStage.NEW,
    );
    expect(newColumn?.page.nextCursor).toEqual(expect.any(String));
    const continuation = await reads.kanban(ownerView, {
      stage: LeadStage.NEW,
      cursor: newColumn?.page.nextCursor as string,
      limit: 1,
    });
    expect(continuation).toMatchObject({
      expectedValueTotalMinor: board.expectedValueTotalMinor,
      withoutExpectedValue: board.withoutExpectedValue,
      columns: [
        expect.objectContaining({
          stage: LeadStage.NEW,
          total: 2,
          expectedValueTotalMinor: '7',
          withoutExpectedValue: 1,
        }),
      ],
    });

    const missingOnly = await reads.kanban(ownerView, {
      source: LeadSource.CAMPAIGN,
      limit: 20,
    });
    expect(missingOnly).toMatchObject({
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 1,
    });
    expect(
      missingOnly.columns.find(({ stage }) => stage === LeadStage.NEW),
    ).toMatchObject({
      total: 1,
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 1,
    });
    const explicitZeroOnly = await reads.kanban(ownerView, {
      source: LeadSource.LEAD_MAGNET,
      limit: 20,
    });
    expect(explicitZeroOnly).toMatchObject({
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 0,
    });
    expect(
      explicitZeroOnly.columns.find(
        ({ stage }) => stage === LeadStage.PROPOSAL,
      ),
    ).toMatchObject({
      total: 1,
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 0,
    });
    const empty = await reads.kanban(ownerView, {
      source: LeadSource.LANDING_PAGE,
      limit: 20,
    });
    expect(empty).toMatchObject({
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 0,
    });
    expect(empty.columns).toHaveLength(5);
    expect(
      empty.columns.every(
        (column) =>
          column.total === 0 &&
          column.expectedValueTotalMinor === '0' &&
          column.withoutExpectedValue === 0,
      ),
    ).toBe(true);

    const memberView = await reads.kanban(
      {
        userId: fixture.users[1].id,
        membershipId: fixture.memberships[1].id,
        organizationId: fixture.organization.id,
        role: MembershipRole.MEMBER,
      },
      { limit: 20 },
    );
    expect(memberView).toMatchObject({
      expectedValueTotalMinor: '7',
      withoutExpectedValue: 0,
    });
    expect(
      memberView.columns.reduce((sum, column) => sum + column.total, 0),
    ).toBe(1);

    const adminUser = await owner.getRepository(User).save({
      email: `lead-admin-${randomUUID()}@example.com`,
      name: 'Lead admin',
      status: UserStatus.ACTIVE,
    });
    const adminMembership = await owner.getRepository(Membership).save({
      userId: adminUser.id,
      organizationId: fixture.organization.id,
      role: MembershipRole.ADMIN,
      status: MembershipStatus.ACTIVE,
    });
    await expect(
      reads.kanban(
        {
          userId: adminUser.id,
          membershipId: adminMembership.id,
          organizationId: fixture.organization.id,
          role: MembershipRole.ADMIN,
        },
        { limit: 20 },
      ),
    ).resolves.toMatchObject({
      expectedValueTotalMinor: board.expectedValueTotalMinor,
      withoutExpectedValue: board.withoutExpectedValue,
    });

    await expect(
      reads.kanban(ownerTenant(otherFixture), { limit: 20 }),
    ).resolves.toMatchObject({
      expectedValueTotalMinor: '9223372036854775807',
      withoutExpectedValue: 0,
    });
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

  it('runs the commercial lifecycle, aggregates closed returns, and preserves immutable cycles', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      '3'.repeat(64),
      'campaign',
      fixture.memberships[1].id,
      '+5562888888888',
    );
    const config = leadConfig();
    const service = new LeadsService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      new OperationalLeadReadiness(config, runtime),
    );
    const ownerTenant = {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const memberTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };

    const moveKey = randomUUID();
    await expect(
      service.move(
        ownerTenant,
        created.leadId,
        created.revision,
        moveKey,
        LeadStage.QUALIFICATION,
      ),
    ).resolves.toMatchObject({ revision: '2', replayed: false });
    await expect(
      service.move(
        ownerTenant,
        created.leadId,
        created.revision,
        moveKey,
        LeadStage.QUALIFICATION,
      ),
    ).resolves.toMatchObject({ revision: '2', replayed: true });

    await expect(
      service.lose(ownerTenant, created.leadId, '2', randomUUID(), {
        lostReason: LeadLostReason.OTHER,
        reasonNote: '  Decisão adiada pelo cliente  ',
      }),
    ).resolves.toMatchObject({ revision: '3', replayed: false });

    await ingest(
      fixture,
      randomUUID(),
      '4'.repeat(64),
      'lead_magnet',
      null,
      '+5562888888888',
    );
    await ingest(
      fixture,
      randomUUID(),
      '5'.repeat(64),
      'landing_page',
      null,
      '+5562888888888',
    );
    const closed = await service.get(ownerTenant, created.leadId);
    expect(closed).toMatchObject({
      status: 'lost',
      stage: LeadStage.QUALIFICATION,
      revision: '5',
      returnReviewPending: true,
    });
    const [review] = await owner.query<
      Array<{ entryCount: string; receivedEvents: string }>
    >(
      `SELECT review.entry_count::text AS "entryCount",
        (SELECT count(*)::text FROM public.lead_timeline_events event
          WHERE event.return_review_id = review.id
            AND event.event_type = 'lead.return.received') AS "receivedEvents"
       FROM public.lead_return_reviews review
       WHERE review.lead_id = $1 AND review.status = 'pending'`,
      [created.leadId],
    );
    expect(review).toEqual({ entryCount: '2', receivedEvents: '1' });

    await expect(
      service.reactivate(ownerTenant, created.leadId, '5', randomUUID()),
    ).resolves.toMatchObject({ revision: '6', replayed: false });
    const active = await service.get(ownerTenant, created.leadId);
    expect(active).toMatchObject({
      status: 'active',
      stage: LeadStage.QUALIFICATION,
      latestCycleNumber: '2',
      returnReviewPending: false,
    });
    const cycles = await service.cycles(ownerTenant, created.leadId, {
      limit: 20,
    });
    expect(cycles.items).toHaveLength(2);
    expect(cycles.items[0]).toMatchObject({
      cycleNumber: '2',
      openingReason: 'reactivated',
      closingStatus: null,
    });
    expect(cycles.items[1]).toMatchObject({
      cycleNumber: '1',
      closingStatus: 'lost',
      lostReason: LeadLostReason.OTHER,
      reasonNote: 'Decisão adiada pelo cliente',
    });

    await expect(
      service.win(memberTenant, created.leadId, '6', randomUUID()),
    ).resolves.toMatchObject({ revision: '7' });
    await expect(
      service.update(memberTenant, created.leadId, '7', {
        displayName: 'Closed member edit',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.assign(ownerTenant, created.leadId, '7', null),
    ).resolves.toMatchObject({ revision: '8', responsibleMembershipId: null });
    await expect(
      service.get(memberTenant, created.leadId),
    ).rejects.toMatchObject({ status: 404 });
    await ingest(
      fixture,
      randomUUID(),
      '7'.repeat(64),
      'landing_page',
      null,
      '+5562888888888',
    );
    await expect(
      service.dismissReturn(ownerTenant, created.leadId, '9', randomUUID()),
    ).resolves.toMatchObject({ revision: '10' });
    await expect(
      service.get(ownerTenant, created.leadId),
    ).resolves.toMatchObject({
      status: 'won',
      stage: LeadStage.QUALIFICATION,
      returnReviewPending: false,
      revision: '10',
    });
  });

  it('persists, replays, clears, historizes, and projects expected cycle value exactly', async () => {
    const fixture = await createFixture();
    const phone = '+5562555555555';
    const created = await ingest(
      fixture,
      randomUUID(),
      'a'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      phone,
    );
    const config = leadConfig();
    const readiness = new OperationalLeadReadiness(config, runtime);
    const service = new LeadsService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      readiness,
    );
    const reads = new LeadOperationalReadService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      readiness,
    );
    const ownerTenant = {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const memberTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };

    await expect(
      service.cycles(ownerTenant, created.leadId, { limit: 20 }),
    ).resolves.toMatchObject({
      items: [{ expectedValueMinor: null }],
    });
    await expect(
      owner.query(
        `UPDATE public.lead_commercial_cycles
         SET expected_value_minor = -1 WHERE lead_id = $1`,
        [created.leadId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });

    const incompleteKey = randomUUID();
    const incompleteInput = {
      organizationId: memberTenant.organizationId,
      actorMembershipId: memberTenant.membershipId,
      leadId: created.leadId,
      expectedRevision: created.revision,
      expectedValueMinor: '10',
    };
    await owner.query(
      `INSERT INTO public.lead_command_idempotency (
        organization_id, actor_membership_id, lead_id, command,
        idempotency_key, fingerprint_key_version, request_fingerprint, status
      ) VALUES ($1,$2,$3,'set_expected_value',$4,1,$5,'processing')`,
      [
        memberTenant.organizationId,
        memberTenant.membershipId,
        created.leadId,
        incompleteKey,
        leadExpectedValueFingerprint(
          incompleteInput,
          config.idempotencyKeys.get(1) as Buffer,
        ),
      ],
    );
    await expect(
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        created.revision,
        incompleteKey,
        { expectedValueMinor: '10' },
      ),
    ).rejects.toMatchObject({ status: 503 });

    const originalKey = randomUUID();
    await expect(
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        created.revision,
        originalKey,
        { expectedValueMinor: '9007199254740993' },
      ),
    ).resolves.toEqual({
      revision: '2',
      replayed: false,
      responseStatus: 204,
    });
    await expect(
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        created.revision,
        originalKey,
        { expectedValueMinor: '9007199254740993' },
      ),
    ).resolves.toEqual({
      revision: '2',
      replayed: true,
      responseStatus: 204,
    });
    await expect(
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        '2',
        randomUUID(),
        { expectedValueMinor: '9007199254740993' },
      ),
    ).resolves.toEqual({
      revision: '2',
      replayed: false,
      responseStatus: 204,
    });
    await expect(
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        created.revision,
        originalKey,
        { expectedValueMinor: '1' },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        created.revision,
        randomUUID(),
        { expectedValueMinor: '1' },
      ),
    ).rejects.toMatchObject({ status: 412 });

    const detail = await reads.detail(ownerTenant, created.leadId);
    expect(detail.latestCycle.expectedValueMinor).toBe('9007199254740993');
    const cycles = await reads.cycles(ownerTenant, created.leadId, {
      limit: 20,
    });
    expect(cycles.items[0]?.expectedValueMinor).toBe('9007199254740993');
    const list = await reads.list(ownerTenant, {
      limit: 25,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(
      list.items.find((item) => item.id === created.leadId)?.expectedValueMinor,
    ).toBe('9007199254740993');
    const kanban = await reads.kanban(ownerTenant, { limit: 20 });
    expect(
      kanban.columns
        .flatMap((column) => column.items)
        .find((item) => item.id === created.leadId)?.expectedValueMinor,
    ).toBe('9007199254740993');
    const timeline = await service.timeline(ownerTenant, created.leadId, {
      limit: 50,
    });
    const financialEvents = timeline.items.filter(
      (event) => event.eventType === 'lead.expected_value.changed',
    );
    expect(financialEvents).toEqual([
      expect.objectContaining({
        cycleId: detail.latestCycle.id,
        previousExpectedValueMinor: null,
        newExpectedValueMinor: '9007199254740993',
      }),
    ]);

    await expect(
      service.setExpectedValue(ownerTenant, created.leadId, '2', randomUUID(), {
        expectedValueMinor: null,
      }),
    ).resolves.toMatchObject({ revision: '3', replayed: false });
    await expect(
      service.setExpectedValue(ownerTenant, created.leadId, '3', randomUUID(), {
        expectedValueMinor: '0',
      }),
    ).resolves.toMatchObject({ revision: '4', replayed: false });
    await expect(
      service.setExpectedValue(ownerTenant, created.leadId, '4', randomUUID(), {
        expectedValueMinor: '125000',
      }),
    ).resolves.toMatchObject({ revision: '5', replayed: false });

    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      role: MembershipRole.ADMIN,
    });
    const adminTenant = { ...memberTenant, role: MembershipRole.ADMIN };
    await expect(
      service.setExpectedValue(adminTenant, created.leadId, '5', randomUUID(), {
        expectedValueMinor: '125001',
      }),
    ).resolves.toMatchObject({ revision: '6' });

    const duplicate = await ingest(
      fixture,
      randomUUID(),
      'b'.repeat(64),
      'campaign',
      null,
      phone,
    );
    expect(duplicate.leadId).toBe(created.leadId);
    expect(
      (await reads.detail(ownerTenant, created.leadId)).latestCycle
        .expectedValueMinor,
    ).toBe('125001');

    await expect(
      service.win(
        ownerTenant,
        created.leadId,
        duplicate.revision,
        randomUUID(),
      ),
    ).resolves.toMatchObject({ replayed: false });
    const closed = await service.get(ownerTenant, created.leadId);
    await expect(
      service.setExpectedValue(
        ownerTenant,
        created.leadId,
        closed.revision,
        randomUUID(),
        { expectedValueMinor: '2' },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      owner.query(
        `UPDATE public.lead_commercial_cycles
         SET expected_value_minor = 2
         WHERE lead_id = $1 AND closed_at IS NOT NULL`,
        [created.leadId],
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P3006' } });
    await expect(
      service.reactivate(
        ownerTenant,
        created.leadId,
        closed.revision,
        randomUUID(),
      ),
    ).resolves.toMatchObject({ replayed: false });
    const reactivatedCycles = await reads.cycles(ownerTenant, created.leadId, {
      limit: 20,
    });
    expect(reactivatedCycles.items[0]).toMatchObject({
      openingReason: 'reactivated',
      expectedValueMinor: null,
    });
    expect(reactivatedCycles.items[1]?.expectedValueMinor).toBe('125001');

    await expect(
      new ManageLeadCommercialCycleExpectedValue1788289200000().down(
        migrationRunner,
      ),
    ).rejects.toThrow(
      'Unsafe rollback: lead expected-value data or history already exists.',
    );
  });

  it('creates expected value atomically and rolls back either side of combined information edits', async () => {
    const fixture = await createFixture();
    const tenant = ownerTenant(fixture);
    const service = createLeadService();
    const reads = createReadService();
    const createKey = randomUUID();
    const phone = uniquePhone();
    const createInput = {
      displayName: 'Atomic creation',
      primaryPhone: phone,
      source: LeadSource.MANUAL,
      city: 'Goiânia',
      expectedValueMinor: '9007199254740993',
    };

    const created = await service.createManual(tenant, createInput, createKey);
    expect(created).toMatchObject({ responseStatus: 201, replayed: false });
    const leadId = created.lead?.id;
    if (leadId === undefined) throw new Error('Owner creation hid the Lead.');
    expect((await reads.detail(tenant, leadId)).latestCycle).toMatchObject({
      expectedValueMinor: '9007199254740993',
    });

    await service.setExpectedValue(
      tenant,
      leadId,
      created.lead?.revision ?? '',
      randomUUID(),
      { expectedValueMinor: '100' },
    );
    await expect(
      service.createManual(tenant, createInput, createKey),
    ).resolves.toMatchObject({ responseStatus: 200, replayed: true });
    await expect(
      service.createManual(
        tenant,
        { ...createInput, expectedValueMinor: '999' },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ responseStatus: 200, replayed: false });
    expect((await reads.detail(tenant, leadId)).latestCycle).toMatchObject({
      expectedValueMinor: '100',
    });

    const memberTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };
    const memberPhone = uniquePhone();
    await expect(
      service.createManual(
        memberTenant,
        {
          displayName: 'Opaque member creation',
          primaryPhone: memberPhone,
          source: LeadSource.MANUAL,
          expectedValueMinor: '0',
        },
        randomUUID(),
      ),
    ).resolves.toEqual({ responseStatus: 204, replayed: false, lead: null });
    const memberLead = await reads.list(tenant, {
      q: memberPhone,
      limit: 25,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(memberLead.items).toHaveLength(1);
    expect(memberLead.items[0]?.expectedValueMinor).toBe('0');

    const internals = service as unknown as {
      executeExpectedValue: (...args: unknown[]) => Promise<unknown>;
      executeLeadUpdate: (...args: unknown[]) => Promise<unknown>;
    };
    const originalExpected = internals.executeExpectedValue.bind(service);
    const originalUpdate = internals.executeLeadUpdate.bind(service);

    const rollbackPhone = uniquePhone();
    internals.executeExpectedValue = () =>
      Promise.reject(new Error('forced initial financial failure'));
    await expect(
      service.createManual(
        tenant,
        {
          displayName: 'Must roll back',
          primaryPhone: rollbackPhone,
          source: LeadSource.MANUAL,
          expectedValueMinor: '1',
        },
        randomUUID(),
      ),
    ).rejects.toThrow('forced initial financial failure');
    internals.executeExpectedValue = originalExpected;
    const rolledBackCreation = await reads.list(tenant, {
      q: rollbackPhone,
      limit: 25,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    expect(rolledBackCreation.items).toHaveLength(0);

    const beforeCombined = await reads.detail(tenant, leadId);
    const combinedKey = randomUUID();
    const combinedBody = {
      displayName: beforeCombined.displayName,
      primaryPhone: beforeCombined.primaryPhone,
      email: beforeCombined.email,
      companyName: beforeCombined.companyName,
      instagram: beforeCombined.instagram,
      city: 'Anápolis',
      serviceInterest: beforeCombined.serviceInterest,
      expectedValueMinor: '200',
    };
    const combined = await service.updateInformation(
      tenant,
      leadId,
      beforeCombined.revision,
      combinedKey,
      combinedBody,
    );
    expect(combined).toMatchObject({ replayed: false });
    expect(combined.lead).toMatchObject({ city: 'Anápolis' });
    expect((await reads.detail(tenant, leadId)).latestCycle).toMatchObject({
      expectedValueMinor: '200',
    });
    await expect(
      service.updateInformation(
        tenant,
        leadId,
        beforeCombined.revision,
        combinedKey,
        combinedBody,
      ),
    ).resolves.toMatchObject({ replayed: true });

    const beforePartial = await reads.detail(tenant, leadId);
    const partialKey = randomUUID();
    const partialBody = {
      city: 'Goiânia',
      expectedValueMinor: '250',
    };
    await expect(
      service.updateInformation(
        tenant,
        leadId,
        beforePartial.revision,
        partialKey,
        partialBody,
      ),
    ).resolves.toMatchObject({ replayed: false });
    const afterPartial = await reads.detail(tenant, leadId);
    await service.update(tenant, leadId, afterPartial.revision, {
      companyName: 'Concurrent edit',
    });
    await expect(
      service.updateInformation(
        tenant,
        leadId,
        beforePartial.revision,
        partialKey,
        partialBody,
      ),
    ).resolves.toMatchObject({
      replayed: true,
      lead: { city: 'Goiânia', companyName: 'Concurrent edit' },
    });

    const beforeCommonFailure = await reads.detail(tenant, leadId);
    const commonFailureKey = randomUUID();
    internals.executeLeadUpdate = () =>
      Promise.reject(new Error('forced common failure'));
    await expect(
      service.updateInformation(
        tenant,
        leadId,
        beforeCommonFailure.revision,
        commonFailureKey,
        { ...combinedBody, city: 'Brasília', expectedValueMinor: '300' },
      ),
    ).rejects.toThrow('forced common failure');
    internals.executeLeadUpdate = originalUpdate;
    const afterCommonFailure = await reads.detail(tenant, leadId);
    expect(afterCommonFailure).toMatchObject({
      city: beforeCommonFailure.city,
      revision: beforeCommonFailure.revision,
    });
    expect(afterCommonFailure.latestCycle.expectedValueMinor).toBe('200');
    await expect(
      service.updateInformation(
        tenant,
        leadId,
        beforeCommonFailure.revision,
        commonFailureKey,
        { ...combinedBody, city: 'Brasília', expectedValueMinor: '300' },
      ),
    ).resolves.toMatchObject({ replayed: false });

    const beforeFinancialFailure = await reads.detail(tenant, leadId);
    internals.executeExpectedValue = () =>
      Promise.reject(new Error('forced financial failure'));
    await expect(
      service.updateInformation(
        tenant,
        leadId,
        beforeFinancialFailure.revision,
        randomUUID(),
        { ...combinedBody, city: 'Palmas', expectedValueMinor: '400' },
      ),
    ).rejects.toThrow('forced financial failure');
    internals.executeExpectedValue = originalExpected;
    const afterFinancialFailure = await reads.detail(tenant, leadId);
    expect(afterFinancialFailure).toMatchObject({
      city: beforeFinancialFailure.city,
      revision: beforeFinancialFailure.revision,
    });
    expect(afterFinancialFailure.latestCycle.expectedValueMinor).toBe(
      beforeFinancialFailure.latestCycle.expectedValueMinor,
    );
  });

  it('preserves financial authorization, tenant isolation, and close-race serialization', async () => {
    const fixture = await createFixture();
    const otherTenant = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      'c'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      '+5562444444444',
    );
    const config = leadConfig();
    const service = new LeadsService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      new OperationalLeadReadiness(config, runtime),
    );
    const ownerTenant = {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const memberTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };
    const foreignTenant = {
      userId: otherTenant.users[1].id,
      membershipId: otherTenant.memberships[1].id,
      organizationId: otherTenant.organization.id,
      role: MembershipRole.MEMBER,
    };

    await expect(
      service.setExpectedValue(
        foreignTenant,
        created.leadId,
        created.revision,
        randomUUID(),
        { expectedValueMinor: '1' },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.assign(ownerTenant, created.leadId, created.revision, null),
    ).resolves.toMatchObject({ revision: '2' });
    await expect(
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        '2',
        randomUUID(),
        { expectedValueMinor: '1' },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const assigned = await service.assign(
      ownerTenant,
      created.leadId,
      '2',
      fixture.memberships[1].id,
    );
    const results = await Promise.allSettled([
      service.setExpectedValue(
        memberTenant,
        created.leadId,
        assigned.revision,
        randomUUID(),
        { expectedValueMinor: '500' },
      ),
      service.win(
        memberTenant,
        created.leadId,
        assigned.revision,
        randomUUID(),
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const current = await service.get(ownerTenant, created.leadId);
    const cycles = await service.cycles(ownerTenant, created.leadId, {
      limit: 20,
    });
    if (current.status === LeadStatus.ACTIVE) {
      expect(cycles.items[0]?.expectedValueMinor).toBe('500');
    } else {
      expect(current.status).toBe(LeadStatus.WON);
      expect(cycles.items[0]?.expectedValueMinor).toBeNull();
    }
  });

  it('serializes concurrent commands and records a same-stage move as an idempotent no-op', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      '6'.repeat(64),
      'manual',
      null,
      '+5562777777777',
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
    const qualificationKey = randomUUID();
    const proposalKey = randomUUID();
    const results = await Promise.allSettled([
      service.move(
        tenant,
        created.leadId,
        created.revision,
        qualificationKey,
        LeadStage.QUALIFICATION,
      ),
      service.move(
        tenant,
        created.leadId,
        created.revision,
        proposalKey,
        LeadStage.PROPOSAL,
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      (
        results.find(
          (result) => result.status === 'rejected',
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ status: 412 });

    const current = await service.get(tenant, created.leadId);
    const winningKey =
      current.stage === LeadStage.QUALIFICATION
        ? qualificationKey
        : proposalKey;
    const otherStage =
      current.stage === LeadStage.QUALIFICATION
        ? LeadStage.PROPOSAL
        : LeadStage.QUALIFICATION;
    await expect(
      service.move(
        tenant,
        created.leadId,
        created.revision,
        winningKey,
        otherStage,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.move(
        tenant,
        created.leadId,
        current.revision,
        randomUUID(),
        current.stage,
      ),
    ).resolves.toMatchObject({ revision: current.revision, replayed: false });
    const [counts] = await owner.query<
      Array<{ stageEvents: string; revision: string }>
    >(
      `SELECT count(event.id)::text AS "stageEvents", lead.revision::text AS revision
       FROM public.leads lead
       LEFT JOIN public.lead_timeline_events event ON event.lead_id = lead.id
         AND event.event_type = 'lead.stage.changed'
       WHERE lead.id = $1 GROUP BY lead.id`,
      [created.leadId],
    );
    expect(counts).toEqual({ stageEvents: '1', revision: '2' });
  });

  it('serializes competing move/close and win/lose commands and enforces command capabilities', async () => {
    const fixture = await createFixture();
    const config = leadConfig();
    const service = new LeadsService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      new OperationalLeadReadiness(config, runtime),
    );
    const ownerTenant = {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
    const memberTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };

    const moveClose = await ingest(
      fixture,
      randomUUID(),
      '9'.repeat(64),
      'campaign',
      fixture.memberships[1].id,
      '+5562555555551',
    );
    const moveCloseResults = await Promise.allSettled([
      service.move(
        ownerTenant,
        moveClose.leadId,
        moveClose.revision,
        randomUUID(),
        LeadStage.DIAGNOSIS,
      ),
      service.win(
        ownerTenant,
        moveClose.leadId,
        moveClose.revision,
        randomUUID(),
      ),
    ]);
    expect(
      moveCloseResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      moveCloseResults.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { status: 412 } });
    await expect(
      service.get(ownerTenant, moveClose.leadId),
    ).resolves.toMatchObject({ revision: '2' });

    const winLose = await ingest(
      fixture,
      randomUUID(),
      'a'.repeat(64),
      'lead_magnet',
      fixture.memberships[1].id,
      '+5562555555552',
    );
    const winLoseResults = await Promise.allSettled([
      service.win(memberTenant, winLose.leadId, winLose.revision, randomUUID()),
      service.lose(
        memberTenant,
        winLose.leadId,
        winLose.revision,
        randomUUID(),
        { lostReason: LeadLostReason.NO_BUDGET },
      ),
    ]);
    expect(
      winLoseResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      winLoseResults.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { status: 412 } });
    const closed = await service.get(ownerTenant, winLose.leadId);
    expect(closed.revision).toBe('2');
    expect(['won', 'lost']).toContain(closed.status);

    const archive = await ingest(
      fixture,
      randomUUID(),
      'b'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      '+5562555555553',
    );
    await expect(
      service.archive(
        memberTenant,
        archive.leadId,
        archive.revision,
        randomUUID(),
        { archiveReason: LeadArchiveReason.SPAM },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.archive(
        ownerTenant,
        archive.leadId,
        archive.revision,
        randomUUID(),
        { archiveReason: LeadArchiveReason.SPAM },
      ),
    ).resolves.toMatchObject({ revision: '2' });
    await expect(
      service.reactivate(ownerTenant, archive.leadId, '2', randomUUID()),
    ).resolves.toMatchObject({ revision: '3' });
    await expect(
      service.get(ownerTenant, archive.leadId),
    ).resolves.toMatchObject({
      status: 'active',
      stage: LeadStage.QUALIFICATION,
      latestCycleNumber: '2',
      returnReviewPending: false,
    });
  });

  it('persists activities, notes and the next action state machine with exact replay', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      'd'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      '+5562555555561',
    );
    const service = createLeadService();
    const tenant = ownerTenant(fixture);
    const performedAt = await databaseNow();
    const activityKey = randomUUID();
    const activity = await service.createActivity(
      tenant,
      created.leadId,
      created.revision,
      activityKey,
      {
        type: LeadActivityType.WHATSAPP,
        performedAt,
        outcome: '  Cliente confirmou interesse.\r\nRetornar amanhã.  ',
      },
    );
    expect(activity).toMatchObject({ revision: '2', responseStatus: 201 });
    await expect(
      service.createActivity(
        tenant,
        created.leadId,
        created.revision,
        activityKey,
        {
          type: LeadActivityType.WHATSAPP,
          performedAt,
          outcome: '  Cliente confirmou interesse.\r\nRetornar amanhã.  ',
        },
      ),
    ).resolves.toMatchObject({
      id: activity.id,
      revision: '2',
      replayed: true,
    });

    const note = await service.createNote(
      tenant,
      created.leadId,
      '2',
      randomUUID(),
      { content: '  Prefere contato à tarde.\r\nSócia participa.  ' },
    );
    expect(note).toMatchObject({ revision: '3', responseStatus: 201 });

    const overdue = new Date(Date.now() - 60_000).toISOString();
    const action = await service.createNextAction(
      tenant,
      created.leadId,
      '3',
      randomUUID(),
      {
        type: LeadNextActionType.INTERNAL_TASK,
        description: 'Preparar diagnóstico interno',
        dueAt: overdue,
      },
    );
    expect(action).toMatchObject({ revision: '4', responseStatus: 201 });
    await expect(
      runtime.query(
        `UPDATE public.lead_next_actions SET description = 'Bypass' WHERE id = $1`,
        [action.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
    await expect(
      owner.query(
        `UPDATE public.lead_next_actions SET description = 'Rewritten' WHERE id = $1`,
        [action.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P3006' } });
    await expect(
      owner.query(`DELETE FROM public.lead_notes WHERE id = $1`, [note.id]),
    ).rejects.toMatchObject({ driverError: { code: 'P3006' } });
    await expect(
      owner.query(`DELETE FROM public.lead_activities WHERE id = $1`, [
        activity.id,
      ]),
    ).rejects.toMatchObject({ driverError: { code: 'P3006' } });
    await expect(
      service.createNextAction(tenant, created.leadId, '4', randomUUID(), {
        type: LeadNextActionType.CALL,
        description: 'Segunda pendência',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.nextAction(tenant, created.leadId),
    ).resolves.toMatchObject({
      temporalState: 'overdue',
      item: { id: action.id, revision: '1' },
    });

    const future = new Date(Date.now() + 172_800_000).toISOString();
    await expect(
      service.rescheduleNextAction(tenant, created.leadId, '4', randomUUID(), {
        dueAt: future,
      }),
    ).resolves.toMatchObject({ revision: '5' });
    await expect(
      service.rescheduleNextAction(tenant, created.leadId, '5', randomUUID(), {
        dueAt: future,
      }),
    ).resolves.toMatchObject({ revision: '5', replayed: false });

    const completeKey = randomUUID();
    const completedAt = await databaseNow();
    await expect(
      service.completeNextAction(tenant, created.leadId, '5', completeKey, {
        performedAt: completedAt,
        outcome: 'Concluída',
      }),
    ).resolves.toMatchObject({ revision: '6', responseStatus: 204 });
    await expect(
      service.completeNextAction(tenant, created.leadId, '5', completeKey, {
        performedAt: completedAt,
        outcome: 'Concluída',
      }),
    ).resolves.toMatchObject({ revision: '6', replayed: true });
    const [counts] = await owner.query<
      Array<{ generated: string; completedEvents: string }>
    >(
      `SELECT
        (SELECT count(*)::text FROM public.lead_activities activity
          WHERE activity.next_action_id = $1) AS generated,
        (SELECT count(*)::text FROM public.lead_timeline_events event
          WHERE event.next_action_id = $1
            AND event.event_type = 'lead.next_action.completed') AS "completedEvents"`,
      [action.id],
    );
    expect(counts).toEqual({ generated: '1', completedEvents: '1' });
    await expect(
      service.nextAction(tenant, created.leadId),
    ).resolves.toMatchObject({
      item: null,
      temporalState: 'none',
      leadRevision: '6',
    });

    await service.createNote(tenant, created.leadId, '6', randomUUID(), {
      content: 'Evolução posterior à conclusão.',
    });
    await service.win(tenant, created.leadId, '7', randomUUID());
    await expect(
      service.completeNextAction(tenant, created.leadId, '5', completeKey, {
        performedAt: completedAt,
        outcome: 'Concluída',
      }),
    ).resolves.toMatchObject({
      revision: '6',
      replayed: true,
      responseStatus: 204,
    });

    const firstPage = await service.timeline(tenant, created.leadId, {
      limit: 2,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.page.nextCursor).not.toBeNull();
    const secondPage = await service.timeline(tenant, created.leadId, {
      limit: 100,
      cursor: firstPage.page.nextCursor as string,
    });
    const timelineItems = [...firstPage.items, ...secondPage.items];
    expect(new Set(timelineItems.map((event) => event.sequence)).size).toBe(
      firstPage.items.length + secondPage.items.length,
    );
    expect(
      timelineItems.find((event) => event.eventType === 'lead.activity.created')
        ?.activity?.performedAt,
    ).toBe(performedAt);
    expect(
      timelineItems.find(
        (event) => event.eventType === 'lead.next_action.completed',
      )?.activity?.performedAt,
    ).toBe(completedAt);
  });

  it('maps every completed next-action type to its canonical activity type', async () => {
    const mappings = [
      [LeadNextActionType.WHATSAPP, LeadActivityType.WHATSAPP],
      [LeadNextActionType.CALL, LeadActivityType.CALL],
      [LeadNextActionType.MEETING, LeadActivityType.MEETING],
      [LeadNextActionType.DIAGNOSIS, LeadActivityType.DIAGNOSIS],
      [LeadNextActionType.SEND_PROPOSAL, LeadActivityType.PROPOSAL_SENT],
      [LeadNextActionType.FOLLOW_UP, LeadActivityType.FOLLOW_UP],
      [LeadNextActionType.INTERNAL_TASK, LeadActivityType.INTERNAL_TASK],
    ] as const;
    for (const [nextActionType, expectedActivityType] of mappings) {
      const fixture = await createFixture();
      const service = createLeadService();
      const tenant = ownerTenant(fixture);
      const created = await ingest(
        fixture,
        randomUUID(),
        '9'.repeat(64),
        'manual',
        null,
        uniquePhone(),
      );
      const action = await service.createNextAction(
        tenant,
        created.leadId,
        '1',
        randomUUID(),
        {
          type: nextActionType,
          description: `Mapeamento ${nextActionType}`,
          dueAt: new Date(Date.now() + 60_000).toISOString(),
        },
      );
      await service.completeNextAction(
        tenant,
        created.leadId,
        '2',
        randomUUID(),
        { performedAt: await databaseNow() },
      );
      const [generated] = await owner.query<Array<{ type: string }>>(
        `SELECT type::text AS type FROM public.lead_activities
         WHERE next_action_id = $1`,
        [action.id],
      );
      expect({ nextActionType, generatedType: generated?.type }).toEqual({
        nextActionType,
        generatedType: expectedActivityType,
      });
    }
  });

  it('validates IANA organization timezones and derives today and future in PostgreSQL', async () => {
    const fixture = await createFixture();
    const [defaultZone] = await owner.query<Array<{ crmTimeZone: string }>>(
      `SELECT crm_time_zone AS "crmTimeZone" FROM public.organizations WHERE id = $1`,
      [fixture.organization.id],
    );
    expect(defaultZone).toEqual({ crmTimeZone: 'America/Belem' });
    await expect(
      owner.query(
        `UPDATE public.organizations SET crm_time_zone = 'Invalid/Timezone' WHERE id = $1`,
        [fixture.organization.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '22023' } });
    const [dstBoundary] = await owner.query<
      Array<{ beforeSpring: string; afterSpring: string }>
    >(
      `SELECT
        to_char('2026-03-08 06:59:00+00'::timestamptz AT TIME ZONE 'America/New_York',
          'YYYY-MM-DD HH24:MI') AS "beforeSpring",
        to_char('2026-03-08 07:01:00+00'::timestamptz AT TIME ZONE 'America/New_York',
          'YYYY-MM-DD HH24:MI') AS "afterSpring"`,
    );
    expect(dstBoundary).toEqual({
      beforeSpring: '2026-03-08 01:59',
      afterSpring: '2026-03-08 03:01',
    });
    await owner.query(
      `UPDATE public.organizations SET crm_time_zone = 'Pacific/Auckland' WHERE id = $1`,
      [fixture.organization.id],
    );
    const [deadlines] = await owner.query<
      Array<{ todayDue: Date; futureDue: Date }>
    >(
      `SELECT
        (((statement_timestamp() AT TIME ZONE crm_time_zone)::date
          + time '23:59:59.999999') AT TIME ZONE crm_time_zone) AS "todayDue",
        ((((statement_timestamp() AT TIME ZONE crm_time_zone)::date + 1)
          + time '12:00:00') AT TIME ZONE crm_time_zone) AS "futureDue"
       FROM public.organizations WHERE id = $1`,
      [fixture.organization.id],
    );
    const created = await ingest(
      fixture,
      randomUUID(),
      '7'.repeat(64),
      'manual',
      null,
      uniquePhone(),
    );
    const service = createLeadService();
    const tenant = ownerTenant(fixture);
    await runtime.query(`SET TIME ZONE 'America/Los_Angeles'`);
    await service.createNextAction(tenant, created.leadId, '1', randomUUID(), {
      type: LeadNextActionType.CALL,
      description: 'Ainda hoje na Organization',
      dueAt: deadlines.todayDue.toISOString(),
    });
    await expect(
      service.nextAction(tenant, created.leadId),
    ).resolves.toMatchObject({
      temporalState: 'today',
    });
    await service.cancelNextAction(tenant, created.leadId, '2', randomUUID(), {
      note: 'Mudança de prioridade',
    });
    const canceledTimeline = await service.timeline(tenant, created.leadId, {
      limit: 100,
    });
    expect(
      canceledTimeline.items.find(
        (event) => event.eventType === 'lead.next_action.canceled',
      )?.nextAction?.cancellationNote,
    ).toBe('Mudança de prioridade');
    await service.createNextAction(tenant, created.leadId, '3', randomUUID(), {
      type: LeadNextActionType.CALL,
      description: 'Amanhã na Organization',
      dueAt: deadlines.futureDue.toISOString(),
    });
    await expect(
      service.nextAction(tenant, created.leadId),
    ).resolves.toMatchObject({
      temporalState: 'future',
    });
    await runtime.query('RESET TIME ZONE');
  });

  it('transfers, clears and closes a pending action atomically', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      'e'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      '+5562555555562',
    );
    const service = createLeadService();
    const tenant = ownerTenant(fixture);
    const action = await service.createNextAction(
      tenant,
      created.leadId,
      created.revision,
      randomUUID(),
      {
        type: LeadNextActionType.CALL,
        description: 'Ligar para cliente',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    await expect(
      service.assign(tenant, created.leadId, '2', fixture.memberships[0].id),
    ).resolves.toMatchObject({ revision: '3' });
    let [pending] = await owner.query<
      Array<{ responsibleMembershipId: string | null; revision: string }>
    >(
      `SELECT responsible_membership_id AS "responsibleMembershipId",
              revision::text AS revision FROM public.lead_next_actions
       WHERE id = $1`,
      [action.id],
    );
    expect(pending).toEqual({
      responsibleMembershipId: fixture.memberships[0].id,
      revision: '2',
    });
    await service.assign(tenant, created.leadId, '3', null);
    [pending] = await owner.query(
      `SELECT responsible_membership_id AS "responsibleMembershipId",
              revision::text AS revision FROM public.lead_next_actions WHERE id = $1`,
      [action.id],
    );
    expect(pending).toEqual({ responsibleMembershipId: null, revision: '3' });
    await service.assign(
      tenant,
      created.leadId,
      '4',
      fixture.memberships[1].id,
    );
    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      status: MembershipStatus.INACTIVE,
    });
    const formerResponsibleTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };
    await expect(
      service.timeline(formerResponsibleTenant, created.leadId, { limit: 50 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.nextAction(formerResponsibleTenant, created.leadId),
    ).rejects.toMatchObject({ status: 404 });
    [pending] = await owner.query(
      `SELECT responsible_membership_id AS "responsibleMembershipId",
              revision::text AS revision FROM public.lead_next_actions WHERE id = $1`,
      [action.id],
    );
    expect(pending).toEqual({ responsibleMembershipId: null, revision: '5' });

    const current = await service.get(tenant, created.leadId);
    await service.win(tenant, created.leadId, current.revision, randomUUID());
    const [closed] = await owner.query<
      Array<{ status: string; reason: string; closeEvents: string }>
    >(
      `SELECT action.status, action.cancellation_reason AS reason,
        (SELECT count(*)::text FROM public.lead_timeline_events event
          WHERE event.lead_id = action.lead_id AND event.next_action_id = action.id
            AND event.event_type = 'lead.won') AS "closeEvents"
       FROM public.lead_next_actions action WHERE action.id = $1`,
      [action.id],
    );
    expect(closed).toEqual({
      status: 'canceled',
      reason: 'lead_closed',
      closeEvents: '1',
    });
    await service.reactivate(
      tenant,
      created.leadId,
      String(BigInt(current.revision) + 1n),
      randomUUID(),
    );
    await expect(
      service.nextAction(tenant, created.leadId),
    ).resolves.toMatchObject({
      item: null,
      temporalState: 'none',
    });
  });

  it('denies exact replay after assignment loss and user offboarding', async () => {
    const fixture = await createFixture();
    const service = createLeadService();
    const tenant = ownerTenant(fixture);
    const memberTenant = {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };
    const created = await ingest(
      fixture,
      randomUUID(),
      '8'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      uniquePhone(),
    );
    const noteKey = randomUUID();
    await service.createNote(memberTenant, created.leadId, '1', noteKey, {
      content: 'Replay depende de visibilidade atual',
    });
    await service.assign(tenant, created.leadId, '2', null);
    await expect(
      service.createNote(memberTenant, created.leadId, '1', noteKey, {
        content: 'Replay depende de visibilidade atual',
      }),
    ).rejects.toMatchObject({ status: 404 });

    await service.assign(
      tenant,
      created.leadId,
      '3',
      fixture.memberships[1].id,
    );
    const actionKey = randomUUID();
    const actionInput = {
      type: LeadNextActionType.CALL,
      description: 'Ação do usuário ativo',
      dueAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await service.createNextAction(
      memberTenant,
      created.leadId,
      '4',
      actionKey,
      actionInput,
    );
    await owner.getRepository(User).update(fixture.users[1].id, {
      status: UserStatus.INACTIVE,
    });
    await expect(
      service.createNextAction(
        memberTenant,
        created.leadId,
        '4',
        actionKey,
        actionInput,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const [state] = await owner.query<
      Array<{
        userStatus: string;
        leadResponsible: string | null;
        pendingResponsible: string | null;
      }>
    >(
      `SELECT application_user.status AS "userStatus",
              lead.responsible_membership_id AS "leadResponsible",
              action.responsible_membership_id AS "pendingResponsible"
       FROM public.users application_user
       JOIN public.leads lead ON lead.organization_id = $2 AND lead.id = $3
       LEFT JOIN public.lead_next_actions action ON action.lead_id = lead.id
         AND action.status = 'pending'
       WHERE application_user.id = $1`,
      [fixture.users[1].id, fixture.organization.id, created.leadId],
    );
    expect(state).toEqual({
      userStatus: 'inactive',
      leadResponsible: null,
      pendingResponsible: null,
    });
  });

  it('allows owner closed-history records, denies member writes, and serializes complete versus reschedule', async () => {
    const fixture = await createFixture();
    const created = await ingest(
      fixture,
      randomUUID(),
      'f'.repeat(64),
      'manual',
      fixture.memberships[1].id,
      '+5562555555563',
    );
    const service = createLeadService();
    const tenant = ownerTenant(fixture);
    await service.win(tenant, created.leadId, created.revision, randomUUID());
    const [cycle] = await owner.query<Array<{ closedAt: Date }>>(
      `SELECT closed_at AS "closedAt" FROM public.lead_commercial_cycles
       WHERE lead_id = $1 ORDER BY cycle_number DESC LIMIT 1`,
      [created.leadId],
    );
    await expect(
      service.createActivity(tenant, created.leadId, '2', randomUUID(), {
        type: LeadActivityType.CALL,
        performedAt: cycle.closedAt.toISOString(),
      }),
    ).resolves.toMatchObject({ revision: '3' });
    await expect(
      service.createActivity(tenant, created.leadId, '3', randomUUID(), {
        type: LeadActivityType.CALL,
        performedAt: new Date(cycle.closedAt.getTime() + 1).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.createNote(tenant, created.leadId, '3', randomUUID(), {
        content: 'Registro administrativo após fechamento.',
      }),
    ).resolves.toMatchObject({ revision: '4' });
    await expect(
      service.createNote(
        {
          userId: fixture.users[1].id,
          membershipId: fixture.memberships[1].id,
          organizationId: fixture.organization.id,
          role: MembershipRole.MEMBER,
        },
        created.leadId,
        '4',
        randomUUID(),
        { content: 'Member não pode.' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.createActivity(
        {
          userId: fixture.users[1].id,
          membershipId: fixture.memberships[1].id,
          organizationId: fixture.organization.id,
          role: MembershipRole.MEMBER,
        },
        created.leadId,
        '4',
        randomUUID(),
        {
          type: LeadActivityType.CALL,
          performedAt: cycle.closedAt.toISOString(),
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const foreignFixture = await createFixture();
    await expect(
      service.createNote(
        ownerTenant(foreignFixture),
        created.leadId,
        '4',
        randomUUID(),
        { content: 'Cross tenant.' },
      ),
    ).rejects.toMatchObject({ status: 404 });

    await owner.getRepository(Membership).update(fixture.memberships[1].id, {
      role: MembershipRole.ADMIN,
    });
    await expect(
      service.createNote(
        {
          userId: fixture.users[1].id,
          membershipId: fixture.memberships[1].id,
          organizationId: fixture.organization.id,
          role: MembershipRole.ADMIN,
        },
        created.leadId,
        '4',
        randomUUID(),
        { content: 'Registro administrativo do admin.' },
      ),
    ).resolves.toMatchObject({ revision: '5' });

    const raceLead = await ingest(
      fixture,
      randomUUID(),
      '1'.repeat(64),
      'manual',
      null,
      '+5562555555564',
    );
    await service.createNextAction(
      tenant,
      raceLead.leadId,
      raceLead.revision,
      randomUUID(),
      {
        type: LeadNextActionType.MEETING,
        description: 'Reunião de diagnóstico',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const results = await Promise.allSettled([
      service.completeNextAction(tenant, raceLead.leadId, '2', randomUUID(), {
        performedAt: await databaseNow(),
      }),
      service.rescheduleNextAction(tenant, raceLead.leadId, '2', randomUUID(), {
        dueAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: { status: 412 },
    });
  });

  it('serializes every competing Next Action state command by the Lead revision', async () => {
    const scenarios: Array<{
      name: string;
      run: (
        service: LeadsService,
        tenant: ReturnType<typeof ownerTenant>,
        leadId: string,
      ) =>
        | PromiseSettledResult<unknown>[]
        | Promise<PromiseSettledResult<unknown>[]>;
    }> = [
      {
        name: 'create × create',
        run: (service, tenant, leadId) =>
          Promise.allSettled([
            service.createNextAction(tenant, leadId, '1', randomUUID(), {
              type: LeadNextActionType.CALL,
              description: 'Primeira ligação',
              dueAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            service.createNextAction(tenant, leadId, '1', randomUUID(), {
              type: LeadNextActionType.MEETING,
              description: 'Primeira reunião',
              dueAt: new Date(Date.now() + 120_000).toISOString(),
            }),
          ]),
      },
    ];

    for (const scenario of scenarios) {
      const fixture = await createFixture();
      const created = await ingest(
        fixture,
        randomUUID(),
        '2'.repeat(64),
        'manual',
        null,
        uniquePhone(),
      );
      const results = await scenario.run(
        createLeadService(),
        ownerTenant(fixture),
        created.leadId,
      );
      expectSingleStaleWinner(scenario.name, results);
    }

    const pairScenarios = [
      'reschedule × reschedule',
      'complete × cancel',
      'complete × complete',
      'cancel × cancel',
    ] as const;
    for (const scenario of pairScenarios) {
      const fixture = await createFixture();
      const service = createLeadService();
      const tenant = ownerTenant(fixture);
      const created = await ingest(
        fixture,
        randomUUID(),
        '3'.repeat(64),
        'manual',
        null,
        uniquePhone(),
      );
      await service.createNextAction(
        tenant,
        created.leadId,
        '1',
        randomUUID(),
        {
          type: LeadNextActionType.CALL,
          description: 'Ação concorrente',
          dueAt: new Date(Date.now() + 60_000).toISOString(),
        },
      );
      const completedAt = await databaseNow();
      const commands =
        scenario === 'reschedule × reschedule'
          ? [
              service.rescheduleNextAction(
                tenant,
                created.leadId,
                '2',
                randomUUID(),
                { dueAt: new Date(Date.now() + 120_000).toISOString() },
              ),
              service.rescheduleNextAction(
                tenant,
                created.leadId,
                '2',
                randomUUID(),
                { dueAt: new Date(Date.now() + 180_000).toISOString() },
              ),
            ]
          : scenario === 'complete × cancel'
            ? [
                service.completeNextAction(
                  tenant,
                  created.leadId,
                  '2',
                  randomUUID(),
                  { performedAt: completedAt },
                ),
                service.cancelNextAction(
                  tenant,
                  created.leadId,
                  '2',
                  randomUUID(),
                  { note: 'Cancelamento concorrente' },
                ),
              ]
            : scenario === 'complete × complete'
              ? [
                  service.completeNextAction(
                    tenant,
                    created.leadId,
                    '2',
                    randomUUID(),
                    { performedAt: completedAt },
                  ),
                  service.completeNextAction(
                    tenant,
                    created.leadId,
                    '2',
                    randomUUID(),
                    { performedAt: completedAt },
                  ),
                ]
              : [
                  service.cancelNextAction(
                    tenant,
                    created.leadId,
                    '2',
                    randomUUID(),
                    { note: 'Primeiro cancelamento' },
                  ),
                  service.cancelNextAction(
                    tenant,
                    created.leadId,
                    '2',
                    randomUUID(),
                    { note: 'Segundo cancelamento' },
                  ),
                ];
      expectSingleStaleWinner(scenario, await Promise.allSettled(commands));
    }
  });

  it('serializes follow-up writes against lifecycle and assignment commands', async () => {
    const scenarios = [
      'close × complete',
      'close × reschedule',
      'assignment × complete',
      'unassignment × complete',
      'Activity create × Activity create',
      'Note create × Note create',
      'Activity create × close',
      'Note create × close',
    ] as const;
    for (const scenario of scenarios) {
      const fixture = await createFixture();
      const service = createLeadService();
      const tenant = ownerTenant(fixture);
      const responsibleTenant = {
        userId: fixture.users[1].id,
        membershipId: fixture.memberships[1].id,
        organizationId: fixture.organization.id,
        role: MembershipRole.MEMBER,
      };
      const requiresAction =
        !scenario.startsWith('Activity') && !scenario.startsWith('Note');
      const created = await ingest(
        fixture,
        randomUUID(),
        '4'.repeat(64),
        'manual',
        fixture.memberships[1].id,
        uniquePhone(),
      );
      if (requiresAction) {
        await service.createNextAction(
          tenant,
          created.leadId,
          '1',
          randomUUID(),
          {
            type: LeadNextActionType.CALL,
            description: 'Ação em disputa',
            dueAt: new Date(Date.now() + 60_000).toISOString(),
          },
        );
      }
      const revision = requiresAction ? '2' : '1';
      const completedAt = await databaseNow();
      const commands =
        scenario === 'close × complete'
          ? [
              service.win(tenant, created.leadId, revision, randomUUID()),
              service.completeNextAction(
                tenant,
                created.leadId,
                revision,
                randomUUID(),
                { performedAt: completedAt },
              ),
            ]
          : scenario === 'close × reschedule'
            ? [
                service.win(tenant, created.leadId, revision, randomUUID()),
                service.rescheduleNextAction(
                  tenant,
                  created.leadId,
                  revision,
                  randomUUID(),
                  { dueAt: new Date(Date.now() + 120_000).toISOString() },
                ),
              ]
            : scenario === 'assignment × complete'
              ? [
                  service.assign(
                    tenant,
                    created.leadId,
                    revision,
                    fixture.memberships[0].id,
                  ),
                  service.completeNextAction(
                    responsibleTenant,
                    created.leadId,
                    revision,
                    randomUUID(),
                    { performedAt: completedAt },
                  ),
                ]
              : scenario === 'unassignment × complete'
                ? [
                    service.assign(tenant, created.leadId, revision, null),
                    service.completeNextAction(
                      responsibleTenant,
                      created.leadId,
                      revision,
                      randomUUID(),
                      { performedAt: completedAt },
                    ),
                  ]
                : scenario === 'Activity create × Activity create'
                  ? [
                      service.createActivity(
                        tenant,
                        created.leadId,
                        revision,
                        randomUUID(),
                        {
                          type: LeadActivityType.CALL,
                          performedAt: completedAt,
                        },
                      ),
                      service.createActivity(
                        tenant,
                        created.leadId,
                        revision,
                        randomUUID(),
                        {
                          type: LeadActivityType.INTERNAL_TASK,
                          performedAt: completedAt,
                        },
                      ),
                    ]
                  : scenario === 'Note create × Note create'
                    ? [
                        service.createNote(
                          tenant,
                          created.leadId,
                          revision,
                          randomUUID(),
                          { content: 'Primeira nota concorrente' },
                        ),
                        service.createNote(
                          tenant,
                          created.leadId,
                          revision,
                          randomUUID(),
                          { content: 'Segunda nota concorrente' },
                        ),
                      ]
                    : scenario === 'Activity create × close'
                      ? [
                          service.createActivity(
                            tenant,
                            created.leadId,
                            revision,
                            randomUUID(),
                            {
                              type: LeadActivityType.CALL,
                              performedAt: completedAt,
                            },
                          ),
                          service.win(
                            tenant,
                            created.leadId,
                            revision,
                            randomUUID(),
                          ),
                        ]
                      : [
                          service.createNote(
                            tenant,
                            created.leadId,
                            revision,
                            randomUUID(),
                            { content: 'Nota em disputa com fechamento' },
                          ),
                          service.win(
                            tenant,
                            created.leadId,
                            revision,
                            randomUUID(),
                          ),
                        ];
      const results = await Promise.allSettled(commands);
      if (
        scenario === 'assignment × complete' ||
        scenario === 'unassignment × complete'
      ) {
        expectSingleRejectedWithStatuses(scenario, results, [404, 412]);
      } else {
        expectSingleStaleWinner(scenario, results);
      }
    }
  });

  it('preserves invariants for offboarding and reactivation races', async () => {
    for (const scenario of [
      'offboarding × complete',
      'offboarding × create',
    ] as const) {
      const fixture = await createFixture();
      const service = createLeadService();
      const memberTenant = {
        userId: fixture.users[1].id,
        membershipId: fixture.memberships[1].id,
        organizationId: fixture.organization.id,
        role: MembershipRole.MEMBER,
      };
      const created = await ingest(
        fixture,
        randomUUID(),
        '5'.repeat(64),
        'manual',
        fixture.memberships[1].id,
        uniquePhone(),
      );
      if (scenario === 'offboarding × complete') {
        await service.createNextAction(
          memberTenant,
          created.leadId,
          '1',
          randomUUID(),
          {
            type: LeadNextActionType.CALL,
            description: 'Ação do member',
            dueAt: new Date(Date.now() + 60_000).toISOString(),
          },
        );
      }
      const revision = scenario === 'offboarding × complete' ? '2' : '1';
      const performedAt = await databaseNow();
      const operation =
        scenario === 'offboarding × complete'
          ? service.completeNextAction(
              memberTenant,
              created.leadId,
              revision,
              randomUUID(),
              { performedAt },
            )
          : service.createNextAction(
              memberTenant,
              created.leadId,
              revision,
              randomUUID(),
              {
                type: LeadNextActionType.CALL,
                description: 'Criação durante offboarding',
                dueAt: new Date(Date.now() + 60_000).toISOString(),
              },
            );
      const results = await Promise.allSettled([
        owner.getRepository(Membership).update(fixture.memberships[1].id, {
          status: MembershipStatus.INACTIVE,
        }),
        operation,
      ]);
      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      if (results[1]?.status === 'rejected') {
        expect([403, 404]).toContain(exceptionStatus(results[1].reason));
      }
      const [state] = await owner.query<
        Array<{
          memberStatus: string;
          leadResponsible: string | null;
          pendingResponsible: string | null;
        }>
      >(
        `SELECT membership.status AS "memberStatus",
                lead.responsible_membership_id AS "leadResponsible",
                action.responsible_membership_id AS "pendingResponsible"
         FROM public.memberships membership
         JOIN public.leads lead ON lead.organization_id = membership.organization_id
           AND lead.id = $2
         LEFT JOIN public.lead_next_actions action ON action.lead_id = lead.id
           AND action.status = 'pending'
         WHERE membership.id = $1`,
        [fixture.memberships[1].id, created.leadId],
      );
      expect(state).toMatchObject({
        memberStatus: 'inactive',
        leadResponsible: null,
        pendingResponsible: null,
      });
    }

    const fixture = await createFixture();
    const service = createLeadService();
    const tenant = ownerTenant(fixture);
    const created = await ingest(
      fixture,
      randomUUID(),
      '6'.repeat(64),
      'manual',
      null,
      uniquePhone(),
    );
    await service.win(tenant, created.leadId, '1', randomUUID());
    const results = await Promise.allSettled([
      service.reactivate(tenant, created.leadId, '2', randomUUID()),
      service.createNextAction(tenant, created.leadId, '2', randomUUID(), {
        type: LeadNextActionType.CALL,
        description: 'Não deve atravessar reativação',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);
    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect([409, 412]).toContain(
      results[1].status === 'rejected'
        ? exceptionStatus(results[1].reason)
        : undefined,
    );
    await expect(
      service.nextAction(tenant, created.leadId),
    ).resolves.toMatchObject({
      item: null,
      temporalState: 'none',
    });
  });

  it('fails the 0.3.3 rollback closed after real follow-up data exists', async () => {
    await expect(
      new ManageLeadActivitiesFollowUp1785519600000().down(migrationRunner),
    ).rejects.toThrow('Unsafe rollback');
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

  function createLeadService(): LeadsService {
    const config = leadConfig();
    return new LeadsService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      new OperationalLeadReadiness(config, runtime),
    );
  }

  function createReadService(): LeadOperationalReadService {
    const config = leadConfig();
    return new LeadOperationalReadService(
      runtime,
      { getOrThrow: () => config } as unknown as ConfigService,
      new OperationalLeadReadiness(config, runtime),
    );
  }

  function ownerTenant(fixture: Fixture) {
    return {
      userId: fixture.users[0].id,
      membershipId: fixture.memberships[0].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.OWNER,
    };
  }

  let phoneSequence = 70;

  function uniquePhone(): string {
    const phone = `+55625555555${phoneSequence}`;
    phoneSequence += 1;
    return phone;
  }

  function expectSingleStaleWinner(
    scenario: string,
    results: PromiseSettledResult<unknown>[],
  ): void {
    expect({
      scenario,
      fulfilled: results.filter((result) => result.status === 'fulfilled')
        .length,
      rejected: results.filter((result) => result.status === 'rejected').length,
    }).toEqual({ scenario, fulfilled: 1, rejected: 1 });
    const loser = results.find((result) => result.status === 'rejected');
    expect(
      loser?.status === 'rejected' ? exceptionStatus(loser.reason) : undefined,
    ).toBe(412);
  }

  function expectSingleRejectedWithStatuses(
    scenario: string,
    results: PromiseSettledResult<unknown>[],
    statuses: number[],
  ): void {
    expect({
      scenario,
      fulfilled: results.filter((result) => result.status === 'fulfilled')
        .length,
      rejected: results.filter((result) => result.status === 'rejected').length,
    }).toEqual({ scenario, fulfilled: 1, rejected: 1 });
    const loser = results.find((result) => result.status === 'rejected');
    expect(statuses).toContain(
      loser?.status === 'rejected' ? exceptionStatus(loser.reason) : undefined,
    );
  }

  function exceptionStatus(reason: unknown): number | undefined {
    if (typeof reason !== 'object' || reason === null) return undefined;
    const status = (reason as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  async function databaseNow(): Promise<string> {
    const [row] = await owner.query<Array<{ now: string }>>(
      `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    if (row === undefined) throw new Error('PostgreSQL clock unavailable.');
    return row.now;
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
      readRateLimitWindowSeconds: 60,
      readMembershipMaxAttempts: 120,
      readIpMaxAttempts: 300,
      metricsMembershipMaxAttempts: 30,
      readRateLimitMaxBuckets: 10_000,
      readStatementTimeoutMs: 3_000,
    };
  }
});
