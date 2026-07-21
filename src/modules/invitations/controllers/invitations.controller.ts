import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AccessTokenGuard } from '../../auth/guards/access-token.guard';
import { Roles } from '../../authorization/decorators/roles.decorator';
import { RoleGuard } from '../../authorization/guards/role.guard';
import { MembershipRole } from '../../memberships/enums/membership-role.enum';
import { CurrentTenant } from '../../tenant-context/decorators/current-tenant.decorator';
import { TenantContextGuard } from '../../tenant-context/guards/tenant-context.guard';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import { CreateInvitationDto } from '../dto/create-invitation.dto';
import {
  EmptyInvitationCommandDto,
  InvitationParamsDto,
} from '../dto/invitation-params.dto';
import { ListInvitationsDto } from '../dto/list-invitations.dto';
import { InvitationsService } from '../services/invitations.service';
import {
  InvitationAdminView,
  InvitationListResponse,
  InvitationReplacementResult,
  InvitationRequestContext,
} from '../types/invitation-api.type';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateInvitationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InvitationAdminView> {
    const invitation = await this.invitations.create(
      tenant,
      dto,
      this.requestContext(request),
    );
    response.location(`/api/v1/invitations/${invitation.id}`);
    return invitation;
  }

  @Get()
  @UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListInvitationsDto,
  ): Promise<InvitationListResponse> {
    return this.invitations.list(tenant, query);
  }

  @Get(':invitationId')
  @UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: InvitationParamsDto,
  ): Promise<InvitationAdminView> {
    return this.invitations.get(tenant, params.invitationId);
  }

  @Post(':invitationId/revoke')
  @UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: InvitationParamsDto,
    @Body() _body: EmptyInvitationCommandDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.invitations.revoke(
      tenant,
      params.invitationId,
      this.requestContext(request),
    );
  }

  @Post(':invitationId/replace')
  @UseGuards(AccessTokenGuard, TenantContextGuard, RoleGuard)
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async replace(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: InvitationParamsDto,
    @Body() _body: EmptyInvitationCommandDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InvitationReplacementResult> {
    if (
      typeof idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        idempotencyKey,
      )
    ) {
      throw new BadRequestException('Invalid Idempotency-Key.');
    }
    const result = await this.invitations.replace(
      tenant,
      params.invitationId,
      idempotencyKey,
      this.requestContext(request),
    );
    response.location(`/api/v1/invitations/${result.result.invitationId}`);
    if (result.replayed) {
      response.setHeader('Idempotency-Replayed', 'true');
    }
    return result.result;
  }

  private requestContext(request: Request): InvitationRequestContext {
    return {
      ipAddress: request.ip || request.socket.remoteAddress || null,
      userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
    };
  }
}
