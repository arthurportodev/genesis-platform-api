import { DataSource, Repository } from 'typeorm';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { LoginRateLimiter } from '../src/modules/auth/services/login-rate-limiter.port';
import { PasswordService } from '../src/modules/auth/services/password.service';
import { TokenService } from '../src/modules/auth/services/token.service';
import { PublicAuthService } from '../src/modules/auth/services/public-auth.service';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';

describe('AuthService', () => {
  const getOne = jest.fn();
  const findOneBy = jest.fn();
  const queryBuilder = {
    addSelect: jest.fn(),
    where: jest.fn(),
    getOne,
  };
  queryBuilder.addSelect.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);

  const users = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    findOneBy,
  } as unknown as Repository<User>;
  const memberships = {} as Repository<never>;
  const verifyForLogin = jest.fn();
  const passwordService = { verifyForLogin } as unknown as PasswordService;
  const recordAudit = jest.fn().mockResolvedValue(undefined);
  const auditService = { record: recordAudit } as unknown as AuthAuditService;
  const assertAllowed = jest.fn();
  const recordFailure = jest.fn();
  const resetCredential = jest.fn();
  const rateLimiter = {
    assertAllowed,
    recordFailure,
    resetCredential,
  } as unknown as LoginRateLimiter;
  const continuationForLogin = jest.fn();
  const publicAuth = {
    continuationForLogin,
  } as unknown as PublicAuthService;
  const service = new AuthService(
    users,
    memberships,
    {} as DataSource,
    passwordService,
    {} as TokenService,
    auditService,
    rateLimiter,
    publicAuth,
  );
  const context = { ipAddress: '127.0.0.1', userAgent: 'test-agent' };
  const credentials = { email: 'user@example.com', password: 'not-disclosed' };

  beforeEach(() => jest.clearAllMocks());

  it('returns the same generic error for an unknown user and wrong password', async () => {
    getOne.mockResolvedValueOnce(null);
    verifyForLogin.mockResolvedValueOnce(false);
    await expect(service.login(credentials, context)).rejects.toThrow(
      'Invalid email or password.',
    );

    getOne.mockResolvedValueOnce({
      id: 'user-id',
      email: credentials.email,
      passwordHash: 'encoded-hash',
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    });
    verifyForLogin.mockResolvedValueOnce(false);
    await expect(service.login(credentials, context)).rejects.toThrow(
      'Invalid email or password.',
    );

    expect(recordFailure).toHaveBeenCalledTimes(2);
    expect(assertAllowed).toHaveBeenCalledWith(
      context.ipAddress,
      credentials.email,
    );
    expect(recordFailure).toHaveBeenCalledWith(
      context.ipAddress,
      credentials.email,
    );
    expect(recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ ipAddress: context.ipAddress }),
    );
  });

  it('rejects an inactive user with the generic credential error', async () => {
    getOne.mockResolvedValueOnce({
      id: 'user-id',
      email: credentials.email,
      passwordHash: 'encoded-hash',
      status: UserStatus.INACTIVE,
    });
    verifyForLogin.mockResolvedValueOnce(true);

    await expect(service.login(credentials, context)).rejects.toThrow(
      'Invalid email or password.',
    );
  });

  it('returns a structured continuation for a correct unverified credential', async () => {
    const continuation = {
      challengeId: '10000000-0000-4000-8000-000000000001',
      expiresAt: new Date('2030-01-01T00:10:00.000Z'),
      resendAvailableAt: new Date('2030-01-01T00:01:00.000Z'),
    };
    getOne.mockResolvedValueOnce({
      id: '10000000-0000-4000-8000-000000000002',
      email: credentials.email,
      passwordHash: 'encoded-hash',
      status: UserStatus.ACTIVE,
      emailVerifiedAt: null,
    });
    verifyForLogin.mockResolvedValueOnce(true);
    continuationForLogin.mockResolvedValueOnce(continuation);

    await expect(service.login(credentials, context)).rejects.toMatchObject({
      response: {
        statusCode: 403,
        code: 'EMAIL_VERIFICATION_REQUIRED',
        continuation,
      },
    });
    expect(resetCredential).toHaveBeenCalledWith(
      context.ipAddress,
      credentials.email,
    );
  });

  it('returns a sanitized current-user response', async () => {
    findOneBy.mockResolvedValueOnce({
      id: 'user-id',
      name: 'Test User',
      email: credentials.email,
      status: UserStatus.ACTIVE,
      passwordHash: 'must-not-leak',
      emailVerifiedAt: new Date(),
    });

    await expect(
      service.getMe({ userId: 'user-id', sessionId: 'session-id' }),
    ).resolves.toEqual({
      id: 'user-id',
      name: 'Test User',
      email: credentials.email,
      status: UserStatus.ACTIVE,
    });
  });
});
