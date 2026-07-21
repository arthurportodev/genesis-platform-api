import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  InvitationRevocationReason,
  InvitationRole,
} from '../../invitations/enums/invitation.enums';
import { OrganizationAuditEventType } from '../enums/organization-audit-event-type.enum';

@Entity({ name: 'organization_audit_logs' })
@Index('IDX_organization_audit_logs_org_occurred', [
  'organizationId',
  'occurredAt',
])
@Index('IDX_organization_audit_logs_invitation', ['invitationId'])
export class OrganizationAuditLog {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 96 })
  eventType!: OrganizationAuditEventType;

  @Column({ name: 'invitation_id', type: 'uuid', nullable: true })
  invitationId!: string | null;

  @Column({ name: 'related_invitation_id', type: 'uuid', nullable: true })
  relatedInvitationId!: string | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({ name: 'actor_membership_id', type: 'uuid', nullable: true })
  actorMembershipId!: string | null;

  @Column({ name: 'invited_role', type: 'varchar', length: 16, nullable: true })
  invitedRole!: InvitationRole | null;

  @Column({ name: 'reason', type: 'varchar', length: 64, nullable: true })
  reason!: InvitationRevocationReason | null;

  @Column({ name: 'correlation_id', type: 'uuid', nullable: true })
  correlationId!: string | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({
    name: 'occurred_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  occurredAt!: Date;
}
