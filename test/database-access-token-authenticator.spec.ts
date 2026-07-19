import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { AuthConfig } from '../src/config/auth.config';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthSessionStatus } from '../src/modules/auth-sessions/enums/auth-session-status.enum';
import { DatabaseAccessTokenAuthenticator } from '../src/modules/auth/guards/access-token.guard';
import { TokenService } from '../src/modules/auth/services/token.service';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';

describe('DatabaseAccessTokenAuthenticator', () => {
  const authConfig: AuthConfig = {
    accessTokenSecret: randomBytes(48).toString('base64url'),
    accessTokenExpiresInSeconds: 900,
    refreshTokenExpiresInDays: 30,
    refreshTokenPepper: randomBytes(48).toString('base64url'),
    loginMaxAttempts: 5,
    loginIpMaxAttempts: 25,
    loginMaxBuckets: 10_000,
    loginWindowSeconds: 900,
  };
  const jwtService = new JwtService();
  const tokenService = new TokenService(
    jwtService,
    new ConfigService({ auth: authConfig }),
  );
  const dataSource = new DataSource({ type: 'postgres' });
  const sessions = new Repository(AuthSession, dataSource.manager);
  const queryBuilder = new SelectQueryBuilder<AuthSession>(dataSource);
  const createQueryBuilder = jest
    .spyOn(sessions, 'createQueryBuilder')
    .mockReturnValue(queryBuilder);
  const innerJoinAndSelect = jest
    .spyOn(queryBuilder, 'innerJoinAndSelect')
    .mockReturnValue(queryBuilder);
  const where = jest.spyOn(queryBuilder, 'where').mockReturnValue(queryBuilder);
  const andWhere = jest
    .spyOn(queryBuilder, 'andWhere')
    .mockReturnValue(queryBuilder);
  const getOne = jest.spyOn(queryBuilder, 'getOne');
  const authenticator = new DatabaseAccessTokenAuthenticator(
    tokenService,
    sessions,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects an invalid token before querying the session', async () => {
    await expect(authenticator.authenticate('invalid-token')).rejects.toThrow(
      'Invalid access token.',
    );
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects a token whose type is not access before querying the session', async () => {
    const token = await jwtService.signAsync(
      { sub: randomUUID(), sessionId: randomUUID(), type: 'refresh' },
      {
        secret: authConfig.accessTokenSecret,
        algorithm: 'HS256',
        expiresIn: 60,
      },
    );

    await expect(authenticator.authenticate(token)).rejects.toThrow(
      'Invalid access token.',
    );
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects when the session or its joined user does not exist', async () => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const token = await issueAccessToken(userId, sessionId);
    getOne.mockResolvedValueOnce(null);

    await expect(authenticator.authenticate(token)).rejects.toThrow(
      'Invalid access token.',
    );

    expect(createQueryBuilder).toHaveBeenCalledWith('session');
    expect(innerJoinAndSelect).toHaveBeenCalledWith('session.user', 'user');
    expect(where).toHaveBeenCalledWith('session.id = :sessionId', {
      sessionId,
    });
    expect(andWhere).toHaveBeenCalledWith('session.userId = :userId', {
      userId,
    });
  });

  it.each([
    ['revoked session', AuthSessionStatus.REVOKED, 60_000, UserStatus.ACTIVE],
    ['expired session', AuthSessionStatus.ACTIVE, -60_000, UserStatus.ACTIVE],
    ['inactive user', AuthSessionStatus.ACTIVE, 60_000, UserStatus.INACTIVE],
  ])(
    'rejects an unavailable identity caused by %s',
    async (_case, status, expirationOffset, userStatus) => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      const token = await issueAccessToken(userId, sessionId);
      getOne.mockResolvedValueOnce(
        createSession(status, expirationOffset, userStatus),
      );

      await expect(authenticator.authenticate(token)).rejects.toThrow(
        'Invalid access token.',
      );
    },
  );

  it('returns only validated user and session identifiers', async () => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const token = await issueAccessToken(userId, sessionId);
    getOne.mockResolvedValueOnce(
      createSession(AuthSessionStatus.ACTIVE, 60_000, UserStatus.ACTIVE),
    );

    const result = await authenticator.authenticate(token);

    expect(result).toEqual({ userId, sessionId });
    expect(Object.keys(result).sort()).toEqual(['sessionId', 'userId']);
    expect(where).toHaveBeenCalledWith('session.id = :sessionId', {
      sessionId,
    });
    expect(andWhere).toHaveBeenCalledWith('session.userId = :userId', {
      userId,
    });
  });

  async function issueAccessToken(
    userId: string,
    sessionId: string,
  ): Promise<string> {
    return (await tokenService.issueAccessToken(userId, sessionId)).accessToken;
  }

  function createSession(
    status: AuthSessionStatus,
    expirationOffset: number,
    userStatus: UserStatus,
  ): AuthSession {
    const user = new User();
    user.status = userStatus;
    const session = new AuthSession();
    session.status = status;
    session.expiresAt = new Date(Date.now() + expirationOffset);
    session.user = user;
    return session;
  }
});
