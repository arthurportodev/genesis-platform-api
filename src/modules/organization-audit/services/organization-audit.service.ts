import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OrganizationAuditLog } from '../entities/organization-audit-log.entity';

export type OrganizationAuditRecord = Omit<
  OrganizationAuditLog,
  'id' | 'occurredAt' | 'membershipResult'
> & { membershipResult?: OrganizationAuditLog['membershipResult'] };

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
      }),
    );
  }
}
