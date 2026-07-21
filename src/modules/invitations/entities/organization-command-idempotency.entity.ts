import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  InvitationCommandOperation,
  InvitationDeliveryStatus,
  InvitationEffectiveState,
  InvitationRole,
} from '../enums/invitation.enums';

@Entity({ name: 'organization_command_idempotency' })
@Index(
  'UQ_organization_command_idempotency_scope',
  ['organizationId', 'actorMembershipId', 'operation', 'idempotencyKey'],
  { unique: true },
)
@Index('IDX_organization_command_idempotency_cleanup', ['createdAt'])
export class OrganizationCommandIdempotency {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'actor_membership_id', type: 'uuid' })
  actorMembershipId!: string;

  @Column({ name: 'operation', type: 'varchar', length: 32 })
  operation!: InvitationCommandOperation;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey!: string;

  @Column({ name: 'fingerprint', type: 'varchar', length: 64 })
  fingerprint!: string;

  @Column({ name: 'result_previous_invitation_id', type: 'uuid' })
  resultPreviousInvitationId!: string;

  @Column({ name: 'result_invitation_id', type: 'uuid' })
  resultInvitationId!: string;

  @Column({ name: 'response_email_normalized', type: 'varchar', length: 320 })
  responseEmailNormalized!: string;

  @Column({ name: 'response_invited_role', type: 'varchar', length: 16 })
  responseInvitedRole!: InvitationRole;

  @Column({ name: 'response_invitation_created_at', type: 'timestamptz' })
  responseInvitationCreatedAt!: Date;

  @Column({ name: 'response_invitation_updated_at', type: 'timestamptz' })
  responseInvitationUpdatedAt!: Date;

  @Column({ name: 'response_invitation_expires_at', type: 'timestamptz' })
  responseInvitationExpiresAt!: Date;

  @Column({ name: 'response_invited_by_membership_id', type: 'uuid' })
  responseInvitedByMembershipId!: string;

  @Column({ name: 'result_state_at_creation', type: 'varchar', length: 16 })
  resultStateAtCreation!: InvitationEffectiveState.PENDING;

  @Column({
    name: 'result_delivery_status_at_creation',
    type: 'varchar',
    length: 16,
  })
  resultDeliveryStatusAtCreation!: InvitationDeliveryStatus.QUEUED;

  @Column({ name: 'response_status', type: 'smallint' })
  responseStatus!: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt!: Date;
}
