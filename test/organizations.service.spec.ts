import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { OrganizationsService } from '../src/modules/organizations/services/organizations.service';
import { OrganizationCreationRateLimiter } from '../src/modules/organizations/services/organization-creation-rate-limiter.service';

describe('OrganizationsService', () => {
  const actorUserId = randomUUID();
  const idempotencyKey = randomUUID();
  const query = jest.fn();
  const reserve = jest.fn().mockReturnValue({
    creationPermitted: true,
    newlyReserved: true,
    retryAfterSeconds: null,
  });
  const release = jest.fn();
  const limiter = {
    reserve,
    release,
  } as unknown as OrganizationCreationRateLimiter;
  const service = new OrganizationsService(
    { query } as unknown as DataSource,
    limiter,
  );
  const context = { ipAddress: '127.0.0.1', userAgent: 'test' };

  beforeEach(() => jest.clearAllMocks());

  it('normalizes the request and maps the narrow function result', async () => {
    const organizationId = randomUUID();
    const membershipId = randomUUID();
    query.mockResolvedValueOnce([
      {
        organization_id: organizationId,
        organization_name: 'Agência Gênesis',
        organization_slug: 'agencia-genesis',
        membership_id: membershipId,
        membership_role: 'owner',
        replayed: false,
      },
    ]);

    await expect(
      service.create(
        actorUserId,
        idempotencyKey,
        { name: '  Agência Ge\u0302nesis  ' },
        context,
      ),
    ).resolves.toEqual({
      replayed: false,
      response: {
        id: organizationId,
        name: 'Agência Gênesis',
        slug: 'agencia-genesis',
        membershipId,
        role: 'owner',
      },
    });
    expect(reserve).toHaveBeenCalledWith(
      actorUserId,
      context.ipAddress,
      idempotencyKey,
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO public.organization_creation_commands',
      ),
      [
        actorUserId,
        idempotencyKey,
        expect.stringMatching(/^[a-f0-9]{64}$/u),
        'Agência Gênesis',
        'agencia-genesis',
        context.ipAddress,
        context.userAgent,
        true,
      ],
    );
  });

  it('rejects missing and non-v4 idempotency keys before rate limiting', async () => {
    await expect(
      service.create(actorUserId, undefined, { name: 'Empresa' }, context),
    ).rejects.toMatchObject({
      response: { code: 'ORGANIZATION_IDEMPOTENCY_KEY_INVALID' },
    });
    await expect(
      service.create(
        actorUserId,
        '00000000-0000-0000-0000-000000000000',
        { name: 'Empresa' },
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'ORGANIZATION_IDEMPOTENCY_KEY_INVALID' },
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['P4001', 'ORGANIZATION_CREATION_UNAUTHORIZED'],
    ['P4002', 'ORGANIZATION_IDEMPOTENCY_CONFLICT'],
    ['P4003', 'ORGANIZATION_CREATION_UNAVAILABLE'],
    ['22023', 'ORGANIZATION_CREATION_INVALID'],
  ])(
    'maps SQLSTATE %s to the stable public error',
    async (code, publicCode) => {
      query.mockRejectedValueOnce(
        new QueryFailedError('SELECT', [], { code } as Error & {
          code: string;
        }),
      );
      await expect(
        service.create(
          actorUserId,
          idempotencyKey,
          { name: 'Empresa' },
          context,
        ),
      ).rejects.toMatchObject({ response: { code: publicCode } });
    },
  );

  it('releases a fresh local reservation when PostgreSQL proves replay', async () => {
    query.mockResolvedValueOnce([
      {
        organization_id: randomUUID(),
        organization_name: 'Empresa',
        organization_slug: 'empresa',
        membership_id: randomUUID(),
        membership_role: 'owner',
        replayed: true,
      },
    ]);
    await service.create(
      actorUserId,
      idempotencyKey,
      { name: 'Empresa' },
      context,
    );
    expect(release).toHaveBeenCalledWith(actorUserId, idempotencyKey);
  });

  it('uses the DB boundary to reject a blocked new intention', async () => {
    reserve.mockReturnValueOnce({
      creationPermitted: false,
      newlyReserved: false,
      retryAfterSeconds: 120,
    });
    query.mockRejectedValueOnce(
      new QueryFailedError('SELECT', [], {
        code: 'P4005',
      } as Error & { code: string }),
    );
    await expect(
      service.create(actorUserId, idempotencyKey, { name: 'Empresa' }, context),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 120 });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      actorUserId,
      idempotencyKey,
      expect.any(String),
      'Empresa',
      'empresa',
      context.ipAddress,
      context.userAgent,
      false,
    ]);
  });

  it('fails closed for malformed privileged results', async () => {
    query.mockResolvedValueOnce([{ membership_role: 'admin' }]);
    await expect(
      service.create(actorUserId, idempotencyKey, { name: 'Empresa' }, context),
    ).rejects.toMatchObject({
      response: { code: 'ORGANIZATION_CREATION_UNAVAILABLE' },
    });
  });
});
