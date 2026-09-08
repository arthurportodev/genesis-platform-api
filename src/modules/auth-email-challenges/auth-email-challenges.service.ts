import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { EmailTransport } from '../../common/email/email-transport';
import { AuthOtpConfig } from '../../config/auth-otp.config';
import { AuthAuditService } from '../auth/services/auth-audit.service';
import { AuthAuditEventType } from '../auth-sessions/enums/auth-audit-event-type.enum';
import { AuthEmailChallenge } from './auth-email-challenge.entity';
import {
  EmailChallengePurpose,
  equalOtpHash,
  generateOtp,
  hashOtp,
} from './otp-codec';

export const AUTH_OTP_EMAIL_TRANSPORT = Symbol('AUTH_OTP_EMAIL_TRANSPORT');

export type ChallengeIssueResult =
  | { status: 'unavailable' | 'rate_limited' }
  | {
      status: 'sent' | 'delivery_unavailable';
      challengeId: string;
      expiresAt: Date;
      resendAvailableAt: Date;
    };

export interface EmailVerificationChallengeContext {
  challengeId: string;
  userId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  stage: 'otp' | 'consumed' | 'invalidated';
  emailVerifiedAt: Date | null;
}

interface LockedUser {
  email: string;
  status: string;
  emailVerifiedAt: Date | null;
}
interface IssueMaterial {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  email: string;
  otp: string;
}

@Injectable()
export class AuthEmailChallengesService {
  private readonly config: AuthOtpConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    @Inject(AUTH_OTP_EMAIL_TRANSPORT)
    private readonly transport: EmailTransport | null,
    private readonly audit: AuthAuditService,
  ) {
    this.config = config.getOrThrow<AuthOtpConfig>('authOtp');
  }

  issueEmailVerification(userId: string): Promise<ChallengeIssueResult> {
    return this.issue(userId, 'email_verification');
  }

  issuePasswordReset(userId: string): Promise<ChallengeIssueResult> {
    return this.issue(userId, 'password_reset');
  }

  consumeEmailVerification(
    userId: string,
    challengeId: string,
    code: string,
  ): Promise<boolean> {
    return this.consume(userId, challengeId, code, 'email_verification');
  }

  consumePasswordReset(
    userId: string,
    challengeId: string,
    code: string,
  ): Promise<boolean> {
    return this.consume(userId, challengeId, code, 'password_reset');
  }

  async resolveEmailVerificationChallenge(
    challengeId: string,
  ): Promise<EmailVerificationChallengeContext | null> {
    if (!isUUID(challengeId)) return null;
    const rows = await this.dataSource.query<
      Array<{
        challengeId: string;
        userId: string;
        expiresAt: Date;
        resendAvailableAt: Date;
        stage: 'otp' | 'consumed' | 'invalidated';
        emailVerifiedAt: Date | null;
      }>
    >(
      `SELECT challenge.id AS "challengeId",
              challenge.user_id AS "userId",
              challenge.expires_at AS "expiresAt",
              challenge.last_sent_at + ($2::integer * interval '1 second')
                AS "resendAvailableAt",
              challenge.stage,
              application_user.email_verified_at AS "emailVerifiedAt"
       FROM public.auth_email_challenges AS challenge
       JOIN public.users AS application_user
         ON application_user.id = challenge.user_id
       WHERE challenge.id = $1::uuid
         AND challenge.purpose = 'email_verification'
         AND application_user.status = 'active'`,
      [challengeId.toLowerCase(), this.config.cooldownSeconds],
    );
    return rows[0] ?? null;
  }

  async currentEmailVerificationChallenge(
    userId: string,
  ): Promise<EmailVerificationChallengeContext | null> {
    if (!isUUID(userId)) return null;
    const rows = await this.dataSource.query<
      EmailVerificationChallengeContext[]
    >(
      `SELECT challenge.id AS "challengeId",
              challenge.user_id AS "userId",
              challenge.expires_at AS "expiresAt",
              challenge.last_sent_at + ($2::integer * interval '1 second')
                AS "resendAvailableAt",
              challenge.stage,
              application_user.email_verified_at AS "emailVerifiedAt"
       FROM public.auth_email_challenges AS challenge
       JOIN public.users AS application_user
         ON application_user.id = challenge.user_id
       WHERE challenge.user_id = $1::uuid
         AND challenge.purpose = 'email_verification'
         AND challenge.stage = 'otp'
         AND challenge.expires_at > clock_timestamp()
         AND challenge.failed_attempts < $3::integer
         AND application_user.status = 'active'`,
      [
        userId.toLowerCase(),
        this.config.cooldownSeconds,
        this.config.maxAttempts,
      ],
    );
    return rows[0] ?? null;
  }

  private ready(): Buffer {
    if (
      this.config.pepper?.length !== 32 ||
      !this.config.emailFrom ||
      !this.transport
    ) {
      throw new ServiceUnavailableException(
        'Email challenges are unavailable.',
      );
    }
    return this.config.pepper;
  }

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<LockedUser | null> {
    await manager.query('SELECT app_private.lock_auth_refresh_user($1::uuid)', [
      userId,
    ]);
    const rows = await manager.query<LockedUser[]>(
      `SELECT email, status, email_verified_at AS "emailVerifiedAt"
       FROM public.users WHERE id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  private async databaseNow(manager: EntityManager): Promise<Date> {
    // Evaluate after acquiring locks, so waiting cannot resurrect an expired OTP.
    const [row] = await manager.query<Array<{ now: Date }>>(
      'SELECT clock_timestamp() AS now',
    );
    if (!row) throw new Error('Database clock unavailable.');
    return row.now;
  }

  private async issue(
    userId: string,
    purpose: EmailChallengePurpose,
  ): Promise<ChallengeIssueResult> {
    const pepper = this.ready();
    if (!isUUID(userId)) return { status: 'unavailable' };
    userId = userId.toLowerCase();
    try {
      const material = await this.dataSource.transaction(
        async (
          manager,
        ): Promise<IssueMaterial | 'unavailable' | 'rate_limited'> => {
          const user = await this.lockUser(manager, userId);
          if (
            !user ||
            user.status !== 'active' ||
            (purpose === 'email_verification' && user.emailVerifiedAt !== null)
          )
            return 'unavailable';
          const repository = manager.getRepository(AuthEmailChallenge);
          const existing = await repository
            .createQueryBuilder('challenge')
            .addSelect('challenge.secretHash')
            .setLock('pessimistic_write')
            .where(
              'challenge.userId = :userId AND challenge.purpose = :purpose',
              { userId, purpose },
            )
            .getOne();
          const now = await this.databaseNow(manager);
          const sameWindow =
            existing !== null &&
            now.getTime() <
              existing.sendWindowStartedAt.getTime() +
                this.config.sendWindowSeconds * 1000;
          if (
            existing &&
            (now.getTime() <
              existing.lastSentAt.getTime() +
                this.config.cooldownSeconds * 1000 ||
              (sameWindow && existing.sendCount >= this.config.maxSends))
          )
            return 'rate_limited';

          let otp = generateOtp();
          // Also avoid repeating the previous numeric value, not just its ID.
          for (
            let tries = 0;
            existing?.secretHash &&
            equalOtpHash(
              hashOtp(pepper, purpose, userId, existing.id, otp),
              existing.secretHash,
            );
            tries += 1
          ) {
            if (tries >= 10) throw new Error('OTP generation unavailable.');
            otp = generateOtp();
          }
          const challengeId = randomUUID();
          const expiresAt = new Date(
            now.getTime() + this.config.ttlSeconds * 1000,
          );
          const resendAvailableAt = new Date(
            now.getTime() + this.config.cooldownSeconds * 1000,
          );
          const values = {
            id: challengeId,
            userId,
            purpose,
            secretHash: hashOtp(pepper, purpose, userId, challengeId, otp),
            stage: 'otp' as const,
            expiresAt,
            failedAttempts: 0,
            lastSentAt: now,
            sendWindowStartedAt:
              sameWindow && existing ? existing.sendWindowStartedAt : now,
            sendCount: sameWindow && existing ? existing.sendCount + 1 : 1,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          if (existing) await repository.update({ id: existing.id }, values);
          else await repository.insert(values);
          await this.record(
            AuthAuditEventType.OTP_ISSUED,
            userId,
            purpose,
            manager,
          );
          return {
            challengeId,
            expiresAt,
            resendAvailableAt,
            email: user.email,
            otp,
          };
        },
      );
      if (typeof material === 'string') return { status: material };

      // This is intentionally outside PostgreSQL: no network call holds locks.
      const subject =
        purpose === 'email_verification'
          ? 'Confirme seu e-mail na Genesis'
          : 'Recupere sua senha na Genesis';
      const body = `Seu código é ${material.otp}. Ele expira em ${this.config.ttlSeconds / 60} minutos. Se você não solicitou, ignore este e-mail.`;
      let sent = false;
      try {
        const delivery = await this.transport!.send({
          idempotencyKey: `genesis-email-otp/v1/${material.challengeId}`,
          from: this.config.emailFrom,
          to: material.email,
          subject,
          text: body,
          html: `<p>${body}</p>`,
        });
        sent = delivery.kind === 'sent';
      } catch {
        // Do not propagate provider exceptions, which may contain the message.
      }
      if (!sent)
        await this.record(
          AuthAuditEventType.OTP_DELIVERY_FAILED,
          userId,
          purpose,
        );
      return {
        status: sent ? 'sent' : 'delivery_unavailable',
        challengeId: material.challengeId,
        expiresAt: material.expiresAt,
        resendAvailableAt: material.resendAvailableAt,
      };
    } catch {
      // TypeORM errors include SQL parameters; never expose them to HTTP/loggers.
      throw new ServiceUnavailableException(
        'Email challenges are unavailable.',
      );
    }
  }

  private async consume(
    userId: string,
    challengeId: string,
    code: string,
    purpose: EmailChallengePurpose,
  ): Promise<boolean> {
    const pepper = this.ready();
    if (!isUUID(userId) || !isUUID(challengeId)) return false;
    userId = userId.toLowerCase();
    challengeId = challengeId.toLowerCase();
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const user = await this.lockUser(manager, userId);
        if (!user || user.status !== 'active')
          return { accepted: false, audit: false };
        const repository = manager.getRepository(AuthEmailChallenge);
        const challenge = await repository
          .createQueryBuilder('challenge')
          .addSelect('challenge.secretHash')
          .setLock('pessimistic_write')
          .where(
            'challenge.id = :challengeId AND challenge.userId = :userId AND challenge.purpose = :purpose',
            { challengeId, userId, purpose },
          )
          .getOne();
        if (!challenge || challenge.stage !== 'otp')
          return { accepted: false, audit: true };
        const now = await this.databaseNow(manager);
        if (
          challenge.expiresAt <= now ||
          challenge.failedAttempts >= this.config.maxAttempts
        ) {
          await repository.update(challenge.id, {
            stage: 'invalidated',
            secretHash: null,
            updatedAt: now,
          });
          return { accepted: false, audit: true };
        }
        const accepted =
          typeof code === 'string' &&
          /^\d{6}$/u.test(code) &&
          challenge.secretHash !== null &&
          equalOtpHash(
            hashOtp(pepper, purpose, userId, challenge.id, code),
            challenge.secretHash,
          );
        if (accepted) {
          await repository.update(challenge.id, {
            stage: 'consumed',
            secretHash: null,
            updatedAt: now,
          });
        } else {
          const failedAttempts = challenge.failedAttempts + 1;
          await repository.update(challenge.id, {
            failedAttempts,
            updatedAt: now,
            ...(failedAttempts >= this.config.maxAttempts
              ? { stage: 'invalidated' as const, secretHash: null }
              : {}),
          });
        }
        return { accepted, audit: true };
      });
      // Persist failure/consumption before any caller or audit exception. This
      // API owns its transaction; it never accepts an outer EntityManager.
      if (result.audit)
        await this.record(
          result.accepted
            ? AuthAuditEventType.OTP_CONSUMED
            : AuthAuditEventType.OTP_REJECTED,
          userId,
          purpose,
        );
      return result.accepted;
    } catch {
      throw new ServiceUnavailableException(
        'Email challenges are unavailable.',
      );
    }
  }

  private record(
    eventType: AuthAuditEventType,
    userId: string,
    purpose: EmailChallengePurpose,
    manager?: EntityManager,
  ): Promise<void> {
    return this.audit.record(
      {
        eventType,
        userId,
        ipAddress: null,
        userAgent: null,
        metadata: { purpose },
      },
      manager,
    );
  }
}
