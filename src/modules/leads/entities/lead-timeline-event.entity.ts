import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  LeadArchiveReason,
  LeadLostReason,
  LeadStage,
  LeadStatus,
  LeadTimelineEventType,
} from '../enums/lead.enums';
import { Lead } from './lead.entity';

@Entity({ name: 'lead_timeline_events' })
@Index('UQ_lead_timeline_events_lead_sequence', ['leadId', 'sequence'], {
  unique: true,
})
export class LeadTimelineEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'lead_id', type: 'uuid' }) leadId!: string;
  @Column({ type: 'bigint' }) sequence!: string;
  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: LeadTimelineEventType;
  @Column({ name: 'actor_membership_id', type: 'uuid', nullable: true })
  actorMembershipId!: string | null;
  @Column({ name: 'lead_entry_id', type: 'uuid', nullable: true })
  leadEntryId!: string | null;
  @Column({
    name: 'previous_responsible_membership_id',
    type: 'uuid',
    nullable: true,
  })
  previousResponsibleMembershipId!: string | null;
  @Column({
    name: 'new_responsible_membership_id',
    type: 'uuid',
    nullable: true,
  })
  newResponsibleMembershipId!: string | null;
  @Column({ name: 'changed_fields', type: 'text', array: true, nullable: true })
  changedFields!: string[] | null;
  @Column({ name: 'cycle_id', type: 'uuid', nullable: true })
  cycleId!: string | null;
  @Column({ name: 'return_review_id', type: 'uuid', nullable: true })
  returnReviewId!: string | null;
  @Column({
    name: 'previous_status',
    type: 'enum',
    enum: LeadStatus,
    enumName: 'lead_status_enum',
    nullable: true,
  })
  previousStatus!: LeadStatus | null;
  @Column({
    name: 'new_status',
    type: 'enum',
    enum: LeadStatus,
    enumName: 'lead_status_enum',
    nullable: true,
  })
  newStatus!: LeadStatus | null;
  @Column({
    name: 'previous_stage',
    type: 'enum',
    enum: LeadStage,
    enumName: 'lead_stage_enum',
    nullable: true,
  })
  previousStage!: LeadStage | null;
  @Column({
    name: 'new_stage',
    type: 'enum',
    enum: LeadStage,
    enumName: 'lead_stage_enum',
    nullable: true,
  })
  newStage!: LeadStage | null;
  @Column({
    name: 'lost_reason',
    type: 'enum',
    enum: LeadLostReason,
    enumName: 'lead_lost_reason_enum',
    nullable: true,
  })
  lostReason!: LeadLostReason | null;
  @Column({
    name: 'archive_reason',
    type: 'enum',
    enum: LeadArchiveReason,
    enumName: 'lead_archive_reason_enum',
    nullable: true,
  })
  archiveReason!: LeadArchiveReason | null;
  @CreateDateColumn({
    name: 'occurred_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  occurredAt!: Date;

  @ManyToOne(() => Lead, (lead) => lead.timeline, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'lead_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  lead!: Lead;
}
