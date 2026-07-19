import { ExecutionContext } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuthSession } from '../src/modules/auth-sessions/entities/auth-session.entity';
import { AuthSessionStatus } from '../src/modules/auth-sessions/enums/auth-session-status.enum';
import { AccessTokenGuard } from '../src/modules/auth/guards/access-token.guard';
import { TokenService } from '../src/modules/auth/services/token.service';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';

describe('AccessTokenGuard', () => {
  const request: { headers: { authorization?: string }; user?: unknown } = {
    headers: { authorization: 'Bearer signed-token' },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const getOne = jest.fn();
  const queryBuilder = {
    innerJoinAndSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getOne,
  };
  queryBuilder.innerJoinAndSelect.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  const sessions = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  } as unknown as Repository<AuthSession>;
  const tokenService = {
    verifyAccessToken: jest.fn().mockResolvedValue({
      sub: 'user-id',
      sessionId: 'session-id',
      type: 'access',
    }),
  } as unknown as TokenService;
  const guard = new AccessTokenGuard(tokenService, sessions);

  beforeEach(() => {
    jest.clearAllMocks();
    request.headers.authorization = 'Bearer signed-token';
    delete request.user;
  });

  it('attaches typed user and session identifiers for an active session', async () => {
    getOne.mockResolvedValueOnce({
      status: AuthSessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 60_000),
      user: { status: UserStatus.ACTIVE },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      userId: 'user-id',
      sessionId: 'session-id',
    });
  });

  it.each([
    {
      status: AuthSessionStatus.REVOKED,
      expiresAt: new Date(Date.now() + 60_000),
      user: { status: UserStatus.ACTIVE },
    },
    {
      status: AuthSessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() - 60_000),
      user: { status: UserStatus.ACTIVE },
    },
    {
      status: AuthSessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 60_000),
      user: { status: UserStatus.INACTIVE },
    },
  ])('rejects unavailable sessions', async (session) => {
    getOne.mockResolvedValueOnce(session);
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Invalid access token.',
    );
  });
});
