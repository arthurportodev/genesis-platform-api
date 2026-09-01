import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUUID } from 'class-validator';
import { DataSource, QueryRunner } from 'typeorm';
import { LeadConfig } from '../../../config/lead.config';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import {
  LeadKanbanDto,
  LeadMetricsDto,
  LeadMyActionsDto,
  LeadReturnReviewQueueDto,
  LeadUnassignedQueueDto,
  ListLeadCyclesDto,
  ListLeadsDto,
} from '../dto/lead.dto';
import {
  LeadListSort,
  LeadNextActionTemporalState,
  LeadStage,
  LeadStatus,
} from '../enums/lead.enums';
import { normalizeLeadPhone } from '../normalization/phone.normalizer';
import { LEAD_READINESS, LeadReadiness } from '../ports/lead-readiness.port';
import {
  LeadCycleListResponse,
  LeadDetailView,
  LeadKanbanResponse,
  LeadListItem,
  LeadListResponse,
  LeadMetricsResponse,
  LeadReturnReviewQueueResponse,
} from '../types/lead-api.type';

interface ListQueryRow extends Omit<
  Partial<LeadListItem>,
  'createdAt' | 'updatedAt' | 'lastEntryAt'
> {
  actorRole: MembershipRole;
  targetExists: boolean;
  asOf: Date | string;
  total: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  lastEntryAt?: Date | string;
  cursorCreatedAt?: string;
  cursorNextActionDueAt?: string;
}

interface ReturnReviewQueryRow extends ListQueryRow {
  reviewId?: string;
  cycleId?: string;
  entryCount?: string;
  openedAt?: Date | string;
  cursorOpenedAt?: string;
  reviewUpdatedAt?: Date | string;
  firstReviewEntry?: { id: string; source: string; receivedAt: string };
  latestReviewEntry?: { id: string; source: string; receivedAt: string };
}

interface QueryCursor {
  v: 1;
  scope: string;
  sort: string;
  stage?: LeadStage;
  key: string;
  id: string;
  filterMac: string;
  cursorMac: string;
}

interface SqlParts {
  parameters: unknown[];
  ctes: string[];
  joins: string[];
  predicates: string[];
  targetRequested: boolean;
}

const CONTROL_OR_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const PHONE_LIKE = /^[+\d().\s-]+$/u;
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/u;
const STAGES = Object.values(LeadStage);

@Injectable()
export class LeadOperationalReadService {
  private readonly config: LeadConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    @Inject(LEAD_READINESS) private readonly readiness: LeadReadiness,
  ) {
    this.config = config.getOrThrow<LeadConfig>('lead');
  }

  async list(
    tenant: TenantContext,
    query: ListLeadsDto,
  ): Promise<LeadListResponse> {
    this.validateListQuery(query);
    const filterMac = this.filterMac('list', [
      tenant.organizationId,
      tenant.membershipId,
      tenant.userId,
      query.sort,
      this.listFilterIdentity(query),
    ]);
    const cursor = query.cursor
      ? this.decodeCursor(query.cursor, 'list', query.sort, filterMac)
      : null;

    return this.withOperationalQuery(async (runner) => {
      const parts = this.baseParts(tenant, query);
      if (query.status === undefined) {
        parts.predicates.push(`lead.status <> 'archived'`);
      } else {
        parts.predicates.push(
          `lead.status = ${this.param(parts, query.status)}::lead_status_enum`,
        );
      }
      if (query.stage !== undefined) {
        parts.predicates.push(
          `lead.stage = ${this.param(parts, query.stage)}::lead_stage_enum`,
        );
      }
      if (query.returnPending !== undefined) {
        parts.predicates.push(
          `${query.returnPending === 'true' ? '' : 'NOT '}EXISTS (
            SELECT 1 FROM public.lead_return_reviews review_filter
            WHERE review_filter.organization_id = lead.organization_id
              AND review_filter.lead_id = lead.id
              AND review_filter.status = 'pending'
          )`,
        );
      }
      if (
        query.sort === LeadListSort.NEXT_ACTION_DUE_AT_ASC ||
        query.sort === LeadListSort.NEXT_ACTION_DUE_AT_DESC
      ) {
        parts.predicates.push('pending_action.id IS NOT NULL');
        if (query.responsibleMembershipId !== undefined) {
          parts.predicates.push(
            'pending_action.responsible_membership_id = (SELECT id FROM target_membership)',
          );
        } else if (query.assignedToMe === 'true') {
          parts.predicates.push(
            'pending_action.responsible_membership_id = actor.id',
          );
        }
      }

      const direction =
        query.sort === LeadListSort.CREATED_AT_ASC ||
        query.sort === LeadListSort.NEXT_ACTION_DUE_AT_ASC
          ? 'ASC'
          : 'DESC';
      const sortColumn = query.sort.startsWith('nextActionDueAt')
        ? '"nextActionDueAt"'
        : '"createdAt"';
      let cursorPredicate = '';
      if (cursor !== null) {
        const key = this.param(parts, cursor.key);
        const id = this.param(parts, cursor.id);
        cursorPredicate = `WHERE (${sortColumn}, id) ${direction === 'ASC' ? '>' : '<'}
          (${key}::timestamptz, ${id}::uuid)`;
      }
      const limit = this.param(parts, query.limit + 1);
      const targetExists = parts.targetRequested
        ? 'EXISTS (SELECT 1 FROM target_membership)'
        : 'true';

      const rows = (await runner.query(
        `WITH ${parts.ctes.join(',\n')},
        filtered AS NOT MATERIALIZED (
          ${this.listSelectSql()}
          ${parts.joins.join('\n')}
          WHERE ${parts.predicates.join(' AND ')}
        ), counted AS (
          SELECT count(*)::text AS total FROM filtered
        ), page_rows AS (
          SELECT * FROM filtered ${cursorPredicate}
          ORDER BY ${sortColumn} ${direction}, id ${direction}
          LIMIT ${limit}
        )
        SELECT actor.role AS "actorRole", ${targetExists} AS "targetExists",
               actor.as_of AS "asOf", counted.total, page_rows.*
        FROM authorized_actor actor CROSS JOIN counted
        LEFT JOIN page_rows ON true
        ORDER BY page_rows.${sortColumn} ${direction}, page_rows.id ${direction}`,
        parts.parameters,
      )) as ListQueryRow[];
      return this.mapListRows(rows, query, filterMac);
    });
  }

  async myActions(
    tenant: TenantContext,
    query: LeadMyActionsDto,
  ): Promise<LeadListResponse> {
    return this.list(tenant, {
      limit: query.limit,
      cursor: query.cursor,
      responsibleMembershipId: query.responsibleMembershipId,
      assignedToMe:
        query.responsibleMembershipId === undefined ? 'true' : undefined,
      nextActionState: query.state,
      sort: LeadListSort.NEXT_ACTION_DUE_AT_ASC,
    });
  }

  async unassigned(
    tenant: TenantContext,
    query: LeadUnassignedQueueDto,
  ): Promise<LeadListResponse> {
    if (
      query.responsibleMembershipId !== undefined ||
      query.assignedToMe !== undefined
    ) {
      throw new BadRequestException('Invalid assignment filters.');
    }
    return this.list(tenant, {
      q: query.q,
      status: query.status ?? LeadStatus.ACTIVE,
      source: query.source,
      nextActionState: query.nextActionState,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      lastEntryFrom: query.lastEntryFrom,
      lastEntryTo: query.lastEntryTo,
      unassigned: 'true',
      limit: query.limit,
      cursor: query.cursor,
      sort: LeadListSort.CREATED_AT_DESC,
    });
  }

  private baseParts(
    tenant: TenantContext,
    query: Pick<
      ListLeadsDto,
      | 'q'
      | 'responsibleMembershipId'
      | 'assignedToMe'
      | 'unassigned'
      | 'source'
      | 'nextActionState'
      | 'createdFrom'
      | 'createdTo'
      | 'lastEntryFrom'
      | 'lastEntryTo'
    >,
  ): SqlParts {
    const parts: SqlParts = {
      parameters: [tenant.organizationId, tenant.membershipId, tenant.userId],
      ctes: [this.authorizedActorCte()],
      joins: [this.listJoinsSql()],
      predicates: [
        `lead.organization_id = $1`,
        `(actor.role <> 'member' OR lead.responsible_membership_id = actor.id)`,
      ],
      targetRequested: query.responsibleMembershipId !== undefined,
    };

    if (query.responsibleMembershipId !== undefined) {
      const target = this.param(parts, query.responsibleMembershipId);
      parts.ctes.push(`target_membership AS MATERIALIZED (
        SELECT membership.id
        FROM public.memberships membership
        JOIN public.users application_user
          ON application_user.id = membership.user_id
         AND application_user.status = 'active'
        WHERE membership.id = ${target}::uuid
          AND membership.organization_id = $1
          AND membership.status = 'active'
      )`);
      parts.predicates.push(
        `actor.role IN ('owner','admin')`,
        `lead.responsible_membership_id = (SELECT id FROM target_membership)`,
      );
    } else if (query.assignedToMe === 'true') {
      parts.predicates.push('lead.responsible_membership_id = actor.id');
    } else if (query.unassigned === 'true') {
      parts.predicates.push(
        `actor.role IN ('owner','admin')`,
        'lead.responsible_membership_id IS NULL',
      );
    }

    if (query.source !== undefined) {
      parts.predicates.push(
        `first_entry.source = ${this.param(parts, query.source)}`,
      );
    }
    this.addSearch(parts, query.q);
    this.addTemporalState(parts, query.nextActionState);
    this.addCivilRange(
      parts,
      'lead.created_at',
      query.createdFrom,
      query.createdTo,
    );
    this.addCivilRange(
      parts,
      'last_entry.received_at',
      query.lastEntryFrom,
      query.lastEntryTo,
    );
    return parts;
  }

  private authorizedActorCte(): string {
    return `authorized_actor AS MATERIALIZED (
      SELECT membership.id, membership.organization_id, membership.role,
             organization.crm_time_zone,
             statement_timestamp() AS as_of
      FROM public.memberships membership
      JOIN public.users application_user
        ON application_user.id = membership.user_id
       AND application_user.status = 'active'
      JOIN public.organizations organization
        ON organization.id = membership.organization_id
       AND organization.status = 'active'
      WHERE organization.id = $1 AND membership.id = $2
        AND membership.user_id = $3 AND membership.status = 'active'
    )`;
  }

  private listSelectSql(extraSelect = ''): string {
    return `SELECT lead.id, lead.display_name AS "displayName",
      lead.primary_phone AS "primaryPhone", lead.email,
      lead.company_name AS "companyName",
      lead.responsible_membership_id AS "responsibleMembershipId",
      lead.status, lead.stage,
      latest_cycle.expected_value_minor::text AS "expectedValueMinor",
      first_entry.source,
      last_entry.received_at AS "lastEntryAt",
      CASE WHEN pending_action.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', pending_action.id, 'type', pending_action.type,
        'description', pending_action.description,
        'dueAt', pending_action.due_at,
        'responsibleMembershipId', pending_action.responsible_membership_id,
        'status', pending_action.status,
        'revision', pending_action.revision::text
      ) END AS "nextAction",
      CASE WHEN pending_action.id IS NULL THEN 'none'
        WHEN pending_action.due_at < actor.as_of THEN 'overdue'
        WHEN (pending_action.due_at AT TIME ZONE actor.crm_time_zone)::date =
             (actor.as_of AT TIME ZONE actor.crm_time_zone)::date THEN 'today'
        ELSE 'future' END AS "temporalState",
      EXISTS (SELECT 1 FROM public.lead_return_reviews return_review
        WHERE return_review.organization_id = lead.organization_id
          AND return_review.lead_id = lead.id
          AND return_review.status = 'pending') AS "returnPending",
      lead.revision::text AS revision, lead.created_at AS "createdAt",
      lead.updated_at AS "updatedAt", pending_action.due_at AS "nextActionDueAt",
      to_char(lead.created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
      to_char(pending_action.due_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorNextActionDueAt"${extraSelect}
      FROM authorized_actor actor JOIN public.leads lead ON true`;
  }

  private listJoinsSql(): string {
    return `JOIN public.lead_entries first_entry
      ON first_entry.organization_id = lead.organization_id
     AND first_entry.lead_id = lead.id AND first_entry.sequence = 1
    JOIN public.lead_entries last_entry
      ON last_entry.organization_id = lead.organization_id
     AND last_entry.lead_id = lead.id
     AND last_entry.sequence = lead.next_entry_sequence - 1
    LEFT JOIN public.lead_next_actions pending_action
      ON pending_action.organization_id = lead.organization_id
     AND pending_action.lead_id = lead.id AND pending_action.status = 'pending'
    JOIN public.lead_commercial_cycles latest_cycle
      ON latest_cycle.organization_id = lead.organization_id
     AND latest_cycle.lead_id = lead.id
     AND latest_cycle.cycle_number = lead.next_cycle_number - 1`;
  }

  private addSearch(parts: SqlParts, rawQuery: string | undefined): void {
    if (rawQuery === undefined) return;
    const query = this.normalizeSearch(rawQuery);
    if (PHONE_LIKE.test(query)) {
      try {
        const phone = normalizeLeadPhone(query);
        parts.predicates.push(
          `lead.primary_phone = ${this.param(parts, phone)}`,
        );
        return;
      } catch {
        // A phone-like value may still be a valid textual prefix.
      }
    }
    const pattern = `${query
      .toLocaleLowerCase('und')
      .replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
    const parameter = this.param(parts, pattern);
    parts.predicates.push(`(
      lower(normalize(lead.display_name, NFC)) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(normalize(lead.company_name, NFC)) LIKE ${parameter} ESCAPE E'\\\\'
      OR lower(normalize(lead.email, NFC)) LIKE ${parameter} ESCAPE E'\\\\'
    )`);
  }

  private addTemporalState(
    parts: SqlParts,
    state: LeadNextActionTemporalState | undefined,
  ): void {
    if (state === undefined) return;
    if (state === LeadNextActionTemporalState.NONE) {
      parts.predicates.push('pending_action.id IS NULL');
    } else if (state === LeadNextActionTemporalState.OVERDUE) {
      parts.predicates.push(
        'pending_action.id IS NOT NULL',
        'pending_action.due_at < actor.as_of',
      );
    } else if (state === LeadNextActionTemporalState.TODAY) {
      parts.predicates.push(
        'pending_action.id IS NOT NULL',
        'pending_action.due_at >= actor.as_of',
        `(pending_action.due_at AT TIME ZONE actor.crm_time_zone)::date =
          (actor.as_of AT TIME ZONE actor.crm_time_zone)::date`,
      );
    } else {
      parts.predicates.push(
        'pending_action.id IS NOT NULL',
        `(pending_action.due_at AT TIME ZONE actor.crm_time_zone)::date >
          (actor.as_of AT TIME ZONE actor.crm_time_zone)::date`,
      );
    }
  }

  private addCivilRange(
    parts: SqlParts,
    expression: string,
    from: string | undefined,
    to: string | undefined,
  ): void {
    this.validateCivilRange(from, to, false);
    if (from !== undefined) {
      parts.predicates.push(
        `${expression} >= (${this.param(parts, from)}::date::timestamp
          AT TIME ZONE actor.crm_time_zone)`,
      );
    }
    if (to !== undefined) {
      parts.predicates.push(
        `${expression} < (${this.param(parts, to)}::date::timestamp
          AT TIME ZONE actor.crm_time_zone)`,
      );
    }
  }

  private mapListRows(
    rows: ListQueryRow[],
    query: ListLeadsDto,
    filterMac: string,
  ): LeadListResponse {
    const first = rows[0];
    if (first === undefined)
      throw new ForbiddenException('Organization access denied.');
    if (
      first.actorRole === MembershipRole.MEMBER &&
      (query.responsibleMembershipId !== undefined ||
        query.unassigned === 'true')
    ) {
      throw new ForbiddenException('Organization access denied.');
    }
    if (query.responsibleMembershipId !== undefined && !first.targetExists) {
      throw new NotFoundException('Membership not found.');
    }
    const candidates = rows.filter(
      (row): row is ListQueryRow & Required<Pick<ListQueryRow, 'id'>> =>
        row.id !== undefined && row.id !== null,
    );
    const hasMore = candidates.length > query.limit;
    const selected = hasMore ? candidates.slice(0, query.limit) : candidates;
    const items = selected.map((row) => this.mapListItem(row));
    const last = selected.at(-1);
    const cursorKey =
      last === undefined
        ? null
        : query.sort.startsWith('nextActionDueAt')
          ? last.cursorNextActionDueAt
          : last.cursorCreatedAt;
    return {
      items,
      page: {
        limit: query.limit,
        total: this.safeCount(first.total),
        asOf: this.iso(first.asOf),
        nextCursor:
          hasMore && last?.id !== undefined && cursorKey
            ? this.encodeCursor({
                v: 1,
                scope: 'list',
                sort: query.sort,
                key: cursorKey,
                id: last.id,
                filterMac,
              })
            : null,
      },
    };
  }

  private mapListItem(row: ListQueryRow): LeadListItem {
    return {
      id: row.id as string,
      displayName: row.displayName as string,
      primaryPhone: row.primaryPhone as string,
      email: row.email ?? null,
      companyName: row.companyName ?? null,
      responsibleMembershipId: row.responsibleMembershipId ?? null,
      status: row.status as LeadStatus,
      stage: row.stage as LeadStage,
      expectedValueMinor: row.expectedValueMinor ?? null,
      source: row.source as string,
      lastEntryAt: this.iso(row.lastEntryAt as Date | string),
      nextAction: row.nextAction ?? null,
      temporalState: row.temporalState as LeadNextActionTemporalState,
      returnPending: row.returnPending === true,
      revision: row.revision as string,
      createdAt: this.iso(row.createdAt as Date | string),
      updatedAt: this.iso(row.updatedAt as Date | string),
    };
  }

  private validateListQuery(query: ListLeadsDto): void {
    const assignmentFilters = [
      query.responsibleMembershipId,
      query.assignedToMe,
      query.unassigned,
    ].filter((value) => value !== undefined).length;
    if (assignmentFilters > 1) {
      throw new BadRequestException(
        'Assignment filters are mutually exclusive.',
      );
    }
    if (
      query.nextActionState === LeadNextActionTemporalState.NONE &&
      query.sort.startsWith('nextActionDueAt')
    ) {
      throw new BadRequestException('Invalid Next Action sort.');
    }
    this.validateCivilRange(query.createdFrom, query.createdTo, true);
    this.validateCivilRange(query.lastEntryFrom, query.lastEntryTo, true);
    if (query.q !== undefined) this.normalizeSearch(query.q);
  }

  private normalizeSearch(value: string): string {
    const normalized = value.trim().normalize('NFC');
    const length = [...normalized].length;
    if (length < 3 || length > 100 || CONTROL_OR_SEPARATOR.test(normalized)) {
      throw new BadRequestException('Invalid lead search.');
    }
    return normalized;
  }

  private validateCivilRange(
    from: string | undefined,
    to: string | undefined,
    requirePair: boolean,
  ): void {
    if (requirePair && (from === undefined) !== (to === undefined)) {
      throw new BadRequestException('Both period limits are required.');
    }
    for (const value of [from, to]) {
      if (value !== undefined && !this.validCivilDate(value)) {
        throw new BadRequestException('Invalid civil date.');
      }
    }
    if (from !== undefined && to !== undefined) {
      const days =
        (Date.parse(`${to}T00:00:00.000Z`) -
          Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000;
      if (days <= 0 || days > 366) {
        throw new BadRequestException('Invalid civil date range.');
      }
    }
  }

  private validCivilDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }

  private listFilterIdentity(query: ListLeadsDto): unknown[] {
    return [
      query.q?.trim().normalize('NFC') ?? null,
      query.status ?? null,
      query.stage ?? null,
      query.responsibleMembershipId ?? null,
      query.assignedToMe ?? null,
      query.unassigned ?? null,
      query.source ?? null,
      query.returnPending ?? null,
      query.nextActionState ?? null,
      query.createdFrom ?? null,
      query.createdTo ?? null,
      query.lastEntryFrom ?? null,
      query.lastEntryTo ?? null,
    ];
  }

  private filterMac(scope: string, identity: unknown): string {
    const version = this.config.idempotencyCurrentKeyVersion;
    if (version === null)
      throw new ServiceUnavailableException('Lead read is unavailable.');
    const key = this.config.idempotencyKeys.get(version);
    if (key === undefined)
      throw new ServiceUnavailableException('Lead read is unavailable.');
    return createHmac('sha256', key)
      .update(JSON.stringify(['lead-read-filter', 1, scope, identity]), 'utf8')
      .digest('base64url');
  }

  private encodeCursor(cursor: Omit<QueryCursor, 'cursorMac'>): string {
    return Buffer.from(
      JSON.stringify({ ...cursor, cursorMac: this.cursorMac(cursor) }),
      'utf8',
    ).toString('base64url');
  }

  private decodeCursor(
    value: string,
    scope: string,
    sort: string,
    filterMac: string,
    stage?: LeadStage,
  ): QueryCursor {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<QueryCursor>;
      const expected = Buffer.from(filterMac, 'base64url');
      const actual = Buffer.from(parsed.filterMac ?? '', 'base64url');
      const cursorWithoutMac = {
        v: 1,
        scope,
        sort,
        ...(stage === undefined ? {} : { stage }),
        key: parsed.key,
        id: parsed.id,
        filterMac: parsed.filterMac,
      } as Omit<QueryCursor, 'cursorMac'>;
      const expectedCursorMac = Buffer.from(
        this.cursorMac(cursorWithoutMac),
        'base64url',
      );
      const actualCursorMac = Buffer.from(parsed.cursorMac ?? '', 'base64url');
      if (
        parsed.v !== 1 ||
        parsed.scope !== scope ||
        parsed.sort !== sort ||
        parsed.stage !== stage ||
        typeof parsed.key !== 'string' ||
        !this.validCursorInstant(parsed.key) ||
        typeof parsed.id !== 'string' ||
        !isUUID(parsed.id, '4') ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected) ||
        actualCursorMac.length !== expectedCursorMac.length ||
        !timingSafeEqual(actualCursorMac, expectedCursorMac) ||
        this.encodeCursor(cursorWithoutMac) !== value
      ) {
        throw new Error('invalid');
      }
      return parsed as QueryCursor;
    } catch {
      throw new BadRequestException('Invalid cursor.');
    }
  }

  private cursorMac(cursor: Omit<QueryCursor, 'cursorMac'>): string {
    const version = this.config.idempotencyCurrentKeyVersion;
    if (version === null)
      throw new ServiceUnavailableException('Lead read is unavailable.');
    const key = this.config.idempotencyKeys.get(version);
    if (key === undefined)
      throw new ServiceUnavailableException('Lead read is unavailable.');
    return createHmac('sha256', key)
      .update(
        JSON.stringify([
          'lead-read-cursor',
          cursor.v,
          cursor.scope,
          cursor.sort,
          cursor.stage ?? null,
          cursor.key,
          cursor.id,
          cursor.filterMac,
        ]),
        'utf8',
      )
      .digest('base64url');
  }

  private param(parts: SqlParts, value: unknown): string {
    parts.parameters.push(value);
    return `$${parts.parameters.length}`;
  }

  private safeCount(value: string): number {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ServiceUnavailableException('Lead read is unavailable.');
    }
    return count;
  }

  private financialTotal(value: string): string {
    if (!NON_NEGATIVE_INTEGER.test(value)) {
      throw new ServiceUnavailableException('Lead read is unavailable.');
    }
    return value;
  }

  private iso(value: Date | string): string {
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  }

  private validCursorInstant(value: string): boolean {
    if (!CURSOR_INSTANT.test(value)) return false;
    const millisecondProjection = `${value.slice(0, 23)}Z`;
    const date = new Date(millisecondProjection);
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString() === millisecondProjection
    );
  }

  private async withOperationalQuery<T>(
    operation: (runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    await this.readiness.assertOperationalReadReady();
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`SELECT set_config('statement_timeout', $1, true)`, [
        `${this.config.readStatementTimeoutMs}ms`,
      ]);
      const result = await operation(runner);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async kanban(
    tenant: TenantContext,
    query: LeadKanbanDto,
  ): Promise<LeadKanbanResponse> {
    this.validateListQuery({
      ...query,
      limit: query.limit,
      sort: LeadListSort.CREATED_AT_DESC,
    });
    if (query.cursor !== undefined && query.stage === undefined) {
      throw new BadRequestException('Kanban stage is required with cursor.');
    }
    const identity = [
      query.q?.trim().normalize('NFC') ?? null,
      query.responsibleMembershipId ?? null,
      query.assignedToMe ?? null,
      query.unassigned ?? null,
      query.source ?? null,
      query.nextActionState ?? null,
      query.createdFrom ?? null,
      query.createdTo ?? null,
      query.lastEntryFrom ?? null,
      query.lastEntryTo ?? null,
    ];
    const filterMac = this.filterMac('kanban', [
      tenant.organizationId,
      tenant.membershipId,
      tenant.userId,
      LeadListSort.CREATED_AT_DESC,
      identity,
    ]);
    const cursor = query.cursor
      ? this.decodeCursor(
          query.cursor,
          'kanban',
          LeadListSort.CREATED_AT_DESC,
          filterMac,
          query.stage,
        )
      : null;

    return this.withOperationalQuery(async (runner) => {
      const parts = this.baseParts(tenant, query);
      parts.predicates.push(`lead.status = 'active'`);
      const requestedStages =
        query.stage === undefined ? STAGES : [query.stage];
      const stageValues = requestedStages
        .map((stage) => `(${this.param(parts, stage)}::lead_stage_enum)`)
        .join(',');
      let cursorPredicate = '';
      if (cursor !== null) {
        const key = this.param(parts, cursor.key);
        const id = this.param(parts, cursor.id);
        cursorPredicate = `AND (candidate."createdAt", candidate.id) <
          (${key}::timestamptz, ${id}::uuid)`;
      }
      const limit = this.param(parts, query.limit + 1);
      const targetExists = parts.targetRequested
        ? 'EXISTS (SELECT 1 FROM target_membership)'
        : 'true';
      const rows = (await runner.query(
        `WITH ${parts.ctes.join(',\n')},
        filtered AS NOT MATERIALIZED (
          ${this.listSelectSql()}
          ${parts.joins.join('\n')}
          WHERE ${parts.predicates.join(' AND ')}
        ), stage_aggregates AS MATERIALIZED (
          SELECT candidate.stage, count(*)::text AS total,
            COALESCE(
              sum(candidate."expectedValueMinor"::numeric), 0::numeric
            )::text AS "expectedValueTotalMinor",
            count(*) FILTER (
              WHERE candidate."expectedValueMinor" IS NULL
            )::text AS "withoutExpectedValue"
          FROM filtered candidate
          GROUP BY candidate.stage
        ), pipeline_aggregate AS (
          SELECT COALESCE(
              sum(stage_aggregate."expectedValueTotalMinor"::numeric),
              0::numeric
            )::text AS "expectedValueTotalMinor",
            COALESCE(
              sum(stage_aggregate."withoutExpectedValue"::numeric),
              0::numeric
            )::text AS "withoutExpectedValue"
          FROM stage_aggregates stage_aggregate
        ), requested_stage(stage) AS (VALUES ${stageValues})
        SELECT actor.role AS "actorRole", ${targetExists} AS "targetExists",
          actor.as_of AS "asOf", requested_stage.stage,
          COALESCE(stage_aggregate.total, '0') AS total,
          COALESCE(
            stage_aggregate."expectedValueTotalMinor", '0'
          ) AS "expectedValueTotalMinor",
          COALESCE(
            stage_aggregate."withoutExpectedValue", '0'
          ) AS "withoutExpectedValue",
          pipeline_aggregate."expectedValueTotalMinor"
            AS "pipelineExpectedValueTotalMinor",
          pipeline_aggregate."withoutExpectedValue"
            AS "pipelineWithoutExpectedValue",
          COALESCE((SELECT jsonb_agg(to_jsonb(page_candidate)
            - 'nextActionDueAt' ORDER BY page_candidate."createdAt" DESC,
              page_candidate.id DESC)
            FROM (SELECT candidate.* FROM filtered candidate
              WHERE candidate.stage = requested_stage.stage ${cursorPredicate}
              ORDER BY candidate."createdAt" DESC, candidate.id DESC
              LIMIT ${limit}) page_candidate), '[]'::jsonb) AS items
        FROM authorized_actor actor CROSS JOIN requested_stage
        LEFT JOIN stage_aggregates stage_aggregate
          ON stage_aggregate.stage = requested_stage.stage
        CROSS JOIN pipeline_aggregate
        ORDER BY array_position(
          ARRAY['new','qualification','diagnosis','proposal','negotiation']::lead_stage_enum[],
          requested_stage.stage
        )`,
        parts.parameters,
      )) as Array<{
        actorRole: MembershipRole;
        targetExists: boolean;
        asOf: Date | string;
        stage: LeadStage;
        total: string;
        expectedValueTotalMinor: string;
        withoutExpectedValue: string;
        pipelineExpectedValueTotalMinor: string;
        pipelineWithoutExpectedValue: string;
        items: ListQueryRow[];
      }>;
      const first = rows[0];
      if (first === undefined) {
        throw new ForbiddenException('Organization access denied.');
      }
      if (
        first.actorRole === MembershipRole.MEMBER &&
        (query.responsibleMembershipId !== undefined ||
          query.unassigned === 'true')
      ) {
        throw new ForbiddenException('Organization access denied.');
      }
      if (query.responsibleMembershipId !== undefined && !first.targetExists) {
        throw new NotFoundException('Membership not found.');
      }
      return {
        asOf: this.iso(first.asOf),
        currency: 'BRL',
        expectedValueTotalMinor: this.financialTotal(
          first.pipelineExpectedValueTotalMinor,
        ),
        withoutExpectedValue: this.safeCount(
          first.pipelineWithoutExpectedValue,
        ),
        columns: rows.map((row) => {
          const hasMore = row.items.length > query.limit;
          const candidates = hasMore
            ? row.items.slice(0, query.limit)
            : row.items;
          const items = candidates.map((item) => this.mapListItem(item));
          const last = candidates.at(-1);
          return {
            stage: row.stage,
            total: this.safeCount(row.total),
            expectedValueTotalMinor: this.financialTotal(
              row.expectedValueTotalMinor,
            ),
            withoutExpectedValue: this.safeCount(row.withoutExpectedValue),
            items,
            page: {
              limit: query.limit,
              nextCursor:
                hasMore && last?.id !== undefined && last.cursorCreatedAt
                  ? this.encodeCursor({
                      v: 1,
                      scope: 'kanban',
                      sort: LeadListSort.CREATED_AT_DESC,
                      stage: row.stage,
                      key: last.cursorCreatedAt,
                      id: last.id,
                      filterMac,
                    })
                  : null,
            },
          };
        }),
      };
    });
  }

  async returnReviews(
    tenant: TenantContext,
    query: LeadReturnReviewQueueDto,
  ): Promise<LeadReturnReviewQueueResponse> {
    if (query.q !== undefined) this.normalizeSearch(query.q);
    const identity = [
      query.q?.trim().normalize('NFC') ?? null,
      query.source ?? null,
    ];
    const filterMac = this.filterMac('return-reviews', [
      tenant.organizationId,
      tenant.membershipId,
      tenant.userId,
      'openedAt:asc',
      identity,
    ]);
    const cursor = query.cursor
      ? this.decodeCursor(
          query.cursor,
          'return-reviews',
          'openedAt:asc',
          filterMac,
        )
      : null;
    return this.withOperationalQuery(async (runner) => {
      const parts = this.baseParts(tenant, {
        q: query.q,
        source: query.source,
      });
      parts.predicates.push(
        `actor.role IN ('owner','admin')`,
        `lead.status <> 'active'`,
        `review.status = 'pending'`,
      );
      parts.joins.push(`JOIN public.lead_return_reviews review
        ON review.organization_id = lead.organization_id
       AND review.lead_id = lead.id
      JOIN public.lead_entries review_first
        ON review_first.id = review.first_entry_id
       AND review_first.organization_id = review.organization_id
       AND review_first.lead_id = review.lead_id
      JOIN public.lead_entries review_latest
        ON review_latest.id = review.latest_entry_id
       AND review_latest.organization_id = review.organization_id
       AND review_latest.lead_id = review.lead_id`);
      let cursorPredicate = '';
      if (cursor !== null) {
        const key = this.param(parts, cursor.key);
        const id = this.param(parts, cursor.id);
        cursorPredicate = `WHERE ("openedAt", "reviewId") >
          (${key}::timestamptz, ${id}::uuid)`;
      }
      const limit = this.param(parts, query.limit + 1);
      const rows = (await runner.query(
        `WITH ${parts.ctes.join(',\n')}, filtered AS NOT MATERIALIZED (
          ${this
            .listSelectSql(`, review.id AS "reviewId", review.cycle_id AS "cycleId",
            review.entry_count::text AS "entryCount",
            review.opened_at AS "openedAt", review.updated_at AS "reviewUpdatedAt",
            to_char(review.opened_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorOpenedAt",
            jsonb_build_object('id', review_first.id, 'source', review_first.source,
              'receivedAt', review_first.received_at) AS "firstReviewEntry",
            jsonb_build_object('id', review_latest.id, 'source', review_latest.source,
              'receivedAt', review_latest.received_at) AS "latestReviewEntry"`)}
          ${parts.joins.join('\n')}
          WHERE ${parts.predicates.join(' AND ')}
        ), counted AS (SELECT count(*)::text AS total FROM filtered),
        page_rows AS (SELECT * FROM filtered ${cursorPredicate}
          ORDER BY "openedAt" ASC, "reviewId" ASC LIMIT ${limit})
        SELECT actor.role AS "actorRole", true AS "targetExists",
          actor.as_of AS "asOf", counted.total, page_rows.*
        FROM authorized_actor actor CROSS JOIN counted
        LEFT JOIN page_rows ON true
        ORDER BY page_rows."openedAt" ASC, page_rows."reviewId" ASC`,
        parts.parameters,
      )) as ReturnReviewQueryRow[];
      const first = rows[0];
      if (first === undefined || first.actorRole === MembershipRole.MEMBER) {
        throw new ForbiddenException('Organization access denied.');
      }
      const candidates = rows.filter((row) => row.reviewId !== undefined);
      const hasMore = candidates.length > query.limit;
      const selected = hasMore ? candidates.slice(0, query.limit) : candidates;
      const items = selected.map((row) => ({
        lead: this.mapListItem(row),
        review: {
          id: row.reviewId as string,
          cycleId: row.cycleId as string,
          entryCount: row.entryCount as string,
          openedAt: this.iso(row.openedAt as Date | string),
          updatedAt: this.iso(row.reviewUpdatedAt as Date | string),
          firstEntry: row.firstReviewEntry as {
            id: string;
            source: string;
            receivedAt: string;
          },
          latestEntry: row.latestReviewEntry as {
            id: string;
            source: string;
            receivedAt: string;
          },
        },
      }));
      const last = selected.at(-1);
      return {
        items,
        page: {
          limit: query.limit,
          total: this.safeCount(first.total),
          asOf: this.iso(first.asOf),
          nextCursor:
            hasMore && last?.reviewId && last.cursorOpenedAt
              ? this.encodeCursor({
                  v: 1,
                  scope: 'return-reviews',
                  sort: 'openedAt:asc',
                  key: last.cursorOpenedAt,
                  id: last.reviewId,
                  filterMac,
                })
              : null,
        },
      };
    });
  }

  async metrics(
    tenant: TenantContext,
    query: LeadMetricsDto,
  ): Promise<LeadMetricsResponse> {
    this.validateMetricsRange(query.from, query.to);
    return this.withOperationalQuery(async (runner) => {
      const rows = (await runner.query(
        `WITH ${this.authorizedActorCte()}, bounds AS MATERIALIZED (
          SELECT actor.*,
            COALESCE($4::date,
              (actor.as_of AT TIME ZONE actor.crm_time_zone)::date - 29) AS from_date,
            COALESCE($5::date,
              (actor.as_of AT TIME ZONE actor.crm_time_zone)::date) AS to_date
          FROM authorized_actor actor
        ), instants AS MATERIALIZED (
          SELECT bounds.*,
            bounds.from_date::timestamp AT TIME ZONE bounds.crm_time_zone AS from_at,
            (bounds.to_date + 1)::timestamp AT TIME ZONE bounds.crm_time_zone AS to_at
          FROM bounds
        ), snapshot AS (
          SELECT
            count(*) FILTER (WHERE lead.status = 'active')::text AS active,
            count(*) FILTER (WHERE lead.status = 'active'
              AND lead.responsible_membership_id IS NULL)::text AS unassigned,
            count(*) FILTER (WHERE lead.status = 'active'
              AND action.due_at < instants.as_of)::text AS overdue,
            count(*) FILTER (WHERE lead.status = 'active'
              AND action.id IS NULL)::text AS "withoutNextAction"
          FROM instants LEFT JOIN public.leads lead
            ON lead.organization_id = instants.organization_id
          LEFT JOIN public.lead_next_actions action
            ON action.organization_id = lead.organization_id
           AND action.lead_id = lead.id AND action.status = 'pending'
          WHERE instants.role IN ('owner','admin')
        ), pending_returns AS (
          SELECT count(review.id)::text AS count FROM instants
          LEFT JOIN public.lead_return_reviews review
            ON review.organization_id = instants.organization_id
           AND review.status = 'pending'
          WHERE instants.role IN ('owner','admin')
        ), period AS (
          SELECT
            (SELECT count(lead.id)::text FROM public.leads lead
              WHERE lead.organization_id = instants.organization_id
                AND lead.created_at >= instants.from_at
                AND lead.created_at < instants.to_at) AS created,
            (SELECT count(cycle.id) FILTER (WHERE cycle.closing_status = 'won')::text
              FROM public.lead_commercial_cycles cycle
              WHERE cycle.organization_id = instants.organization_id
                AND cycle.closed_at >= instants.from_at
                AND cycle.closed_at < instants.to_at) AS won,
            (SELECT count(cycle.id) FILTER (WHERE cycle.closing_status = 'lost')::text
              FROM public.lead_commercial_cycles cycle
              WHERE cycle.organization_id = instants.organization_id
                AND cycle.closed_at >= instants.from_at
                AND cycle.closed_at < instants.to_at) AS lost,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'source', grouped.source, 'count', grouped.count::text)
                ORDER BY grouped.source)
              FROM (SELECT entry.source, count(*) AS count
                FROM public.leads lead
                JOIN public.lead_entries entry
                  ON entry.organization_id = lead.organization_id
                 AND entry.lead_id = lead.id AND entry.sequence = 1
                WHERE lead.organization_id = instants.organization_id
                  AND lead.created_at >= instants.from_at
                  AND lead.created_at < instants.to_at
                GROUP BY entry.source) grouped), '[]'::jsonb) AS "createdBySource"
          FROM instants WHERE instants.role IN ('owner','admin')
        )
        SELECT instants.role AS "actorRole", instants.as_of AS "asOf",
          instants.crm_time_zone AS "timeZone",
          instants.from_date::text AS "fromDate",
          instants.to_date::text AS "toDate",
          snapshot.active, snapshot.unassigned, snapshot.overdue,
          snapshot."withoutNextAction", pending_returns.count AS "pendingReturns",
          period.created, period.won, period.lost, period."createdBySource"
        FROM instants LEFT JOIN snapshot ON true
        LEFT JOIN pending_returns ON true LEFT JOIN period ON true`,
        [
          tenant.organizationId,
          tenant.membershipId,
          tenant.userId,
          query.from ?? null,
          query.to ?? null,
        ],
      )) as Array<{
        actorRole: MembershipRole;
        asOf: Date | string;
        timeZone: string;
        fromDate: string;
        toDate: string;
        active: string;
        unassigned: string;
        overdue: string;
        withoutNextAction: string;
        pendingReturns: string;
        created: string;
        won: string;
        lost: string;
        createdBySource: Array<{ source: string; count: string }>;
      }>;
      const row = rows[0];
      if (row === undefined || row.actorRole === MembershipRole.MEMBER) {
        throw new ForbiddenException('Organization access denied.');
      }
      return {
        asOf: this.iso(row.asOf),
        timeZone: row.timeZone,
        snapshot: {
          active: this.safeCount(row.active),
          unassigned: this.safeCount(row.unassigned),
          overdue: this.safeCount(row.overdue),
          withoutNextAction: this.safeCount(row.withoutNextAction),
          pendingReturns: this.safeCount(row.pendingReturns),
        },
        period: {
          from: row.fromDate,
          to: row.toDate,
          created: this.safeCount(row.created),
          won: this.safeCount(row.won),
          lost: this.safeCount(row.lost),
          createdBySource: row.createdBySource.map((entry) => ({
            source: entry.source,
            count: this.safeCount(entry.count),
          })),
        },
      };
    });
  }

  async detail(tenant: TenantContext, leadId: string): Promise<LeadDetailView> {
    return this.withOperationalQuery(async (runner) => {
      const rows = (await runner.query(
        `WITH ${this.authorizedActorCte()}, authorized_lead AS MATERIALIZED (
          SELECT lead.* FROM authorized_actor actor
          JOIN public.leads lead ON lead.organization_id = $1 AND lead.id = $4
          WHERE actor.role <> 'member' OR lead.responsible_membership_id = actor.id
        )
        SELECT CASE WHEN lead.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', lead.id, 'displayName', lead.display_name,
          'primaryPhone', lead.primary_phone, 'email', lead.email,
          'companyName', lead.company_name, 'instagram', lead.instagram,
          'city', lead.city, 'serviceInterest', lead.service_interest,
          'responsibleMembershipId', lead.responsible_membership_id,
          'status', lead.status, 'stage', lead.stage,
          'latestCycleNumber', (lead.next_cycle_number - 1)::text,
          'returnReviewPending', pending_return.id IS NOT NULL,
          'revision', lead.revision::text, 'createdAt', lead.created_at,
          'updatedAt', lead.updated_at,
          'initialAttribution', first_entry.attribution,
          'lastAttribution', last_entry.attribution,
          'latestEntry', last_entry.summary,
          'latestCycle', latest_cycle.summary,
          'pendingReturn', pending_return.summary,
          'nextAction', pending_action.summary,
          'counts', counts.summary
        ) END AS item
        FROM authorized_actor actor
        LEFT JOIN authorized_lead lead ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object('source', entry.source,
            'sourceDetail', entry.source_detail, 'utmSource', entry.utm_source,
            'utmMedium', entry.utm_medium, 'utmCampaign', entry.utm_campaign,
            'utmContent', entry.utm_content, 'utmTerm', entry.utm_term,
            'receivedAt', entry.received_at) AS attribution
          FROM public.lead_entries entry WHERE entry.organization_id = lead.organization_id
            AND entry.lead_id = lead.id AND entry.sequence = 1
        ) first_entry ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object('source', entry.source,
            'sourceDetail', entry.source_detail, 'utmSource', entry.utm_source,
            'utmMedium', entry.utm_medium, 'utmCampaign', entry.utm_campaign,
            'utmContent', entry.utm_content, 'utmTerm', entry.utm_term,
            'receivedAt', entry.received_at) AS attribution,
            jsonb_build_object('id', entry.id, 'sequence', entry.sequence::text,
              'intakeChannel', entry.intake_channel, 'source', entry.source,
              'receivedAt', entry.received_at) AS summary
          FROM public.lead_entries entry WHERE entry.organization_id = lead.organization_id
            AND entry.lead_id = lead.id ORDER BY entry.sequence DESC LIMIT 1
        ) last_entry ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object('id', cycle.id,
            'cycleNumber', cycle.cycle_number::text,
            'expectedValueMinor', cycle.expected_value_minor::text,
            'openingReason', cycle.opening_reason, 'startingStage', cycle.starting_stage,
            'openedByMembershipId', cycle.opened_by_membership_id,
            'openedAt', cycle.opened_at, 'closedByMembershipId', cycle.closed_by_membership_id,
            'closedAt', cycle.closed_at, 'closingStatus', cycle.closing_status,
            'stageAtClose', cycle.stage_at_close, 'lostReason', cycle.lost_reason,
            'archiveReason', cycle.archive_reason,
            'reasonNote', cycle.reason_note) AS summary
          FROM public.lead_commercial_cycles cycle
          WHERE cycle.organization_id = lead.organization_id AND cycle.lead_id = lead.id
          ORDER BY cycle.cycle_number DESC LIMIT 1
        ) latest_cycle ON true
        LEFT JOIN LATERAL (
          SELECT review.id, jsonb_build_object('id', review.id,
            'cycleId', review.cycle_id, 'entryCount', review.entry_count::text,
            'openedAt', review.opened_at, 'updatedAt', review.updated_at) AS summary
          FROM public.lead_return_reviews review
          WHERE review.organization_id = lead.organization_id AND review.lead_id = lead.id
            AND review.status = 'pending'
        ) pending_return ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object('id', action.id, 'type', action.type,
            'description', action.description, 'dueAt', action.due_at,
            'responsibleMembershipId', action.responsible_membership_id,
            'status', action.status, 'revision', action.revision::text) AS summary
          FROM public.lead_next_actions action
          WHERE action.organization_id = lead.organization_id AND action.lead_id = lead.id
            AND action.status = 'pending'
        ) pending_action ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object(
            'timeline', (SELECT count(*) FROM public.lead_timeline_events event
              WHERE event.organization_id = lead.organization_id AND event.lead_id = lead.id),
            'cycles', (SELECT count(*) FROM public.lead_commercial_cycles cycle
              WHERE cycle.organization_id = lead.organization_id AND cycle.lead_id = lead.id),
            'activities', (SELECT count(*) FROM public.lead_activities activity
              WHERE activity.organization_id = lead.organization_id AND activity.lead_id = lead.id),
            'notes', (SELECT count(*) FROM public.lead_notes note
              WHERE note.organization_id = lead.organization_id AND note.lead_id = lead.id)
          ) AS summary
        ) counts ON true`,
        [tenant.organizationId, tenant.membershipId, tenant.userId, leadId],
      )) as Array<{ item: LeadDetailView | null }>;
      const item = rows[0]?.item;
      if (item === undefined || item === null)
        throw new NotFoundException('Lead not found.');
      for (const key of [
        'timeline',
        'cycles',
        'activities',
        'notes',
      ] as const) {
        item.counts[key] = this.safeCount(String(item.counts[key]));
      }
      return item;
    });
  }

  async cycles(
    tenant: TenantContext,
    leadId: string,
    query: ListLeadCyclesDto,
  ): Promise<LeadCycleListResponse> {
    const cursor = query.cursor ? this.decodeCycleCursor(query.cursor) : null;
    return this.withOperationalQuery(async (runner) => {
      const parameters: unknown[] = [
        tenant.organizationId,
        tenant.membershipId,
        tenant.userId,
        leadId,
      ];
      let cursorPredicate = '';
      if (cursor !== null) {
        parameters.push(cursor);
        cursorPredicate = `AND cycle.cycle_number < $5::bigint`;
      }
      parameters.push(query.limit + 1);
      const rows = (await runner.query(
        `WITH ${this.authorizedActorCte()}, authorized_lead AS MATERIALIZED (
          SELECT lead.id, lead.organization_id FROM authorized_actor actor
          JOIN public.leads lead ON lead.organization_id = $1 AND lead.id = $4
          WHERE actor.role <> 'member' OR lead.responsible_membership_id = actor.id
        )
        SELECT authorized.id IS NOT NULL AS "leadVisible",
          cycle.id, cycle.cycle_number::text AS "cycleNumber",
          cycle.expected_value_minor::text AS "expectedValueMinor",
          cycle.opening_reason AS "openingReason", cycle.starting_stage AS "startingStage",
          cycle.opened_by_membership_id AS "openedByMembershipId",
          cycle.opened_at AS "openedAt", cycle.closed_by_membership_id AS "closedByMembershipId",
          cycle.closed_at AS "closedAt", cycle.closing_status AS "closingStatus",
          cycle.stage_at_close AS "stageAtClose", cycle.lost_reason AS "lostReason",
          cycle.archive_reason AS "archiveReason", cycle.reason_note AS "reasonNote"
        FROM authorized_actor actor LEFT JOIN authorized_lead authorized ON true
        LEFT JOIN LATERAL (SELECT candidate.* FROM public.lead_commercial_cycles candidate
          WHERE candidate.organization_id = authorized.organization_id
            AND candidate.lead_id = authorized.id ${cursorPredicate}
          ORDER BY candidate.cycle_number DESC LIMIT $${parameters.length}) cycle ON true
        ORDER BY cycle.cycle_number DESC`,
        parameters,
      )) as Array<{
        leadVisible: boolean;
        id: string | null;
        cycleNumber: string | null;
        openingReason: string | null;
        startingStage: LeadStage | null;
        openedByMembershipId: string | null;
        openedAt: Date | null;
        closedByMembershipId: string | null;
        closedAt: Date | null;
        closingStatus: LeadStatus | null;
        stageAtClose: LeadStage | null;
        lostReason: null;
        archiveReason: null;
        reasonNote: string | null;
      }>;
      if (rows[0]?.leadVisible !== true)
        throw new NotFoundException('Lead not found.');
      const candidates = rows.filter((row) => row.id !== null);
      const hasMore = candidates.length > query.limit;
      const selected = hasMore ? candidates.slice(0, query.limit) : candidates;
      const items = selected.map(({ leadVisible, ...row }) => {
        if (!leadVisible)
          throw new ServiceUnavailableException('Lead read is unavailable.');
        return row;
      });
      const last = items.at(-1);
      return {
        items: items as LeadCycleListResponse['items'],
        page: {
          limit: query.limit,
          nextCursor:
            hasMore && last?.cycleNumber
              ? Buffer.from(
                  JSON.stringify({ cycleNumber: last.cycleNumber }),
                  'utf8',
                ).toString('base64url')
              : null,
        },
      };
    });
  }

  private validateMetricsRange(
    from: string | undefined,
    to: string | undefined,
  ): void {
    if ((from === undefined) !== (to === undefined)) {
      throw new BadRequestException('Both period limits are required.');
    }
    for (const value of [from, to]) {
      if (value !== undefined && !this.validCivilDate(value)) {
        throw new BadRequestException('Invalid civil date.');
      }
    }
    if (from !== undefined && to !== undefined) {
      const dates =
        (Date.parse(`${to}T00:00:00.000Z`) -
          Date.parse(`${from}T00:00:00.000Z`)) /
          86_400_000 +
        1;
      if (dates < 1 || dates > 366) {
        throw new BadRequestException('Invalid metrics period.');
      }
    }
  }

  private decodeCycleCursor(value: string): string {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as {
        cycleNumber?: unknown;
      };
      if (
        typeof parsed.cycleNumber !== 'string' ||
        !/^[1-9]\d*$/u.test(parsed.cycleNumber) ||
        BigInt(parsed.cycleNumber) > 9_223_372_036_854_775_807n ||
        Buffer.from(value, 'base64url').toString('base64url') !== value
      ) {
        throw new Error('invalid');
      }
      return parsed.cycleNumber;
    } catch {
      throw new BadRequestException('Invalid cursor.');
    }
  }
}
