import { HttpException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { ROLES_METADATA_KEY } from '../src/modules/authorization/decorators/roles.decorator';
import { RoleGuard } from '../src/modules/authorization/guards/role.guard';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';
import { TenantContext } from '../src/modules/tenant-context/types/tenant-context.type';

class RolePolicyController {
  controllerPolicy(this: void): void {}
  handlerPolicy(this: void): void {}
  noPolicy(this: void): void {}
}

describe('RoleGuard', () => {
  const reflector = new Reflector();
  const guard = new RoleGuard(reflector);
  const tenantContext: TenantContext = {
    userId: randomUUID(),
    organizationId: randomUUID(),
    membershipId: randomUUID(),
    role: MembershipRole.OWNER,
  };
  const request: {
    headers: Record<string, string | undefined>;
    body: { role?: string };
    query: { role?: string };
    user: { userId: string; sessionId: string; role?: string };
    tenantContext?: TenantContext;
  } = {
    headers: {},
    body: {},
    query: {},
    user: { userId: randomUUID(), sessionId: randomUUID() },
    tenantContext,
  };

  beforeEach(() => {
    request.tenantContext = tenantContext;
    request.body = {};
    request.query = {};
    request.headers = {};
    request.user = { userId: randomUUID(), sessionId: randomUUID() };
    Reflect.deleteMetadata(ROLES_METADATA_KEY, RolePolicyController);
    for (const handler of [
      RolePolicyController.prototype.controllerPolicy,
      RolePolicyController.prototype.handlerPolicy,
      RolePolicyController.prototype.noPolicy,
    ]) {
      Reflect.deleteMetadata(ROLES_METADATA_KEY, handler);
    }
  });

  it.each([MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER])(
    'allows %s when explicitly listed',
    (role) => {
      request.tenantContext = { ...tenantContext, role };
      const context = createContext('handlerPolicy');
      Reflect.defineMetadata(ROLES_METADATA_KEY, [role], context.getHandler());

      expect(guard.canActivate(context)).toBe(true);
    },
  );

  it('denies a role that is not explicitly listed with a generic 403', () => {
    const context = createContext('handlerPolicy');
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.ADMIN, MembershipRole.MEMBER],
      context.getHandler(),
    );

    expectHttpError(
      () => guard.canActivate(context),
      403,
      'Organization access denied.',
    );

    try {
      guard.canActivate(context);
    } catch (error: unknown) {
      const serialized = JSON.stringify((error as HttpException).getResponse());
      expect(serialized).not.toContain(MembershipRole.OWNER);
      expect(serialized).not.toContain(MembershipRole.ADMIN);
      expect(serialized).not.toContain(MembershipRole.MEMBER);
    }
  });

  it('uses handler metadata before controller metadata', () => {
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.OWNER],
      RolePolicyController,
    );
    const context = createContext('handlerPolicy');
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.MEMBER],
      context.getHandler(),
    );
    request.tenantContext = {
      ...tenantContext,
      role: MembershipRole.MEMBER,
    };

    expect(guard.canActivate(context)).toBe(true);
  });

  it('uses controller metadata as a fallback', () => {
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.OWNER],
      RolePolicyController,
    );

    expect(guard.canActivate(createContext('controllerPolicy'))).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['empty', []],
    ['not an array', MembershipRole.OWNER],
    ['containing an invalid role', [MembershipRole.OWNER, 'super-admin']],
  ])('fails explicitly when metadata is %s', (_case, metadata) => {
    const context = createContext('handlerPolicy');
    if (metadata !== undefined) {
      Reflect.defineMetadata(
        ROLES_METADATA_KEY,
        metadata,
        context.getHandler(),
      );
    }

    expectHttpError(
      () => guard.canActivate(context),
      500,
      'Authorization configuration is invalid.',
    );
  });

  it('fails explicitly when metadata contains a sparse array index', () => {
    const context = createContext('handlerPolicy');
    const sparseRoles = new Array<unknown>(1);
    expect(Object.prototype.hasOwnProperty.call(sparseRoles, 0)).toBe(false);
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      sparseRoles,
      context.getHandler(),
    );

    expectHttpError(
      () => guard.canActivate(context),
      500,
      'Authorization configuration is invalid.',
    );
  });

  it('fails explicitly when a role index exists only on the prototype', () => {
    const context = createContext('handlerPolicy');
    const inheritedRoles = new Array<unknown>(1);
    const inheritedPrototype: object = {};
    Object.setPrototypeOf(inheritedPrototype, Array.prototype);
    Reflect.set(inheritedPrototype, '0', MembershipRole.OWNER);
    Object.setPrototypeOf(inheritedRoles, inheritedPrototype);
    expect(Object.prototype.hasOwnProperty.call(inheritedRoles, 0)).toBe(false);
    expect(Reflect.get(inheritedRoles, '0')).toBe(MembershipRole.OWNER);
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      inheritedRoles,
      context.getHandler(),
    );

    expectHttpError(
      () => guard.canActivate(context),
      500,
      'Authorization configuration is invalid.',
    );
  });

  it('fails explicitly when tenant context is unavailable', () => {
    delete request.tenantContext;
    const context = createContext('handlerPolicy');
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.OWNER],
      context.getHandler(),
    );

    expectHttpError(
      () => guard.canActivate(context),
      500,
      'Tenant context is unavailable.',
    );
  });

  it('allows duplicate roles without changing the result', () => {
    const context = createContext('handlerPolicy');
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.OWNER, MembershipRole.OWNER],
      context.getHandler(),
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('preserves the tenant context object identity', () => {
    const context = createContext('handlerPolicy');
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.OWNER],
      context.getHandler(),
    );
    const originalContext = request.tenantContext;

    guard.canActivate(context);

    expect(request.tenantContext).toBe(originalContext);
  });

  it('ignores role values from body, query, headers, and authenticated user', () => {
    request.body.role = MembershipRole.OWNER;
    request.query.role = MembershipRole.OWNER;
    request.headers.role = MembershipRole.OWNER;
    request.user.role = MembershipRole.OWNER;
    request.tenantContext = { ...tenantContext, role: MembershipRole.MEMBER };
    const context = createContext('handlerPolicy');
    Reflect.defineMetadata(
      ROLES_METADATA_KEY,
      [MembershipRole.OWNER],
      context.getHandler(),
    );

    expectHttpError(
      () => guard.canActivate(context),
      403,
      'Organization access denied.',
    );
  });

  it('depends only on Reflector and has no database collaborator', () => {
    expect(Object.keys(guard)).toEqual(['reflector']);
    expect(guard).not.toHaveProperty('repository');
    expect(guard).not.toHaveProperty('dataSource');
  });

  function createContext(
    handlerName: 'controllerPolicy' | 'handlerPolicy' | 'noPolicy',
  ): ExecutionContextHost {
    return new ExecutionContextHost(
      [request],
      RolePolicyController,
      RolePolicyController.prototype[handlerName],
    );
  }

  function expectHttpError(
    action: () => boolean,
    status: number,
    message: string,
  ): void {
    expect(action).toThrow(HttpException);
    try {
      action();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(status);
      expect((error as HttpException).message).toBe(message);
    }
  }
});
