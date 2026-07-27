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
import { isUUID } from 'class-validator';
import { DataSource, QueryFailedError } from 'typeorm';
import { LeadConfig } from '../../../config/lead.config';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import {
  ArchiveLeadDto,
  CreateLeadDto,
  ListLeadCyclesDto,
  ListLeadsDto,
  LoseLeadDto,
  UpdateLeadDto,
} from '../dto/lead.dto';
import {
  LeadArchiveReason,
  LeadCommand,
  LeadIntakeChannel,
  LeadLostReason,
  LeadStage,
  LeadStatus,
} from '../enums/lead.enums';
import { normalizeLeadPhone } from '../normalization/phone.normalizer';
import { LEAD_READINESS, LeadReadiness } from '../ports/lead-readiness.port';
import {
  leadRequestFingerprint,
  leadCommandFingerprint,
  LeadCommandFingerprintInput,
  normalizeLeadInput,
} from '../security/lead-fingerprint';
import {
  LeadCommandResult,
  LeadCommercialCycleView,
  LeadCycleListResponse,
  LeadIngestResult,
  LeadListResponse,
  LeadTimelineView,
  LeadView,
} from '../types/lead-api.type';

interface LeadRow {
  id: string;
  displayName: string;
  primaryPhone: string;
  email: string | null;
  companyName: string | null;
  instagram: string | null;
  city: string | null;
  serviceInterest: string | null;
  responsibleMembershipId: string | null;
  status: LeadStatus;
  stage: LeadStage;
  latestCycleNumber: string;
  returnReviewPending: boolean;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  initialAttribution: LeadView['initialAttribution'];
  lastAttribution: LeadView['lastAttribution'];
}

interface IngestRow {
  leadId: string;
  revision: string;
  replayed: boolean;
  visible: boolean;
  responseStatus: number;
}

interface CursorValue {
  createdAt: string;
  id: string;
}

interface CycleCursorValue {
  cycleNumber: string;
}

interface CommandRow {
  revision: string;
  replayed: boolean;
  responseStatus: number;
}

@Injectable()
export class LeadsService {
  private readonly config: LeadConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    @Inject(LEAD_READINESS) private readonly readiness: LeadReadiness,
  ) {
    this.config = config.getOrThrow<LeadConfig>('lead');
  }

  async createManual(
    tenant: TenantContext,
    dto: CreateLeadDto,
    idempotencyKey: string,
  ): Promise<LeadIngestResult> {
    await this.readiness.assertManualReady();
    const version = this.config.idempotencyCurrentKeyVersion as number;
    return this.ingest(
      tenant,
      LeadIntakeChannel.MANUAL,
      dto,
      idempotencyKey,
      version,
      this.config.idempotencyKeys.get(version) as Buffer,
    );
  }

  async createFromForm(
    dto: CreateLeadDto,
    idempotencyKey: string,
  ): Promise<void> {
    await this.readiness.assertFormReady();
    const version = this.config.idempotencyCurrentKeyVersion as number;
    await this.ingest(
      null,
      LeadIntakeChannel.GENESIS_FORM,
      dto,
      idempotencyKey,
      version,
      this.config.idempotencyKeys.get(version) as Buffer,
    );
  }

  async list(
    tenant: TenantContext,
    query: ListLeadsDto,
  ): Promise<LeadListResponse> {
    await this.readiness.assertManualReady();
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const parameters: unknown[] = [tenant.organizationId];
    const predicates = ['lead.organization_id = $1'];
    if (tenant.role === MembershipRole.MEMBER) {
      parameters.push(tenant.membershipId);
      predicates.push(`lead.responsible_membership_id = $${parameters.length}`);
    }
    if (query.unassigned === 'true') {
      predicates.push('lead.responsible_membership_id IS NULL');
    }
    if (query.status !== undefined) {
      parameters.push(query.status);
      predicates.push(`lead.status = $${parameters.length}::lead_status_enum`);
    }
    if (query.stage !== undefined) {
      parameters.push(query.stage);
      predicates.push(`lead.stage = $${parameters.length}::lead_stage_enum`);
    }
    if (query.returnPending !== undefined) {
      predicates.push(
        `${query.returnPending === 'true' ? '' : 'NOT '}EXISTS (
          SELECT 1 FROM public.lead_return_reviews review
          WHERE review.organization_id = lead.organization_id
            AND review.lead_id = lead.id AND review.status = 'pending'
        )`,
      );
    }
    if (cursor !== null) {
      parameters.push(cursor.createdAt, cursor.id);
      predicates.push(
        `(lead.created_at, lead.id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`,
      );
    }
    parameters.push(query.limit + 1);
    const rows = await this.dataSource.query<LeadRow[]>(
      `${this.leadSelectSql()} WHERE ${predicates.join(' AND ')}
       ORDER BY lead.created_at DESC, lead.id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => this.toView(row)),
      page: {
        limit: query.limit,
        nextCursor:
          hasMore && last !== undefined
            ? this.encodeCursor(last.createdAt, last.id)
            : null,
      },
    };
  }

  async get(tenant: TenantContext, leadId: string): Promise<LeadView> {
    await this.readiness.assertManualReady();
    const row = await this.findVisible(tenant, leadId);
    if (row === null) throw new NotFoundException('Lead not found.');
    return this.toView(row);
  }

  async timeline(
    tenant: TenantContext,
    leadId: string,
  ): Promise<LeadTimelineView[]> {
    await this.readiness.assertManualReady();
    const parameters: unknown[] = [tenant.organizationId, leadId];
    let visibility = '';
    if (tenant.role === MembershipRole.MEMBER) {
      parameters.push(tenant.membershipId);
      visibility = ' AND lead.responsible_membership_id = $3';
    }
    const rows = await this.dataSource.query<LeadTimelineView[]>(
      `SELECT event.id, event.sequence::text AS sequence,
              event.event_type AS "eventType",
              event.actor_membership_id AS "actorMembershipId",
              event.lead_entry_id AS "leadEntryId",
              event.previous_responsible_membership_id AS "previousResponsibleMembershipId",
              event.new_responsible_membership_id AS "newResponsibleMembershipId",
              event.changed_fields AS "changedFields",
              event.cycle_id AS "cycleId",
              event.return_review_id AS "returnReviewId",
              event.previous_status AS "previousStatus",
              event.new_status AS "newStatus",
              event.previous_stage AS "previousStage",
              event.new_stage AS "newStage",
              event.lost_reason AS "lostReason",
              event.archive_reason AS "archiveReason",
              event.occurred_at AS "occurredAt"
       FROM public.lead_timeline_events event
       JOIN public.leads lead ON lead.id = event.lead_id
         AND lead.organization_id = event.organization_id
       WHERE event.organization_id = $1 AND event.lead_id = $2${visibility}
       ORDER BY event.sequence ASC`,
      parameters,
    );
    if (rows.length === 0) throw new NotFoundException('Lead not found.');
    return rows;
  }

  async cycles(
    tenant: TenantContext,
    leadId: string,
    query: ListLeadCyclesDto,
  ): Promise<LeadCycleListResponse> {
    await this.readiness.assertManualReady();
    if ((await this.findVisible(tenant, leadId)) === null) {
      throw new NotFoundException('Lead not found.');
    }
    const cursor = query.cursor ? this.decodeCycleCursor(query.cursor) : null;
    const parameters: unknown[] = [tenant.organizationId, leadId];
    let cursorPredicate = '';
    if (cursor !== null) {
      parameters.push(cursor.cycleNumber);
      cursorPredicate = ` AND cycle.cycle_number < $${parameters.length}::bigint`;
    }
    parameters.push(query.limit + 1);
    const rows = await this.dataSource.query<LeadCommercialCycleView[]>(
      `SELECT cycle.id, cycle.cycle_number::text AS "cycleNumber",
              cycle.opening_reason AS "openingReason",
              cycle.starting_stage AS "startingStage",
              cycle.opened_by_membership_id AS "openedByMembershipId",
              cycle.opened_at AS "openedAt",
              cycle.closed_by_membership_id AS "closedByMembershipId",
              cycle.closed_at AS "closedAt",
              cycle.closing_status AS "closingStatus",
              cycle.stage_at_close AS "stageAtClose",
              cycle.lost_reason AS "lostReason",
              cycle.archive_reason AS "archiveReason",
              cycle.reason_note AS "reasonNote"
       FROM public.lead_commercial_cycles cycle
       WHERE cycle.organization_id = $1 AND cycle.lead_id = $2${cursorPredicate}
       ORDER BY cycle.cycle_number DESC LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items.at(-1);
    return {
      items,
      page: {
        limit: query.limit,
        nextCursor:
          hasMore && last !== undefined
            ? this.encodeCycleCursor(last.cycleNumber)
            : null,
      },
    };
  }

  async update(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    dto: UpdateLeadDto,
  ): Promise<LeadView> {
    await this.readiness.assertManualReady();
    const current = await this.findVisible(tenant, leadId);
    if (current === null) throw new NotFoundException('Lead not found.');
    const merged = {
      displayName: dto.displayName?.trim() ?? current.displayName,
      primaryPhone:
        dto.primaryPhone === undefined
          ? current.primaryPhone
          : normalizeLeadPhone(dto.primaryPhone),
      email:
        dto.email === undefined
          ? current.email
          : dto.email === null
            ? null
            : dto.email.trim().toLowerCase(),
      companyName:
        dto.companyName === undefined
          ? current.companyName
          : dto.companyName === null
            ? null
            : dto.companyName.trim(),
      instagram:
        dto.instagram === undefined
          ? current.instagram
          : dto.instagram === null
            ? null
            : dto.instagram.trim(),
      city:
        dto.city === undefined
          ? current.city
          : dto.city === null
            ? null
            : dto.city.trim(),
      serviceInterest:
        dto.serviceInterest === undefined
          ? current.serviceInterest
          : dto.serviceInterest === null
            ? null
            : dto.serviceInterest.trim(),
    };
    if (
      merged.displayName === '' ||
      [
        merged.email,
        merged.companyName,
        merged.instagram,
        merged.city,
        merged.serviceInterest,
      ].some((value) => value === '')
    ) {
      throw new BadRequestException('Invalid lead text.');
    }
    try {
      await this.dataSource.query(
        `SELECT * FROM app_private.update_lead(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,
          $6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text)`,
        [
          tenant.userId,
          tenant.membershipId,
          tenant.organizationId,
          leadId,
          expectedRevision,
          merged.displayName,
          merged.primaryPhone,
          merged.email,
          merged.companyName,
          merged.instagram,
          merged.city,
          merged.serviceInterest,
        ],
      );
    } catch (error) {
      this.mapDatabaseError(error);
    }
    return this.get(tenant, leadId);
  }

  async assign(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    responsibleMembershipId: string | null,
  ): Promise<LeadView> {
    await this.readiness.assertManualReady();
    try {
      await this.dataSource.query(
        `SELECT * FROM app_private.assign_lead(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint)`,
        [
          tenant.userId,
          tenant.membershipId,
          tenant.organizationId,
          leadId,
          responsibleMembershipId,
          expectedRevision,
        ],
      );
    } catch (error) {
      this.mapDatabaseError(error);
    }
    return this.get(tenant, leadId);
  }

  move(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    idempotencyKey: string,
    stage: LeadStage,
  ): Promise<LeadCommandResult> {
    return this.executeCommand(
      tenant,
      leadId,
      expectedRevision,
      idempotencyKey,
      LeadCommand.MOVE,
      stage,
      null,
      null,
      null,
    );
  }

  win(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    idempotencyKey: string,
  ): Promise<LeadCommandResult> {
    return this.executeCommand(
      tenant,
      leadId,
      expectedRevision,
      idempotencyKey,
      LeadCommand.WIN,
      null,
      null,
      null,
      null,
    );
  }

  lose(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    idempotencyKey: string,
    dto: LoseLeadDto,
  ): Promise<LeadCommandResult> {
    return this.executeCommand(
      tenant,
      leadId,
      expectedRevision,
      idempotencyKey,
      LeadCommand.LOSE,
      null,
      dto.lostReason,
      null,
      this.normalizeReasonNote(
        dto.reasonNote,
        dto.lostReason === LeadLostReason.OTHER,
      ),
    );
  }

  archive(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    idempotencyKey: string,
    dto: ArchiveLeadDto,
  ): Promise<LeadCommandResult> {
    return this.executeCommand(
      tenant,
      leadId,
      expectedRevision,
      idempotencyKey,
      LeadCommand.ARCHIVE,
      null,
      null,
      dto.archiveReason,
      this.normalizeReasonNote(
        dto.reasonNote,
        dto.archiveReason === LeadArchiveReason.OTHER,
      ),
    );
  }

  reactivate(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    idempotencyKey: string,
  ): Promise<LeadCommandResult> {
    return this.executeCommand(
      tenant,
      leadId,
      expectedRevision,
      idempotencyKey,
      LeadCommand.REACTIVATE,
      null,
      null,
      null,
      null,
    );
  }

  dismissReturn(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    idempotencyKey: string,
  ): Promise<LeadCommandResult> {
    return this.executeCommand(
      tenant,
      leadId,
      expectedRevision,
      idempotencyKey,
      LeadCommand.DISMISS_RETURN,
      null,
      null,
      null,
      null,
    );
  }

  private async executeCommand(
    tenant: TenantContext,
    leadId: string,
    expectedRevision: string,
    idempotencyKey: string,
    command: LeadCommand,
    stage: LeadStage | null,
    lostReason: LeadLostReason | null,
    archiveReason: LeadArchiveReason | null,
    reasonNote: string | null,
  ): Promise<LeadCommandResult> {
    await this.readiness.assertManualReady();
    const version = this.config.idempotencyCurrentKeyVersion as number;
    const input: LeadCommandFingerprintInput = {
      organizationId: tenant.organizationId,
      actorMembershipId: tenant.membershipId,
      leadId,
      command,
      expectedRevision,
      stage,
      lostReason,
      archiveReason,
      reasonNote,
    };
    const fingerprints = Object.fromEntries(
      [...this.config.idempotencyKeys.entries()].map(
        ([candidateVersion, candidateKey]) => [
          String(candidateVersion),
          leadCommandFingerprint(input, candidateKey),
        ],
      ),
    );
    let rows: CommandRow[];
    try {
      rows = await this.dataSource.query<CommandRow[]>(
        `SELECT revision::text AS revision, replayed,
                response_status AS "responseStatus"
         FROM app_private.execute_lead_command(
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,
           $5::app_private.lead_command_enum,$6::bigint,$7::uuid,$8::smallint,
           $9::text,$10::jsonb,$11::lead_stage_enum,$12::lead_lost_reason_enum,
           $13::lead_archive_reason_enum,$14::text)`,
        [
          tenant.userId,
          tenant.membershipId,
          tenant.organizationId,
          leadId,
          command,
          expectedRevision,
          idempotencyKey,
          version,
          leadCommandFingerprint(
            input,
            this.config.idempotencyKeys.get(version) as Buffer,
          ),
          JSON.stringify(fingerprints),
          stage,
          lostReason,
          archiveReason,
          reasonNote,
        ],
      );
    } catch (error) {
      this.mapDatabaseError(error);
    }
    const result = rows[0];
    if (result === undefined) {
      throw new ServiceUnavailableException('Lead command is unavailable.');
    }
    return result;
  }

  private normalizeReasonNote(
    value: string | undefined,
    required: boolean,
  ): string | null {
    const normalized = value?.trim() ?? '';
    if (normalized === '') {
      if (required) {
        throw new BadRequestException(
          'Reason note is required for the selected reason.',
        );
      }
      return null;
    }
    if (
      [...normalized].length > 500 ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized) ||
      !this.isWellFormedUnicode(normalized)
    ) {
      throw new BadRequestException('Invalid reason note.');
    }
    return normalized;
  }

  private isWellFormedUnicode(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
          return false;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return false;
      }
    }
    return true;
  }

  private async ingest(
    tenant: TenantContext | null,
    channel: LeadIntakeChannel,
    dto: CreateLeadDto,
    idempotencyKey: string,
    version: number,
    key: Buffer,
  ): Promise<LeadIngestResult> {
    const input = normalizeLeadInput(dto, normalizeLeadPhone(dto.primaryPhone));
    if (channel === LeadIntakeChannel.GENESIS_FORM) {
      input.responsibleMembershipId = null;
    }
    const fingerprints = Object.fromEntries(
      [...this.config.idempotencyKeys.entries()].map(
        ([candidateVersion, candidateKey]) => [
          String(candidateVersion),
          leadRequestFingerprint(input, candidateKey),
        ],
      ),
    );
    let rows: IngestRow[];
    try {
      rows = await this.dataSource.query<IngestRow[]>(
        `SELECT lead_id AS "leadId", revision::text AS revision,
                replayed, actor_can_view AS visible,
                response_status AS "responseStatus"
         FROM app_private.ingest_lead(
           $1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,$7::text,
           $8::text,$9::text,$10::text,$11::text,$12::uuid,$13::text,$14::text,
           $15::text,$16::text,$17::text,$18::text,$19::text,$20::uuid,$21::smallint,$22::text,$23::jsonb)`,
        [
          tenant?.userId ?? null,
          tenant?.membershipId ?? null,
          tenant?.organizationId ?? this.config.formOrganizationId,
          channel,
          input.displayName,
          input.primaryPhone,
          input.email,
          input.companyName,
          input.instagram,
          input.city,
          input.serviceInterest,
          input.responsibleMembershipId,
          input.source,
          input.sourceDetail,
          input.utmSource,
          input.utmMedium,
          input.utmCampaign,
          input.utmContent,
          input.utmTerm,
          idempotencyKey,
          version,
          leadRequestFingerprint(input, key),
          JSON.stringify(fingerprints),
        ],
      );
    } catch (error) {
      if (
        channel === LeadIntakeChannel.GENESIS_FORM &&
        this.databaseErrorCode(error) === 'P3001'
      ) {
        throw new ServiceUnavailableException('Lead intake is unavailable.');
      }
      this.mapDatabaseError(error);
    }
    const result = rows[0];
    if (result === undefined) {
      throw new ServiceUnavailableException('Lead intake is unavailable.');
    }
    const mayReturnLead =
      channel === LeadIntakeChannel.MANUAL &&
      tenant !== null &&
      tenant.role !== MembershipRole.MEMBER &&
      result.visible;
    return {
      responseStatus: result.responseStatus,
      replayed: result.replayed,
      lead: mayReturnLead ? await this.get(tenant, result.leadId) : null,
    };
  }

  private async findVisible(
    tenant: TenantContext,
    leadId: string,
  ): Promise<LeadRow | null> {
    const parameters: unknown[] = [tenant.organizationId, leadId];
    let visibility = '';
    if (tenant.role === MembershipRole.MEMBER) {
      parameters.push(tenant.membershipId);
      visibility = ` AND lead.responsible_membership_id = $3`;
    }
    const rows = await this.dataSource.query<LeadRow[]>(
      `${this.leadSelectSql()}
       WHERE lead.organization_id = $1 AND lead.id = $2${visibility}`,
      parameters,
    );
    return rows[0] ?? null;
  }

  private leadSelectSql(): string {
    return `SELECT lead.id, lead.display_name AS "displayName",
      lead.primary_phone AS "primaryPhone", lead.email,
      lead.company_name AS "companyName", lead.instagram, lead.city,
      lead.service_interest AS "serviceInterest",
      lead.responsible_membership_id AS "responsibleMembershipId",
      lead.status, lead.stage,
      (lead.next_cycle_number - 1)::text AS "latestCycleNumber",
      EXISTS (
        SELECT 1 FROM public.lead_return_reviews review
        WHERE review.organization_id = lead.organization_id
          AND review.lead_id = lead.id AND review.status = 'pending'
      ) AS "returnReviewPending",
      lead.revision::text AS revision, lead.created_at AS "createdAt",
      lead.updated_at AS "updatedAt",
      first_entry.attribution AS "initialAttribution",
      last_entry.attribution AS "lastAttribution"
      FROM public.leads lead
      JOIN LATERAL (
        SELECT jsonb_build_object(
          'source', entry.source, 'sourceDetail', entry.source_detail,
          'utmSource', entry.utm_source, 'utmMedium', entry.utm_medium,
          'utmCampaign', entry.utm_campaign, 'utmContent', entry.utm_content,
          'utmTerm', entry.utm_term, 'receivedAt', entry.received_at
        ) AS attribution
        FROM public.lead_entries entry
        WHERE entry.organization_id = lead.organization_id AND entry.lead_id = lead.id
        ORDER BY entry.sequence ASC LIMIT 1
      ) first_entry ON true
      JOIN LATERAL (
        SELECT jsonb_build_object(
          'source', entry.source, 'sourceDetail', entry.source_detail,
          'utmSource', entry.utm_source, 'utmMedium', entry.utm_medium,
          'utmCampaign', entry.utm_campaign, 'utmContent', entry.utm_content,
          'utmTerm', entry.utm_term, 'receivedAt', entry.received_at
        ) AS attribution
        FROM public.lead_entries entry
        WHERE entry.organization_id = lead.organization_id AND entry.lead_id = lead.id
        ORDER BY entry.sequence DESC LIMIT 1
      ) last_entry ON true`;
  }

  private toView(row: LeadRow): LeadView {
    return row;
  }

  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(
      JSON.stringify({ createdAt: createdAt.toISOString(), id }),
      'utf8',
    ).toString('base64url');
  }

  private decodeCursor(value: string): CursorValue {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<CursorValue>;
      if (
        typeof parsed.createdAt !== 'string' ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        new Date(parsed.createdAt).toISOString() !== parsed.createdAt ||
        typeof parsed.id !== 'string' ||
        !isUUID(parsed.id, '4') ||
        Buffer.from(value, 'base64url').toString('base64url') !== value
      ) {
        throw new Error('invalid');
      }
      return parsed as CursorValue;
    } catch {
      throw new BadRequestException('Invalid cursor.');
    }
  }

  private encodeCycleCursor(cycleNumber: string): string {
    return Buffer.from(JSON.stringify({ cycleNumber }), 'utf8').toString(
      'base64url',
    );
  }

  private decodeCycleCursor(value: string): CycleCursorValue {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<CycleCursorValue>;
      if (
        typeof parsed.cycleNumber !== 'string' ||
        !/^[1-9]\d*$/u.test(parsed.cycleNumber) ||
        BigInt(parsed.cycleNumber) > 9_223_372_036_854_775_807n ||
        Buffer.from(value, 'base64url').toString('base64url') !== value
      ) {
        throw new Error('invalid');
      }
      return parsed as CycleCursorValue;
    } catch {
      throw new BadRequestException('Invalid cursor.');
    }
  }

  private mapDatabaseError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const code = (error.driverError as { code?: string }).code;
      if (code === 'P3001')
        throw new ForbiddenException('Organization access denied.');
      if (code === 'P3002') throw new NotFoundException('Lead not found.');
      if (code === 'P3003')
        throw new PreconditionFailedException('Lead revision is stale.');
      if (code === 'P3004' || code === '23505') {
        throw new ConflictException(
          'Lead request conflicts with existing state.',
        );
      }
      if (code === 'P3005') {
        throw new ServiceUnavailableException('Lead intake is unavailable.');
      }
      if (code === 'P3007') {
        throw new ServiceUnavailableException('Lead lifecycle is unavailable.');
      }
      if (code === '22023') {
        throw new BadRequestException('Invalid lead command.');
      }
    }
    throw error;
  }

  private databaseErrorCode(error: unknown): string | undefined {
    return error instanceof QueryFailedError
      ? (error.driverError as { code?: string }).code
      : undefined;
  }
}
