import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Membership } from '../../memberships/entities/membership.entity';
import { LeadReturnReviewStatus } from '../enums/lead.enums';
import { Lead } from './lead.entity';
import { LeadCommercialCycle } from './lead-commercial-cycle.entity';
import { LeadEntry } from './lead-entry.entity';

@Entity({ name: 'lead_return_reviews' })
@Index('UQ_lead_return_reviews_id_organization', ['id', 'organizationId'], {
  unique: true,
})
export class LeadReturnReview {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'lead_id', type: 'uuid' }) leadId!: string;
  @Column({ name: 'cycle_id', type: 'uuid' }) cycleId!: string;
  @Column({
    type: 'enum',
    enum: LeadReturnReviewStatus,
    enumName: 'lead_return_review_status_enum',
  })
  status!: LeadReturnReviewStatus;
  @Column({ name: 'first_entry_id', type: 'uuid' }) firstEntryId!: string;
  @Column({ name: 'latest_entry_id', type: 'uuid' }) latestEntryId!: string;
  @Column({ name: 'entry_count', type: 'bigint' }) entryCount!: string;
  @Column({ name: 'opened_at', type: 'timestamptz' }) openedAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;
  @Column({ name: 'resolved_by_membership_id', type: 'uuid', nullable: true })
  resolvedByMembershipId!: string | null;

  @ManyToOne(() => Lead, (lead) => lead.returnReviews, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'lead_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  lead!: Lead;

  @ManyToOne(() => LeadCommercialCycle, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'cycle_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  cycle!: LeadCommercialCycle;

  @ManyToOne(() => LeadEntry, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'first_entry_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  firstEntry!: LeadEntry;

  @ManyToOne(() => Membership, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'resolved_by_membership_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  resolvedByMembership!: Membership | null;
}
