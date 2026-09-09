import {
  BadRequestException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import { AuthOtpConfig } from '../../../config/auth-otp.config';
import { AuthEmailChallengesService } from '../../auth-email-challenges/auth-email-challenges.service';
import { hashOtp } from '../../auth-email-challenges/otp-codec';
import { AuthAuditEventType } from '../../auth-sessions/enums/auth-audit-event-type.enum';
import {
  PASSWORD_HASHER,
  PasswordHasher,
} from '../../credentials/ports/password-hasher.port';
import { PasswordHashCapacity } from '../../credentials/services/password-hash-capacity.service';
import { PasswordResetCompleteDto } from '../dto/password-reset.dto';
import { AuthRequestContext } from '../types/authenticated-user.type';
import { AuthAuditService } from './auth-audit.service';
import { InMemoryPasswordResetRateLimiter } from './in-memory-password-reset-rate-limiter.service';
import { Inject } from '@nestjs/common';

export const PASSWORD_RESET_PUBLIC_RESPONSE_FLOOR_MS = 750;

export interface PasswordResetAcceptedResponse {
  status: 'accepted';
  expiresAt: Date;
  resendAvailableAt: Date;
}

export interface PasswordResetCompletedResponse {
  status: 'password_reset';
}

interface ActiveUserRow {
  id: string;
}

interface CompletionRow {
  completed: boolean;
  revokedSessionCount: string | number;
  revokedRefreshTokenCount: string | number;
}

@Injectable()
export class PasswordResetService {
  private readonly config: AuthOtpConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    private readonly hashCapacity: PasswordHashCapacity,
    private readonly limiter: InMemoryPasswordResetRateLimiter,
    private readonly challenges: AuthEmailChallengesService,
    private readonly audit: AuthAuditService,
  ) {
    this.config = config.getOrThrow<AuthOtpConfig>('authOtp');
  }

  async request(
    emailInput: string,
    context: AuthRequestContext,
  ): Promise<PasswordResetAcceptedResponse> {
    this.assertEnabled();
    const startedAt = Date.now();
    const email = normalizeEmail(emailInput);
    this.limiter.consumeRequest(context.ipAddress, email);
    try {
      const users = await this.dataSource.query<ActiveUserRow[]>(
        `SELECT id FROM public.users WHERE email = $1 AND status = 'active'`,
        [email],
      );
      const user = users[0];
      if (user) await this.challenges.issuePasswordReset(user.id, 'detached');
      else this.syntheticOtpWork();
    } catch {
      this.unavailable();
    }
    await this.waitForPublicFloor(startedAt);
    return {
      status: 'accepted',
      expiresAt: new Date(startedAt + this.config.ttlSeconds * 1_000),
      resendAvailableAt: new Date(
        startedAt + this.config.cooldownSeconds * 1_000,
      ),
    };
  }

  async complete(
    input: PasswordResetCompleteDto,
    context: AuthRequestContext,
  ): Promise<PasswordResetCompletedResponse> {
    this.assertEnabled();
    const email = normalizeEmail(input.email);
    this.limiter.consumeComplete(context.ipAddress, email);
    const passwordHash = await this.hashCapacity.run(() =>
      this.passwordHasher.hash(input.password),
    );
    let users: ActiveUserRow[];
    try {
      users = await this.dataSource.query<ActiveUserRow[]>(
        `SELECT id FROM public.users WHERE email = $1 AND status = 'active'`,
        [email],
      );
    } catch {
      this.unavailable();
    }
    const user = users[0];
    if (!user) this.invalid();

    let completed: boolean;
    try {
      completed = await this.dataSource.transaction(async (manager) => {
        const consumption =
          await this.challenges.consumeCurrentPasswordResetInTransaction(
            manager,
            user.id,
            input.code,
          );
        if (!consumption.accepted || !consumption.challengeId) return false;
        const rows = await manager.query<CompletionRow[]>(
          `SELECT completed AS "completed",
                  revoked_session_count AS "revokedSessionCount",
                  revoked_refresh_token_count AS "revokedRefreshTokenCount"
           FROM app_private.complete_password_reset($1::uuid, $2::uuid, $3::text)`,
          [user.id, consumption.challengeId, passwordHash],
        );
        const completion = rows[0];
        if (completion?.completed !== true) {
          throw new Error('Password reset completion invariant failed.');
        }
        await this.recordSuccess(manager, context, user.id, completion);
        return true;
      });
    } catch {
      this.unavailable();
    }
    if (!completed) this.invalid();
    return { status: 'password_reset' };
  }

  private async recordSuccess(
    manager: EntityManager,
    context: AuthRequestContext,
    userId: string,
    completion: CompletionRow,
  ): Promise<void> {
    await this.audit.record(
      {
        ...context,
        eventType: AuthAuditEventType.PASSWORD_RESET_SUCCEEDED,
        userId,
        metadata: {
          revokedSessions: Number(completion.revokedSessionCount),
          revokedRefreshCredentials: Number(
            completion.revokedRefreshTokenCount,
          ),
        },
      },
      manager,
    );
  }

  private syntheticOtpWork(): void {
    const pepper = this.config.pepper;
    if (pepper?.length !== 32) {
      throw new ServiceUnavailableException('Password reset is unavailable.');
    }
    hashOtp(pepper, 'password_reset', randomUUID(), randomUUID(), '000000');
  }

  private async waitForPublicFloor(startedAt: number): Promise<void> {
    const remaining =
      PASSWORD_RESET_PUBLIC_RESPONSE_FLOOR_MS - (Date.now() - startedAt);
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
  private assertEnabled(): void {
    if (!this.config.passwordResetPublicFlowEnabled) {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'AUTH_PASSWORD_RESET_PUBLIC_FLOW_DISABLED',
        message: 'Password reset is unavailable.',
      });
    }
  }

  private invalid(): never {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'AUTH_PASSWORD_RESET_INVALID',
      message: 'Invalid or expired password reset code.',
    });
  }

  private unavailable(): never {
    throw new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'AUTH_PASSWORD_RESET_UNAVAILABLE',
      message: 'Password reset is unavailable.',
    });
  }
}
