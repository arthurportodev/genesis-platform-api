import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { LeadConfig } from '../../src/config/lead.config';
import { AddCustomPipelinesAndStages1788375600000 } from '../../src/database/migrations/1788375600000-AddCustomPipelinesAndStages';
import { CreateLeadFoundation1785346800000 } from '../../src/database/migrations/1785346800000-CreateLeadFoundation';
import { ManageLeadCommercialPipeline1785433200000 } from '../../src/database/migrations/1785433200000-ManageLeadCommercialPipeline';
import { ManageLeadActivitiesFollowUp1785519600000 } from '../../src/database/migrations/1785519600000-ManageLeadActivitiesFollowUp';
import { AddLeadOperationalReadIndexes1785606000000 } from '../../src/database/migrations/1785606000000-AddLeadOperationalReadIndexes';
import { ManageLeadCommercialCycleExpectedValue1788289200000 } from '../../src/database/migrations/1788289200000-ManageLeadCommercialCycleExpectedValue';
import {
  LeadListSort,
  LeadSource,
  LeadStage,
} from '../../src/modules/leads/enums/lead.enums';
import { OperationalLeadReadiness } from '../../src/modules/leads/ports/lead-readiness.port';
import { LeadOperationalReadService } from '../../src/modules/leads/services/lead-operational-read.service';
import { LeadsService } from '../../src/modules/leads/services/leads.service';
import { PipelinesService } from '../../src/modules/leads/services/pipelines.service';
import { Membership } from '../../src/modules/memberships/entities/membership.entity';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../../src/modules/memberships/enums/membership-status.enum';
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

describe('custom pipelines database foundation', () => {
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
    await new AddCustomPipelinesAndStages1788375600000().up(migrationRunner);
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

  it('provisions one canonical default pipeline for every new organization', async () => {
    const first = await createFixture();
    const second = await createFixture();
    for (const fixture of [first, second]) {
      const rows = await owner.query<
        Array<{ defaults: string; names: string[]; positions: number[] }>
      >(
        `SELECT count(DISTINCT pipeline.id)::text AS defaults,
          array_agg(stage.name ORDER BY stage.position) AS names,
          array_agg(stage.position ORDER BY stage.position) AS positions
        FROM public.pipelines pipeline
        JOIN public.pipeline_stages stage ON stage.pipeline_id=pipeline.id
          AND stage.organization_id=pipeline.organization_id
        WHERE pipeline.organization_id=$1 AND pipeline.is_default
          AND stage.archived_at IS NULL`,
        [fixture.organization.id],
      );
      expect(rows[0]).toEqual({
        defaults: '1',
        names: [
          'Novo',
          'Qualificação',
          'Diagnóstico',
          'Proposta',
          'Negociação',
        ],
        positions: [1, 2, 3, 4, 5],
      });
    }
  });

  it('creates and configures tenant-scoped pipelines with revision and archive guards', async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const service = createPipelineService();
    const pipelineId = randomUUID();
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
    const created = await service.create(ownerTenant(fixture), pipelineId, {
      name: 'Onboarding',
      stages: [
        { id: firstStageId, name: 'Entrada' },
        { id: secondStageId, name: 'Implantação' },
      ],
    });
    expect(created).toMatchObject({
      replayed: false,
      pipeline: { id: pipelineId, revision: '0' },
    });
    await expect(
      service.create(ownerTenant(fixture), pipelineId, {
        name: 'Onboarding',
        stages: [
          { id: firstStageId, name: 'Entrada' },
          { id: secondStageId, name: 'Implantação' },
        ],
      }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      service.rename(
        ownerTenant(fixture),
        pipelineId,
        '99',
        'Customer Success',
      ),
    ).rejects.toMatchObject({ status: 412 });
    const renamed = await service.rename(
      ownerTenant(fixture),
      pipelineId,
      '0',
      'Customer Success',
    );
    expect(renamed.pipeline.revision).toBe('1');
    const thirdStageId = randomUUID();
    const withStage = await service.createStage(
      ownerTenant(fixture),
      pipelineId,
      thirdStageId,
      '1',
      'Acompanhamento',
    );
    expect(withStage.pipeline.revision).toBe('2');
    const reordered = await service.reorder(
      ownerTenant(fixture),
      pipelineId,
      '2',
      { stageIds: [thirdStageId, firstStageId, secondStageId] },
    );
    expect(
      reordered.pipeline.stages.slice(0, 3).map((stage) => stage.id),
    ).toEqual([thirdStageId, firstStageId, secondStageId]);
    await expect(
      service.renameStage(
        ownerTenant(foreign),
        pipelineId,
        firstStageId,
        '3',
        'Cross tenant',
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.create(memberTenant(fixture), randomUUID(), {
        name: 'Denied',
        stages: [{ id: randomUUID(), name: 'Stage' }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    const archived = await service.archiveStage(
      ownerTenant(fixture),
      pipelineId,
      secondStageId,
      '3',
    );
    expect(archived.pipeline.revision).toBe('4');
    await expect(
      service.archiveStage(
        ownerTenant(fixture),
        pipelineId,
        secondStageId,
        '0',
      ),
    ).resolves.toMatchObject({ replayed: true });
  });

  it('supports lead-only creation, explicit cycle start, dynamic move, and immutable name snapshots', async () => {
    const fixture = await createFixture();
    const leads = createLeadService();
    const reads = createReadService();
    const pipelines = createPipelineService();
    const tenant = ownerTenant(fixture);
    const pipelineId = randomUUID();
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
    await pipelines.create(tenant, pipelineId, {
      name: 'Onboarding',
      stages: [
        { id: firstStageId, name: 'Entrada' },
        { id: secondStageId, name: 'Implantação' },
      ],
    });
    const leadOnly = await leads.createManual(
      tenant,
      {
        displayName: 'Lead sem pipeline',
        primaryPhone: uniquePhone(),
        source: LeadSource.MANUAL,
        pipelineId: null,
      },
      randomUUID(),
    );
    expect(leadOnly.lead).toMatchObject({
      status: 'active',
      pipelineId: null,
      pipelineStageId: null,
      latestCycleNumber: null,
    });
    await expect(
      leads.createManual(
        tenant,
        {
          displayName: 'Valor sem ciclo',
          primaryPhone: uniquePhone(),
          source: LeadSource.MANUAL,
          pipelineId: null,
          expectedValueMinor: '100',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const detail = await reads.detail(tenant, leadOnly.lead?.id as string);
    expect(detail.latestCycle).toBeNull();
    expect(detail.counts.cycles).toBe(0);
    await expect(
      reads.detail(tenant, leadOnly.lead?.id as string, false),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reads.assertContractVisibility(
        tenant,
        leadOnly.lead?.id as string,
        false,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const legacyList = await reads.list(
      tenant,
      { limit: 25, sort: LeadListSort.CREATED_AT_DESC },
      false,
    );
    const pipelineV2List = await reads.list(
      tenant,
      { limit: 25, sort: LeadListSort.CREATED_AT_DESC },
      true,
    );
    expect(legacyList.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: detail.id })]),
    );
    expect(pipelineV2List.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: detail.id })]),
    );
    expect(
      (await reads.kanban(tenant, { limit: 20 })).columns.flatMap(
        (column) => column.items,
      ),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: detail.id })]),
    );
    const started = await leads.startCycle(
      tenant,
      leadOnly.lead?.id as string,
      leadOnly.lead?.revision as string,
      randomUUID(),
      { pipelineId },
    );
    expect(started).toMatchObject({ revision: '2', replayed: false });
    const current = await leads.get(tenant, leadOnly.lead?.id as string);
    expect(current).toMatchObject({
      pipelineId,
      pipelineStageId: firstStageId,
      pipelineStageName: 'Entrada',
      latestCycleNumber: '1',
    });
    await leads.move(tenant, current.id, current.revision, randomUUID(), {
      pipelineStageId: secondStageId,
    });
    const moved = await leads.get(tenant, current.id);
    expect(moved.pipelineStageName).toBe('Implantação');
    expect(
      (
        await reads.list(
          tenant,
          { limit: 25, sort: LeadListSort.CREATED_AT_DESC },
          false,
        )
      ).items,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: current.id })]),
    );
    expect(
      (
        await reads.list(
          tenant,
          { limit: 25, sort: LeadListSort.CREATED_AT_DESC },
          true,
        )
      ).items,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: current.id })]),
    );
    const renamed = await pipelines.renameStage(
      tenant,
      pipelineId,
      secondStageId,
      '0',
      'Acompanhamento',
    );
    expect(renamed.pipeline.revision).toBe('1');
    const timeline = await leads.timeline(tenant, current.id, { limit: 50 });
    expect(
      timeline.items.find((event) => event.eventType === 'lead.stage.changed'),
    ).toMatchObject({
      previousPipelineStageId: firstStageId,
      previousStageName: 'Entrada',
      newPipelineStageId: secondStageId,
      newStageName: 'Implantação',
    });
    await expect(
      pipelines.archiveStage(
        tenant,
        pipelineId,
        secondStageId,
        renamed.pipeline.revision,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('keeps legacy create, move, Kanban, detail, and external deduplication compatible', async () => {
    const fixture = await createFixture();
    const leads = createLeadService();
    const reads = createReadService();
    const pipelines = createPipelineService();
    const tenant = ownerTenant(fixture);
    const phone = uniquePhone();
    const created = await leads.createManual(
      tenant,
      {
        displayName: 'Legacy Lead',
        primaryPhone: phone,
        source: LeadSource.MANUAL,
        expectedValueMinor: '1234',
      },
      randomUUID(),
    );
    expect(created.lead).toMatchObject({
      stage: LeadStage.NEW,
      pipelineName: 'Pipeline Comercial',
      pipelineStageName: 'Novo',
      latestCycleNumber: '1',
    });
    await leads.move(
      tenant,
      created.lead?.id as string,
      created.lead?.revision as string,
      randomUUID(),
      LeadStage.QUALIFICATION,
    );
    const detail = await reads.detail(tenant, created.lead?.id as string);
    expect(detail).toMatchObject({
      stage: LeadStage.QUALIFICATION,
      pipelineStageName: 'Qualificação',
      latestCycle: { expectedValueMinor: '1234' },
    });
    const legacyKanban = await reads.kanban(tenant, { limit: 20 });
    expect(legacyKanban.columns).toHaveLength(5);
    expect(
      legacyKanban.columns.find(
        (column) => column.stage === LeadStage.QUALIFICATION,
      )?.items,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: detail.id })]),
    );
    const defaultPipeline = (await pipelines.list(tenant)).find(
      (pipeline) => pipeline.isDefault,
    );
    const dynamicKanban = await pipelines.kanban(
      tenant,
      defaultPipeline?.id as string,
      { limit: 20 },
    );
    expect(
      dynamicKanban.columns.find(
        (column) => column.stage.name === 'Qualificação',
      )?.items,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: detail.id })]),
    );
    const before = await owner.query<Array<{ cycles: string }>>(
      `SELECT count(*)::text AS cycles FROM public.lead_commercial_cycles WHERE lead_id=$1`,
      [detail.id],
    );
    await runtime.query(
      `SELECT * FROM app_private.ingest_lead(
        NULL,NULL,$1::uuid,'genesis_form','External duplicate',$2::text,NULL,NULL,NULL,NULL,NULL,NULL,
        'landing_page',NULL,NULL,NULL,NULL,NULL,NULL,$3::uuid,1::smallint,$4::text,$5::jsonb)`,
      [
        fixture.organization.id,
        phone,
        randomUUID(),
        'f'.repeat(64),
        JSON.stringify({ 1: 'f'.repeat(64) }),
      ],
    );
    const after = await owner.query<Array<{ cycles: string; entries: string }>>(
      `SELECT (SELECT count(*)::text FROM public.lead_commercial_cycles WHERE lead_id=$1) AS cycles,
        (SELECT count(*)::text FROM public.lead_entries WHERE lead_id=$1) AS entries`,
      [detail.id],
    );
    expect({ before: before[0]?.cycles, after: after[0] }).toEqual({
      before: '1',
      after: { cycles: '1', entries: '2' },
    });
  });

  it('keeps the five default bridge slots stable through rename and rejects structural mutations', async () => {
    const fixture = await createFixture();
    const leads = createLeadService();
    const pipelines = createPipelineService();
    const tenant = ownerTenant(fixture);
    let defaultPipeline = (await pipelines.list(tenant)).find(
      (pipeline) => pipeline.isDefault,
    );
    expect(defaultPipeline).toBeDefined();
    const stageIds = defaultPipeline?.stages.map((stage) => stage.id) ?? [];
    for (const [index, stageId] of stageIds.entries()) {
      const result = await pipelines.renameStage(
        tenant,
        defaultPipeline?.id as string,
        stageId,
        defaultPipeline?.revision as string,
        `Bridge ${index + 1}`,
      );
      defaultPipeline = result.pipeline;
    }
    await expect(
      pipelines.createStage(
        tenant,
        defaultPipeline?.id as string,
        randomUUID(),
        defaultPipeline?.revision as string,
        'Extra',
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      pipelines.reorder(
        tenant,
        defaultPipeline?.id as string,
        defaultPipeline?.revision as string,
        { stageIds: [...stageIds].reverse() },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      pipelines.archiveStage(
        tenant,
        defaultPipeline?.id as string,
        stageIds[4],
        defaultPipeline?.revision as string,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const created = await leads.createManual(
      tenant,
      {
        displayName: 'Legacy renamed bridge',
        primaryPhone: uniquePhone(),
        source: LeadSource.MANUAL,
      },
      randomUUID(),
    );
    expect(created.lead).toMatchObject({
      stage: LeadStage.NEW,
      pipelineStageName: 'Bridge 1',
    });
    const legacyStages = [
      LeadStage.QUALIFICATION,
      LeadStage.DIAGNOSIS,
      LeadStage.PROPOSAL,
      LeadStage.NEGOTIATION,
    ];
    let current = created.lead;
    for (const [index, stage] of legacyStages.entries()) {
      await leads.move(
        tenant,
        current?.id as string,
        current?.revision as string,
        randomUUID(),
        stage,
      );
      current = await leads.get(tenant, current?.id as string);
      expect(current).toMatchObject({
        stage,
        pipelineStageName: `Bridge ${index + 2}`,
      });
    }

    const externalPhone = uniquePhone();
    await runtime.query(
      `SELECT * FROM app_private.ingest_lead(
        NULL,NULL,$1::uuid,'genesis_form','External bridge',$2::text,NULL,NULL,NULL,NULL,NULL,NULL,
        'landing_page',NULL,NULL,NULL,NULL,NULL,NULL,$3::uuid,1::smallint,$4::text,$5::jsonb)`,
      [
        fixture.organization.id,
        externalPhone,
        randomUUID(),
        'e'.repeat(64),
        JSON.stringify({ 1: 'e'.repeat(64) }),
      ],
    );
    const [external] = await owner.query<
      Array<{ stage: string; stageName: string }>
    >(
      `SELECT lead.stage, stage.name AS "stageName" FROM public.leads lead
       JOIN public.pipeline_stages stage ON stage.id=lead.pipeline_stage_id
       WHERE lead.organization_id=$1 AND lead.primary_phone=$2`,
      [fixture.organization.id, externalPhone],
    );
    expect(external).toEqual({ stage: 'new', stageName: 'Bridge 1' });
    await expect(
      new AddCustomPipelinesAndStages1788375600000().down(migrationRunner),
    ).rejects.toThrow('Unsafe rollback: custom pipeline state already exists.');
  });

  it('preserves the closed-stage name snapshot when a renamed stage is reactivated', async () => {
    const fixture = await createFixture();
    const leads = createLeadService();
    const pipelines = createPipelineService();
    const tenant = ownerTenant(fixture);
    const pipelineId = randomUUID();
    const firstStageId = randomUUID();
    const closingStageId = randomUUID();
    await pipelines.create(tenant, pipelineId, {
      name: 'Snapshot pipeline',
      stages: [
        { id: firstStageId, name: 'Start snapshot' },
        { id: closingStageId, name: 'Close snapshot' },
      ],
    });
    const created = await leads.createManual(
      tenant,
      {
        displayName: 'Historical snapshot',
        primaryPhone: uniquePhone(),
        source: LeadSource.MANUAL,
        pipelineId,
      },
      randomUUID(),
    );
    await leads.move(
      tenant,
      created.lead?.id as string,
      created.lead?.revision as string,
      randomUUID(),
      { pipelineStageId: closingStageId },
    );
    let current = await leads.get(tenant, created.lead?.id as string);
    await leads.win(tenant, current.id, current.revision, randomUUID());
    current = await leads.get(tenant, current.id);
    await pipelines.renameStage(
      tenant,
      pipelineId,
      closingStageId,
      '0',
      'Renamed after close',
    );
    await leads.startCycle(tenant, current.id, current.revision, randomUUID(), {
      pipelineId,
    });
    const timeline = await leads.timeline(tenant, current.id, { limit: 50 });
    expect(
      timeline.items.find((event) => event.eventType === 'lead.reactivated'),
    ).toMatchObject({
      previousPipelineStageId: closingStageId,
      previousStageName: 'Close snapshot',
      newPipelineStageId: firstStageId,
      newStageName: 'Start snapshot',
    });
  });

  it('serializes concurrent commands, replays exact intents, and rejects fingerprint conflicts', async () => {
    const fixture = await createFixture();
    const leads = createLeadService();
    const pipelines = createPipelineService();
    const tenant = ownerTenant(fixture);
    const pipelineId = randomUUID();
    const firstStageId = randomUUID();
    const secondStageId = randomUUID();
    const thirdStageId = randomUUID();
    await pipelines.create(tenant, pipelineId, {
      name: 'Concurrent pipeline',
      stages: [
        { id: firstStageId, name: 'First' },
        { id: secondStageId, name: 'Second' },
        { id: thirdStageId, name: 'Third' },
      ],
    });
    const leadOnly = await leads.createManual(
      tenant,
      {
        displayName: 'Concurrent lead',
        primaryPhone: uniquePhone(),
        source: LeadSource.MANUAL,
        pipelineId: null,
      },
      randomUUID(),
    );
    const startKey = randomUUID();
    const startResults = await Promise.all([
      leads.startCycle(tenant, leadOnly.lead?.id as string, '1', startKey, {
        pipelineId,
      }),
      leads.startCycle(tenant, leadOnly.lead?.id as string, '1', startKey, {
        pipelineId,
      }),
    ]);
    expect(startResults.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      leads.startCycle(tenant, leadOnly.lead?.id as string, '1', startKey, {
        pipelineId: (await pipelines.list(tenant))[0]?.id,
      }),
    ).rejects.toMatchObject({ status: 409 });

    let current = await leads.get(tenant, leadOnly.lead?.id as string);
    const moveKey = randomUUID();
    const moveResults = await Promise.all([
      leads.move(tenant, current.id, current.revision, moveKey, {
        pipelineStageId: secondStageId,
      }),
      leads.move(tenant, current.id, current.revision, moveKey, {
        pipelineStageId: secondStageId,
      }),
    ]);
    expect(moveResults.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      leads.move(tenant, current.id, current.revision, moveKey, {
        pipelineStageId: thirdStageId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const renameResults = await Promise.allSettled([
      pipelines.rename(tenant, pipelineId, '0', 'Concurrent winner A'),
      pipelines.rename(tenant, pipelineId, '0', 'Concurrent winner B'),
    ]);
    expect(
      renameResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      renameResults.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    current = await leads.get(tenant, current.id);
    expect(current.pipelineStageId).toBe(secondStageId);
  });

  it('denies direct runtime DML against the new catalog tables', async () => {
    const fixture = await createFixture();
    await expect(
      runtime.query(
        `INSERT INTO public.pipelines (id,organization_id,name,is_default,revision)
         VALUES ($1,$2,'Forbidden',false,0)`,
        [randomUUID(), fixture.organization.id],
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  async function createFixture(): Promise<Fixture> {
    const suffix = randomUUID();
    const organization = await owner.getRepository(Organization).save({
      name: `Pipeline org ${suffix}`,
      slug: `pipeline-${suffix}`,
      status: OrganizationStatus.INACTIVE,
    });
    const users = await owner.getRepository(User).save([
      {
        email: `pipeline-owner-${suffix}@example.com`,
        name: 'Pipeline owner',
        status: UserStatus.ACTIVE,
      },
      {
        email: `pipeline-member-${suffix}@example.com`,
        name: 'Pipeline member',
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

  function createPipelineService(): PipelinesService {
    const config = leadConfig();
    return new PipelinesService(
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

  function memberTenant(fixture: Fixture) {
    return {
      userId: fixture.users[1].id,
      membershipId: fixture.memberships[1].id,
      organizationId: fixture.organization.id,
      role: MembershipRole.MEMBER,
    };
  }

  let phoneSequence = 100;
  function uniquePhone(): string {
    const value = `+5562888888${phoneSequence}`;
    phoneSequence += 1;
    return value;
  }

  function leadConfig(): LeadConfig {
    return {
      formReadiness: false,
      formOrganizationId: null,
      formCurrentKeyVersion: null,
      formKeys: new Map(),
      idempotencyCurrentKeyVersion: 1,
      idempotencyKeys: new Map([[1, Buffer.alloc(32, 1)]]),
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
