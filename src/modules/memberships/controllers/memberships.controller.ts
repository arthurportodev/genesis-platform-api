import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AccessTokenGuard } from '../../auth/guards/access-token.guard';
import { Roles } from '../../authorization/decorators/roles.decorator';
import { RoleGuard } from '../../authorization/guards/role.guard';
import { CurrentTenant } from '../../tenant-context/decorators/current-tenant.decorator';
import { TenantContextGuard } from '../../tenant-context/guards/tenant-context.guard';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import {
  ChangeMembershipRoleDto,
  EmptyMembershipCommandDto,
  ListMembershipsDto,
  MembershipParamsDto,
} from '../dto/membership.dto';
import { MembershipReadRateLimitGuard } from '../guards/membership-read-rate-limit.guard';
import { MembershipCommandRateLimitGuard } from '../guards/membership-command-rate-limit.guard';
import { MembershipReadinessGuard } from '../guards/membership-readiness.guard';
import { MembershipRole } from '../enums/membership-role.enum';
import { MembershipsService } from '../services/memberships.service';
import {
  MemberListResponse,
  MembershipRequestContext,
  MemberView,
} from '../types/membership-api.type';

@Controller('members')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @UseGuards(
    AccessTokenGuard,
    TenantContextGuard,
    MembershipReadinessGuard,
    MembershipReadRateLimitGuard,
    RoleGuard,
  )
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListMembershipsDto,
  ): Promise<MemberListResponse> {
    return this.memberships.list(tenant, query);
  }

  @Get(':membershipId')
  @UseGuards(
    AccessTokenGuard,
    TenantContextGuard,
    MembershipReadinessGuard,
    MembershipReadRateLimitGuard,
    RoleGuard,
  )
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: MembershipParamsDto,
  ): Promise<MemberView> {
    return this.memberships.get(tenant, params.membershipId);
  }

  @Patch(':membershipId/role')
  @UseGuards(
    AccessTokenGuard,
    TenantContextGuard,
    MembershipReadinessGuard,
    MembershipCommandRateLimitGuard,
    RoleGuard,
  )
  @Roles(MembershipRole.OWNER)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  changeRole(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: MembershipParamsDto,
    @Body() dto: ChangeMembershipRoleDto,
    @Req() request: Request,
  ): Promise<MemberView> {
    return this.memberships.changeRole(
      tenant,
      params.membershipId,
      dto,
      this.requestContext(request),
    );
  }

  @Post(':membershipId/promote-owner')
  @UseGuards(
    AccessTokenGuard,
    TenantContextGuard,
    MembershipReadinessGuard,
    MembershipCommandRateLimitGuard,
    RoleGuard,
  )
  @Roles(MembershipRole.OWNER)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  promoteOwner(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: MembershipParamsDto,
    @Body() _body: EmptyMembershipCommandDto,
    @Req() request: Request,
  ): Promise<MemberView> {
    return this.memberships.promoteOwner(
      tenant,
      params.membershipId,
      this.requestContext(request),
    );
  }

  @Post(':membershipId/deactivate')
  @UseGuards(
    AccessTokenGuard,
    TenantContextGuard,
    MembershipReadinessGuard,
    MembershipCommandRateLimitGuard,
    RoleGuard,
  )
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivate(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: MembershipParamsDto,
    @Body() _body: EmptyMembershipCommandDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.memberships.deactivate(
      tenant,
      params.membershipId,
      this.requestContext(request),
    );
  }

  @Post(':membershipId/reactivate')
  @UseGuards(
    AccessTokenGuard,
    TenantContextGuard,
    MembershipReadinessGuard,
    MembershipCommandRateLimitGuard,
    RoleGuard,
  )
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  reactivate(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: MembershipParamsDto,
    @Body() _body: EmptyMembershipCommandDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.memberships.reactivate(
      tenant,
      params.membershipId,
      this.requestContext(request),
    );
  }

  @Post('me/leave')
  @UseGuards(
    AccessTokenGuard,
    TenantContextGuard,
    MembershipReadinessGuard,
    MembershipCommandRateLimitGuard,
    RoleGuard,
  )
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER)
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(
    @CurrentTenant() tenant: TenantContext,
    @Body() _body: EmptyMembershipCommandDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.memberships.leave(tenant, this.requestContext(request));
  }

  private requestContext(request: Request): MembershipRequestContext {
    return {
      ipAddress: request.ip || request.socket.remoteAddress || null,
      userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
    };
  }
}
