import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity({ name: 'auth_identities' })
@Index('UQ_auth_identities_provider_subject', ['provider', 'providerSubject'], {
  unique: true,
})
@Index('UQ_auth_identities_user_provider', ['userId', 'provider'], {
  unique: true,
})
@Index('IDX_auth_identities_user_id', ['userId'])
@Check('CHK_auth_identities_provider', `"provider" = 'google'`)
@Check(
  'CHK_auth_identities_subject',
  '"provider_subject" = btrim("provider_subject") AND length("provider_subject") > 0',
)
@Check(
  'CHK_auth_identities_email_normalized',
  '"provider_email" = lower(btrim("provider_email")) AND length("provider_email") BETWEEN 3 AND 320 AND strpos("provider_email", \'@\') >= 2',
)
export class AuthIdentity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'provider', type: 'varchar', length: 32 })
  provider!: 'google';

  @Column({ name: 'provider_subject', type: 'varchar', length: 255 })
  providerSubject!: string;

  @Column({ name: 'provider_email', type: 'varchar', length: 320 })
  providerEmail!: string;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_auth_identities_user',
  })
  user!: User;
}
