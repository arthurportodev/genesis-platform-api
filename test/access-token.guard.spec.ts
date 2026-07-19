import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import {
  AccessTokenAuthenticator,
  AccessTokenGuard,
} from '../src/modules/auth/guards/access-token.guard';
import { AuthenticatedRequest } from '../src/modules/auth/types/auth-request.type';
import { AuthenticatedUser } from '../src/modules/auth/types/authenticated-user.type';

describe('AccessTokenGuard', () => {
  const authenticatedUser: AuthenticatedUser = {
    userId: 'user-id',
    sessionId: 'session-id',
  };
  const request: Pick<AuthenticatedRequest, 'headers' | 'user'> = {
    headers: { authorization: 'Bearer signed-token' },
    user: authenticatedUser,
  };
  const executionContext = new ExecutionContextHost([request]);
  const authenticate = jest.fn<
    ReturnType<AccessTokenAuthenticator['authenticate']>,
    Parameters<AccessTokenAuthenticator['authenticate']>
  >();
  const authenticator: jest.Mocked<AccessTokenAuthenticator> = {
    authenticate,
  };
  const guard = new AccessTokenGuard(authenticator);

  beforeEach(() => {
    jest.clearAllMocks();
    request.headers = { authorization: 'Bearer signed-token' };
    request.user = authenticatedUser;
  });

  it.each([
    ['missing', undefined],
    ['without a bearer scheme', 'signed-token'],
    ['using a different scheme', 'Basic signed-token'],
    ['without a token', 'Bearer'],
    ['containing extra content', 'Bearer signed-token extra'],
  ])('rejects an authorization header %s', async (_case, authorization) => {
    request.headers.authorization = authorization;

    await expect(guard.canActivate(executionContext)).rejects.toThrow(
      new UnauthorizedException('Invalid access token.'),
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('passes the exact bearer token to the authenticator', async () => {
    authenticate.mockResolvedValueOnce(authenticatedUser);

    await guard.canActivate(executionContext);

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith('signed-token');
  });

  it('propagates the generic authentication failure', async () => {
    const authenticationError = new UnauthorizedException(
      'Invalid access token.',
    );
    authenticate.mockRejectedValueOnce(authenticationError);

    await expect(guard.canActivate(executionContext)).rejects.toBe(
      authenticationError,
    );
    expect(authenticate).toHaveBeenCalledWith('signed-token');
  });

  it('attaches only the authenticated identity and returns true', async () => {
    authenticate.mockResolvedValueOnce(authenticatedUser);

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);

    expect(request.user).toEqual({
      userId: 'user-id',
      sessionId: 'session-id',
    });
    expect(request.user).not.toHaveProperty('organizationId');
    expect(request.user).not.toHaveProperty('membershipId');
    expect(request.user).not.toHaveProperty('role');
    expect(request.user).not.toHaveProperty('permissions');
  });
});
