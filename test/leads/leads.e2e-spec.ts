import {
  BadRequestException,
  CanActivate,
  ConflictException,
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
import {
  LeadMetricsRateLimitGuard,
  LeadReadRateLimitGuard,
} from '../../src/modules/leads/guards/lead-read-rate-limit.guards';
import { FormLeadReadinessGuard } from '../../src/modules/leads/guards/lead-readiness.guards';
import { ManualLeadReadinessGuard } from '../../src/modules/leads/guards/lead-readiness.guards';
import {
  LeadStage,
  LeadStatus,
} from '../../src/modules/leads/enums/lead.enums';
import { LEAD_READINESS } from '../../src/modules/leads/ports/lead-readiness.port';
import { FormSignatureService } from '../../src/modules/leads/security/form-signature.service';
import { FormRateLimiter } from '../../src/modules/leads/services/form-rate-limiter.service';
import { LeadsService } from '../../src/modules/leads/services/leads.service';
import { LeadOperationalReadService } from '../../src/modules/leads/services/lead-operational-read.service';
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
    status: LeadStatus.ACTIVE,
    stage: LeadStage.NEW,
    latestCycleNumber: '1',
    returnReviewPending: false,
    revision: '1',
    createdAt: new Date('2026-07-22T12:00:00Z'),
    updatedAt: new Date('2026-07-22T12:00:00Z'),
    initialAttribution: attribution('manual'),
    lastAttribution: attribution('manual'),
    nextAction: null,
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
    cycles: jest.fn(),
    update: jest.fn(),
    assign: jest.fn(),
    move: jest.fn(),
    setExpectedValue: jest.fn(),
    win: jest.fn(),
    lose: jest.fn(),
    archive: jest.fn(),
    reactivate: jest.fn(),
    dismissReturn: jest.fn(),
    nextAction: jest.fn(),
    createActivity: jest.fn(),
    createNote: jest.fn(),
    createNextAction: jest.fn(),
    rescheduleNextAction: jest.fn(),
    completeNextAction: jest.fn(),
    cancelNextAction: jest.fn(),
  };
  const reads = {
    list: jest.fn(),
    kanban: jest.fn(),
    myActions: jest.fn(),
    unassigned: jest.fn(),
    returnReviews: jest.fn(),
    metrics: jest.fn(),
    detail: jest.fn(),
    cycles: jest.fn(),
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
        { provide: LeadOperationalReadService, useValue: reads },
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
      .overrideGuard(LeadReadRateLimitGuard)
      .useValue(allow)
      .overrideGuard(LeadMetricsRateLimitGuard)
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

  it('does not accept expected value through Lead creation', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/v1/leads')
      .set('Idempotency-Key', randomUUID())
      .send({
        displayName: 'Maria',
        primaryPhone: '+5562999999999',
        expectedValueMinor: '100',
      })
      .expect(400);
    expect(leads.createManual).not.toHaveBeenCalled();
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

  it('returns bodyless 204, ETag, no-store, and replay metadata for commands', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    leads.move.mockResolvedValue({
      responseStatus: 204,
      revision: '2',
      replayed: true,
    });
    const key = randomUUID();
    const response = await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/move`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', key)
      .send({ stage: 'qualification' })
      .expect(204)
      .expect('ETag', `"lead:${leadId}:2"`)
      .expect('Idempotency-Replayed', 'true')
      .expect('Cache-Control', 'no-store');
    expect(response.text).toBe('');
    expect(leads.move).toHaveBeenCalledWith(
      expect.any(Object),
      leadId,
      '1',
      key,
      'qualification',
    );
  });

  it('sets expected value as an exact string with conditional replay semantics', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    leads.setExpectedValue.mockResolvedValue({
      responseStatus: 204,
      revision: '2',
      replayed: true,
    });
    const key = randomUUID();
    const response = await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/expected-value`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', key)
      .send({ expectedValueMinor: '9007199254740993' })
      .expect(204)
      .expect('ETag', `"lead:${leadId}:2"`)
      .expect('Idempotency-Replayed', 'true')
      .expect('Cache-Control', 'no-store');
    expect(response.text).toBe('');
    expect(leads.setExpectedValue).toHaveBeenCalledWith(
      expect.any(Object),
      leadId,
      '1',
      key,
      { expectedValueMinor: '9007199254740993' },
    );
  });

  it.each([
    {},
    { expectedValueMinor: 1 },
    { expectedValueMinor: '-1' },
    { expectedValueMinor: ' 1' },
    { expectedValueMinor: '+1' },
    { expectedValueMinor: '1.0' },
    { expectedValueMinor: '1e3' },
    { expectedValueMinor: '00' },
  ])('rejects invalid expected-value request %p', async (body) => {
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/expected-value`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(400);
    expect(leads.setExpectedValue).not.toHaveBeenCalled();
  });

  it('requires command headers, accepts null, and propagates state conflicts', async () => {
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/expected-value`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedValueMinor: null })
      .expect(428);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/expected-value`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .send({ expectedValueMinor: null })
      .expect(400);

    leads.setExpectedValue.mockRejectedValueOnce(
      new BadRequestException('Invalid expected value.'),
    );
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/expected-value`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedValueMinor: '9223372036854775808' })
      .expect(400);

    leads.setExpectedValue.mockResolvedValueOnce({
      responseStatus: 204,
      revision: '1',
      replayed: false,
    });
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/expected-value`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedValueMinor: null })
      .expect(204)
      .expect('ETag', `"lead:${leadId}:1"`);

    leads.setExpectedValue.mockRejectedValueOnce(
      new ConflictException('Lead request conflicts with existing state.'),
    );
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/expected-value`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedValueMinor: '1' })
      .expect(409);
  });

  it('validates command preconditions, closed reason notes, and empty bodies', async () => {
    const key = randomUUID();
    leads.lose.mockRejectedValueOnce(
      new BadRequestException('Reason note is required.'),
    );
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/win`)
      .set('Idempotency-Key', key)
      .send({})
      .expect(428);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/win`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .send({})
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/lose`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', key)
      .send({ lostReason: 'other' })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/archive`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', key)
      .send({ archiveReason: 'other', reasonNote: 'line\nbreak' })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/archive`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', key)
      .send({ archiveReason: 'other', reasonNote: 'line\u2028break' })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/reactivate`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', key)
      .send({ unexpected: true })
      .expect(400);
    expect(leads.win).not.toHaveBeenCalled();
    expect(leads.lose).toHaveBeenCalledTimes(1);
    expect(leads.archive).not.toHaveBeenCalled();
    expect(leads.reactivate).not.toHaveBeenCalled();
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

  it('exposes paginated timeline and volatile next-action reads without cache validators', async () => {
    leads.timeline.mockResolvedValue({
      items: [],
      page: { nextCursor: null, limit: 25 },
    });
    const timelineResponse = await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}/timeline?limit=25&cursor=7`)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(timelineResponse.body).toEqual({
      items: [],
      page: { nextCursor: null, limit: 25 },
    });
    expect(leads.timeline).toHaveBeenCalledWith(expect.any(Object), leadId, {
      cursor: '7',
      limit: 25,
    });

    leads.nextAction.mockResolvedValue({
      item: null,
      temporalState: 'none',
      leadRevision: '1',
    });
    const nextActionResponse = await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}/next-action`)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(nextActionResponse.headers).not.toHaveProperty('etag');
    expect(nextActionResponse.body).toEqual({
      item: null,
      temporalState: 'none',
      leadRevision: '1',
    });

    await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}/timeline?limit=101`)
      .expect(400);
  });

  it('serializes expected value as string or null on every approved read projection', async () => {
    reads.detail.mockResolvedValue({
      ...view,
      latestEntry: { id: randomUUID() },
      latestCycle: {
        id: randomUUID(),
        expectedValueMinor: '9007199254740993',
      },
      pendingReturn: null,
      counts: { timeline: 1, cycles: 1, activities: 0, notes: 0 },
    });
    reads.cycles.mockResolvedValue({
      items: [
        { id: randomUUID(), expectedValueMinor: '9007199254740993' },
        { id: randomUUID(), expectedValueMinor: null },
      ],
      page: { nextCursor: null, limit: 20 },
    });
    reads.list.mockResolvedValue({
      items: [{ id: leadId, expectedValueMinor: '9007199254740993' }],
      page: {
        nextCursor: null,
        limit: 25,
        total: 1,
        asOf: '2026-07-27T12:00:00.000Z',
      },
    });
    reads.kanban.mockResolvedValue({
      columns: [
        {
          stage: LeadStage.NEW,
          total: 1,
          expectedValueTotalMinor: '9007199254740993',
          withoutExpectedValue: 0,
          items: [{ id: leadId, expectedValueMinor: '9007199254740993' }],
          page: { nextCursor: null, limit: 20 },
        },
      ],
      asOf: '2026-07-27T12:00:00.000Z',
      currency: 'BRL',
      expectedValueTotalMinor: '9007199254740993',
      withoutExpectedValue: 0,
    });
    leads.timeline.mockResolvedValue({
      items: [
        {
          id: randomUUID(),
          eventType: 'lead.expected_value.changed',
          previousExpectedValueMinor: null,
          newExpectedValueMinor: '9007199254740993',
        },
      ],
      page: { nextCursor: null, limit: 50 },
    });

    const detail = await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}`)
      .expect(200);
    const detailBody = detail.body as {
      latestCycle: { expectedValueMinor: string | null };
    };
    expect(detailBody.latestCycle.expectedValueMinor).toBe('9007199254740993');
    const cycles = await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}/cycles?limit=20`)
      .expect(200);
    const cyclesBody = cycles.body as {
      items: Array<{ expectedValueMinor: string | null }>;
    };
    expect(
      cyclesBody.items.map(
        (item: { expectedValueMinor: unknown }) => item.expectedValueMinor,
      ),
    ).toEqual(['9007199254740993', null]);
    const list = await request(app.getHttpServer() as Server)
      .get('/api/v1/leads?limit=25')
      .expect(200);
    const listBody = list.body as {
      items: Array<{ expectedValueMinor: string | null }>;
    };
    expect(listBody.items[0]?.expectedValueMinor).toBe('9007199254740993');
    const kanban = await request(app.getHttpServer() as Server)
      .get('/api/v1/leads/kanban?limit=20')
      .expect(200);
    const kanbanBody = kanban.body as {
      currency: string;
      expectedValueTotalMinor: string;
      withoutExpectedValue: number;
      columns: Array<{
        expectedValueTotalMinor: string;
        withoutExpectedValue: number;
        items: Array<{ expectedValueMinor: string | null }>;
      }>;
    };
    expect(kanbanBody).toMatchObject({
      currency: 'BRL',
      expectedValueTotalMinor: '9007199254740993',
      withoutExpectedValue: 0,
    });
    expect(kanbanBody.columns[0]).toMatchObject({
      expectedValueTotalMinor: '9007199254740993',
      withoutExpectedValue: 0,
    });
    expect(kanbanBody.columns[0]?.items[0]?.expectedValueMinor).toBe(
      '9007199254740993',
    );
    const timeline = await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}/timeline?limit=50`)
      .expect(200);
    const timelineBody = timeline.body as {
      items: Array<{
        previousExpectedValueMinor: string | null;
        newExpectedValueMinor: string | null;
      }>;
    };
    expect(timelineBody.items[0]).toMatchObject({
      previousExpectedValueMinor: null,
      newExpectedValueMinor: '9007199254740993',
    });
  });

  it('creates activities, notes and next actions with stable replay responses', async () => {
    const key = randomUUID();
    const activityId = randomUUID();
    leads.createActivity.mockResolvedValue({
      id: activityId,
      revision: '2',
      replayed: true,
      responseStatus: 201,
    });
    const activityResponse = await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/activities`)
      .set('If-Match', `"lead:${leadId}:1"`)
      .set('Idempotency-Key', key)
      .send({
        type: 'internal_task',
        performedAt: '2026-07-22T09:00:00-03:00',
        outcome: '  retorno\r\nfeito  ',
      })
      .expect(201)
      .expect('ETag', `"lead:${leadId}:2"`)
      .expect('Idempotency-Replayed', 'true')
      .expect('Cache-Control', 'no-store');
    expect(activityResponse.body).toEqual({ id: activityId });
    expect(leads.createActivity).toHaveBeenCalledWith(
      expect.any(Object),
      leadId,
      '1',
      key,
      expect.objectContaining({ type: 'internal_task' }),
    );

    const noteId = randomUUID();
    leads.createNote.mockResolvedValue({
      id: noteId,
      revision: '3',
      replayed: false,
      responseStatus: 201,
    });
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/notes`)
      .set('If-Match', `"lead:${leadId}:2"`)
      .set('Idempotency-Key', randomUUID())
      .send({ content: 'Observação interna' })
      .expect(201)
      .expect('ETag', `"lead:${leadId}:3"`)
      .expect({ id: noteId });

    const nextActionId = randomUUID();
    leads.createNextAction.mockResolvedValue({
      id: nextActionId,
      revision: '4',
      replayed: false,
      responseStatus: 201,
    });
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/next-action`)
      .set('If-Match', `"lead:${leadId}:3"`)
      .set('Idempotency-Key', randomUUID())
      .send({
        type: 'call',
        description: 'Retornar contato',
        dueAt: '2026-07-23T09:00:00-03:00',
      })
      .expect(201)
      .expect('ETag', `"lead:${leadId}:4"`)
      .expect({ id: nextActionId });
  });

  it('exposes bodyless next-action state commands and validates their contracts', async () => {
    const successfulCommand = {
      revision: '5',
      replayed: false,
      responseStatus: 204,
    };
    leads.rescheduleNextAction.mockResolvedValue(successfulCommand);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/next-action/reschedule`)
      .set('If-Match', `"lead:${leadId}:4"`)
      .set('Idempotency-Key', randomUUID())
      .send({ dueAt: '2026-07-24T09:00:00-03:00' })
      .expect(204)
      .expect('ETag', `"lead:${leadId}:5"`);

    leads.completeNextAction.mockResolvedValue({
      ...successfulCommand,
      revision: '6',
      replayed: true,
    });
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/next-action/complete`)
      .set('If-Match', `"lead:${leadId}:5"`)
      .set('Idempotency-Key', randomUUID())
      .send({
        performedAt: '2026-07-22T12:00:00Z',
        outcome: 'Concluído',
      })
      .expect(204)
      .expect('ETag', `"lead:${leadId}:6"`)
      .expect('Idempotency-Replayed', 'true');

    leads.cancelNextAction.mockResolvedValue({
      ...successfulCommand,
      revision: '7',
    });
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/next-action/cancel`)
      .set('If-Match', `"lead:${leadId}:6"`)
      .set('Idempotency-Key', randomUUID())
      .send({ note: 'Cancelada manualmente' })
      .expect(204)
      .expect('ETag', `"lead:${leadId}:7"`);

    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/next-action`)
      .set('If-Match', `"lead:${leadId}:7"`)
      .set('Idempotency-Key', randomUUID())
      .send({
        type: 'call',
        description: 'Sem offset',
        dueAt: '2026-07-24T09:00:00',
      })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/next-action/cancel`)
      .set('If-Match', `"lead:${leadId}:7"`)
      .set('Idempotency-Key', randomUUID())
      .send({ unexpected: true })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/leads/${leadId}/activities`)
      .set('Idempotency-Key', randomUUID())
      .send({
        type: 'call',
        performedAt: '2026-07-22T12:00:00Z',
      })
      .expect(428);
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

  it('routes the operational list, board, queues, metrics and detail contracts', async () => {
    reads.list.mockResolvedValue({
      items: [],
      page: {
        limit: 25,
        total: 0,
        asOf: '2026-07-27T12:00:00.000Z',
        nextCursor: null,
      },
    });
    reads.kanban.mockResolvedValue({
      asOf: '2026-07-27T12:00:00.000Z',
      currency: 'BRL',
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 0,
      columns: [],
    });
    reads.returnReviews.mockResolvedValue({
      items: [],
      page: {
        limit: 25,
        total: 0,
        asOf: '2026-07-27T12:00:00.000Z',
        nextCursor: null,
      },
    });
    reads.metrics.mockResolvedValue({
      asOf: '2026-07-27T12:00:00.000Z',
      timeZone: 'America/Belem',
      snapshot: {
        active: 0,
        unassigned: 0,
        overdue: 0,
        withoutNextAction: 0,
        pendingReturns: 0,
      },
      period: {
        from: '2026-07-27',
        to: '2026-07-27',
        created: 0,
        won: 0,
        lost: 0,
        createdBySource: [],
      },
    });
    reads.detail.mockResolvedValue({
      ...view,
      latestEntry: { id: randomUUID() },
      latestCycle: null,
      pendingReturn: null,
      counts: { timeline: 1, cycles: 1, activities: 0, notes: 0 },
    });

    await request(app.getHttpServer() as Server)
      .get('/api/v1/leads?q=Maria&sort=createdAt%3Adesc')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(reads.list).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        q: 'Maria',
        limit: 25,
        sort: 'createdAt:desc',
      }),
    );

    await request(app.getHttpServer() as Server)
      .get('/api/v1/leads/kanban?limit=20')
      .expect(200);
    await request(app.getHttpServer() as Server)
      .get('/api/v1/leads/work/return-reviews?limit=25')
      .expect(200);
    await request(app.getHttpServer() as Server)
      .get('/api/v1/leads/metrics/summary?from=2026-07-27&to=2026-07-27')
      .expect(200);
    await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}`)
      .expect(200)
      .expect('ETag', `"lead:${leadId}:1"`);
    expect(reads.detail).toHaveBeenCalledWith(expect.any(Object), leadId);

    await request(app.getHttpServer() as Server)
      .get('/api/v1/leads/kanban?limit=21')
      .expect(400);
  });

  it('returns uniform 404 from the resource boundary', async () => {
    reads.detail.mockRejectedValue(new NotFoundException('Lead not found.'));
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
