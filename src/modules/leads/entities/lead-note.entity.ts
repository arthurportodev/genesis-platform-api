import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'lead_notes' })
@Index(
  'UQ_lead_notes_id_organization_lead',
  ['id', 'organizationId', 'leadId'],
  { unique: true },
)
export class LeadNote {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'lead_id', type: 'uuid' }) leadId!: string;
  @Column({ name: 'cycle_id', type: 'uuid' }) cycleId!: string;
  @Column({ type: 'varchar', length: 4000 }) content!: string;
  @Column({ name: 'author_membership_id', type: 'uuid' })
  authorMembershipId!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
