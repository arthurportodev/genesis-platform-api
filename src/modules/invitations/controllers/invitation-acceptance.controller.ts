import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AccessTokenGuard } from '../../auth/guards/access-token.guard';
import { AuthenticatedRequest } from '../../auth/types/auth-request.type';
import { Request } from 'express';
import { InvitationTokenDto } from '../dto/invitation-token.dto';
import {
  InvitationAcceptIpRateLimitGuard,
  InvitationAcceptUserIpRateLimitGuard,
  InvitationActivateIpRateLimitGuard,
  InvitationInspectRateLimitGuard,
} from '../guards/invitation-acceptance-rate-limit.guards';
import { NoStoreInterceptor } from '../interceptors/no-store.interceptor';
import { InvitationAcceptanceService } from '../services/invitation-acceptance.service';
import { InvitationActivationService } from '../services/invitation-activation.service';

@Controller('invitation-acceptance')
@UseInterceptors(NoStoreInterceptor)
export class InvitationAcceptanceController {
  constructor(
    private readonly acceptance: InvitationAcceptanceService,
    private readonly activation: InvitationActivationService,
  ) {}

  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(InvitationInspectRateLimitGuard)
  inspect(@Body() dto: InvitationTokenDto) {
    return this.acceptance.inspect(dto.token);
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(
    InvitationAcceptIpRateLimitGuard,
    AccessTokenGuard,
    InvitationAcceptUserIpRateLimitGuard,
  )
  accept(
    @Body() dto: InvitationTokenDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.acceptance.accept(dto.token, request.user.userId, {
      ipAddress: request.ip || request.socket.remoteAddress || null,
      userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
    });
  }

  @Post('activate')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(InvitationActivateIpRateLimitGuard)
  activate(@Body() body: unknown, @Req() request: Request) {
    return this.activation.activate(body, {
      ipAddress: request.ip || request.socket.remoteAddress || null,
      userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
    });
  }
}
