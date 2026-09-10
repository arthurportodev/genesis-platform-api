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
import { getTrustedClientIp } from '../../common/http/trusted-client-ip';
import {
  AuthBootstrapResponse,
  AuthService,
  AuthTokenResponse,
} from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import {
  EmailVerificationResendDto,
  EmailVerificationVerifyDto,
} from './dto/email-verification.dto';
import { RegisterDto } from './dto/register.dto';
import {
  PasswordResetCompleteDto,
  PasswordResetRequestDto,
} from './dto/password-reset.dto';
import { AccessTokenGuard } from './guards/access-token.guard';
import { CsrfGuard } from './guards/csrf.guard';
import { WebSessionService } from './services/web-session.service';
import {
  EmailVerifiedResponse,
  PublicAuthService,
  VerificationRequiredResponse,
} from './services/public-auth.service';
import {
  PasswordResetAcceptedResponse,
  PasswordResetCompletedResponse,
  PasswordResetService,
} from './services/password-reset.service';
import {
  AuthenticatedUser,
  AuthRequestContext,
  PublicUser,
} from './types/authenticated-user.type';
import {
  GoogleAuthenticateDto,
  GoogleLinkDto,
  GoogleProfileDto,
} from './dto/google-auth.dto';
import {
  GoogleAuthService,
  GooglePublicConfigResponse,
} from './services/google-auth.service';
import { IssuedGoogleChallenge } from './services/google-challenge.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly webSessionService: WebSessionService,
    private readonly publicAuthService: PublicAuthService,
    private readonly passwordResetService: PasswordResetService,
    private readonly googleAuthService: GoogleAuthService,
  ) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  csrf(@Res({ passthrough: true }) response: Response): { csrfToken: string } {
    return { csrfToken: this.webSessionService.issueCsrfToken(response) };
  }

  @Get('google/config')
  @Header('Cache-Control', 'no-store')
  googleConfig(): GooglePublicConfigResponse {
    return this.googleAuthService.getPublicConfig();
  }

  @Post('google/challenge')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  googleChallenge(@Req() request: Request): Promise<IssuedGoogleChallenge> {
    return this.googleAuthService.issueChallenge(this.getContext(request));
  }

  @Post('google')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async googleAuthenticate(
    @Body() input: GoogleAuthenticateDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokenResponse> {
    const result = await this.googleAuthService.authenticate(
      input.challengeToken,
      input.credential,
      this.getContext(request),
    );
    this.webSessionService.setRefreshCookie(
      response,
      result.refreshToken,
      result.refreshExpiresAt,
    );
    return result.response;
  }

  @Post('google/profile')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async googleProfile(
    @Body() input: GoogleProfileDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokenResponse> {
    const result = await this.googleAuthService.completeProfile(
      input,
      this.getContext(request),
    );
    this.webSessionService.setRefreshCookie(
      response,
      result.refreshToken,
      result.refreshExpiresAt,
    );
    return result.response;
  }

  @Post('google/link')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async googleLink(
    @Body() input: GoogleLinkDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokenResponse> {
    const result = await this.googleAuthService.link(
      input,
      this.getContext(request),
    );
    this.webSessionService.setRefreshCookie(
      response,
      result.refreshToken,
      result.refreshExpiresAt,
    );
    return result.response;
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

  @Post('register')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  register(
    @Body() input: RegisterDto,
    @Req() request: Request,
  ): Promise<VerificationRequiredResponse> {
    return this.publicAuthService.register(input, this.getContext(request));
  }

  @Post('email-verification/resend')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  resendEmailVerification(
    @Body() input: EmailVerificationResendDto,
  ): Promise<VerificationRequiredResponse> {
    return this.publicAuthService.resend(input.challengeId);
  }

  @Post('email-verification/verify')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  verifyEmail(
    @Body() input: EmailVerificationVerifyDto,
    @Req() request: Request,
  ): Promise<EmailVerifiedResponse> {
    return this.publicAuthService.verify(
      input.challengeId,
      input.code,
      this.getContext(request),
    );
  }

  @Post('password-reset/request')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  requestPasswordReset(
    @Body() input: PasswordResetRequestDto,
    @Req() request: Request,
  ): Promise<PasswordResetAcceptedResponse> {
    return this.passwordResetService.request(
      input.email,
      this.getContext(request),
    );
  }

  @Post('password-reset/complete')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async completePasswordReset(
    @Body() input: PasswordResetCompleteDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PasswordResetCompletedResponse> {
    const result = await this.passwordResetService.complete(
      input,
      this.getContext(request),
    );
    this.webSessionService.clearAuthCookies(response);
    return result;
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
      ipAddress: getTrustedClientIp(request),
      userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
    };
  }
}
