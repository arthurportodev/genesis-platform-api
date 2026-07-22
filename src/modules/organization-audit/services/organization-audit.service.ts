import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OrganizationAuditLog } from '../entities/organization-audit-log.entity';

export type OrganizationAuditRecord = Omit<
  OrganizationAuditLog,
  | 'id'
  | 'occurredAt'
  | 'membershipResult'
  | 'targetMembershipId'
  | 'membershipAction'
  | 'previousRole'
  | 'newRole'
  | 'previousMembershipStatus'
  | 'newMembershipStatus'
> & {
  membershipResult?: OrganizationAuditLog['membershipResult'];
  targetMembershipId?: OrganizationAuditLog['targetMembershipId'];
  membershipAction?: OrganizationAuditLog['membershipAction'];
  previousRole?: OrganizationAuditLog['previousRole'];
  newRole?: OrganizationAuditLog['newRole'];
  previousMembershipStatus?: OrganizationAuditLog['previousMembershipStatus'];
  newMembershipStatus?: OrganizationAuditLog['newMembershipStatus'];
};

@Injectable()
export class OrganizationAuditService {
  async record(
    input: OrganizationAuditRecord,
    manager: EntityManager,
  ): Promise<void> {
    const repository = manager.getRepository(OrganizationAuditLog);
    await repository.insert(
      repository.create({
        ...input,
        membershipResult: input.membershipResult ?? null,
        targetMembershipId: input.targetMembershipId ?? null,
        membershipAction: input.membershipAction ?? null,
        previousRole: input.previousRole ?? null,
        newRole: input.newRole ?? null,
        previousMembershipStatus: input.previousMembershipStatus ?? null,
        newMembershipStatus: input.newMembershipStatus ?? null,
      }),
    );
  }
}
