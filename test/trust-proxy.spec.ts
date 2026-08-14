import {
  Controller,
  Get,
  INestApplication,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import { Server } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureTrustProxy } from '../src/config/trust-proxy';
import { AuthAuditLog } from '../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthAuditEventType } from '../src/modules/auth-sessions/enums/auth-audit-event-type.enum';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { AccessTokenGuard } from '../src/modules/auth/guards/access-token.guard';
import { CsrfGuard } from '../src/modules/auth/guards/csrf.guard';
import { AuthAuditService } from '../src/modules/auth/services/auth-audit.service';
import { InMemoryLoginRateLimiter } from '../src/modules/auth/services/in-memory-login-rate-limiter.service';
import { LoginRateLimiter } from '../src/modules/auth/services/login-rate-limiter.port';
import { TokenService } from '../src/modules/auth/services/token.service';
import { WebSessionService } from '../src/modules/auth/services/web-session.service';
import { PASSWORD_LOGIN_VERIFIER } from '../src/modules/credentials/ports/password-login-verifier.port';
import { Membership } from '../src/modules/memberships/entities/membership.entity';
import { User } from '../src/modules/users/entities/user.entity';

@Controller()
class ClientIpController {
  @Get('client-ip')
  getClientIp(@Req() incomingRequest: Request): { ip: string | undefined } {
    return { ip: incomingRequest.ip };
  }
}

interface AuthHarness {
  app: INestApplication;
  auditRepository: {
    create: jest.Mock;
    save: jest.Mock;
  };
  auditService: AuthAuditService;
  rateLimiter: LoginRateLimiter;
}

describe('Trust proxy configuration', () => {
  jest.setTimeout(15_000);

  it('does not trust a spoofed X-Forwarded-For header by default', async () => {
    const app = await createClientIpApp(0);
    try {
      const response = await request(app.getHttpServer())
        .get('/client-ip')
        .set('X-Forwarded-For', '203.0.113.10')
        .expect(200);

      expect(response.body).not.toEqual({ ip: '203.0.113.10' });
    } finally {
      await app.close();
    }
  });

  it('uses the forwarded client address behind one trusted proxy hop', async () => {
    const app = await createClientIpApp(1);
    try {
      const response = await request(app.getHttpServer())
        .get('/client-ip')
        .set('X-Forwarded-For', '203.0.113.11')
        .expect(200);

      expect(response.body).toEqual({ ip: '203.0.113.11' });
    } finally {
      await app.close();
    }
  });

  it('sends only the nearest trusted address to the real login limiter and audit service', async () => {
    const harness = await createAuthHarness(1);
    const assertAllowed = jest.spyOn(harness.rateLimiter, 'assertAllowed');
    const recordFailure = jest.spyOn(harness.rateLimiter, 'recordFailure');
    const recordAudit = jest.spyOn(harness.auditService, 'record');
    const forgedAddress = '198.51.100.240';
    const legitimateAddress = '203.0.113.25';
    const email = 'proxy-consumers@example.com';
    const userAgent = 'trust-proxy-consumers-hops-1';

    try {
      await request(harness.app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `${forgedAddress}, ${legitimateAddress}`)
        .set('User-Agent', userAgent)
        .send({ email, password: 'invalid-password-123' })
        .expect(401);

      expect(assertAllowed).toHaveBeenCalledWith(legitimateAddress, email);
      expect(recordFailure).toHaveBeenCalledWith(legitimateAddress, email);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuthAuditEventType.LOGIN_FAILED,
          ipAddress: legitimateAddress,
          userAgent,
        }),
      );
      expect(harness.auditRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuthAuditEventType.LOGIN_FAILED,
          ipAddress: legitimateAddress,
          userAgent,
        }),
      );
      expect(
        JSON.stringify([
          assertAllowed.mock.calls,
          recordFailure.mock.calls,
          recordAudit.mock.calls,
        ]),
      ).not.toContain(forgedAddress);
    } finally {
      assertAllowed.mockRestore();
      recordFailure.mockRestore();
      recordAudit.mockRestore();
      await harness.app.close();
    }
  });

  it('sends the direct peer to the real consumers when trust rolls back to zero', async () => {
    const harness = await createAuthHarness(0);
    const assertAllowed = jest.spyOn(harness.rateLimiter, 'assertAllowed');
    const recordFailure = jest.spyOn(harness.rateLimiter, 'recordFailure');
    const recordAudit = jest.spyOn(harness.auditService, 'record');
    const forwardedAddresses = ['198.51.100.241', '203.0.113.26'];
    const email = 'proxy-rollback@example.com';
    const userAgent = 'trust-proxy-consumers-hops-0';

    try {
      await request(harness.app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', forwardedAddresses.join(', '))
        .set('User-Agent', userAgent)
        .send({ email, password: 'invalid-password-123' })
        .expect(401);

      const directPeer = assertAllowed.mock.calls.at(-1)?.[0];
      expect(directPeer).toMatch(/^(?:(?:::ffff:)?127\.0\.0\.1|::1)$/u);
      expect(recordFailure).toHaveBeenCalledWith(directPeer, email);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuthAuditEventType.LOGIN_FAILED,
          ipAddress: directPeer,
          userAgent,
        }),
      );
      expect(harness.auditRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuthAuditEventType.LOGIN_FAILED,
          ipAddress: directPeer,
          userAgent,
        }),
      );
      for (const forwardedAddress of forwardedAddresses) {
        expect(
          JSON.stringify([
            assertAllowed.mock.calls,
            recordFailure.mock.calls,
            recordAudit.mock.calls,
          ]),
        ).not.toContain(forwardedAddress);
      }
    } finally {
      assertAllowed.mockRestore();
      recordFailure.mockRestore();
      recordAudit.mockRestore();
      await harness.app.close();
    }
  });
});

async function createClientIpApp(
  hops: number,
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ClientIpController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureTrustProxy(app, hops);
  await app.init();
  return app;
}

async function createAuthHarness(hops: number): Promise<AuthHarness> {
  const userQuery = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
  };
  const auditRepository = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  };
  const moduleBuilder = Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      AuthService,
      AuthAuditService,
      {
        provide: LoginRateLimiter,
        useClass: InMemoryLoginRateLimiter,
      },
      {
        provide: ConfigService,
        useValue: {
          getOrThrow: jest.fn().mockReturnValue({
            loginMaxAttempts: 5,
            loginIpMaxAttempts: 25,
            loginMaxBuckets: 100,
            loginWindowSeconds: 900,
          }),
        },
      },
      {
        provide: getRepositoryToken(User),
        useValue: {
          createQueryBuilder: jest.fn(() => userQuery),
        },
      },
      {
        provide: getRepositoryToken(Membership),
        useValue: {},
      },
      {
        provide: getRepositoryToken(AuthAuditLog),
        useValue: auditRepository,
      },
      {
        provide: PASSWORD_LOGIN_VERIFIER,
        useValue: {
          verifyForLogin: jest.fn().mockResolvedValue(false),
        },
      },
      {
        provide: TokenService,
        useValue: {},
      },
      {
        provide: DataSource,
        useValue: {},
      },
      {
        provide: WebSessionService,
        useValue: {
          assertCsrf: jest.fn(),
          clearAuthCookies: jest.fn(),
          getRefreshToken: jest.fn(),
          issueCsrfToken: jest.fn(),
          setRefreshCookie: jest.fn(),
        },
      },
    ],
  })
    .overrideGuard(CsrfGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(AccessTokenGuard)
    .useValue({ canActivate: () => true });
  const moduleRef = await moduleBuilder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureTrustProxy(app, hops);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  return {
    app,
    auditRepository,
    auditService: moduleRef.get(AuthAuditService),
    rateLimiter: moduleRef.get(LoginRateLimiter),
  };
}
