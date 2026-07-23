import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Membership } from '../../memberships/entities/membership.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { LeadEntry } from './lead-entry.entity';
import { LeadTimelineEvent } from './lead-timeline-event.entity';

@Entity({ name: 'leads' })
@Index('UQ_leads_organization_phone', ['organizationId', 'primaryPhone'], {
  unique: true,
})
@Index('UQ_leads_id_organization', ['id', 'organizationId'], { unique: true })
@Index('IDX_leads_organization_responsible', [
  'organizationId',
  'responsibleMembershipId',
])
export class Lead {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'display_name', type: 'varchar', length: 160 })
  displayName!: string;
  @Column({ name: 'primary_phone', type: 'varchar', length: 16 })
  primaryPhone!: string;
  @Column({ type: 'varchar', length: 320, nullable: true }) email!:
    string | null;
  @Column({
    name: 'company_name',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  companyName!: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) instagram!:
    string | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) city!:
    string | null;
  @Column({
    name: 'service_interest',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  serviceInterest!: string | null;
  @Column({ name: 'responsible_membership_id', type: 'uuid', nullable: true })
  responsibleMembershipId!: string | null;
  @Column({ name: 'created_by_membership_id', type: 'uuid', nullable: true })
  createdByMembershipId!: string | null;
  @Column({ type: 'bigint', default: 0 }) revision!: string;
  @Column({ name: 'next_entry_sequence', type: 'bigint', default: 1 })
  nextEntrySequence!: string;
  @Column({ name: 'next_event_sequence', type: 'bigint', default: 1 })
  nextEventSequence!: string;
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

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_leads_organization',
  })
  organization!: Organization;

  @ManyToOne(() => Membership, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'responsible_membership_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  responsibleMembership!: Membership | null;

  @OneToMany(() => LeadEntry, (entry) => entry.lead) entries!: LeadEntry[];
  @OneToMany(() => LeadTimelineEvent, (event) => event.lead)
  timeline!: LeadTimelineEvent[];
}
