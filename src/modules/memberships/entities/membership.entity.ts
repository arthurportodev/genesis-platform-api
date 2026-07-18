import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from '../../organizations/entities/organization.entity';
import { User } from '../../users/entities/user.entity';
import { MembershipRole } from '../enums/membership-role.enum';
import { MembershipStatus } from '../enums/membership-status.enum';

@Entity({ name: 'memberships' })
@Index('UQ_memberships_user_organization', ['userId', 'organizationId'], {
  unique: true,
})
@Index('IDX_memberships_user_id', ['userId'])
@Index('IDX_memberships_organization_id', ['organizationId'])
@Index('IDX_memberships_organization_status', ['organizationId', 'status'])
export class Membership {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({
    name: 'role',
    type: 'enum',
    enum: MembershipRole,
    enumName: 'membership_role_enum',
  })
  role!: MembershipRole;

  @Column({
    name: 'status',
    type: 'enum',
    enum: MembershipStatus,
    enumName: 'membership_status_enum',
    default: MembershipStatus.ACTIVE,
  })
  status!: MembershipStatus;

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

  @ManyToOne(() => User, (user) => user.memberships, {
    nullable: false,
    eager: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_memberships_user',
  })
  user!: User;

  @ManyToOne(() => Organization, (organization) => organization.memberships, {
    nullable: false,
    eager: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_memberships_organization',
  })
  organization!: Organization;
}
