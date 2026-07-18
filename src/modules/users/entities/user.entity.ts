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
import { UserStatus } from '../enums/user-status.enum';

@Entity({ name: 'users' })
@Index('UQ_users_email', ['email'], { unique: true })
@Check('CHK_users_email_normalized', '"email" = lower(btrim("email"))')
@Check(
  'CHK_users_name_trimmed',
  '"name" = btrim("name") AND length("name") > 0',
)
export class User {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'email', type: 'varchar', length: 320 })
  email!: string;

  @Column({ name: 'name', type: 'varchar', length: 160 })
  name!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: UserStatus,
    enumName: 'user_status_enum',
    default: UserStatus.ACTIVE,
  })
  status!: UserStatus;

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

  @OneToMany(() => Membership, (membership) => membership.user)
  memberships!: Membership[];

  @BeforeInsert()
  @BeforeUpdate()
  normalize(): void {
    this.email = this.email.trim().toLowerCase();
    this.name = this.name.trim();
  }
}
