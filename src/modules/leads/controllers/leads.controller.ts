import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { AccessTokenGuard } from '../../auth/guards/access-token.guard';
import { Roles } from '../../authorization/decorators/roles.decorator';
import { RoleGuard } from '../../authorization/guards/role.guard';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { CurrentTenant } from '../../tenant-context/decorators/current-tenant.decorator';
import { TenantContextGuard } from '../../tenant-context/guards/tenant-context.guard';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import { NoStoreInterceptor } from '../../invitations/interceptors/no-store.interceptor';
import {
  AssignLeadDto,
  CancelLeadNextActionDto,
  CompleteLeadNextActionDto,
  CreateLeadActivityDto,
  CreateLeadDto,
  CreateLeadNextActionDto,
  CreateLeadNoteDto,
  LeadParamsDto,
  LeadKanbanDto,
  LeadMetricsDto,
  LeadMyActionsDto,
  LeadReturnReviewQueueDto,
  LeadUnassignedQueueDto,
  ListLeadCyclesDto,
  ListLeadTimelineDto,
  ListLeadsDto,
  MoveLeadDto,
  LoseLeadDto,
  ArchiveLeadDto,
  EmptyLeadCommandDto,
  RescheduleLeadNextActionDto,
  SetLeadExpectedValueDto,
  UpdateLeadDto,
} from '../dto/lead.dto';
import { LeadsService } from '../services/leads.service';
import { LeadOperationalReadService } from '../services/lead-operational-read.service';
import {
  LeadMetricsRateLimitGuard,
  LeadReadRateLimitGuard,
} from '../guards/lead-read-rate-limit.guards';
import {
  LeadListResponse,
  LeadDetailView,
  LeadKanbanResponse,
  LeadMetricsResponse,
  LeadReturnReviewQueueResponse,
  LeadCycleListResponse,
  LeadCommandResult,
  LeadCreateMutationResult,
  LeadNextActionResponse,
  LeadTimelineResponse,
  LeadView,
} from '../types/lead-api.type';

const ALL_ROLES = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.MEMBER,
] as const;

@Controller('leads')
@UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
@Roles(...ALL_ROLES)
@UseInterceptors(NoStoreInterceptor)
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly reads: LeadOperationalReadService,
  ) {}

  @Post()
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateLeadDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LeadView | undefined> {
    const key = this.idempotencyKey(idempotencyKey);
    const result = await this.leads.createManual(tenant, dto, key);
    response.status(
      tenant.role === MembershipRole.MEMBER
        ? HttpStatus.NO_CONTENT
        : result.responseStatus,
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    if (result.lead !== null) {
      response.setHeader('ETag', this.etag(result.lead));
      if (result.responseStatus === 201) {
        response.location(`/api/v1/leads/${result.lead.id}`);
      }
      return result.lead;
    }
    return undefined;
  }

  @Get()
  @UseGuards(LeadReadRateLimitGuard)
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListLeadsDto,
  ): Promise<LeadListResponse> {
    return this.reads.list(tenant, query);
  }

  @Get('kanban')
  @UseGuards(LeadReadRateLimitGuard)
  kanban(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: LeadKanbanDto,
  ): Promise<LeadKanbanResponse> {
    return this.reads.kanban(tenant, query);
  }

  @Get('work/my-actions')
  @UseGuards(LeadReadRateLimitGuard)
  myActions(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: LeadMyActionsDto,
  ): Promise<LeadListResponse> {
    return this.reads.myActions(tenant, query);
  }

  @Get('work/unassigned')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @UseGuards(LeadReadRateLimitGuard)
  unassigned(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: LeadUnassignedQueueDto,
  ): Promise<LeadListResponse> {
    return this.reads.unassigned(tenant, query);
  }

  @Get('work/return-reviews')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @UseGuards(LeadReadRateLimitGuard)
  returnReviews(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: LeadReturnReviewQueueDto,
  ): Promise<LeadReturnReviewQueueResponse> {
    return this.reads.returnReviews(tenant, query);
  }

  @Get('metrics/summary')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @UseGuards(LeadMetricsRateLimitGuard)
  metrics(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: LeadMetricsDto,
  ): Promise<LeadMetricsResponse> {
    return this.reads.metrics(tenant, query);
  }

  @Get(':leadId')
  @UseGuards(LeadReadRateLimitGuard)
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LeadDetailView> {
    const lead = await this.reads.detail(tenant, params.leadId);
    response.setHeader('ETag', this.etag(lead));
    return lead;
  }

  @Get(':leadId/timeline')
  @UseGuards(LeadReadRateLimitGuard)
  timeline(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Query() query: ListLeadTimelineDto,
  ): Promise<LeadTimelineResponse> {
    return this.leads.timeline(tenant, params.leadId, query);
  }

  @Get(':leadId/next-action')
  @UseGuards(LeadReadRateLimitGuard)
  async nextAction(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Res() response: Response,
  ): Promise<void> {
    const result: LeadNextActionResponse = await this.leads.nextAction(
      tenant,
      params.leadId,
    );
    response.status(200);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(result));
  }

  @Get(':leadId/cycles')
  @UseGuards(LeadReadRateLimitGuard)
  cycles(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Query() query: ListLeadCyclesDto,
  ): Promise<LeadCycleListResponse> {
    return this.reads.cycles(tenant, params.leadId, query);
  }

  @Patch(':leadId')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: UpdateLeadDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LeadView> {
    const lead = await this.leads.update(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      dto,
    );
    response.setHeader('ETag', this.etag(lead));
    return lead;
  }

  @Patch(':leadId/assignment')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  async assign(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: AssignLeadDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LeadView> {
    const lead = await this.leads.assign(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      dto.responsibleMembershipId,
    );
    response.setHeader('ETag', this.etag(lead));
    return lead;
  }

  @Post(':leadId/activities')
  async createActivity(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: CreateLeadActivityDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ id: string }> {
    const result = await this.leads.createActivity(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    return this.createMutationResponse(response, params.leadId, result);
  }

  @Post(':leadId/notes')
  async createNote(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: CreateLeadNoteDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ id: string }> {
    const result = await this.leads.createNote(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    return this.createMutationResponse(response, params.leadId, result);
  }

  @Post(':leadId/next-action')
  async createNextAction(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: CreateLeadNextActionDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ id: string }> {
    const result = await this.leads.createNextAction(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    return this.createMutationResponse(response, params.leadId, result);
  }

  @Post(':leadId/next-action/reschedule')
  async rescheduleNextAction(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: RescheduleLeadNextActionDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.rescheduleNextAction(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/next-action/complete')
  async completeNextAction(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: CompleteLeadNextActionDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.completeNextAction(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/next-action/cancel')
  async cancelNextAction(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: CancelLeadNextActionDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.cancelNextAction(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/move')
  async move(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: MoveLeadDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.move(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto.stage,
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/expected-value')
  async setExpectedValue(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: SetLeadExpectedValueDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.setExpectedValue(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/win')
  async win(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() _dto: EmptyLeadCommandDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.win(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/lose')
  async lose(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: LoseLeadDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.lose(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/archive')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() dto: ArchiveLeadDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.archive(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
      dto,
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/reactivate')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  async reactivate(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() _dto: EmptyLeadCommandDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.reactivate(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
    );
    this.commandResponse(response, params.leadId, result);
  }

  @Post(':leadId/return-review/dismiss')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  async dismissReturn(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Body() _dto: EmptyLeadCommandDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.leads.dismissReturn(
      tenant,
      params.leadId,
      this.expectedRevision(ifMatch, params.leadId),
      this.idempotencyKey(idempotencyKey),
    );
    this.commandResponse(response, params.leadId, result);
  }

  private idempotencyKey(value: string | undefined): string {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      )
    ) {
      throw new BadRequestException('Invalid Idempotency-Key.');
    }
    return value;
  }

  private expectedRevision(value: string | undefined, leadId: string): string {
    if (value === undefined) {
      throw new HttpException('If-Match is required.', 428);
    }
    const match = /^"lead:([0-9a-f-]{36}):(0|[1-9]\d*)"$/iu.exec(value);
    if (match === null || match[1].toLowerCase() !== leadId.toLowerCase()) {
      throw new BadRequestException('Invalid If-Match.');
    }
    if (BigInt(match[2]) > 9_223_372_036_854_775_807n) {
      throw new BadRequestException('Invalid If-Match.');
    }
    return match[2];
  }

  private etag(lead: LeadView): string {
    return `"lead:${lead.id}:${lead.revision}"`;
  }

  private commandResponse(
    response: Response,
    leadId: string,
    result: LeadCommandResult,
  ): void {
    response.status(result.responseStatus);
    response.setHeader('ETag', `"lead:${leadId}:${result.revision}"`);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
  }

  private createMutationResponse(
    response: Response,
    leadId: string,
    result: LeadCreateMutationResult,
  ): { id: string } {
    response.status(result.responseStatus);
    response.setHeader('ETag', `"lead:${leadId}:${result.revision}"`);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return { id: result.id };
  }
}
