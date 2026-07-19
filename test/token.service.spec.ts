import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthConfig } from '../src/config/auth.config';
import { TokenService } from '../src/modules/auth/services/token.service';

describe('TokenService', () => {
  const config: AuthConfig = {
    accessTokenSecret: randomBytes(48).toString('base64url'),
    accessTokenExpiresInSeconds: 900,
    refreshTokenExpiresInDays: 30,
    refreshTokenPepper: randomBytes(48).toString('base64url'),
    loginMaxAttempts: 5,
    loginWindowSeconds: 900,
  };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(config),
  } as unknown as ConfigService;
  const jwtService = new JwtService();
  const service = new TokenService(jwtService, configService);

  it('issues a short-lived access JWT with only user and session context', async () => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const result = await service.issueAccessToken(userId, sessionId);
    const payload = await service.verifyAccessToken(result.accessToken);

    expect(result.expiresIn).toBe(900);
    expect(payload).toMatchObject({ sub: userId, sessionId, type: 'access' });
    expect(payload.exp).toBeGreaterThan(payload.iat ?? 0);
    expect(payload).not.toHaveProperty('organizationId');
    expect(payload).not.toHaveProperty('role');
    expect(payload).not.toHaveProperty('membershipId');
  });

  it('creates opaque refresh tokens and compares their HMAC safely', () => {
    const sessionId = randomUUID();
    const token = service.generateRefreshToken(sessionId);
    const parts = service.parseRefreshToken(token);
    const hash = service.hashRefreshToken(token);

    expect(parts).toMatchObject({ sessionId });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(service.hashRefreshToken(token)).toBe(hash);
    expect(service.hashRefreshToken(`${token}x`)).not.toBe(hash);
  });

  it('rejects an access token with a non-access type', async () => {
    const token = await jwtService.signAsync(
      { sub: randomUUID(), sessionId: randomUUID(), type: 'refresh' },
      { secret: config.accessTokenSecret, algorithm: 'HS256', expiresIn: 60 },
    );
    await expect(service.verifyAccessToken(token)).rejects.toThrow(
      'Invalid access token.',
    );
  });
});
