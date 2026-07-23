import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  PreconditionFailedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { AccessTokenGuard } from '../../src/modules/auth/guards/access-token.guard';
import { RoleGuard } from '../../src/modules/authorization/guards/role.guard';
import { NoStoreInterceptor } from '../../src/modules/invitations/interceptors/no-store.interceptor';
import { FormLeadsController } from '../../src/modules/leads/controllers/form-leads.controller';
import { LeadsController } from '../../src/modules/leads/controllers/leads.controller';
import { FormRateLimitGuard } from '../../src/modules/leads/guards/form-rate-limit.guard';
import { FormSignatureGuard } from '../../src/modules/leads/guards/form-signature.guard';
import { FormLeadReadinessGuard } from '../../src/modules/leads/guards/lead-readiness.guards';
import { ManualLeadReadinessGuard } from '../../src/modules/leads/guards/lead-readiness.guards';
import { LEAD_READINESS } from '../../src/modules/leads/ports/lead-readiness.port';
import { FormSignatureService } from '../../src/modules/leads/security/form-signature.service';
import { FormRateLimiter } from '../../src/modules/leads/services/form-rate-limiter.service';
import { LeadsService } from '../../src/modules/leads/services/leads.service';
import { LeadView } from '../../src/modules/leads/types/lead-api.type';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';
import { TenantContextGuard } from '../../src/modules/tenant-context/guards/tenant-context.guard';

class TenantFixtureGuard implements CanActivate {
  role = MembershipRole.OWNER;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      tenantContext?: unknown;
    }>();
    request.tenantContext = {
      userId: randomUUID(),
      membershipId: randomUUID(),
      organizationId: randomUUID(),
      role: this.role,
    };
    return true;
  }
}

describe('Lead HTTP contract (e2e)', () => {
  let app: INestApplication;
  let tenantGuard: TenantFixtureGuard;
  const leadId = '08fc7c73-498e-4c05-9b83-cdd9d612e32e';
  const view: LeadView = {
    id: leadId,
    displayName: 'Maria',
    primaryPhone: '+5562999999999',
    email: null,
    companyName: null,
    instagram: null,
    city: null,
    serviceInterest: null,
    responsibleMembershipId: null,
    status: 'active',
    stage: 'new',
    revision: '1',
    createdAt: new Date('2026-07-22T12:00:00Z'),
    updatedAt: new Date('2026-07-22T12:00:00Z'),
    initialAttribution: attribution('manual'),
    lastAttribution: attribution('manual'),
  };
  const createManual = jest.fn() as jest.MockedFunction<
    LeadsService['createManual']
  >;
  const createFromForm = jest.fn() as jest.MockedFunction<
    LeadsService['createFromForm']
  >;
  const formKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const readiness = {
    assertManualReady: jest.fn().mockResolvedValue(undefined),
    assertFormReady: jest.fn().mockResolvedValue(undefined),
  };
  const leads = {
    createManual,
    createFromForm,
    list: jest.fn(),
    get: jest.fn(),
    timeline: jest.fn(),
    update: jest.fn(),
    assign: jest.fn(),
  };

  beforeAll(async () => {
    tenantGuard = new TenantFixtureGuard();
    const allow = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      controllers: [LeadsController, FormLeadsController],
      providers: [
        NoStoreInterceptor,
        FormRateLimiter,
        FormSignatureService,
        FormLeadReadinessGuard,
        FormRateLimitGuard,
        FormSignatureGuard,
        { provide: LEAD_READINESS, useValue: readiness },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => ({
              formReadiness: true,
              formOrganizationId: randomUUID(),
              formCurrentKeyVersion: 1,
              formKeys: new Map([[1, formKey]]),
              idempotencyCurrentKeyVersion: 1,
              idempotencyKeys: new Map([[1, Buffer.alloc(32, 1)]]),
              publicReplicaCount: 1,
              rateLimitWindowSeconds: 900,
              formIpMaxAttempts: 100,
              formKeyMaxAttempts: 100,
              rateLimitMaxBuckets: 100,
            }),
          },
        },
        { provide: LeadsService, useValue: leads },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue(allow)
      .overrideGuard(TenantContextGuard)
      .useValue(tenantGuard)
      .overrideGuard(ManualLeadReadinessGuard)
      .useValue(allow)
      .overrideGuard(RoleGuard)
      .useValue(allow)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => jest.clearAllMocks());

  it('returns 201 plus strong ETag for owner creation and defaults source to manual', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    leads.createManual.mockResolvedValue({
      responseStatus: 201,
      replayed: false,
      lead: view,
    });
    await request(app.getHttpServer() as Server)
      .post('/api/v1/leads')
      .set('Idempotency-Key', randomUUID())
      .send({ displayName: 'Maria', primaryPhone: '(62) 99999-9999' })
      .expect(201)
      .expect('ETag', `"lead:${leadId}:1"`)
      .expect('Cache-Control', 'no-store');
    expect(leads.createManual.mock.calls[0]?.[1]).toMatchObject({
      source: 'manual',
    });
  });

  it('always returns opaque 204 for member success, including hidden duplicate', async () => {
    tenantGuard.role = MembershipRole.MEMBER;
    leads.createManual.mockResolvedValue({
      responseStatus: 200,
      replayed: false,
      lead: null,
    });
    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/leads')
      .set('Idempotency-Key', randomUUID())
      .send({ displayName: 'Maria', primaryPhone: '+5562999999999' })
      .expect(204);
    expect(response.text).toBe('');
    expect(response.headers).not.toHaveProperty('location');
    expect(response.headers).not.toHaveProperty('etag');
  });

  it('enforces UUIDv4 idempotency and If-Match preconditions', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    await request(app.getHttpServer() as Server)
      .post('/api/v1/leads')
      .set('Idempotency-Key', 'invalid')
      .send({ displayName: 'Maria', primaryPhone: '+5562999999999' })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}`)
      .send({ displayName: 'Updated' })
      .expect(428);
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}`)
      .set('If-Match', `"lead:${randomUUID()}:1"`)
      .send({ displayName: 'Updated' })
      .expect(400);
    expect(leads.update).not.toHaveBeenCalled();
  });

  it('requires explicit assignment intent and accepts explicit unassignment', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}/assignment`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .send({})
      .expect(400);
    expect(leads.assign).not.toHaveBeenCalled();

    leads.assign.mockResolvedValue({ ...view, revision: '2' });
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}/assignment`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .send({ responsibleMembershipId: null })
      .expect(200)
      .expect('ETag', `"lead:${leadId}:2"`);
    expect(leads.assign).toHaveBeenCalledWith(
      expect.any(Object),
      leadId,
      '1',
      null,
    );
  });

  it('returns updated ETags and propagates stale preconditions', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    leads.update.mockResolvedValueOnce({
      ...view,
      displayName: 'Updated',
      revision: '2',
    });
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .send({ displayName: 'Updated' })
      .expect(200)
      .expect('ETag', `"lead:${leadId}:2"`);
    leads.update.mockRejectedValueOnce(
      new PreconditionFailedException('Lead revision is stale.'),
    );
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .send({ displayName: 'Stale' })
      .expect(412);
  });

  it('executes the real form readiness, rate-limit and raw-body HMAC guard chain', async () => {
    const idempotencyKey = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = {
      displayName: 'Maria form',
      primaryPhone: '+5562999999999',
      source: 'campaign',
    };
    const rawBody = JSON.stringify(payload);
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    const signature = createHmac('sha256', formKey)
      .update(`v1\n${timestamp}\n${idempotencyKey}\n${bodyHash}`, 'utf8')
      .digest('hex');
    createFromForm.mockResolvedValue(undefined);
    await request(app.getHttpServer() as Server)
      .post('/api/v1/lead-intake/genesis-form')
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Genesis-Key-Version', '1')
      .set('X-Genesis-Timestamp', timestamp)
      .set('X-Genesis-Signature', signature)
      .send(payload)
      .expect(204)
      .expect('Cache-Control', 'no-store');
    expect(readiness.assertFormReady).toHaveBeenCalled();
    expect(createFromForm).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'campaign' }),
      idempotencyKey,
    );

    await request(app.getHttpServer() as Server)
      .post('/api/v1/lead-intake/genesis-form')
      .set('Idempotency-Key', randomUUID())
      .set('X-Genesis-Key-Version', '1')
      .set('X-Genesis-Timestamp', timestamp)
      .set('X-Genesis-Signature', '0'.repeat(64))
      .send(payload)
      .expect(401);
    expect(createFromForm).toHaveBeenCalledTimes(1);
  });

  it('returns uniform 404 from the resource boundary', async () => {
    leads.get.mockRejectedValue(new NotFoundException('Lead not found.'));
    await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}`)
      .expect(404)
      .expect('Cache-Control', 'no-store');
  });
});

function attribution(source: string): LeadView['initialAttribution'] {
  return {
    source,
    sourceDetail: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    receivedAt: '2026-07-22T12:00:00.000Z',
  };
}
