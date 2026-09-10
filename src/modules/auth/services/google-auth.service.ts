import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuthGoogleConfig } from '../../../config/auth-google.config';
import { normalizeAndValidateUserName } from '../../credentials/name-policy';
import { PasswordHashCapacity } from '../../credentials/services/password-hash-capacity.service';
import {
  PASSWORD_LOGIN_VERIFIER,
  PasswordLoginVerifier,
} from '../../credentials/ports/password-login-verifier.port';
import { User } from '../../users/entities/user.entity';
import { UserStatus } from '../../users/enums/user-status.enum';
import { GoogleLinkDto, GoogleProfileDto } from '../dto/google-auth.dto';
import { AuthGoogleChallenge } from '../entities/auth-google-challenge.entity';
import { AuthIdentity } from '../entities/auth-identity.entity';
import {
  GOOGLE_IDENTITY_VERIFIER,
  GoogleIdentityVerifier,
  VerifiedGoogleIdentity,
} from '../ports/google-identity-verifier.port';
import { AuthRequestContext } from '../types/authenticated-user.type';
import { AuthAuditService } from './auth-audit.service';
import { AuthAuditEventType } from '../../auth-sessions/enums/auth-audit-event-type.enum';
import {
  GoogleChallengeService,
  IssuedGoogleChallenge,
} from './google-challenge.service';
import {
  GenesisSessionIssuer,
  AuthOperationResult,
} from './genesis-session-issuer.service';
import { InMemoryGoogleAuthRateLimiter } from './in-memory-google-auth-rate-limiter.service';
import { PublicAuthService } from './public-auth.service';

export interface GooglePublicConfigResponse {
  enabled: boolean;
  clientId: string | null;
}

interface CreateGoogleUserRow {
  user_id: string;
}
interface LinkGoogleIdentityRow {
  linked: boolean;
}

@Injectable()
export class GoogleAuthService {
  private readonly config: AuthGoogleConfig;

  constructor(
    private readonly dataSource: DataSource,
    configService: ConfigService,
    @Inject(GOOGLE_IDENTITY_VERIFIER)
    private readonly verifier: GoogleIdentityVerifier,
    @Inject(PASSWORD_LOGIN_VERIFIER)
    private readonly passwords: PasswordLoginVerifier,
    private readonly hashCapacity: PasswordHashCapacity,
    private readonly challenges: GoogleChallengeService,
    private readonly sessions: GenesisSessionIssuer,
    private readonly limiter: InMemoryGoogleAuthRateLimiter,
    private readonly publicAuth: PublicAuthService,
    private readonly audit: AuthAuditService,
  ) {
    this.config = configService.getOrThrow<AuthGoogleConfig>('authGoogle');
  }

  getPublicConfig(): GooglePublicConfigResponse {
    return this.config.publicFlowEnabled && this.config.clientId !== null
      ? { enabled: true, clientId: this.config.clientId }
      : { enabled: false, clientId: null };
  }

  issueChallenge(context: AuthRequestContext): Promise<IssuedGoogleChallenge> {
    this.assertEnabled();
    this.limiter.assertAllowed('challenge', context.ipAddress);
    return this.challenges.issue();
  }

  async authenticate(
    challengeToken: string,
    credential: string,
    context: AuthRequestContext,
  ): Promise<AuthOperationResult> {
    this.assertEnabled();
    this.limiter.assertAllowed('verify', context.ipAddress);
    let claims: VerifiedGoogleIdentity;
    try {
      claims = await this.verifier.verify(credential);
    } catch {
      await this.debitFailedChallenge(challengeToken, ['issued']);
      await this.audit.record({
        ...context,
        eventType: AuthAuditEventType.LOGIN_FAILED,
        metadata: { method: 'google', reason: 'invalid_assertion' },
      });
      this.invalid();
    }
    const operation = async (manager: EntityManager) => {
      const challenge = await this.challenges.resolve(manager, challengeToken, [
        'issued',
      ]);
      if (!this.challenges.nonceMatches(challenge, claims.nonce)) {
        this.challenges.markFailed(challenge);
        await manager.save(challenge);
        return { kind: 'invalid' as const };
      }
      return this.resolveValidatedIdentity(manager, challenge, claims, context);
    };
    const result = await this.transactionWithRaceRetry(operation);
    if (result.kind === 'invalid') {
      await this.audit.record({
        ...context,
        eventType: AuthAuditEventType.LOGIN_FAILED,
        metadata: { method: 'google', reason: 'identity_unavailable' },
      });
      this.invalid();
    }
    if (result.kind === 'verification') {
      await this.throwVerificationRequired(result.userId);
    }
    if (result.kind === 'profile' || result.kind === 'link') {
      this.continuation(result.kind, challengeToken, result.expiresAt);
    }
    if (result.kind === 'session') return result.operation;
    this.invalid();
  }

  async completeProfile(
    input: GoogleProfileDto,
    context: AuthRequestContext,
  ): Promise<AuthOperationResult> {
    this.assertEnabled();
    this.limiter.assertAllowed('profile', context.ipAddress);
    let name: string;
    try {
      const firstName = normalizeAndValidateUserName(input.firstName);
      const lastName = normalizeAndValidateUserName(input.lastName);
      name = normalizeAndValidateUserName(`${firstName} ${lastName}`);
    } catch {
      throw new BadRequestException({
        statusCode: 400,
        code: 'AUTH_GOOGLE_PROFILE_INVALID',
        message: 'Google profile is invalid.',
      });
    }
    const operation = async (manager: EntityManager) => {
      const challenge = await this.challenges.resolve(
        manager,
        input.challengeToken,
        ['profile_pending'],
      );
      if (
        challenge.providerSubject === null ||
        challenge.providerEmail === null
      )
        this.invalid();
      return this.resolveStoredIdentity(manager, challenge, name, context);
    };
    const result = await this.transactionWithRaceRetry(operation);
    if (result.kind === 'verification')
      await this.throwVerificationRequired(result.userId);
    if (result.kind === 'link')
      this.continuation('link', input.challengeToken, result.expiresAt);
    if (result.kind === 'session') return result.operation;
    this.invalid();
  }

  async link(
    input: GoogleLinkDto,
    context: AuthRequestContext,
  ): Promise<AuthOperationResult> {
    this.assertEnabled();
    this.limiter.assertAllowed('link', context.ipAddress);
    const snapshot = await this.dataSource.transaction(async (manager) => {
      const challenge = await this.challenges.resolve(
        manager,
        input.challengeToken,
        ['link_pending'],
      );
      if (challenge.userId === null) this.invalid();
      const user = await manager
        .getRepository(User)
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .where('user.id = :id', { id: challenge.userId })
        .getOne();
      return user === null
        ? null
        : { userId: user.id, passwordHash: user.passwordHash };
    });
    const valid = await this.hashCapacity.run(() =>
      this.passwords.verifyForLogin(
        snapshot?.passwordHash ?? null,
        input.password,
      ),
    );
    if (snapshot === null || !valid) {
      await this.debitFailedChallenge(input.challengeToken, ['link_pending']);
      await this.audit.record({
        ...context,
        eventType: AuthAuditEventType.LOGIN_FAILED,
        userId: snapshot?.userId,
        metadata: { method: 'google', reason: 'invalid_credentials' },
      });
      throw new UnauthorizedException('Invalid credentials.');
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const challenge = await this.challenges.resolve(
        manager,
        input.challengeToken,
        ['link_pending'],
      );
      await manager.query(
        `SELECT app_private.lock_auth_refresh_user($1::uuid)`,
        [snapshot.userId],
      );
      const user = await manager
        .getRepository(User)
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .where('user.id = :id', { id: snapshot.userId })
        .getOne();
      if (
        user === null ||
        user.status !== UserStatus.ACTIVE ||
        user.emailVerifiedAt === null ||
        user.email !== challenge.providerEmail ||
        user.passwordHash !== snapshot.passwordHash ||
        challenge.providerSubject === null
      )
        return null;
      const rows = await manager.query<LinkGoogleIdentityRow[]>(
        `SELECT app_private.link_google_identity($1::uuid,$2::text,$3::text) AS linked`,
        [user.id, challenge.providerSubject, challenge.providerEmail],
      );
      if (rows[0]?.linked !== true) return null;
      this.challenges.consume(challenge);
      await manager.save(challenge);
      await this.audit.record(
        {
          ...context,
          eventType: AuthAuditEventType.IDENTITY_LINKED,
          userId: user.id,
          metadata: { provider: 'google' },
        },
        manager,
      );
      return this.sessions.issue(manager, user, context, 'google');
    });
    if (result === null)
      throw new UnauthorizedException('Invalid credentials.');
    return result;
  }

  private async resolveValidatedIdentity(
    manager: EntityManager,
    challenge: AuthGoogleChallenge,
    claims: VerifiedGoogleIdentity,
    context: AuthRequestContext,
  ) {
    const identity = await manager
      .getRepository(AuthIdentity)
      .createQueryBuilder('identity')
      .innerJoinAndSelect('identity.user', 'user')
      .where('identity.provider = :provider', { provider: 'google' })
      .andWhere('identity.providerSubject = :subject', {
        subject: claims.subject,
      })
      .getOne();
    if (identity !== null) {
      return this.loginKnownIdentity(
        manager,
        challenge,
        identity,
        claims.email,
        context,
      );
    }
    const user = await manager
      .getRepository(User)
      .findOneBy({ email: claims.email });
    if (user !== null) {
      if (user.emailVerifiedAt === null) {
        this.challenges.consume(challenge);
        await manager.save(challenge);
        return { kind: 'verification' as const, userId: user.id };
      }
      challenge.stage = 'link_pending';
      challenge.userId = user.id;
      challenge.providerSubject = claims.subject;
      challenge.providerEmail = claims.email;
      challenge.emailAuthoritative = null;
      await manager.save(challenge);
      return { kind: 'link' as const, expiresAt: challenge.expiresAt };
    }
    const authoritative =
      claims.email.endsWith('@gmail.com') || claims.hostedDomain !== null;
    const name = this.googleName(claims);
    if (name === null) {
      challenge.stage = 'profile_pending';
      challenge.providerSubject = claims.subject;
      challenge.providerEmail = claims.email;
      challenge.emailAuthoritative = authoritative;
      await manager.save(challenge);
      return { kind: 'profile' as const, expiresAt: challenge.expiresAt };
    }
    return this.createGoogleUser(
      manager,
      challenge,
      claims.subject,
      claims.email,
      name,
      authoritative,
      context,
    );
  }

  private async resolveStoredIdentity(
    manager: EntityManager,
    challenge: AuthGoogleChallenge,
    name: string,
    context: AuthRequestContext,
  ) {
    const subject = challenge.providerSubject as string;
    const email = challenge.providerEmail as string;
    const identity = await manager
      .getRepository(AuthIdentity)
      .createQueryBuilder('identity')
      .innerJoinAndSelect('identity.user', 'user')
      .where('identity.provider = :provider', { provider: 'google' })
      .andWhere('identity.providerSubject = :subject', { subject })
      .getOne();
    if (identity !== null)
      return this.loginKnownIdentity(
        manager,
        challenge,
        identity,
        email,
        context,
      );
    const user = await manager.getRepository(User).findOneBy({ email });
    if (user !== null) {
      if (user.emailVerifiedAt === null) {
        this.challenges.consume(challenge);
        await manager.save(challenge);
        return { kind: 'verification' as const, userId: user.id };
      }
      challenge.stage = 'link_pending';
      challenge.userId = user.id;
      await manager.save(challenge);
      return { kind: 'link' as const, expiresAt: challenge.expiresAt };
    }
    return this.createGoogleUser(
      manager,
      challenge,
      subject,
      email,
      name,
      challenge.emailAuthoritative === true,
      context,
    );
  }

  private async createGoogleUser(
    manager: EntityManager,
    challenge: AuthGoogleChallenge,
    subject: string,
    email: string,
    name: string,
    authoritative: boolean,
    context: AuthRequestContext,
  ) {
    let rows: CreateGoogleUserRow[];
    try {
      rows = await manager.query<CreateGoogleUserRow[]>(
        `SELECT app_private.create_google_user_identity($1::text,$2::text,$3::boolean,$4::text) AS user_id`,
        [email, name, authoritative, subject],
      );
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === '23505'
      ) {
        throw new HttpException(
          {
            statusCode: 409,
            code: 'AUTH_GOOGLE_RETRY',
            message: 'Retry Google authentication.',
          },
          409,
        );
      }
      throw error;
    }
    const userId = rows[0]?.user_id;
    const user = userId
      ? await manager.getRepository(User).findOneBy({ id: userId })
      : null;
    if (user === null) this.unavailable();
    this.challenges.consume(challenge);
    await manager.save(challenge);
    await this.audit.record(
      {
        ...context,
        eventType: AuthAuditEventType.REGISTRATION_SUCCEEDED,
        userId: user.id,
        metadata: { method: 'google' },
      },
      manager,
    );
    if (user.emailVerifiedAt === null)
      return { kind: 'verification' as const, userId: user.id };
    return {
      kind: 'session' as const,
      operation: await this.sessions.issue(manager, user, context, 'google'),
    };
  }

  private async loginKnownIdentity(
    manager: EntityManager,
    challenge: AuthGoogleChallenge,
    identity: AuthIdentity,
    currentProviderEmail: string,
    context: AuthRequestContext,
  ) {
    await manager.query(`SELECT app_private.lock_auth_refresh_user($1::uuid)`, [
      identity.userId,
    ]);
    const user = await manager
      .getRepository(User)
      .findOneBy({ id: identity.userId });
    if (user === null || user.status !== UserStatus.ACTIVE) {
      this.challenges.consume(challenge);
      await manager.save(challenge);
      return { kind: 'invalid' as const };
    }
    await manager.query(
      `SELECT app_private.touch_google_identity($1::uuid,$2::text)`,
      [identity.id, currentProviderEmail],
    );
    this.challenges.consume(challenge);
    await manager.save(challenge);
    if (user.emailVerifiedAt === null)
      return { kind: 'verification' as const, userId: user.id };
    return {
      kind: 'session' as const,
      operation: await this.sessions.issue(manager, user, context, 'google'),
    };
  }

  private googleName(claims: VerifiedGoogleIdentity): string | null {
    const candidates = [
      claims.name,
      [claims.givenName, claims.familyName].filter(Boolean).join(' '),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        return normalizeAndValidateUserName(candidate);
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private async throwVerificationRequired(userId: string): Promise<never> {
    const continuation = await this.publicAuth.continuationForLogin(userId);
    throw new HttpException(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: 'Email verification is required.',
        ...(continuation ? { continuation } : {}),
      },
      HttpStatus.FORBIDDEN,
    );
  }

  private async transactionWithRaceRetry<T>(
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(operation);
    } catch (error) {
      if (
        error instanceof HttpException &&
        typeof error.getResponse() === 'object' &&
        (error.getResponse() as { code?: string }).code === 'AUTH_GOOGLE_RETRY'
      ) {
        return this.dataSource.transaction(operation);
      }
      throw error;
    }
  }

  private async debitFailedChallenge(
    challengeToken: string,
    allowedStages: readonly ('issued' | 'link_pending')[],
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const challenge = await this.challenges.resolve(
          manager,
          challengeToken,
          allowedStages,
        );
        this.challenges.markFailed(challenge);
        await manager.save(challenge);
      });
    } catch {
      // Authentication failures remain generic even when the ceremony is absent,
      // expired, consumed, or already exhausted.
    }
  }

  private continuation(
    kind: 'profile' | 'link',
    token: string,
    expiresAt: Date,
  ): never {
    throw new HttpException(
      {
        statusCode: HttpStatus.CONFLICT,
        code:
          kind === 'profile'
            ? 'AUTH_GOOGLE_PROFILE_REQUIRED'
            : 'AUTH_GOOGLE_LINK_REQUIRED',
        message:
          kind === 'profile'
            ? 'Google profile is required.'
            : 'Password confirmation is required.',
        googleContinuation: {
          challengeToken: token,
          expiresAt: expiresAt.toISOString(),
        },
      },
      HttpStatus.CONFLICT,
    );
  }

  private assertEnabled(): void {
    if (!this.config.publicFlowEnabled || this.config.clientId === null)
      this.unavailable();
  }

  private invalid(): never {
    throw new BadRequestException({
      statusCode: 400,
      code: 'AUTH_GOOGLE_INVALID',
      message: 'Google authentication is invalid.',
    });
  }

  private unavailable(): never {
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'AUTH_GOOGLE_UNAVAILABLE',
      message: 'Google authentication is unavailable.',
    });
  }
}
