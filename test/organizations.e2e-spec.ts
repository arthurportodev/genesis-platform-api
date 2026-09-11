import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { isSensitiveWebResponse } from '../src/config/app.config';
import { ACCESS_TOKEN_AUTHENTICATOR } from '../src/modules/auth/guards/access-token.guard';
import { AuthenticatedUser } from '../src/modules/auth/types/authenticated-user.type';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  membershipId: string;
  role: 'owner';
}

interface BootstrapResponse {
  organizations: OrganizationResponse[];
}

interface PipelineResponse {
  name: string;
  isDefault: boolean;
}

describe('Self-service organization HTTP contract', () => {
  let app: INestApplication;
  let owner: DataSource;
  let server: Server;
  let userId: string;
  const sessionId = randomUUID();
  const bearer = 'valid-test-access-token';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_NAME = 'Genesis Platform API';
    process.env.APP_VERSION = '0.1.0';
    process.env.DATABASE_HOST = process.env.TEST_DATABASE_HOST ?? 'localhost';
    process.env.DATABASE_PORT = process.env.TEST_DATABASE_PORT ?? '5433';
    process.env.DATABASE_NAME =
      process.env.TEST_DATABASE_NAME ?? 'genesis_platform_test';
    configureIntegrationRuntimeEnvironment();
    process.env.FRONTEND_URL = 'http://localhost:5173';
    process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('base64url');
    process.env.REFRESH_TOKEN_PEPPER = randomBytes(48).toString('base64url');
    process.env.AUTH_OTP_PUBLIC_FLOWS_ENABLED = 'false';
    process.env.AUTH_GOOGLE_PUBLIC_FLOW_ENABLED = 'false';
    process.env.API_PUBLIC_REPLICA_COUNT = '1';
    process.env.LEAD_FORM_READINESS = 'false';
    process.env.LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION = '1';
    process.env.LEAD_IDEMPOTENCY_KEYS = JSON.stringify({
      1: randomBytes(32).toString('base64'),
    });

    const { AppModule } = await import('../src/app.module');
    owner = createIntegrationDataSource({ includeOrganizationCreation: true });
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    const [user] = await owner.query<Array<{ id: string }>>(
      `INSERT INTO public.users (
        id,email,name,status,password_hash,password_changed_at,email_verified_at,
        created_at,updated_at
      ) VALUES (
        gen_random_uuid(),$1,'HTTP Owner','active',NULL,NULL,
        transaction_timestamp(),transaction_timestamp(),transaction_timestamp()
      ) RETURNING id`,
      [`http-${randomUUID()}@example.test`],
    );
    if (!user) throw new Error('Could not create HTTP test User.');
    userId = user.id;

    const authenticator = {
      authenticate: (token: string): Promise<AuthenticatedUser> => {
        if (token !== bearer) {
          throw new UnauthorizedException('Invalid access token.');
        }
        return Promise.resolve({ userId, sessionId });
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ACCESS_TOKEN_AUTHENTICATOR)
      .useValue(authenticator)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use((requestValue: Request, response: Response, next: NextFunction) => {
      if (
        isSensitiveWebResponse(
          requestValue.path,
          requestValue.get('x-organization-id'),
        )
      ) {
        response.setHeader('Cache-Control', 'no-store');
      }
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  it('requires bearer authentication and does not accept refresh cookie alone', async () => {
    await request(server)
      .post('/api/v1/organizations')
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Sem Bearer' })
      .expect('Cache-Control', 'no-store')
      .expect(401);
    await request(server)
      .post('/api/v1/organizations')
      .set('Cookie', 'genesis_refresh=synthetic')
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Cookie Only' })
      .expect('Cache-Control', 'no-store')
      .expect(401);
  });

  it('rejects unknown fields, invalid names and invalid idempotency keys', async () => {
    await authorizedCreate('invalid', { name: 'Empresa' })
      .expect('Cache-Control', 'no-store')
      .expect(400);
    await authorizedCreate(randomUUID(), {
      name: 'Empresa',
      slug: 'client-controlled',
    }).expect(400);
    await authorizedCreate(randomUUID(), {
      name: `Linha\u2028Quebrada`,
    }).expect(400);
    await authorizedCreate(randomUUID(), {
      name: `Direção\u202einvisível`,
    }).expect(400);
    await authorizedCreate(randomUUID(), {
      name: `Marca\u061cinvisível`,
    }).expect(400);
  });

  it('returns no-store when readiness fails before the controller', async () => {
    await owner.query(`
      ALTER TABLE public.organization_creation_idempotency
      RENAME CONSTRAINT UQ_organization_creation_actor_key
      TO UQ_organization_creation_actor_key_drift
    `);
    try {
      await authorizedCreate(randomUUID(), { name: 'Boundary Drift' })
        .expect('Cache-Control', 'no-store')
        .expect(503);
    } finally {
      await owner.query(`
        ALTER TABLE public.organization_creation_idempotency
        RENAME CONSTRAINT UQ_organization_creation_actor_key_drift
        TO UQ_organization_creation_actor_key
      `);
    }
  });

  it('creates, replays, bootstraps and accepts the created tenant context', async () => {
    const key = randomUUID();
    const created = await authorizedCreate(key, {
      name: '  Agência Ge\u0302nesis  ',
    })
      .expect('Cache-Control', 'no-store')
      .expect(201);
    const createdBody = created.body as OrganizationResponse;
    expect(Object.keys(createdBody).sort()).toEqual([
      'id',
      'membershipId',
      'name',
      'role',
      'slug',
    ]);
    expect(createdBody.id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(createdBody.membershipId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(createdBody).toMatchObject({
      name: 'Agência Gênesis',
      slug: 'agencia-genesis',
      role: 'owner',
    });
    expect(created.headers.location).toBe(
      `/api/v1/organizations/${createdBody.id}`,
    );
    expect(created.headers['idempotency-replayed']).toBeUndefined();

    const replay = await authorizedCreate(key, {
      name: 'Agência Gênesis',
    }).expect(201);
    expect(replay.body as OrganizationResponse).toEqual(createdBody);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    await authorizedCreate(key, { name: 'Payload Diferente' })
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({
          code: 'ORGANIZATION_IDEMPOTENCY_CONFLICT',
        });
      });

    const bootstrap = await request(server)
      .get('/api/v1/auth/bootstrap')
      .set('Authorization', `Bearer ${bearer}`)
      .expect(200);
    const bootstrapBody = bootstrap.body as BootstrapResponse;
    expect(bootstrapBody.organizations).toContainEqual(
      expect.objectContaining({
        id: createdBody.id,
        name: 'Agência Gênesis',
        slug: 'agencia-genesis',
        membershipId: createdBody.membershipId,
        role: 'owner',
      }),
    );

    const pipelines = await request(server)
      .get('/api/v1/pipelines')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Organization-Id', createdBody.id)
      .expect(200);
    expect(pipelines.body as PipelineResponse[]).toContainEqual(
      expect.objectContaining({ name: 'Pipeline Comercial', isDefault: true }),
    );

    const [otherTenant] = await owner.query<Array<{ id: string }>>(
      `WITH other_user AS (
         INSERT INTO public.users (
           id,email,name,status,email_verified_at,created_at,updated_at
         ) VALUES (
           gen_random_uuid(),$1,'Other Owner','active',transaction_timestamp(),
           transaction_timestamp(),transaction_timestamp()
         ) RETURNING id
       ), other_organization AS (
         INSERT INTO public.organizations (id,name,slug,status,created_at,updated_at)
         VALUES (
           gen_random_uuid(),'Other Tenant',$2,'active',
           transaction_timestamp(),transaction_timestamp()
         ) RETURNING id
       ), other_owner AS (
         INSERT INTO public.memberships (
           id,user_id,organization_id,role,status,created_at,updated_at
         )
         SELECT gen_random_uuid(),other_user.id,other_organization.id,
                'owner','active',transaction_timestamp(),transaction_timestamp()
         FROM other_user CROSS JOIN other_organization
       )
       SELECT id FROM other_organization`,
      [`other-${randomUUID()}@example.test`, `other-${randomUUID()}`],
    );
    if (!otherTenant) throw new Error('Could not create cross-tenant fixture.');
    await request(server)
      .get('/api/v1/pipelines')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Organization-Id', otherTenant.id)
      .expect(403)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ message: 'Organization access denied.' });
      });
  }, 30_000);

  it('enforces new-intention limits, emits Retry-After and still permits replay', async () => {
    const successful: Array<{ key: string; body: { name: string } }> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = {
        key: randomUUID(),
        body: { name: `Limite ${attempt + 1}` },
      };
      await authorizedCreate(candidate.key, candidate.body).expect(201);
      successful.push(candidate);
    }
    const blocked = await authorizedCreate(randomUUID(), {
      name: 'Limite Excedido',
    }).expect(429);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/u);
    expect(blocked.body).toMatchObject({
      code: 'ORGANIZATION_CREATION_RATE_LIMITED',
    });

    const firstSuccess = successful[0];
    if (!firstSuccess) throw new Error('Expected one successful intention.');
    const replay = await authorizedCreate(
      firstSuccess.key,
      firstSuccess.body,
    ).expect(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  function authorizedCreate(key: string, body: object): request.Test {
    return request(server)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${bearer}`)
      .set('Idempotency-Key', key)
      .send(body);
  }
});
