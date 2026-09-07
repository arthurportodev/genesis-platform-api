import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import request from 'supertest';
import { AccessTokenGuard } from '../../src/modules/auth/guards/access-token.guard';
import { RoleGuard } from '../../src/modules/authorization/guards/role.guard';
import { NoStoreInterceptor } from '../../src/modules/invitations/interceptors/no-store.interceptor';
import { PipelinesController } from '../../src/modules/leads/controllers/pipelines.controller';
import { PipelinesService } from '../../src/modules/leads/services/pipelines.service';
import { PipelineView } from '../../src/modules/leads/types/pipeline-api.type';
import { MembershipRole } from '../../src/modules/memberships/enums/membership-role.enum';
import { TenantContextGuard } from '../../src/modules/tenant-context/guards/tenant-context.guard';

class PipelineTenantGuard implements CanActivate {
  role = MembershipRole.OWNER;

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ tenantContext?: unknown }>();
    request.tenantContext = {
      userId: randomUUID(),
      membershipId: randomUUID(),
      organizationId: randomUUID(),
      role: this.role,
    };
    return true;
  }
}

describe('Pipeline HTTP contract (e2e)', () => {
  let app: INestApplication;
  let tenantGuard: PipelineTenantGuard;
  const pipelineId = '6abf1ca5-53c7-4f52-b07c-d1e71c483980';
  const stageId = '4c1e8075-b921-498e-9dd4-00d355bd9781';
  const pipeline: PipelineView = {
    id: pipelineId,
    name: 'Onboarding',
    isDefault: false,
    revision: '0',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    stages: [
      {
        id: stageId,
        name: 'Entrada',
        position: 1,
        archivedAt: null,
      },
    ],
  };
  const pipelines = {
    list: jest.fn(),
    kanban: jest.fn(),
    create: jest.fn(),
    rename: jest.fn(),
    createStage: jest.fn(),
    renameStage: jest.fn(),
    reorder: jest.fn(),
    archiveStage: jest.fn(),
  };

  beforeAll(async () => {
    tenantGuard = new PipelineTenantGuard();
    const allow = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      controllers: [PipelinesController],
      providers: [
        NoStoreInterceptor,
        RoleGuard,
        { provide: PipelinesService, useValue: pipelines },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue(allow)
      .overrideGuard(TenantContextGuard)
      .useValue(tenantGuard)
      .compile();
    app = moduleRef.createNestApplication();
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

  it('allows members to read the tenant catalog and dynamic board', async () => {
    tenantGuard.role = MembershipRole.MEMBER;
    pipelines.list.mockResolvedValue([pipeline]);
    pipelines.kanban.mockResolvedValue({
      pipeline,
      currency: 'BRL',
      expectedValueTotalMinor: '0',
      withoutExpectedValue: 0,
      columns: [],
    });
    await request(app.getHttpServer() as Server)
      .get('/api/v1/pipelines')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    await request(app.getHttpServer() as Server)
      .get(`/api/v1/pipelines/${pipelineId}/kanban?limit=20`)
      .expect(200);
    expect(pipelines.kanban).toHaveBeenCalledWith(
      expect.any(Object),
      pipelineId,
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('denies configuration writes to members at the HTTP role boundary', async () => {
    tenantGuard.role = MembershipRole.MEMBER;
    await request(app.getHttpServer() as Server)
      .put(`/api/v1/pipelines/${pipelineId}`)
      .send({ name: 'Denied', stages: [{ id: stageId, name: 'Stage' }] })
      .expect(403);
    expect(pipelines.create).not.toHaveBeenCalled();
  });

  it('creates atomically and reports exact replay semantics', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    pipelines.create
      .mockResolvedValueOnce({ pipeline, replayed: false })
      .mockResolvedValueOnce({ pipeline, replayed: true });
    const body = {
      name: 'Onboarding',
      stages: [{ id: stageId, name: 'Entrada' }],
    };
    await request(app.getHttpServer() as Server)
      .put(`/api/v1/pipelines/${pipelineId}`)
      .send(body)
      .expect(201)
      .expect('ETag', `"pipeline:${pipelineId}:0"`);
    await request(app.getHttpServer() as Server)
      .put(`/api/v1/pipelines/${pipelineId}`)
      .send(body)
      .expect(200)
      .expect('Idempotency-Replayed', 'true');
  });

  it('enforces strong pipeline If-Match before configuration writes', async () => {
    tenantGuard.role = MembershipRole.ADMIN;
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/pipelines/${pipelineId}`)
      .send({ name: 'Renamed' })
      .expect(428);
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/pipelines/${pipelineId}`)
      .set('If-Match', `"pipeline:${randomUUID()}:0"`)
      .send({ name: 'Renamed' })
      .expect(400);
    expect(pipelines.rename).not.toHaveBeenCalled();
  });

  it('routes stage create, rename, order, and archive with one pipeline revision', async () => {
    tenantGuard.role = MembershipRole.ADMIN;
    const changed = { ...pipeline, revision: '1' };
    for (const method of [
      'createStage',
      'renameStage',
      'reorder',
      'archiveStage',
    ] as const) {
      pipelines[method].mockResolvedValue({
        pipeline: changed,
        replayed: false,
      });
    }
    const match = `"pipeline:${pipelineId}:0"`;
    await request(app.getHttpServer() as Server)
      .put(`/api/v1/pipelines/${pipelineId}/stages/${stageId}`)
      .set('If-Match', match)
      .send({ name: 'Entrada' })
      .expect(200)
      .expect('ETag', `"pipeline:${pipelineId}:1"`);
    await request(app.getHttpServer() as Server)
      .patch(`/api/v1/pipelines/${pipelineId}/stages/${stageId}`)
      .set('If-Match', match)
      .send({ name: 'Entrada 2' })
      .expect(200);
    await request(app.getHttpServer() as Server)
      .put(`/api/v1/pipelines/${pipelineId}/stages/order`)
      .set('If-Match', match)
      .send({ stageIds: [stageId] })
      .expect(200);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/pipelines/${pipelineId}/stages/${stageId}/archive`)
      .set('If-Match', match)
      .expect(200);
  });

  it('rejects malformed atomic configuration before the service boundary', async () => {
    tenantGuard.role = MembershipRole.OWNER;
    await request(app.getHttpServer() as Server)
      .put(`/api/v1/pipelines/${pipelineId}`)
      .send({ name: 'Invalid', stages: [] })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .put(`/api/v1/pipelines/${pipelineId}/stages/order`)
      .set('If-Match', `"pipeline:${pipelineId}:0"`)
      .send({ stageIds: [stageId, stageId] })
      .expect(400);
    expect(pipelines.create).not.toHaveBeenCalled();
    expect(pipelines.reorder).not.toHaveBeenCalled();
  });
});
