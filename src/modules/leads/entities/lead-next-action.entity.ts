import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import {
  LeadNextActionCancellationReason,
  LeadNextActionStatus,
  LeadNextActionType,
} from '../enums/lead.enums';

@Entity({ name: 'lead_next_actions' })
@Index(
  'UQ_lead_next_actions_id_organization_lead',
  ['id', 'organizationId', 'leadId'],
  { unique: true },
)
@Index('UQ_lead_next_actions_one_pending', ['leadId'], {
  unique: true,
  where: '"status" = \'pending\'',
})
export class LeadNextAction {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'lead_id', type: 'uuid' }) leadId!: string;
  @Column({ name: 'cycle_id', type: 'uuid' }) cycleId!: string;
  @Column({
    type: 'enum',
    enum: LeadNextActionType,
    enumName: 'lead_next_action_type_enum',
  })
  type!: LeadNextActionType;
  @Column({ type: 'varchar', length: 500 }) description!: string;
  @Column({ name: 'due_at', type: 'timestamptz' }) dueAt!: Date;
  @Column({ name: 'responsible_membership_id', type: 'uuid', nullable: true })
  responsibleMembershipId!: string | null;
  @Column({
    type: 'enum',
    enum: LeadNextActionStatus,
    enumName: 'lead_next_action_status_enum',
  })
  status!: LeadNextActionStatus;
  @Column({ type: 'bigint', default: 1 }) revision!: string;
  @Column({ name: 'created_by_membership_id', type: 'uuid' })
  createdByMembershipId!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'completed_by_membership_id', type: 'uuid', nullable: true })
  completedByMembershipId!: string | null;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
  @Column({ name: 'canceled_by_membership_id', type: 'uuid', nullable: true })
  canceledByMembershipId!: string | null;
  @Column({ name: 'canceled_at', type: 'timestamptz', nullable: true })
  canceledAt!: Date | null;
  @Column({
    name: 'cancellation_reason',
    type: 'enum',
    enum: LeadNextActionCancellationReason,
    enumName: 'lead_next_action_cancellation_reason_enum',
    nullable: true,
  })
  cancellationReason!: LeadNextActionCancellationReason | null;
  @Column({
    name: 'cancellation_note',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  cancellationNote!: string | null;
}
