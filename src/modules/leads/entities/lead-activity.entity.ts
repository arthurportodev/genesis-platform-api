import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { LeadActivityType } from '../enums/lead.enums';

@Entity({ name: 'lead_activities' })
@Index(
  'UQ_lead_activities_id_organization_lead',
  ['id', 'organizationId', 'leadId'],
  { unique: true },
)
@Index('UQ_lead_activities_next_action', ['nextActionId'], { unique: true })
export class LeadActivity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'lead_id', type: 'uuid' }) leadId!: string;
  @Column({ name: 'cycle_id', type: 'uuid' }) cycleId!: string;
  @Column({
    type: 'enum',
    enum: LeadActivityType,
    enumName: 'lead_activity_type_enum',
  })
  type!: LeadActivityType;
  @Column({ name: 'performed_at', type: 'timestamptz' }) performedAt!: Date;
  @Column({ name: 'recorded_at', type: 'timestamptz' }) recordedAt!: Date;
  @Column({ name: 'recorded_by_membership_id', type: 'uuid' })
  recordedByMembershipId!: string;
  @Column({ name: 'responsible_membership_id', type: 'uuid', nullable: true })
  responsibleMembershipId!: string | null;
  @Column({ type: 'varchar', length: 2000, nullable: true }) outcome!:
    string | null;
  @Column({ name: 'next_action_id', type: 'uuid', nullable: true })
  nextActionId!: string | null;
}
