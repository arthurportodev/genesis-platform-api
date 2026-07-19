import { HttpException, InternalServerErrorException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { randomUUID } from 'node:crypto';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { currentTenantFactory } from '../src/modules/tenant-context/decorators/current-tenant.decorator';
import { TenantContextGuard } from '../src/modules/tenant-context/guards/tenant-context.guard';
import { TenantContextResolver } from '../src/modules/tenant-context/services/tenant-context.service';
import { TenantContext } from '../src/modules/tenant-context/types/tenant-context.type';

describe('TenantContextGuard', () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const tenantContext: TenantContext = {
    userId,
    organizationId,
    membershipId: randomUUID(),
    role: MembershipRole.ADMIN,
  };
  const request: {
    headers: Record<string, string | string[] | undefined>;
    user?: { userId: string; sessionId: string };
    tenantContext?: TenantContext;
  } = {
    headers: {},
  };
  const executionContext = new ExecutionContextHost([request]);
  const resolve = jest.fn<
    ReturnType<TenantContextResolver['resolve']>,
    Parameters<TenantContextResolver['resolve']>
  >();
  const resolver: jest.Mocked<TenantContextResolver> = { resolve };
  const guard = new TenantContextGuard(resolver);

  beforeEach(() => {
    jest.clearAllMocks();
    request.user = { userId, sessionId: randomUUID() };
    request.headers['x-organization-id'] = organizationId;
    delete request.tenantContext;
  });

  it('rejects a request without an authenticated user', async () => {
    delete request.user;

    await expectHttpError(401, 'Invalid access token.');
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['malformed', 'not-a-uuid'],
  ])('rejects a %s organization header', async (_case, header) => {
    request.headers['x-organization-id'] = header;

    await expectHttpError(400, 'Invalid organization context.');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects multiple organization header values', async () => {
    request.headers['x-organization-id'] = [organizationId, randomUUID()];

    await expectHttpError(400, 'Invalid organization context.');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a comma-combined organization header', async () => {
    request.headers['x-organization-id'] = `${organizationId},${randomUUID()}`;

    await expectHttpError(400, 'Invalid organization context.');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects an organization that the service cannot resolve', async () => {
    resolve.mockResolvedValueOnce(null);

    await expectHttpError(403, 'Organization access denied.');
    expect(resolve).toHaveBeenCalledWith(userId, organizationId);
  });

  it('attaches the resolved context and uses authenticated identifiers', async () => {
    resolve.mockResolvedValueOnce(tenantContext);

    expect(request.tenantContext).toBeUndefined();
    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith(userId, organizationId);
    expect(request.tenantContext).toBe(tenantContext);
  });

  describe('CurrentTenant', () => {
    it('returns the context attached to the request', () => {
      request.tenantContext = tenantContext;

      expect(currentTenantFactory(undefined, executionContext)).toBe(
        tenantContext,
      );
    });

    it('fails explicitly when the context is unavailable', () => {
      expect(() => currentTenantFactory(undefined, executionContext)).toThrow(
        new InternalServerErrorException('Tenant context is unavailable.'),
      );
    });
  });

  async function expectHttpError(
    status: number,
    message: string,
  ): Promise<void> {
    try {
      await guard.canActivate(executionContext);
      throw new Error('Expected TenantContextGuard to reject the request.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(status);
      expect((error as HttpException).message).toBe(message);
    }
  }
});
