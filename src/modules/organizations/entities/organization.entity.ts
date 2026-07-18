import {
  BeforeInsert,
  BeforeUpdate,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Membership } from '../../memberships/entities/membership.entity';
import { OrganizationStatus } from '../enums/organization-status.enum';

@Entity({ name: 'organizations' })
@Index('UQ_organizations_slug', ['slug'], { unique: true })
@Check(
  'CHK_organizations_name_trimmed',
  '"name" = btrim("name") AND length("name") > 0',
)
@Check(
  'CHK_organizations_slug_format',
  '"slug" ~ \'^[a-z0-9]+(?:-[a-z0-9]+)*$\'',
)
export class Organization {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'name', type: 'varchar', length: 160 })
  name!: string;

  @Column({ name: 'slug', type: 'varchar', length: 120 })
  slug!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: OrganizationStatus,
    enumName: 'organization_status_enum',
    default: OrganizationStatus.ACTIVE,
  })
  status!: OrganizationStatus;

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

  @OneToMany(() => Membership, (membership) => membership.organization)
  memberships!: Membership[];

  @BeforeInsert()
  @BeforeUpdate()
  normalize(): void {
    this.name = this.name.trim();
    this.slug = this.slug.trim().toLowerCase();
  }
}
