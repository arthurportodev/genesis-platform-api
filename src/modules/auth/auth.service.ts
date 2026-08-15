import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { normalizeEmail } from '../../common/normalization/email.normalizer';
import { AuthRefreshToken } from '../auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../auth-sessions/entities/auth-session.entity';
import { AuthAuditEventType } from '../auth-sessions/enums/auth-audit-event-type.enum';
import { AuthRefreshTokenStatus } from '../auth-sessions/enums/auth-refresh-token-status.enum';
import { AuthSessionStatus } from '../auth-sessions/enums/auth-session-status.enum';
import {
  PASSWORD_LOGIN_VERIFIER,
  PasswordLoginVerifier,
} from '../credentials/ports/password-login-verifier.port';
import { User } from '../users/entities/user.entity';
import { UserStatus } from '../users/enums/user-status.enum';
import { Membership } from '../memberships/entities/membership.entity';
import { MembershipRole } from '../memberships/enums/membership-role.enum';
import { MembershipStatus } from '../memberships/enums/membership-status.enum';
import { OrganizationStatus } from '../organizations/enums/organization-status.enum';
import { LoginDto } from './dto/login.dto';
import { AuthAuditService } from './services/auth-audit.service';
import { LoginRateLimiter } from './services/login-rate-limiter.port';
import { TokenService } from './services/token.service';
import {
  AuthenticatedUser,
  AuthRequestContext,
  PublicUser,
} from './types/authenticated-user.type';

export interface AuthTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: PublicUser;
}

interface AuthOperationResult {
  response: AuthTokenResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface BootstrapOrganization {
  id: string;
  name: string;
  slug: string;
  membershipId: string;
  role: MembershipRole;
}

export interface AuthBootstrapResponse {
  user: PublicUser;
  organizations: BootstrapOrganization[];
}

type RefreshTransactionResult =
  { ok: true; result: AuthOperationResult } | { ok: false };

interface RefreshLockTarget {
  refreshTokenId: string;
  sessionId: string;
  userId: string;
}

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';
const INVALID_REFRESH_MESSAGE = 'Invalid refresh token.';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Membership)
    private readonly memberships: Repository<Membership>,
    private readonly dataSource: DataSource,
    @Inject(PASSWORD_LOGIN_VERIFIER)
    private readonly passwordService: PasswordLoginVerifier,
    private readonly tokenService: TokenService,
    private readonly auditService: AuthAuditService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  async login(
    credentials: LoginDto,
    context: AuthRequestContext,
  ): Promise<AuthOperationResult> {
    const email = normalizeEmail(credentials.email);
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

    const operation = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT app_private.lock_auth_refresh_user($1::uuid)`,
        [user.id],
      );
      const lockedUser = await manager.getRepository(User).findOneBy({
        id: user.id,
        status: UserStatus.ACTIVE,
      });
      if (lockedUser === null) return null;

      const sessionId = randomUUID();
      const refreshToken = this.tokenService.generateRefreshToken(sessionId);
      const access = await this.tokenService.issueAccessToken(
        lockedUser.id,
        sessionId,
      );
      const refreshExpiresAt = this.tokenService.getRefreshExpiration();
      const sessions = manager.getRepository(AuthSession);
      await sessions.save(
        sessions.create({
          id: sessionId,
          userId: lockedUser.id,
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
          userId: lockedUser.id,
          sessionId,
        },
        manager,
      );
      return {
        response: this.buildTokenResponse(access, lockedUser),
        refreshToken,
        refreshExpiresAt,
      };
    });

    if (operation === null) {
      this.rateLimiter.recordFailure(context.ipAddress, email);
      await this.auditService.record({
        ...context,
        eventType: AuthAuditEventType.LOGIN_FAILED,
        userId: user.id,
        metadata: { reason: 'invalid_credentials' },
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }
    this.rateLimiter.resetCredential(context.ipAddress, email);
    return operation;
  }

  async refresh(
    refreshToken: string | null,
    context: AuthRequestContext,
  ): Promise<AuthOperationResult> {
    if (refreshToken === null) {
      await this.auditService.record({
        ...context,
        eventType: AuthAuditEventType.REFRESH_FAILED,
        metadata: { reason: 'missing_cookie' },
      });
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
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
    return result.result;
  }

  async logout(
    refreshToken: string | null,
    context: AuthRequestContext,
  ): Promise<void> {
    if (refreshToken === null) {
      return;
    }
    const parts = this.tokenService.parseRefreshToken(refreshToken);
    if (parts === null) {
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const presentedTokenHash =
        this.tokenService.hashRefreshToken(refreshToken);
      const lockTarget = await manager
        .getRepository(AuthRefreshToken)
        .createQueryBuilder('refreshToken')
        .select('refreshToken.id', 'refreshTokenId')
        .addSelect('refreshToken.sessionId', 'sessionId')
        .addSelect('session.userId', 'userId')
        .innerJoin('refreshToken.session', 'session')
        .where('refreshToken.tokenHash = :presentedTokenHash', {
          presentedTokenHash,
        })
        .andWhere('refreshToken.sessionId = :presentedSessionId', {
          presentedSessionId: parts.sessionId,
        })
        .getRawOne<RefreshLockTarget>();

      if (lockTarget === undefined) {
        return;
      }

      await this.lockRefreshTarget(manager, lockTarget);
      const refreshTokenRecord = await manager
        .getRepository(AuthRefreshToken)
        .createQueryBuilder('refreshToken')
        .addSelect('refreshToken.tokenHash')
        .innerJoinAndSelect('refreshToken.session', 'session')
        .where('refreshToken.id = :refreshTokenId', {
          refreshTokenId: lockTarget.refreshTokenId,
        })
        .andWhere('refreshToken.tokenHash = :presentedTokenHash', {
          presentedTokenHash,
        })
        .andWhere('refreshToken.sessionId = :presentedSessionId', {
          presentedSessionId: parts.sessionId,
        })
        .getOne();

      if (refreshTokenRecord === null) {
        return;
      }

      const session = refreshTokenRecord.session;

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
          userId: session.userId,
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

  async getBootstrap(
    currentUser: AuthenticatedUser,
  ): Promise<AuthBootstrapResponse> {
    const user = await this.users.findOneBy({
      id: currentUser.userId,
      status: UserStatus.ACTIVE,
    });
    if (user === null) {
      throw new UnauthorizedException('Invalid access token.');
    }

    const memberships = await this.memberships
      .createQueryBuilder('membership')
      .innerJoinAndSelect('membership.organization', 'organization')
      .where('membership.userId = :userId', { userId: currentUser.userId })
      .andWhere('membership.status = :membershipStatus', {
        membershipStatus: MembershipStatus.ACTIVE,
      })
      .andWhere('organization.status = :organizationStatus', {
        organizationStatus: OrganizationStatus.ACTIVE,
      })
      .orderBy('organization.slug', 'ASC')
      .addOrderBy('organization.id', 'ASC')
      .getMany();

    return {
      user: this.toPublicUser(user),
      organizations: memberships.map((membership) => ({
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        membershipId: membership.id,
        role: membership.role,
      })),
    };
  }

  private async rotateRefreshToken(
    manager: EntityManager,
    presentedSessionId: string,
    presentedTokenHash: string,
    context: AuthRequestContext,
  ): Promise<RefreshTransactionResult> {
    const refreshTokens = manager.getRepository(AuthRefreshToken);
    const lockTarget = await refreshTokens
      .createQueryBuilder('refreshToken')
      .select('refreshToken.id', 'refreshTokenId')
      .addSelect('refreshToken.sessionId', 'sessionId')
      .addSelect('session.userId', 'userId')
      .innerJoin('refreshToken.session', 'session')
      .where('refreshToken.tokenHash = :presentedTokenHash', {
        presentedTokenHash,
      })
      .andWhere('refreshToken.sessionId = :presentedSessionId', {
        presentedSessionId,
      })
      .getRawOne<RefreshLockTarget>();

    if (lockTarget === undefined) {
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

    await this.lockRefreshTarget(manager, lockTarget);

    const refreshToken = await refreshTokens
      .createQueryBuilder('refreshToken')
      .addSelect('refreshToken.tokenHash')
      .innerJoinAndSelect('refreshToken.session', 'session')
      .innerJoinAndSelect('session.user', 'user')
      .where('refreshToken.id = :refreshTokenId', {
        refreshTokenId: lockTarget.refreshTokenId,
      })
      .andWhere('refreshToken.tokenHash = :presentedTokenHash', {
        presentedTokenHash,
      })
      .andWhere('refreshToken.sessionId = :presentedSessionId', {
        presentedSessionId,
      })
      .andWhere('session.userId = :userId', { userId: lockTarget.userId })
      .getOne();

    if (refreshToken === null) {
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
      result: {
        response: this.buildTokenResponse(access, session.user),
        refreshToken: nextRefreshToken,
        refreshExpiresAt: session.expiresAt,
      },
    };
  }

  private async lockRefreshTarget(
    manager: EntityManager,
    lockTarget: RefreshLockTarget,
  ): Promise<void> {
    await manager.query(`SELECT app_private.lock_auth_refresh_user($1::uuid)`, [
      lockTarget.userId,
    ]);
    await manager.query(
      `SELECT auth_session.id
       FROM public.auth_sessions AS auth_session
       WHERE auth_session.id = $1::uuid
       FOR UPDATE OF auth_session`,
      [lockTarget.sessionId],
    );
    await manager.query(
      `SELECT locked_refresh_token.id
       FROM public.auth_refresh_tokens AS locked_refresh_token
       WHERE locked_refresh_token.id = $1::uuid
       FOR UPDATE OF locked_refresh_token`,
      [lockTarget.refreshTokenId],
    );
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
    user: User,
  ): AuthTokenResponse {
    return {
      accessToken: access.accessToken,
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
