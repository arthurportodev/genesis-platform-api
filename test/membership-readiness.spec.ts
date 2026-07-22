import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RUNTIME_EXECUTABLE_FUNCTIONS } from '../src/database/runtime-executable-functions';
import { OperationalMembershipReadiness } from '../src/modules/memberships/ports/membership-readiness.port';

describe('OperationalMembershipReadiness', () => {
  const validBoundary = {
    hasFunction: true,
    canExecute: true,
    canUseSchema: true,
    canCreateSchema: false,
    publicCanExecute: false,
    canAssumeOwner: false,
    canMutateCentralTables: false,
    executableFunctions: [...RUNTIME_EXECUTABLE_FUNCTIONS],
    catalogSafe: true,
  };
  const query = jest.fn();
  const dataSource = { query } as unknown as DataSource;

  beforeEach(() => query.mockReset());

  it('passes only the complete boundary with one public replica', async () => {
    query.mockResolvedValue([validBoundary]);
    await expect(readiness().assertReady()).resolves.toBeUndefined();
  });

  it.each([
    { hasFunction: false },
    { canExecute: false },
    { canUseSchema: false },
    { canCreateSchema: true },
    { publicCanExecute: true },
    { canAssumeOwner: true },
    { canMutateCentralTables: true },
    { executableFunctions: [] },
    { catalogSafe: false },
  ])('fails closed on boundary drift', async (drift) => {
    query.mockResolvedValue([{ ...validBoundary, ...drift }]);
    await expect(readiness().assertReady()).rejects.toEqual(
      new ServiceUnavailableException('Membership management is unavailable.'),
    );
  });

  it('fails before querying with multiple public replicas', async () => {
    await expect(readiness(2).assertReady()).rejects.toMatchObject({
      status: 503,
      message: 'Membership management is unavailable.',
    });
    expect(query).not.toHaveBeenCalled();
  });

  function readiness(replicas = 1): OperationalMembershipReadiness {
    return new OperationalMembershipReadiness(replicas, dataSource);
  }
});
