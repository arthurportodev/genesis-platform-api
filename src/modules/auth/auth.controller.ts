import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  AuthBootstrapResponse,
  AuthService,
  AuthTokenResponse,
} from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { AccessTokenGuard } from './guards/access-token.guard';
import { CsrfGuard } from './guards/csrf.guard';
import { WebSessionService } from './services/web-session.service';
import {
  AuthenticatedUser,
  AuthRequestContext,
  PublicUser,
} from './types/authenticated-user.type';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly webSessionService: WebSessionService,
  ) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  csrf(@Res({ passthrough: true }) response: Response): { csrfToken: string } {
    return { csrfToken: this.webSessionService.issueCsrfToken(response) };
  }

  @Post('login')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() credentials: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokenResponse> {
    const result = await this.authService.login(
      credentials,
      this.getContext(request),
    );
    this.webSessionService.setRefreshCookie(
      response,
      result.refreshToken,
      result.refreshExpiresAt,
    );
    return result.response;
  }

  @Post('refresh')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokenResponse> {
    const result = await this.authService.refresh(
      this.webSessionService.getRefreshToken(request),
      this.getContext(request),
    );
    this.webSessionService.setRefreshCookie(
      response,
      result.refreshToken,
      result.refreshExpiresAt,
    );
    return result.response;
  }

  @Post('logout')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      await this.authService.logout(
        this.webSessionService.getRefreshToken(request),
        this.getContext(request),
      );
    } finally {
      this.webSessionService.clearAuthCookies(response);
    }
  }

  @Post('logout-all')
  @UseGuards(CsrfGuard, AccessTokenGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async logoutAll(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      await this.authService.logoutAll(currentUser, this.getContext(request));
    } finally {
      this.webSessionService.clearAuthCookies(response);
    }
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @Header('Cache-Control', 'no-store')
  me(@CurrentUser() currentUser: AuthenticatedUser): Promise<PublicUser> {
    return this.authService.getMe(currentUser);
  }

  @Get('bootstrap')
  @UseGuards(AccessTokenGuard)
  @Header('Cache-Control', 'no-store')
  bootstrap(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<AuthBootstrapResponse> {
    return this.authService.getBootstrap(currentUser);
  }

  private getContext(request: Request): AuthRequestContext {
    return {
      ipAddress: request.ip || request.socket.remoteAddress || null,
      userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
    };
  }
}
