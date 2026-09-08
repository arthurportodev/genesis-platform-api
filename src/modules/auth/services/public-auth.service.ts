import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryFailedError } from 'typeorm';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import { AuthOtpConfig } from '../../../config/auth-otp.config';
import {
  AuthEmailChallengesService,
  ChallengeIssueResult,
  EmailVerificationChallengeContext,
} from '../../auth-email-challenges/auth-email-challenges.service';
import { AuthAuditEventType } from '../../auth-sessions/enums/auth-audit-event-type.enum';
import { normalizeAndValidateUserName } from '../../credentials/name-policy';
import {
  PASSWORD_HASHER,
  PasswordHasher,
} from '../../credentials/ports/password-hasher.port';
import { PasswordHashCapacity } from '../../credentials/services/password-hash-capacity.service';
import { RegisterDto } from '../dto/register.dto';
import { AuthRequestContext } from '../types/authenticated-user.type';
import { AuthAuditService } from './auth-audit.service';
import { InMemoryRegistrationRateLimiter } from './in-memory-registration-rate-limiter.service';
import { Inject } from '@nestjs/common';

export interface VerificationContinuation {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
}

export interface VerificationRequiredResponse extends VerificationContinuation {
  status: 'verification_required';
  delivery: 'sent' | 'delivery_unavailable';
}

export interface EmailVerifiedResponse {
  status: 'email_verified';
}

interface RegisteredUserRow {
  user_id: string;
}

interface VerifyUserRow {
  verified: boolean;
}

interface PostgresError {
  code?: string;
  constraint?: string;
}

@Injectable()
export class PublicAuthService {
  private readonly config: AuthOtpConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    private readonly hashCapacity: PasswordHashCapacity,
    private readonly limiter: InMemoryRegistrationRateLimiter,
    private readonly challenges: AuthEmailChallengesService,
    private readonly audit: AuthAuditService,
  ) {
    this.config = config.getOrThrow<AuthOtpConfig>('authOtp');
  }

  async register(
    input: RegisterDto,
    context: AuthRequestContext,
  ): Promise<VerificationRequiredResponse> {
    this.assertEnabled();
    const email = normalizeEmail(input.email);
    this.limiter.consume(context.ipAddress, email);
    let name: string;
    try {
      const firstName = normalizeAndValidateUserName(input.firstName);
      const lastName = normalizeAndValidateUserName(input.lastName);
      name = normalizeAndValidateUserName(`${firstName} ${lastName}`);
    } catch {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'AUTH_REGISTRATION_INVALID',
        message: 'Invalid registration request.',
      });
    }

    const duplicate = await this.dataSource.query<Array<{ exists: boolean }>>(
      'SELECT EXISTS(SELECT 1 FROM public.users WHERE email = $1) AS exists',
      [email],
    );
    if (duplicate[0]?.exists === true) this.duplicateEmail();

    const passwordHash = await this.hashCapacity.run(() =>
      this.passwordHasher.hash(input.password),
    );
    let userId: string;
    try {
      userId = await this.dataSource.transaction(async (manager) => {
        const rows = await manager.query<RegisteredUserRow[]>(
          `SELECT * FROM app_private.register_unverified_user(
             $1::text, $2::text, $3::text
           )`,
          [email, name, passwordHash],
        );
        const row = rows[0];
        if (!row) throw new Error('Registration returned an invalid result.');
        await this.audit.record(
          {
            ...context,
            eventType: AuthAuditEventType.REGISTRATION_SUCCEEDED,
            userId: row.user_id,
          },
          manager,
        );
        return row.user_id;
      });
    } catch (error) {
      if (this.isDuplicateEmail(error)) this.duplicateEmail();
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'AUTH_REGISTRATION_UNAVAILABLE',
        message: 'Registration is unavailable.',
      });
    }

    const issued = await this.challenges.issueEmailVerification(userId);
    return this.toRequiredResponse(issued);
  }

  async resend(challengeId: string): Promise<VerificationRequiredResponse> {
    this.assertEnabled();
    const challenge =
      await this.challenges.resolveEmailVerificationChallenge(challengeId);
    if (!challenge || challenge.emailVerifiedAt !== null)
      this.challengeUnavailable();
    const issued = await this.challenges.issueEmailVerification(
      challenge.userId,
    );
    if (issued.status === 'rate_limited') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'AUTH_EMAIL_VERIFICATION_RATE_LIMITED',
          message: 'Verification resend is not available yet.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.toRequiredResponse(issued);
  }

  async verify(
    challengeId: string,
    code: string,
    context: AuthRequestContext,
  ): Promise<EmailVerifiedResponse> {
    this.assertEnabled();
    const challenge =
      await this.challenges.resolveEmailVerificationChallenge(challengeId);
    if (!challenge) this.challengeUnavailable();
    const accepted = await this.challenges.consumeEmailVerification(
      challenge.userId,
      challenge.challengeId,
      code,
    );
    if (!accepted) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'AUTH_EMAIL_VERIFICATION_INVALID',
        message: 'Invalid or expired verification code.',
      });
    }

    const verified = await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<VerifyUserRow[]>(
        `SELECT app_private.verify_user_email($1::uuid, $2::uuid) AS verified`,
        [challenge.userId, challenge.challengeId],
      );
      if (rows[0]?.verified !== true) return false;
      const now = new Date();
      const sessions = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM public.auth_sessions
         WHERE user_id = $1::uuid AND status = 'active'
         FOR UPDATE`,
        [challenge.userId],
      );
      const sessionIds = sessions.map((session) => session.id);
      if (sessionIds.length > 0) {
        await manager.query(
          `UPDATE public.auth_sessions
           SET status = 'revoked', revoked_at = $2,
               revoke_reason = 'email_verified', updated_at = $2
           WHERE id = ANY($1::uuid[]) AND status = 'active'`,
          [sessionIds, now],
        );
        await manager.query(
          `UPDATE public.auth_refresh_tokens
           SET status = 'revoked', revoked_at = $2, updated_at = $2
           WHERE session_id = ANY($1::uuid[]) AND status = 'active'`,
          [sessionIds, now],
        );
      }
      await this.audit.record(
        {
          ...context,
          eventType: AuthAuditEventType.EMAIL_VERIFIED,
          userId: challenge.userId,
          metadata: { revokedSessions: sessionIds.length },
        },
        manager,
      );
      return true;
    });
    if (!verified) this.challengeUnavailable();
    return { status: 'email_verified' };
  }

  async continuationForLogin(
    userId: string,
  ): Promise<VerificationContinuation | null> {
    const existing =
      await this.challenges.currentEmailVerificationChallenge(userId);
    if (existing) return this.toContinuation(existing);
    if (!this.config.publicFlowsEnabled) return null;
    try {
      const issued = await this.challenges.issueEmailVerification(userId);
      return 'challengeId' in issued
        ? {
            challengeId: issued.challengeId,
            expiresAt: issued.expiresAt,
            resendAvailableAt: issued.resendAvailableAt,
          }
        : null;
    } catch {
      return null;
    }
  }

  private assertEnabled(): void {
    if (!this.config.publicFlowsEnabled) {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'AUTH_OTP_PUBLIC_FLOWS_DISABLED',
        message: 'Public authentication flows are unavailable.',
      });
    }
  }

  private toRequiredResponse(
    issued: ChallengeIssueResult,
  ): VerificationRequiredResponse {
    if (!('challengeId' in issued)) {
      if (issued.status === 'unavailable') this.challengeUnavailable();
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'AUTH_EMAIL_VERIFICATION_RATE_LIMITED',
          message: 'Verification resend is not available yet.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return {
      status: 'verification_required',
      challengeId: issued.challengeId,
      expiresAt: issued.expiresAt,
      resendAvailableAt: issued.resendAvailableAt,
      delivery: issued.status,
    };
  }

  private toContinuation(
    challenge: EmailVerificationChallengeContext,
  ): VerificationContinuation {
    return {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
    };
  }

  private duplicateEmail(): never {
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: 'AUTH_EMAIL_ALREADY_REGISTERED',
      message: 'Email is already registered.',
    });
  }

  private challengeUnavailable(): never {
    throw new NotFoundException({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'AUTH_EMAIL_VERIFICATION_UNAVAILABLE',
      message: 'Email verification challenge is unavailable.',
    });
  }

  private isDuplicateEmail(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driver = error.driverError as PostgresError;
    return driver.code === '23505' && driver.constraint === 'UQ_users_email';
  }
}
