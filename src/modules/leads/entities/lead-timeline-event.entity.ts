import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { LeadTimelineEventType } from '../enums/lead.enums';
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
