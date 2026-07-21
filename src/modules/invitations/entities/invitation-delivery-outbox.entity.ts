import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  InvitationDeliveryEventType,
  InvitationDeliveryStatus,
} from '../enums/invitation.enums';

@Entity({ name: 'invitation_delivery_outbox' })
@Index(
  'UQ_invitation_delivery_outbox_event',
  ['invitationId', 'tokenVersion', 'eventType'],
  { unique: true },
)
@Index('IDX_invitation_delivery_outbox_dispatch', [
  'status',
  'nextAttemptAt',
  'createdAt',
])
export class InvitationDeliveryOutbox {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'invitation_id', type: 'uuid' })
  invitationId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: InvitationDeliveryEventType;

  @Column({ name: 'token_version', type: 'smallint' })
  tokenVersion!: number;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    default: InvitationDeliveryStatus.QUEUED,
  })
  status!: InvitationDeliveryStatus;

  @Column({ name: 'attempts', type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'locked_by', type: 'varchar', length: 128, nullable: true })
  lockedBy!: string | null;

  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt!: Date | null;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerMessageId!: string | null;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updatedAt!: Date;
}
