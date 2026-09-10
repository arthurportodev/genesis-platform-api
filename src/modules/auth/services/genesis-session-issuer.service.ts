import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { AuthRefreshToken } from '../../auth-sessions/entities/auth-refresh-token.entity';
import { AuthSession } from '../../auth-sessions/entities/auth-session.entity';
import { AuthAuditEventType } from '../../auth-sessions/enums/auth-audit-event-type.enum';
import { AuthRefreshTokenStatus } from '../../auth-sessions/enums/auth-refresh-token-status.enum';
import { AuthSessionStatus } from '../../auth-sessions/enums/auth-session-status.enum';
import { User } from '../../users/entities/user.entity';
import type { AuthTokenResponse } from '../auth.service';
import { AuthRequestContext } from '../types/authenticated-user.type';
import { AuthAuditService } from './auth-audit.service';
import { TokenService } from './token.service';

export interface AuthOperationResult {
  response: AuthTokenResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class GenesisSessionIssuer {
  constructor(
    private readonly tokenService: TokenService,
    private readonly auditService: AuthAuditService,
  ) {}

  async issue(
    manager: EntityManager,
    user: User,
    context: AuthRequestContext,
    method: 'password' | 'google',
  ): Promise<AuthOperationResult> {
    const sessionId = randomUUID();
    const refreshToken = this.tokenService.generateRefreshToken(sessionId);
    const access = await this.tokenService.issueAccessToken(user.id, sessionId);
    const refreshExpiresAt = this.tokenService.getRefreshExpiration();
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
        metadata: { method },
      },
      manager,
    );
    return {
      response: {
        accessToken: access.accessToken,
        tokenType: 'Bearer',
        expiresIn: access.expiresIn,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          status: user.status,
        },
      },
      refreshToken,
      refreshExpiresAt,
    };
  }
}
