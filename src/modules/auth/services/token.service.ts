import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes } from 'node:crypto';
import { AuthConfig } from '../../../config/auth.config';

export interface AccessTokenPayload {
  sub: string;
  sessionId: string;
  type: 'access';
  iat?: number;
  exp?: number;
}

export interface AccessTokenResult {
  accessToken: string;
  expiresIn: number;
}

export interface RefreshTokenParts {
  sessionId: string;
  secret: string;
}

const REFRESH_TOKEN_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

@Injectable()
export class TokenService {
  private readonly config: AuthConfig;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AuthConfig>('auth');
  }

  async issueAccessToken(
    userId: string,
    sessionId: string,
  ): Promise<AccessTokenResult> {
    const payload: AccessTokenPayload = {
      sub: userId,
      sessionId,
      type: 'access',
    };
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.accessTokenSecret,
      algorithm: 'HS256',
      expiresIn: this.config.accessTokenExpiresInSeconds,
    });

    return {
      accessToken,
      expiresIn: this.config.accessTokenExpiresInSeconds,
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    let payload: unknown;
    try {
      payload = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        {
          secret: this.config.accessTokenSecret,
          algorithms: ['HS256'],
        },
      );
    } catch {
      throw new UnauthorizedException('Invalid access token.');
    }

    if (!this.isAccessTokenPayload(payload)) {
      throw new UnauthorizedException('Invalid access token.');
    }
    return payload;
  }

  generateRefreshToken(sessionId: string): string {
    return `${sessionId}.${randomBytes(32).toString('base64url')}`;
  }

  parseRefreshToken(token: string): RefreshTokenParts | null {
    const match = REFRESH_TOKEN_PATTERN.exec(token);
    if (match === null) {
      return null;
    }
    return { sessionId: match[1], secret: match[2] };
  }

  hashRefreshToken(token: string): string {
    return createHmac('sha256', this.config.refreshTokenPepper)
      .update(token, 'utf8')
      .digest('hex');
  }

  getRefreshExpiration(from = new Date()): Date {
    return new Date(
      from.getTime() + this.config.refreshTokenExpiresInDays * 86_400_000,
    );
  }

  private isAccessTokenPayload(value: unknown): value is AccessTokenPayload {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.sub === 'string' &&
      typeof candidate.sessionId === 'string' &&
      candidate.type === 'access'
    );
  }
}
