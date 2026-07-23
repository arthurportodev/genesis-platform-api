import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Membership } from '../../memberships/entities/membership.entity';
import { LeadIntakeChannel, LeadSource } from '../enums/lead.enums';
import { Lead } from './lead.entity';

@Entity({ name: 'lead_entries' })
@Index('UQ_lead_entries_lead_sequence', ['leadId', 'sequence'], {
  unique: true,
})
@Index('UQ_lead_entries_id_organization', ['id', 'organizationId'], {
  unique: true,
})
export class LeadEntry {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'lead_id', type: 'uuid' }) leadId!: string;
  @Column({ type: 'bigint' }) sequence!: string;
  @Column({ name: 'intake_channel', type: 'varchar', length: 32 })
  intakeChannel!: LeadIntakeChannel;
  @Column({ type: 'varchar', length: 32 }) source!: LeadSource;
  @Column({
    name: 'source_detail',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  sourceDetail!: string | null;
  @Column({ name: 'utm_source', type: 'varchar', length: 255, nullable: true })
  utmSource!: string | null;
  @Column({ name: 'utm_medium', type: 'varchar', length: 255, nullable: true })
  utmMedium!: string | null;
  @Column({
    name: 'utm_campaign',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  utmCampaign!: string | null;
  @Column({ name: 'utm_content', type: 'varchar', length: 255, nullable: true })
  utmContent!: string | null;
  @Column({ name: 'utm_term', type: 'varchar', length: 255, nullable: true })
  utmTerm!: string | null;
  @Column({ name: 'actor_membership_id', type: 'uuid', nullable: true })
  actorMembershipId!: string | null;
  @Column({ name: 'received_at', type: 'timestamptz' }) receivedAt!: Date;
  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt!: Date;

  @ManyToOne(() => Lead, (lead) => lead.entries, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'lead_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  lead!: Lead;

  @ManyToOne(() => Membership, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'actor_membership_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  actorMembership!: Membership | null;
}
