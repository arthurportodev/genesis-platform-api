import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthSession } from '../../auth-sessions/entities/auth-session.entity';
import { AuthSessionStatus } from '../../auth-sessions/enums/auth-session-status.enum';
import { UserStatus } from '../../users/enums/user-status.enum';
import { TokenService } from '../services/token.service';
import { AuthenticatedRequest } from '../types/auth-request.type';
import { AuthenticatedUser } from '../types/authenticated-user.type';

export const ACCESS_TOKEN_AUTHENTICATOR = Symbol('ACCESS_TOKEN_AUTHENTICATOR');

export interface AccessTokenAuthenticator {
  authenticate(token: string): Promise<AuthenticatedUser>;
}

@Injectable()
export class DatabaseAccessTokenAuthenticator implements AccessTokenAuthenticator {
  constructor(
    private readonly tokenService: TokenService,
    @InjectRepository(AuthSession)
    private readonly sessions: Repository<AuthSession>,
  ) {}

  async authenticate(token: string): Promise<AuthenticatedUser> {
    const payload = await this.tokenService.verifyAccessToken(token);
    const session = await this.sessions
      .createQueryBuilder('session')
      .innerJoinAndSelect('session.user', 'user')
      .where('session.id = :sessionId', { sessionId: payload.sessionId })
      .andWhere('session.userId = :userId', { userId: payload.sub })
      .getOne();

    if (
      session === null ||
      session.status !== AuthSessionStatus.ACTIVE ||
      session.expiresAt.getTime() <= Date.now() ||
      session.user.status !== UserStatus.ACTIVE
    ) {
      throw new UnauthorizedException('Invalid access token.');
    }

    return { userId: payload.sub, sessionId: payload.sessionId };
  }
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_TOKEN_AUTHENTICATOR)
    private readonly authenticator: AccessTokenAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);
    request.user = await this.authenticator.authenticate(token);
    return true;
  }

  private extractBearerToken(authorization: string | undefined): string {
    if (authorization === undefined) {
      throw new UnauthorizedException('Invalid access token.');
    }
    const [scheme, token, extra] = authorization.split(' ');
    if (scheme !== 'Bearer' || token === undefined || extra !== undefined) {
      throw new UnauthorizedException('Invalid access token.');
    }
    return token;
  }
}
