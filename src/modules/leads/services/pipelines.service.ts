import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { LeadConfig } from '../../../config/lead.config';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import {
  CreatePipelineDto,
  DynamicKanbanDto,
  ReorderPipelineStagesDto,
} from '../dto/pipeline.dto';
import { LEAD_READINESS, LeadReadiness } from '../ports/lead-readiness.port';
import { LeadListItem } from '../types/lead-api.type';
import {
  DynamicKanbanResponse,
  PipelineMutationResult,
  PipelineView,
} from '../types/pipeline-api.type';

interface MutationRow {
  revision: string;
  replayed: boolean;
}

interface DynamicCursor {
  v: 1;
  pipelineId: string;
  pipelineStageId: string;
  createdAt: string;
  id: string;
  mac: string;
}

type RawLeadListItem = Omit<
  LeadListItem,
  'createdAt' | 'updatedAt' | 'lastEntryAt'
> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  lastEntryAt: Date | string;
};

@Injectable()
export class PipelinesService {
  private readonly config: LeadConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    @Inject(LEAD_READINESS) private readonly readiness: LeadReadiness,
  ) {
    this.config = config.getOrThrow<LeadConfig>('lead');
  }

  async list(tenant: TenantContext): Promise<PipelineView[]> {
    await this.readiness.assertManualReady();
    const rows = await this.dataSource.query<PipelineView[]>(
      `WITH actor AS MATERIALIZED (
        SELECT membership.id FROM public.memberships membership
        JOIN public.users application_user ON application_user.id = membership.user_id
          AND application_user.status = 'active'
        JOIN public.organizations organization ON organization.id = membership.organization_id
          AND organization.status = 'active'
        WHERE membership.id = $2 AND membership.user_id = $3
          AND membership.organization_id = $1 AND membership.status = 'active'
      )
      SELECT pipeline.id, pipeline.name, pipeline.is_default AS "isDefault",
        pipeline.revision::text AS revision, pipeline.created_at AS "createdAt",
        pipeline.updated_at AS "updatedAt",
        COALESCE(jsonb_agg(jsonb_build_object(
          'id', stage.id, 'name', stage.name, 'position', stage.position,
          'archivedAt', stage.archived_at
        ) ORDER BY stage.archived_at NULLS FIRST, stage.position, stage.id)
          FILTER (WHERE stage.id IS NOT NULL), '[]'::jsonb) AS stages
      FROM actor JOIN public.pipelines pipeline ON pipeline.organization_id = $1
      LEFT JOIN public.pipeline_stages stage ON stage.organization_id = pipeline.organization_id
        AND stage.pipeline_id = pipeline.id
      GROUP BY pipeline.id ORDER BY pipeline.is_default DESC, lower(pipeline.name), pipeline.id`,
      [tenant.organizationId, tenant.membershipId, tenant.userId],
    );
    return rows.map((pipeline) => this.mapPipeline(pipeline));
  }

  async create(
    tenant: TenantContext,
    pipelineId: string,
    dto: CreatePipelineDto,
  ): Promise<PipelineMutationResult> {
    const result = await this.execute(
      `SELECT revision::text AS revision, replayed
       FROM app_private.create_pipeline($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::jsonb)`,
      [
        tenant.userId,
        tenant.membershipId,
        tenant.organizationId,
        pipelineId,
        this.name(dto.name, 160),
        JSON.stringify(
          dto.stages.map((stage) => ({
            id: stage.id,
            name: this.name(stage.name, 120),
          })),
        ),
      ],
    );
    return this.mutationResult(tenant, pipelineId, result);
  }

  async rename(
    tenant: TenantContext,
    pipelineId: string,
    expectedRevision: string,
    name: string,
  ): Promise<PipelineMutationResult> {
    const result = await this.execute(
      `SELECT revision::text AS revision, replayed
       FROM app_private.rename_pipeline($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text)`,
      [
        tenant.userId,
        tenant.membershipId,
        tenant.organizationId,
        pipelineId,
        expectedRevision,
        this.name(name, 160),
      ],
    );
    return this.mutationResult(tenant, pipelineId, result);
  }

  async createStage(
    tenant: TenantContext,
    pipelineId: string,
    stageId: string,
    expectedRevision: string,
    name: string,
  ): Promise<PipelineMutationResult> {
    const result = await this.execute(
      `SELECT revision::text AS revision, replayed FROM app_private.create_pipeline_stage(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text)`,
      [
        tenant.userId,
        tenant.membershipId,
        tenant.organizationId,
        pipelineId,
        stageId,
        expectedRevision,
        this.name(name, 120),
      ],
    );
    return this.mutationResult(tenant, pipelineId, result);
  }

  async renameStage(
    tenant: TenantContext,
    pipelineId: string,
    stageId: string,
    expectedRevision: string,
    name: string,
  ): Promise<PipelineMutationResult> {
    const result = await this.execute(
      `SELECT revision::text AS revision, replayed FROM app_private.rename_pipeline_stage(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text)`,
      [
        tenant.userId,
        tenant.membershipId,
        tenant.organizationId,
        pipelineId,
        stageId,
        expectedRevision,
        this.name(name, 120),
      ],
    );
    return this.mutationResult(tenant, pipelineId, result);
  }

  async reorder(
    tenant: TenantContext,
    pipelineId: string,
    expectedRevision: string,
    dto: ReorderPipelineStagesDto,
  ): Promise<PipelineMutationResult> {
    const result = await this.execute(
      `SELECT revision::text AS revision, replayed FROM app_private.reorder_pipeline_stages(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid[])`,
      [
        tenant.userId,
        tenant.membershipId,
        tenant.organizationId,
        pipelineId,
        expectedRevision,
        dto.stageIds,
      ],
    );
    return this.mutationResult(tenant, pipelineId, result);
  }

  async archiveStage(
    tenant: TenantContext,
    pipelineId: string,
    stageId: string,
    expectedRevision: string,
  ): Promise<PipelineMutationResult> {
    const result = await this.execute(
      `SELECT revision::text AS revision, replayed FROM app_private.archive_pipeline_stage(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint)`,
      [
        tenant.userId,
        tenant.membershipId,
        tenant.organizationId,
        pipelineId,
        stageId,
        expectedRevision,
      ],
    );
    return this.mutationResult(tenant, pipelineId, result);
  }

  async kanban(
    tenant: TenantContext,
    pipelineId: string,
    query: DynamicKanbanDto,
  ): Promise<DynamicKanbanResponse> {
    await this.readiness.assertManualReady();
    if (
      (query.cursor === undefined) !==
      (query.pipelineStageId === undefined)
    ) {
      throw new BadRequestException(
        'pipelineStageId and cursor must be provided together.',
      );
    }
    const cursor = query.cursor
      ? this.decodeCursor(
          query.cursor,
          pipelineId,
          query.pipelineStageId as string,
        )
      : null;
    return this.dataSource.transaction('REPEATABLE READ', async (runner) => {
      await runner.query(
        `SET LOCAL statement_timeout = '${this.config.readStatementTimeoutMs}ms'`,
      );
      const pipelines = await runner.query<PipelineView[]>(
        `WITH actor AS MATERIALIZED (
          SELECT membership.id, membership.role FROM public.memberships membership
          JOIN public.users application_user ON application_user.id = membership.user_id
            AND application_user.status = 'active'
          JOIN public.organizations organization ON organization.id = membership.organization_id
            AND organization.status = 'active'
          WHERE membership.id = $2 AND membership.user_id = $3
            AND membership.organization_id = $1 AND membership.status = 'active'
        ) SELECT pipeline.id, pipeline.name, pipeline.is_default AS "isDefault",
            pipeline.revision::text AS revision, pipeline.created_at AS "createdAt",
            pipeline.updated_at AS "updatedAt",
            jsonb_agg(jsonb_build_object('id', stage.id, 'name', stage.name,
              'position', stage.position, 'archivedAt', NULL)
              ORDER BY stage.position) AS stages
          FROM actor JOIN public.pipelines pipeline ON pipeline.organization_id = $1
            AND pipeline.id = $4
          JOIN public.pipeline_stages stage ON stage.organization_id = pipeline.organization_id
            AND stage.pipeline_id = pipeline.id AND stage.archived_at IS NULL
          GROUP BY pipeline.id`,
        [tenant.organizationId, tenant.membershipId, tenant.userId, pipelineId],
      );
      const pipeline = pipelines[0];
      if (pipeline === undefined)
        throw new NotFoundException('Pipeline not found.');
      if (
        query.pipelineStageId !== undefined &&
        !pipeline.stages.some((stage) => stage.id === query.pipelineStageId)
      ) {
        throw new NotFoundException('Pipeline stage not found.');
      }
      const totals = await runner.query<
        Array<{
          pipelineStageId: string;
          total: string;
          expectedValueTotalMinor: string;
          withoutExpectedValue: string;
        }>
      >(
        `WITH actor AS MATERIALIZED (
          SELECT membership.id, membership.role FROM public.memberships membership
          JOIN public.users application_user ON application_user.id = membership.user_id
            AND application_user.status = 'active'
          WHERE membership.id = $2 AND membership.user_id = $3
            AND membership.organization_id = $1 AND membership.status = 'active'
        ) SELECT stage.id AS "pipelineStageId", count(lead.id)::text AS total,
          COALESCE(sum(cycle.expected_value_minor), 0)::text AS "expectedValueTotalMinor",
          count(lead.id) FILTER (WHERE cycle.expected_value_minor IS NULL)::text AS "withoutExpectedValue"
        FROM actor JOIN public.pipeline_stages stage ON stage.organization_id = $1
          AND stage.pipeline_id = $4 AND stage.archived_at IS NULL
        LEFT JOIN public.leads lead ON lead.organization_id = stage.organization_id
          AND lead.pipeline_id = stage.pipeline_id AND lead.pipeline_stage_id = stage.id
          AND lead.status = 'active'
          AND (actor.role <> 'member' OR lead.responsible_membership_id = actor.id)
        LEFT JOIN public.lead_commercial_cycles cycle ON cycle.organization_id = lead.organization_id
          AND cycle.lead_id = lead.id AND cycle.closed_at IS NULL
        GROUP BY stage.id`,
        [tenant.organizationId, tenant.membershipId, tenant.userId, pipelineId],
      );
      const columns = [];
      for (const stage of pipeline.stages) {
        const stageCursor = query.pipelineStageId === stage.id ? cursor : null;
        const items = await this.stageItems(
          runner,
          tenant,
          pipelineId,
          stage.id,
          query.limit,
          stageCursor,
        );
        const hasMore = items.length > query.limit;
        const selected = hasMore ? items.slice(0, query.limit) : items;
        const aggregate = totals.find(
          (candidate) => candidate.pipelineStageId === stage.id,
        );
        const last = selected.at(-1);
        columns.push({
          stage: { id: stage.id, name: stage.name, position: stage.position },
          total: Number(aggregate?.total ?? 0),
          expectedValueTotalMinor: aggregate?.expectedValueTotalMinor ?? '0',
          withoutExpectedValue: Number(aggregate?.withoutExpectedValue ?? 0),
          items: selected,
          page: {
            limit: query.limit,
            nextCursor:
              hasMore && last
                ? this.encodeCursor({
                    pipelineId,
                    pipelineStageId: stage.id,
                    createdAt: last.createdAt,
                    id: last.id,
                  })
                : null,
          },
        });
      }
      return {
        pipeline: {
          id: pipeline.id,
          name: pipeline.name,
          isDefault: pipeline.isDefault,
          revision: pipeline.revision,
        },
        currency: 'BRL',
        expectedValueTotalMinor: totals
          .reduce((sum, item) => sum + BigInt(item.expectedValueTotalMinor), 0n)
          .toString(),
        withoutExpectedValue: totals.reduce(
          (sum, item) => sum + Number(item.withoutExpectedValue),
          0,
        ),
        columns,
      };
    });
  }

  private async stageItems(
    runner: EntityManager,
    tenant: TenantContext,
    pipelineId: string,
    stageId: string,
    limit: number,
    cursor: DynamicCursor | null,
  ): Promise<LeadListItem[]> {
    const rows: RawLeadListItem[] = await runner.query(
      `WITH actor AS MATERIALIZED (
        SELECT membership.id, membership.role, organization.crm_time_zone,
          statement_timestamp() AS as_of
        FROM public.memberships membership
        JOIN public.users application_user ON application_user.id = membership.user_id
          AND application_user.status = 'active'
        JOIN public.organizations organization ON organization.id = membership.organization_id
          AND organization.status = 'active'
        WHERE membership.id = $2 AND membership.user_id = $3
          AND membership.organization_id = $1 AND membership.status = 'active'
      ) SELECT lead.id, lead.display_name AS "displayName", lead.primary_phone AS "primaryPhone",
        lead.email, lead.company_name AS "companyName",
        lead.responsible_membership_id AS "responsibleMembershipId", lead.status, lead.stage,
        lead.pipeline_id AS "pipelineId", lead.pipeline_stage_id AS "pipelineStageId",
        pipeline.name AS "pipelineName", stage.name AS "pipelineStageName",
        cycle.expected_value_minor::text AS "expectedValueMinor", first_entry.source,
        last_entry.received_at AS "lastEntryAt",
        CASE WHEN action.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', action.id, 'type', action.type, 'description', action.description,
          'dueAt', action.due_at, 'responsibleMembershipId', action.responsible_membership_id,
          'status', action.status, 'revision', action.revision::text) END AS "nextAction",
        CASE WHEN action.id IS NULL THEN 'none'
          WHEN action.due_at < actor.as_of THEN 'overdue'
          WHEN (action.due_at AT TIME ZONE actor.crm_time_zone)::date =
            (actor.as_of AT TIME ZONE actor.crm_time_zone)::date THEN 'today'
          ELSE 'future' END AS "temporalState",
        EXISTS (SELECT 1 FROM public.lead_return_reviews review
          WHERE review.organization_id = lead.organization_id AND review.lead_id = lead.id
            AND review.status = 'pending') AS "returnPending",
        lead.revision::text AS revision, lead.created_at AS "createdAt",
        lead.updated_at AS "updatedAt"
      FROM actor JOIN public.leads lead ON lead.organization_id = $1
        AND lead.pipeline_id = $4 AND lead.pipeline_stage_id = $5 AND lead.status = 'active'
        AND (actor.role <> 'member' OR lead.responsible_membership_id = actor.id)
      JOIN public.pipelines pipeline ON pipeline.id = lead.pipeline_id
        AND pipeline.organization_id = lead.organization_id
      JOIN public.pipeline_stages stage ON stage.id = lead.pipeline_stage_id
        AND stage.pipeline_id = lead.pipeline_id AND stage.organization_id = lead.organization_id
      JOIN public.lead_entries first_entry ON first_entry.lead_id = lead.id
        AND first_entry.organization_id = lead.organization_id AND first_entry.sequence = 1
      JOIN public.lead_entries last_entry ON last_entry.lead_id = lead.id
        AND last_entry.organization_id = lead.organization_id
        AND last_entry.sequence = lead.next_entry_sequence - 1
      JOIN public.lead_commercial_cycles cycle ON cycle.lead_id = lead.id
        AND cycle.organization_id = lead.organization_id AND cycle.closed_at IS NULL
      LEFT JOIN public.lead_next_actions action ON action.lead_id = lead.id
        AND action.organization_id = lead.organization_id AND action.status = 'pending'
      WHERE ($6::timestamptz IS NULL OR (lead.created_at, lead.id) < ($6::timestamptz, $7::uuid))
      ORDER BY lead.created_at DESC, lead.id DESC LIMIT $8`,
      [
        tenant.organizationId,
        tenant.membershipId,
        tenant.userId,
        pipelineId,
        stageId,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    return rows.map((row) => ({
      ...row,
      expectedValueMinor: row.expectedValueMinor ?? null,
      email: row.email ?? null,
      companyName: row.companyName ?? null,
      responsibleMembershipId: row.responsibleMembershipId ?? null,
      nextAction: row.nextAction ?? null,
      temporalState: row.temporalState,
      returnPending: row.returnPending === true,
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
      lastEntryAt: this.iso(row.lastEntryAt),
    }));
  }

  private async execute(
    sql: string,
    parameters: unknown[],
  ): Promise<MutationRow> {
    await this.readiness.assertManualReady();
    try {
      const rows = await this.dataSource.query<MutationRow[]>(sql, parameters);
      const result = rows[0];
      if (result === undefined) {
        throw new ServiceUnavailableException(
          'Pipeline command is unavailable.',
        );
      }
      return result;
    } catch (error) {
      this.mapDatabaseError(error);
    }
  }

  private async mutationResult(
    tenant: TenantContext,
    pipelineId: string,
    result: MutationRow,
  ): Promise<PipelineMutationResult> {
    const pipeline = (await this.list(tenant)).find(
      (item) => item.id === pipelineId,
    );
    if (pipeline === undefined)
      throw new NotFoundException('Pipeline not found.');
    return { pipeline, replayed: result.replayed };
  }

  private name(value: string, maximum: number): string {
    const normalized = value.trim().normalize('NFC');
    if (
      normalized.length === 0 ||
      [...normalized].length > maximum ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)
    ) {
      throw new BadRequestException('Invalid pipeline name.');
    }
    return normalized;
  }

  private mapPipeline(pipeline: PipelineView): PipelineView {
    return {
      ...pipeline,
      createdAt: this.iso(pipeline.createdAt),
      updatedAt: this.iso(pipeline.updatedAt),
      stages: pipeline.stages.map((stage) => ({
        ...stage,
        archivedAt:
          stage.archivedAt === null ? null : this.iso(stage.archivedAt),
      })),
    };
  }

  private encodeCursor(value: Omit<DynamicCursor, 'v' | 'mac'>): string {
    const payload = { v: 1 as const, ...value };
    const mac = this.mac(payload);
    return Buffer.from(JSON.stringify({ ...payload, mac }), 'utf8').toString(
      'base64url',
    );
  }

  private decodeCursor(
    value: string,
    pipelineId: string,
    pipelineStageId: string,
  ): DynamicCursor {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as DynamicCursor;
      const expected = this.mac({
        v: parsed.v,
        pipelineId: parsed.pipelineId,
        pipelineStageId: parsed.pipelineStageId,
        createdAt: parsed.createdAt,
        id: parsed.id,
      });
      if (
        parsed.v !== 1 ||
        parsed.pipelineId !== pipelineId ||
        parsed.pipelineStageId !== pipelineStageId ||
        !/^[0-9a-f-]{36}$/iu.test(parsed.id) ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        !this.equalMac(parsed.mac, expected)
      ) {
        throw new Error('invalid');
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid cursor.');
    }
  }

  private mac(payload: Omit<DynamicCursor, 'mac'>): string {
    const version = this.config.idempotencyCurrentKeyVersion;
    const key =
      version === null ? undefined : this.config.idempotencyKeys.get(version);
    if (key === undefined) {
      throw new ServiceUnavailableException('Pipeline read is unavailable.');
    }
    return createHmac('sha256', key)
      .update(JSON.stringify(payload), 'utf8')
      .digest('base64url');
  }

  private equalMac(received: string, expected: string): boolean {
    const left = Buffer.from(received);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private iso(value: Date | string): string {
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  }

  private mapDatabaseError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const code = (error.driverError as { code?: string }).code;
      if (code === 'P3001')
        throw new ForbiddenException('Organization access denied.');
      if (code === 'P3002') throw new NotFoundException('Pipeline not found.');
      if (code === 'P3003') {
        throw new PreconditionFailedException('Pipeline revision is stale.');
      }
      if (code === 'P3004' || code === '23505') {
        throw new ConflictException(
          'Pipeline request conflicts with existing state.',
        );
      }
      if (code === '22023' || code === '23514') {
        throw new BadRequestException('Invalid pipeline command.');
      }
      if (code === 'P3007') {
        throw new ServiceUnavailableException('Pipeline state is unavailable.');
      }
    }
    throw error;
  }
}
