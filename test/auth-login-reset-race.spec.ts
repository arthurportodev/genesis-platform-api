import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { LoginRateLimiter } from '../src/modules/auth/services/login-rate-limiter.port';
import { PublicAuthService } from '../src/modules/auth/services/public-auth.service';
import { TokenService } from '../src/modules/auth/services/token.service';
import { PasswordLoginVerifier } from '../src/modules/credentials/ports/password-login-verifier.port';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/enums/user-status.enum';

describe('login versus password-reset credential race', () => {
  it('does not create a session when the hash changes while login waits for the user lock', async () => {
    const beforeLock = {
      id: '10000000-0000-4000-8000-000000000001',
      email: 'user@example.test',
      passwordHash: '$argon2id$old',
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    } as User;
    const afterLock = {
      ...beforeLock,
      passwordHash: '$argon2id$new',
    } as User;
    const beforeBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(beforeLock),
    };
    const addSelect = jest.fn().mockReturnThis();
    const afterBuilder = {
      addSelect,
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(afterLock),
    };
    const users = {
      createQueryBuilder: jest.fn().mockReturnValue(beforeBuilder),
    } as unknown as Repository<User>;
    const managerQuery = jest.fn().mockResolvedValue([]);
    const manager = {
      query: managerQuery,
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(afterBuilder),
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        (operation: (target: EntityManager) => Promise<unknown>) =>
          operation(manager),
      ),
    } as unknown as DataSource;
    const generateRefreshToken = jest.fn();
    const issueAccessToken = jest.fn();
    const tokenService = {
      generateRefreshToken,
      issueAccessToken,
    } as unknown as TokenService;
    const rateLimiter = {
      assertAllowed: jest.fn(),
      recordFailure: jest.fn(),
      resetCredential: jest.fn(),
    } as unknown as LoginRateLimiter;
    const audit = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuthAuditService;
    const verifier = {
      verifyForLogin: jest.fn().mockResolvedValue(true),
    } as unknown as PasswordLoginVerifier;
    const service = new AuthService(
      users,
      {} as Repository<never>,
      dataSource,
      verifier,
      tokenService,
      audit,
      rateLimiter,
      {} as PublicAuthService,
    );

    await expect(
      service.login(
        { email: beforeLock.email, password: 'old-password' },
        { ipAddress: '127.0.0.1', userAgent: 'test' },
      ),
    ).rejects.toThrow('Invalid email or password.');
    expect(managerQuery).toHaveBeenCalledWith(
      expect.stringContaining('lock_auth_refresh_user'),
      [beforeLock.id],
    );
    expect(addSelect).toHaveBeenCalledWith('user.passwordHash');
    expect(generateRefreshToken).not.toHaveBeenCalled();
    expect(issueAccessToken).not.toHaveBeenCalled();
  });
});
