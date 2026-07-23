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
  CreateLeadDto,
  LeadParamsDto,
  ListLeadsDto,
  UpdateLeadDto,
} from '../dto/lead.dto';
import { ManualLeadReadinessGuard } from '../guards/lead-readiness.guards';
import { LeadsService } from '../services/leads.service';
import {
  LeadListResponse,
  LeadTimelineView,
  LeadView,
} from '../types/lead-api.type';

const ALL_ROLES = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.MEMBER,
] as const;

@Controller('leads')
@UseGuards(
  AccessTokenGuard,
  TenantContextGuard,
  ManualLeadReadinessGuard,
  RoleGuard,
)
@Roles(...ALL_ROLES)
@UseInterceptors(NoStoreInterceptor)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

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
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListLeadsDto,
  ): Promise<LeadListResponse> {
    return this.leads.list(tenant, query);
  }

  @Get(':leadId')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LeadView> {
    const lead = await this.leads.get(tenant, params.leadId);
    response.setHeader('ETag', this.etag(lead));
    return lead;
  }

  @Get(':leadId/timeline')
  timeline(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: LeadParamsDto,
  ): Promise<LeadTimelineView[]> {
    return this.leads.timeline(tenant, params.leadId);
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
}
