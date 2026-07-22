import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership } from '../../memberships/entities/membership.entity';
import { MembershipStatus } from '../../memberships/enums/membership-status.enum';
import { OrganizationStatus } from '../../organizations/enums/organization-status.enum';
import { UserStatus } from '../../users/enums/user-status.enum';
import { TenantContext } from '../types/tenant-context.type';

export const TENANT_CONTEXT_RESOLVER = Symbol('TENANT_CONTEXT_RESOLVER');

export interface TenantContextResolver {
  resolve(
    userId: string,
    organizationId: string,
  ): Promise<TenantContext | null>;
}

@Injectable()
export class TenantContextService implements TenantContextResolver {
  constructor(
    @InjectRepository(Membership)
    private readonly memberships: Repository<Membership>,
  ) {}

  async resolve(
    userId: string,
    organizationId: string,
  ): Promise<TenantContext | null> {
    const membership = await this.memberships
      .createQueryBuilder('membership')
      .select(['membership.id', 'membership.role'])
      .innerJoin(
        'membership.organization',
        'organization',
        'organization.status = :organizationStatus',
        { organizationStatus: OrganizationStatus.ACTIVE },
      )
      .innerJoin('membership.user', 'user', 'user.status = :userStatus', {
        userStatus: UserStatus.ACTIVE,
      })
      .where('membership.userId = :userId', { userId })
      .andWhere('membership.organizationId = :organizationId', {
        organizationId,
      })
      .andWhere('membership.status = :membershipStatus', {
        membershipStatus: MembershipStatus.ACTIVE,
      })
      .getOne();

    if (membership === null) {
      return null;
    }

    return {
      userId,
      organizationId,
      membershipId: membership.id,
      role: membership.role,
    };
  }
}
