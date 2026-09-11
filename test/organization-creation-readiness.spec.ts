import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../src/database/runtime-executable-functions';
import { OperationalOrganizationCreationReadiness } from '../src/modules/organizations/ports/organization-creation-readiness.port';

describe('OperationalOrganizationCreationReadiness', () => {
  const validBoundary = {
    ready: true,
    executableFunctions: [...CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS],
  };
  const query = jest.fn<
    Promise<Array<{ ready: boolean; executableFunctions: string[] }>>,
    [string]
  >();
  const dataSource = { query } as unknown as DataSource;

  beforeEach(() => query.mockReset());

  it('passes only with the command surface and exact runtime allowlist', async () => {
    query.mockResolvedValue([validBoundary]);

    await expect(readiness().assertReady()).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain(
      'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)',
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      'app_private.execute_organization_creation_command()',
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      'public.organization_creation_commands',
    );
    expect(query.mock.calls[0]?.[0]).toContain('has_column_privilege');
    expect(query.mock.calls[0]?.[0]).toContain('WHERE false');
    expect(query.mock.calls[0]?.[0]).toContain(
      "'organization_creation_idempotency'",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "name = 'uq_organization_creation_actor_key'",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "'chk_organization_audit_logs_event'",
    );
  });

  it('fails closed before querying when the public topology has multiple replicas', async () => {
    await expect(readiness(2).assertReady()).rejects.toMatchObject({
      status: 503,
      response: { code: 'ORGANIZATION_CREATION_UNAVAILABLE' },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { ready: false },
    { executableFunctions: [] },
    {
      executableFunctions: [
        ...CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS,
        'unexpected()',
      ],
    },
  ])('fails closed on catalog or executable-function drift', async (drift) => {
    query.mockResolvedValue([{ ...validBoundary, ...drift }]);

    await expect(readiness().assertReady()).rejects.toEqual(
      new ServiceUnavailableException({
        statusCode: 503,
        code: 'ORGANIZATION_CREATION_UNAVAILABLE',
        message: 'Organization creation is unavailable.',
      }),
    );
  });

  it('fails closed without exposing a database error and then recovers', async () => {
    query.mockRejectedValueOnce(new Error('private database detail'));
    await expect(readiness().assertReady()).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'ORGANIZATION_CREATION_UNAVAILABLE',
        message: 'Organization creation is unavailable.',
      },
    });

    query.mockResolvedValueOnce([validBoundary]);
    await expect(readiness().assertReady()).resolves.toBeUndefined();
  });

  function readiness(replicas = 1): OperationalOrganizationCreationReadiness {
    return new OperationalOrganizationCreationReadiness(replicas, dataSource);
  }
});
