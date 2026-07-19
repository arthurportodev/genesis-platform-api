import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AuthRefreshToken } from '../auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../auth-sessions/entities/auth-session.entity';
import { AuthAuditEventType } from '../auth-sessions/enums/auth-audit-event-type.enum';
import { AuthRefreshTokenStatus } from '../auth-sessions/enums/auth-refresh-token-status.enum';
import { AuthSessionStatus } from '../auth-sessions/enums/auth-session-status.enum';
import { User } from '../users/entities/user.entity';
import { UserStatus } from '../users/enums/user-status.enum';
import { LoginDto } from './dto/login.dto';
import { AuthAuditService } from './services/auth-audit.service';
import { LoginRateLimiter } from './services/login-rate-limiter.port';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import {
  AuthenticatedUser,
  AuthRequestContext,
  PublicUser,
} from './types/authenticated-user.type';

export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: PublicUser;
}

type RefreshTransactionResult =
  { ok: true; response: AuthTokenResponse } | { ok: false };

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';
const INVALID_REFRESH_MESSAGE = 'Invalid refresh token.';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly auditService: AuthAuditService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  async login(
    credentials: LoginDto,
    context: AuthRequestContext,
  ): Promise<AuthTokenResponse> {
    const email = credentials.email.trim().toLowerCase();
    this.rateLimiter.assertAllowed(context.ipAddress, email);

    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
    const passwordValid = await this.passwordService.verifyForLogin(
      user?.passwordHash ?? null,
      credentials.password,
    );

    if (user === null || !passwordValid || user.status !== UserStatus.ACTIVE) {
      this.rateLimiter.recordFailure(context.ipAddress, email);
      await this.auditService.record({
        ...context,
        eventType: AuthAuditEventType.LOGIN_FAILED,
        userId: user?.id,
        metadata: { reason: 'invalid_credentials' },
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    this.rateLimiter.resetCredential(context.ipAddress, email);
    const sessionId = randomUUID();
    const refreshToken = this.tokenService.generateRefreshToken(sessionId);
    const access = await this.tokenService.issueAccessToken(user.id, sessionId);
    const refreshExpiresAt = this.tokenService.getRefreshExpiration();

    await this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(AuthSession);
      await sessions.save(
        sessions.create({
          id: sessionId,
          userId: user.id,
          status: AuthSessionStatus.ACTIVE,
          expiresAt: refreshExpiresAt,
          lastUsedAt: null,
          revokedAt: null,
          revokeReason: null,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent?.slice(0, 512) ?? null,
        }),
      );
      const refreshTokens = manager.getRepository(AuthRefreshToken);
      await refreshTokens.save(
        refreshTokens.create({
          sessionId,
          tokenHash: this.tokenService.hashRefreshToken(refreshToken),
          status: AuthRefreshTokenStatus.ACTIVE,
          expiresAt: refreshExpiresAt,
          consumedAt: null,
          revokedAt: null,
          replacedByTokenId: null,
        }),
      );
      await this.auditService.record(
        {
          ...context,
          eventType: AuthAuditEventType.LOGIN_SUCCEEDED,
          userId: user.id,
          sessionId,
        },
        manager,
      );
    });

    return this.buildTokenResponse(access, refreshToken, user);
  }

  async refresh(
    refreshToken: string,
    context: AuthRequestContext,
  ): Promise<AuthTokenResponse> {
    const parts = this.tokenService.parseRefreshToken(refreshToken);
    if (parts === null) {
      await this.auditService.record({
        ...context,
        eventType: AuthAuditEventType.REFRESH_FAILED,
        metadata: { reason: 'invalid_format' },
      });
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    const result = await this.dataSource.transaction((manager) =>
      this.rotateRefreshToken(
        manager,
        parts.sessionId,
        this.tokenService.hashRefreshToken(refreshToken),
        context,
      ),
    );
    if (!result.ok) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
    return result.response;
  }

  async logout(
    currentUser: AuthenticatedUser,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const session = await manager
        .getRepository(AuthSession)
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session.id = :sessionId', {
          sessionId: currentUser.sessionId,
        })
        .andWhere('session.userId = :userId', { userId: currentUser.userId })
        .getOne();

      if (session !== null && session.status === AuthSessionStatus.ACTIVE) {
        this.revokeSession(session, 'logout');
        await manager.getRepository(AuthSession).save(session);
      }
      if (session !== null) {
        await this.revokeActiveRefreshTokens(manager, [session.id]);
      }
      await this.auditService.record(
        {
          ...context,
          eventType: AuthAuditEventType.LOGOUT,
          userId: currentUser.userId,
          sessionId: session?.id,
        },
        manager,
      );
    });
  }

  async logoutAll(
    currentUser: AuthenticatedUser,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const revokedAt = new Date();
      const sessions = await manager
        .getRepository(AuthSession)
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session.userId = :userId', { userId: currentUser.userId })
        .andWhere('session.status = :status', {
          status: AuthSessionStatus.ACTIVE,
        })
        .getMany();
      for (const session of sessions) {
        this.revokeSession(session, 'logout_all', revokedAt);
      }
      await manager.getRepository(AuthSession).save(sessions);
      await this.revokeActiveRefreshTokens(
        manager,
        sessions.map((session) => session.id),
        revokedAt,
      );
      await this.auditService.record(
        {
          ...context,
          eventType: AuthAuditEventType.LOGOUT_ALL,
          userId: currentUser.userId,
          sessionId: currentUser.sessionId,
          metadata: { revokedSessions: sessions.length },
        },
        manager,
      );
    });
  }

  async getMe(currentUser: AuthenticatedUser): Promise<PublicUser> {
    const user = await this.users.findOneBy({
      id: currentUser.userId,
      status: UserStatus.ACTIVE,
    });
    if (user === null) {
      throw new UnauthorizedException('Invalid access token.');
    }
    return this.toPublicUser(user);
  }

  private async rotateRefreshToken(
    manager: EntityManager,
    presentedSessionId: string,
    presentedTokenHash: string,
    context: AuthRequestContext,
  ): Promise<RefreshTransactionResult> {
    const refreshTokens = manager.getRepository(AuthRefreshToken);
    const refreshToken = await refreshTokens
      .createQueryBuilder('refreshToken')
      .addSelect('refreshToken.tokenHash')
      .innerJoinAndSelect('refreshToken.session', 'session')
      .innerJoinAndSelect('session.user', 'user')
      .setLock('pessimistic_write')
      .where('refreshToken.tokenHash = :presentedTokenHash', {
        presentedTokenHash,
      })
      .getOne();

    if (
      refreshToken === null ||
      refreshToken.sessionId !== presentedSessionId
    ) {
      await this.auditService.record(
        {
          ...context,
          eventType: AuthAuditEventType.REFRESH_FAILED,
          metadata: { reason: 'token_not_found' },
        },
        manager,
      );
      return { ok: false };
    }

    const now = new Date();
    const session = refreshToken.session;
    const sessions = manager.getRepository(AuthSession);

    if (refreshToken.status === AuthRefreshTokenStatus.CONSUMED) {
      if (session.status === AuthSessionStatus.ACTIVE) {
        this.revokeSession(session, 'refresh_reuse_detected', now);
        await sessions.save(session);
      }
      await this.revokeActiveRefreshTokens(manager, [session.id], now);
      await this.auditService.record(
        {
          ...context,
          eventType: AuthAuditEventType.REFRESH_REUSE_DETECTED,
          userId: session.userId,
          sessionId: session.id,
        },
        manager,
      );
      await this.recordRefreshFailure(
        manager,
        context,
        'reuse_detected',
        session,
      );
      return { ok: false };
    }

    if (refreshToken.status === AuthRefreshTokenStatus.REVOKED) {
      await this.recordRefreshFailure(
        manager,
        context,
        'token_revoked',
        session,
      );
      return { ok: false };
    }

    if (refreshToken.expiresAt.getTime() <= now.getTime()) {
      refreshToken.status = AuthRefreshTokenStatus.REVOKED;
      refreshToken.revokedAt = now;
      await refreshTokens.save(refreshToken);
      await this.recordRefreshFailure(
        manager,
        context,
        'token_expired',
        session,
      );
      return { ok: false };
    }

    if (
      session.status !== AuthSessionStatus.ACTIVE ||
      session.expiresAt.getTime() <= now.getTime() ||
      session.user.status !== UserStatus.ACTIVE
    ) {
      if (session.status === AuthSessionStatus.ACTIVE) {
        this.revokeSession(
          session,
          session.user.status !== UserStatus.ACTIVE
            ? 'user_inactive'
            : 'expired',
          now,
        );
        await sessions.save(session);
        await this.revokeActiveRefreshTokens(manager, [session.id], now);
      }
      await this.recordRefreshFailure(
        manager,
        context,
        'session_unavailable',
        session,
      );
      return { ok: false };
    }

    const nextRefreshToken = this.tokenService.generateRefreshToken(session.id);
    const nextRefreshTokenRecord = refreshTokens.create({
      id: randomUUID(),
      sessionId: session.id,
      tokenHash: this.tokenService.hashRefreshToken(nextRefreshToken),
      status: AuthRefreshTokenStatus.ACTIVE,
      expiresAt: session.expiresAt,
      consumedAt: null,
      revokedAt: null,
      replacedByTokenId: null,
    });
    const access = await this.tokenService.issueAccessToken(
      session.userId,
      session.id,
    );
    await refreshTokens.save(nextRefreshTokenRecord);
    refreshToken.status = AuthRefreshTokenStatus.CONSUMED;
    refreshToken.consumedAt = now;
    refreshToken.replacedByTokenId = nextRefreshTokenRecord.id;
    await refreshTokens.save(refreshToken);
    session.lastUsedAt = now;
    await sessions.save(session);
    await this.auditService.record(
      {
        ...context,
        eventType: AuthAuditEventType.REFRESH_SUCCEEDED,
        userId: session.userId,
        sessionId: session.id,
      },
      manager,
    );

    return {
      ok: true,
      response: this.buildTokenResponse(access, nextRefreshToken, session.user),
    };
  }

  private async recordRefreshFailure(
    manager: EntityManager,
    context: AuthRequestContext,
    reason: string,
    session?: AuthSession,
  ): Promise<void> {
    await this.auditService.record(
      {
        ...context,
        eventType: AuthAuditEventType.REFRESH_FAILED,
        userId: session?.userId,
        sessionId: session?.id,
        metadata: { reason },
      },
      manager,
    );
  }

  private async revokeActiveRefreshTokens(
    manager: EntityManager,
    sessionIds: string[],
    revokedAt = new Date(),
  ): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }
    await manager.getRepository(AuthRefreshToken).update(
      {
        sessionId: In(sessionIds),
        status: AuthRefreshTokenStatus.ACTIVE,
      },
      {
        status: AuthRefreshTokenStatus.REVOKED,
        revokedAt,
      },
    );
  }

  private revokeSession(
    session: AuthSession,
    reason: string,
    revokedAt = new Date(),
  ): void {
    session.status = AuthSessionStatus.REVOKED;
    session.revokedAt = revokedAt;
    session.revokeReason = reason;
  }

  private buildTokenResponse(
    access: { accessToken: string; expiresIn: number },
    refreshToken: string,
    user: User,
  ): AuthTokenResponse {
    return {
      accessToken: access.accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      user: this.toPublicUser(user),
    };
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
    };
  }
}
