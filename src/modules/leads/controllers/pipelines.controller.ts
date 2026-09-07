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
  Put,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { AccessTokenGuard } from '../../auth/guards/access-token.guard';
import { Roles } from '../../authorization/decorators/roles.decorator';
import { RoleGuard } from '../../authorization/guards/role.guard';
import { NoStoreInterceptor } from '../../invitations/interceptors/no-store.interceptor';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { CurrentTenant } from '../../tenant-context/decorators/current-tenant.decorator';
import { TenantContextGuard } from '../../tenant-context/guards/tenant-context.guard';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import {
  CreatePipelineDto,
  CreatePipelineStageDto,
  DynamicKanbanDto,
  PipelineParamsDto,
  PipelineStageParamsDto,
  RenamePipelineDto,
  RenamePipelineStageDto,
  ReorderPipelineStagesDto,
} from '../dto/pipeline.dto';
import { PipelinesService } from '../services/pipelines.service';
import {
  DynamicKanbanResponse,
  PipelineView,
} from '../types/pipeline-api.type';

const ADMIN_ROLES = [MembershipRole.OWNER, MembershipRole.ADMIN] as const;

@Controller('pipelines')
@UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
@Roles(MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER)
@UseInterceptors(NoStoreInterceptor)
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  @Get()
  list(@CurrentTenant() tenant: TenantContext): Promise<PipelineView[]> {
    return this.pipelines.list(tenant);
  }

  @Get(':pipelineId/kanban')
  kanban(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: PipelineParamsDto,
    @Query() query: DynamicKanbanDto,
  ): Promise<DynamicKanbanResponse> {
    return this.pipelines.kanban(tenant, params.pipelineId, query);
  }

  @Put(':pipelineId')
  @Roles(...ADMIN_ROLES)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: PipelineParamsDto,
    @Body() dto: CreatePipelineDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PipelineView> {
    const result = await this.pipelines.create(tenant, params.pipelineId, dto);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    response.setHeader('ETag', this.etag(result.pipeline));
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.pipeline;
  }

  @Patch(':pipelineId')
  @Roles(...ADMIN_ROLES)
  async rename(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: PipelineParamsDto,
    @Body() dto: RenamePipelineDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PipelineView> {
    const result = await this.pipelines.rename(
      tenant,
      params.pipelineId,
      this.expectedRevision(ifMatch, params.pipelineId),
      dto.name,
    );
    return this.response(response, result.pipeline, result.replayed);
  }

  @Put(':pipelineId/stages/order')
  @Roles(...ADMIN_ROLES)
  async reorder(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: PipelineParamsDto,
    @Body() dto: ReorderPipelineStagesDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PipelineView> {
    const result = await this.pipelines.reorder(
      tenant,
      params.pipelineId,
      this.expectedRevision(ifMatch, params.pipelineId),
      dto,
    );
    return this.response(response, result.pipeline, result.replayed);
  }

  @Put(':pipelineId/stages/:stageId')
  @Roles(...ADMIN_ROLES)
  async createStage(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: PipelineStageParamsDto,
    @Body() dto: CreatePipelineStageDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PipelineView> {
    const result = await this.pipelines.createStage(
      tenant,
      params.pipelineId,
      params.stageId,
      this.expectedRevision(ifMatch, params.pipelineId),
      dto.name,
    );
    return this.response(response, result.pipeline, result.replayed);
  }

  @Patch(':pipelineId/stages/:stageId')
  @Roles(...ADMIN_ROLES)
  async renameStage(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: PipelineStageParamsDto,
    @Body() dto: RenamePipelineStageDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PipelineView> {
    const result = await this.pipelines.renameStage(
      tenant,
      params.pipelineId,
      params.stageId,
      this.expectedRevision(ifMatch, params.pipelineId),
      dto.name,
    );
    return this.response(response, result.pipeline, result.replayed);
  }

  @Post(':pipelineId/stages/:stageId/archive')
  @Roles(...ADMIN_ROLES)
  async archiveStage(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: PipelineStageParamsDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PipelineView> {
    const result = await this.pipelines.archiveStage(
      tenant,
      params.pipelineId,
      params.stageId,
      this.expectedRevision(ifMatch, params.pipelineId),
    );
    return this.response(response, result.pipeline, result.replayed);
  }

  private expectedRevision(
    value: string | undefined,
    pipelineId: string,
  ): string {
    if (value === undefined)
      throw new HttpException('If-Match is required.', 428);
    const match = /^"pipeline:([0-9a-f-]{36}):(0|[1-9]\d*)"$/iu.exec(value);
    if (match === null || match[1].toLowerCase() !== pipelineId.toLowerCase()) {
      throw new BadRequestException('Invalid If-Match.');
    }
    if (BigInt(match[2]) > 9_223_372_036_854_775_807n) {
      throw new BadRequestException('Invalid If-Match.');
    }
    return match[2];
  }

  private etag(pipeline: PipelineView): string {
    return `"pipeline:${pipeline.id}:${pipeline.revision}"`;
  }

  private response(
    response: Response,
    pipeline: PipelineView,
    replayed: boolean,
  ): PipelineView {
    response.status(HttpStatus.OK);
    response.setHeader('ETag', this.etag(pipeline));
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
    return pipeline;
  }
}
