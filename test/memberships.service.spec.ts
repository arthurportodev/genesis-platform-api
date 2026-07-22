import { BadRequestException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { ListMembershipsDto } from '../src/modules/memberships/dto/membership.dto';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { MembershipStatus } from '../src/modules/memberships/enums/membership-status.enum';
import { MembershipReadiness } from '../src/modules/memberships/ports/membership-readiness.port';
import { MembershipsService } from '../src/modules/memberships/services/memberships.service';
import { TenantContext } from '../src/modules/tenant-context/types/tenant-context.type';

describe('MembershipsService cursor handling', () => {
  const tenant: TenantContext = {
    userId: '11111111-1111-4111-8111-111111111111',
    membershipId: '22222222-2222-4222-8222-222222222222',
    organizationId: '33333333-3333-4333-8333-333333333333',
    role: MembershipRole.OWNER,
  };
  const actor = {
    userId: tenant.userId,
    membershipId: tenant.membershipId,
    organizationId: tenant.organizationId,
    role: MembershipRole.OWNER,
  };
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();
  const dataSource = { query } as unknown as DataSource;
  const readiness: MembershipReadiness = {
    assertReady: jest.fn().mockResolvedValue(undefined),
  };
  const service = new MembershipsService(dataSource, readiness);

  beforeEach(() => query.mockReset());

  it('round-trips the emitted canonical base64url cursor', async () => {
    const createdAt = new Date('2026-07-22T12:34:56.789Z');
    const memberId = '44444444-4444-4444-8444-444444444444';
    query.mockResolvedValueOnce([actor]).mockResolvedValueOnce([
      {
        id: memberId,
        name: 'Member',
        email: 'member@example.com',
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Next',
        email: 'next@example.com',
        role: MembershipRole.MEMBER,
        status: MembershipStatus.ACTIVE,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    const first = await service.list(tenant, { limit: 1 });
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);

    query.mockResolvedValueOnce([actor]).mockResolvedValueOnce([]);
    await service.list(tenant, {
      limit: 1,
      cursor: first.page.nextCursor!,
    });
    expect(query.mock.calls.at(-1)?.[1]).toEqual([
      tenant.organizationId,
      createdAt.toISOString(),
      memberId,
      2,
    ]);
  });

  it.each([
    ['padded base64', 'e30='],
    [
      'an extra JSON key',
      cursor({
        createdAt: '2026-07-22T12:34:56.789Z',
        id: '44444444-4444-4444-8444-444444444444',
        extra: true,
      }),
    ],
    [
      'a non-canonical timestamp',
      cursor({
        createdAt: '2026-07-22T12:34:56Z',
        id: '44444444-4444-4444-8444-444444444444',
      }),
    ],
    [
      'an uppercase UUID',
      cursor({
        createdAt: '2026-07-22T12:34:56.789Z',
        id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }),
    ],
  ])('rejects %s', async (_description, encodedCursor) => {
    query.mockResolvedValueOnce([actor]);
    await expect(
      service.list(tenant, {
        limit: new ListMembershipsDto().limit,
        cursor: encodedCursor,
      }),
    ).rejects.toEqual(new BadRequestException('Invalid member cursor.'));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['40P01', '40001'])(
    'does not retry database fault %s',
    async (code) => {
      const databaseError = new QueryFailedError(
        'SELECT app_private.execute_membership_command(...)',
        [],
        Object.assign(new Error('database concurrency fault'), { code }),
      );
      query.mockRejectedValueOnce(databaseError);

      await expect(
        service.deactivate(tenant, '44444444-4444-4444-8444-444444444444', {
          ipAddress: null,
          userAgent: null,
        }),
      ).rejects.toBe(databaseError);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  function cursor(value: object): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }
});
