import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Membership } from '../../memberships/entities/membership.entity';
import {
  LeadArchiveReason,
  LeadCycleOpeningReason,
  LeadLostReason,
  LeadStage,
  LeadStatus,
} from '../enums/lead.enums';
import { Lead } from './lead.entity';

@Entity({ name: 'lead_commercial_cycles' })
@Index('UQ_lead_commercial_cycles_id_organization', ['id', 'organizationId'], {
  unique: true,
})
@Index('UQ_lead_commercial_cycles_lead_number', ['leadId', 'cycleNumber'], {
  unique: true,
})
export class LeadCommercialCycle {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'lead_id', type: 'uuid' }) leadId!: string;
  @Column({ name: 'cycle_number', type: 'bigint' }) cycleNumber!: string;
  @Column({
    name: 'opening_reason',
    type: 'enum',
    enum: LeadCycleOpeningReason,
    enumName: 'lead_cycle_opening_reason_enum',
  })
  openingReason!: LeadCycleOpeningReason;
  @Column({
    name: 'starting_stage',
    type: 'enum',
    enum: LeadStage,
    enumName: 'lead_stage_enum',
  })
  startingStage!: LeadStage;
  @Column({ name: 'opened_by_membership_id', type: 'uuid', nullable: true })
  openedByMembershipId!: string | null;
  @Column({ name: 'opened_at', type: 'timestamptz' }) openedAt!: Date;
  @Column({ name: 'closed_by_membership_id', type: 'uuid', nullable: true })
  closedByMembershipId!: string | null;
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;
  @Column({
    name: 'closing_status',
    type: 'enum',
    enum: LeadStatus,
    enumName: 'lead_status_enum',
    nullable: true,
  })
  closingStatus!: LeadStatus | null;
  @Column({
    name: 'stage_at_close',
    type: 'enum',
    enum: LeadStage,
    enumName: 'lead_stage_enum',
    nullable: true,
  })
  stageAtClose!: LeadStage | null;
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
  @Column({ name: 'reason_note', type: 'varchar', length: 500, nullable: true })
  reasonNote!: string | null;

  @ManyToOne(() => Lead, (lead) => lead.commercialCycles, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn([
    { name: 'lead_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  lead!: Lead;

  @ManyToOne(() => Membership, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'opened_by_membership_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  openedByMembership!: Membership | null;
}
