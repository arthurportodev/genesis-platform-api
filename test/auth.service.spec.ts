import { DataSource, Repository } from 'typeorm';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { LoginRateLimiter } from '../src/modules/auth/services/login-rate-limiter.port';
import { PasswordService } from '../src/modules/auth/services/password.service';
import { TokenService } from '../src/modules/auth/services/token.service';
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
  const service = new AuthService(
    users,
    {} as DataSource,
    passwordService,
    {} as TokenService,
    auditService,
    rateLimiter,
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

  it('returns a sanitized current-user response', async () => {
    findOneBy.mockResolvedValueOnce({
      id: 'user-id',
      name: 'Test User',
      email: credentials.email,
      status: UserStatus.ACTIVE,
      passwordHash: 'must-not-leak',
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
