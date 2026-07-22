import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { TenantContext } from '../../tenant-context/types/tenant-context.type';
import {
  ChangeMembershipRoleDto,
  ListMembershipsDto,
} from '../dto/membership.dto';
import {
  MembershipCommand,
  MembershipCommandOutcome,
} from '../enums/membership-command.enum';
import { MembershipRole } from '../enums/membership-role.enum';
import { MembershipStatus } from '../enums/membership-status.enum';
import {
  MEMBERSHIP_READINESS,
  MembershipReadiness,
} from '../ports/membership-readiness.port';
import {
  MemberListResponse,
  MembershipRequestContext,
  MemberView,
} from '../types/membership-api.type';

interface ActorRow {
  userId: string;
  membershipId: string;
  organizationId: string;
  role: MembershipRole;
}

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface CursorValue {
  createdAt: string;
  id: string;
}

interface CommandRow {
  outcome: MembershipCommandOutcome;
  targetMembershipId: string;
  role: MembershipRole;
  status: MembershipStatus;
}

@Injectable()
export class MembershipsService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(MEMBERSHIP_READINESS)
    private readonly readiness: MembershipReadiness,
  ) {}

  async list(
    tenant: TenantContext,
    query: ListMembershipsDto,
  ): Promise<MemberListResponse> {
    await this.readiness.assertReady();
    const actor = await this.resolveActor(tenant);
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    if (
      actor.role === MembershipRole.ADMIN &&
      query.role !== undefined &&
      query.role !== MembershipRole.MEMBER
    ) {
      return { items: [], page: { nextCursor: null, limit: query.limit } };
    }

    const parameters: unknown[] = [actor.organizationId];
    const predicates = ['membership.organization_id = $1'];
    if (actor.role === MembershipRole.ADMIN) {
      parameters.push(MembershipRole.MEMBER);
      predicates.push(`membership.role = $${parameters.length}`);
    } else if (query.role !== undefined) {
      parameters.push(query.role);
      predicates.push(`membership.role = $${parameters.length}`);
    }
    if (query.status !== undefined) {
      parameters.push(query.status);
      predicates.push(`membership.status = $${parameters.length}`);
    }
    if (cursor !== null) {
      parameters.push(cursor.createdAt, cursor.id);
      predicates.push(
        `(membership.created_at, membership.id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`,
      );
    }
    parameters.push(query.limit + 1);
    const rows = await this.dataSource.query<MemberRow[]>(
      `${this.memberSelectSql()}
       WHERE ${predicates.join(' AND ')}
       ORDER BY membership.created_at DESC, membership.id DESC
       LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => this.toView(row)),
      page: {
        nextCursor:
          hasMore && last !== undefined
            ? this.encodeCursor(last.createdAt, last.id)
            : null,
        limit: query.limit,
      },
    };
  }

  async get(tenant: TenantContext, membershipId: string): Promise<MemberView> {
    await this.readiness.assertReady();
    const actor = await this.resolveActor(tenant);
    const row = await this.findVisibleMember(actor, membershipId);
    if (row === null) throw new NotFoundException('Member not found.');
    return this.toView(row);
  }

  async changeRole(
    tenant: TenantContext,
    membershipId: string,
    dto: ChangeMembershipRoleDto,
    context: MembershipRequestContext,
  ): Promise<MemberView> {
    await this.readiness.assertReady();
    const target = await this.dataSource.query<Array<{ role: MembershipRole }>>(
      `SELECT role FROM public.memberships
       WHERE id = $1 AND organization_id = $2`,
      [membershipId, tenant.organizationId],
    );
    if (target[0] === undefined)
      throw new NotFoundException('Member not found.');
    const command =
      target[0].role === MembershipRole.OWNER
        ? MembershipCommand.DEMOTE_OWNER
        : MembershipCommand.CHANGE_ROLE;
    await this.executeCommand(tenant, membershipId, command, dto.role, context);
    return this.get(tenant, membershipId);
  }

  async promoteOwner(
    tenant: TenantContext,
    membershipId: string,
    context: MembershipRequestContext,
  ): Promise<MemberView> {
    await this.readiness.assertReady();
    await this.executeCommand(
      tenant,
      membershipId,
      MembershipCommand.PROMOTE_OWNER,
      null,
      context,
    );
    return this.get(tenant, membershipId);
  }

  async deactivate(
    tenant: TenantContext,
    membershipId: string,
    context: MembershipRequestContext,
  ): Promise<void> {
    await this.readiness.assertReady();
    await this.executeCommand(
      tenant,
      membershipId,
      MembershipCommand.DEACTIVATE,
      null,
      context,
    );
  }

  async reactivate(
    tenant: TenantContext,
    membershipId: string,
    context: MembershipRequestContext,
  ): Promise<void> {
    await this.readiness.assertReady();
    await this.executeCommand(
      tenant,
      membershipId,
      MembershipCommand.REACTIVATE,
      null,
      context,
    );
  }

  async leave(
    tenant: TenantContext,
    context: MembershipRequestContext,
  ): Promise<void> {
    await this.readiness.assertReady();
    await this.executeCommand(
      tenant,
      null,
      MembershipCommand.LEAVE,
      null,
      context,
    );
  }

  private async executeCommand(
    tenant: TenantContext,
    targetMembershipId: string | null,
    command: MembershipCommand,
    requestedRole: MembershipRole | null,
    context: MembershipRequestContext,
  ): Promise<CommandRow> {
    let rows: CommandRow[];
    try {
      rows = await this.dataSource.query<CommandRow[]>(
        `SELECT outcome::text AS outcome,
                target_membership_id AS "targetMembershipId",
                role::text AS role, status::text AS status
         FROM app_private.execute_membership_command(
           $1::uuid, $2::uuid, $3::uuid,
           $4::app_private.membership_command_enum,
           $5::public.membership_role_enum,
           $6::uuid, $7::inet, $8::text
         )`,
        [
          tenant.userId,
          tenant.membershipId,
          targetMembershipId,
          command,
          requestedRole,
          randomUUID(),
          context.ipAddress,
          context.userAgent,
        ],
      );
    } catch (error) {
      this.mapDatabaseError(error);
    }
    const result = rows[0];
    if (result === undefined)
      throw new Error('Membership command returned no result.');
    if (result.outcome === MembershipCommandOutcome.BLOCKED_LAST_OWNER) {
      throw new ConflictException('Organization must retain an active owner.');
    }
    return result;
  }

  private mapDatabaseError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const driver = error.driverError as {
        code?: string;
        constraint?: string;
      };
      if (driver.code === 'P2001') {
        throw new ForbiddenException('Organization access denied.');
      }
      if (driver.code === 'P2002') {
        throw new NotFoundException('Member not found.');
      }
      if (driver.code === 'P2003') {
        throw new ConflictException('Membership state conflict.');
      }
      if (
        driver.code === '22004' ||
        driver.code === '22001' ||
        driver.code === '22023'
      ) {
        throw new BadRequestException('Invalid membership command.');
      }
      if (
        driver.code === '23514' &&
        driver.constraint === 'CHK_active_organization_effective_owner'
      ) {
        throw new ConflictException(
          'Organization must retain an active owner.',
        );
      }
    }
    throw error;
  }

  private async resolveActor(tenant: TenantContext): Promise<ActorRow> {
    const rows = await this.dataSource.query<ActorRow[]>(
      `SELECT application_user.id AS "userId",
              membership.id AS "membershipId",
              membership.organization_id AS "organizationId",
              membership.role
       FROM public.memberships AS membership
       JOIN public.users AS application_user
         ON application_user.id = membership.user_id
        AND application_user.status = 'active'
       JOIN public.organizations AS organization
         ON organization.id = membership.organization_id
        AND organization.status = 'active'
       WHERE membership.id = $1
         AND membership.user_id = $2
         AND membership.organization_id = $3
         AND membership.status = 'active'`,
      [tenant.membershipId, tenant.userId, tenant.organizationId],
    );
    const actor = rows[0];
    if (
      actor === undefined ||
      ![MembershipRole.OWNER, MembershipRole.ADMIN].includes(actor.role)
    ) {
      throw new ForbiddenException('Organization access denied.');
    }
    return actor;
  }

  private async findVisibleMember(
    actor: ActorRow,
    membershipId: string,
  ): Promise<MemberRow | null> {
    const parameters: unknown[] = [membershipId, actor.organizationId];
    let rolePredicate = '';
    if (actor.role === MembershipRole.ADMIN) {
      parameters.push(MembershipRole.MEMBER);
      rolePredicate = ` AND membership.role = $3`;
    }
    const rows = await this.dataSource.query<MemberRow[]>(
      `${this.memberSelectSql()}
       WHERE membership.id = $1
         AND membership.organization_id = $2${rolePredicate}`,
      parameters,
    );
    return rows[0] ?? null;
  }

  private memberSelectSql(): string {
    return `SELECT membership.id,
                   application_user.name,
                   application_user.email,
                   membership.role,
                   membership.status,
                   membership.created_at AS "createdAt",
                   membership.updated_at AS "updatedAt"
            FROM public.memberships AS membership
            JOIN public.users AS application_user
              ON application_user.id = membership.user_id`;
  }

  private toView(row: MemberRow): MemberView {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(
      JSON.stringify({ createdAt: createdAt.toISOString(), id }),
      'utf8',
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): CursorValue {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('invalid cursor');
      const decoded = Buffer.from(cursor, 'base64url');
      if (decoded.toString('base64url') !== cursor) {
        throw new Error('invalid cursor');
      }
      const value = JSON.parse(
        decoded.toString('utf8'),
      ) as Partial<CursorValue>;
      if (
        typeof value !== 'object' ||
        value === null ||
        Object.keys(value).sort().join(',') !== 'createdAt,id' ||
        typeof value.createdAt !== 'string' ||
        Number.isNaN(Date.parse(value.createdAt)) ||
        new Date(value.createdAt).toISOString() !== value.createdAt ||
        typeof value.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          value.id,
        )
      ) {
        throw new Error('invalid cursor');
      }
      return { createdAt: value.createdAt, id: value.id };
    } catch {
      throw new BadRequestException('Invalid member cursor.');
    }
  }
}
