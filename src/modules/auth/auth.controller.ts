import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService, AuthTokenResponse } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AccessTokenGuard } from './guards/access-token.guard';
import {
  AuthenticatedUser,
  AuthRequestContext,
  PublicUser,
} from './types/authenticated-user.type';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body() credentials: LoginDto,
    @Req() request: Request,
  ): Promise<AuthTokenResponse> {
    return this.authService.login(credentials, this.getContext(request));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body() body: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<AuthTokenResponse> {
    return this.authService.refresh(
      body.refreshToken,
      this.getContext(request),
    );
  }

  @Post('logout')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<void> {
    return this.authService.logout(currentUser, this.getContext(request));
  }

  @Post('logout-all')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  logoutAll(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<void> {
    return this.authService.logoutAll(currentUser, this.getContext(request));
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  me(@CurrentUser() currentUser: AuthenticatedUser): Promise<PublicUser> {
    return this.authService.getMe(currentUser);
  }

  private getContext(request: Request): AuthRequestContext {
    return {
      ipAddress: request.ip || request.socket.remoteAddress || null,
      userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
    };
  }
}
