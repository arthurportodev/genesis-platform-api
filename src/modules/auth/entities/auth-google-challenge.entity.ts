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

export type GoogleChallengeStage =
  'issued' | 'profile_pending' | 'link_pending' | 'consumed';

@Entity({ name: 'auth_google_challenges' })
@Index('UQ_auth_google_challenges_token_hash', ['tokenHash'], { unique: true })
@Index('UQ_auth_google_challenges_nonce_hash', ['nonceHash'], { unique: true })
@Index('IDX_auth_google_challenges_expires_at', ['expiresAt'])
@Check(
  'CHK_auth_google_challenges_token_hash',
  `"token_hash" ~ '^[a-f0-9]{64}$'`,
)
@Check(
  'CHK_auth_google_challenges_nonce_hash',
  `"nonce_hash" ~ '^[a-f0-9]{64}$'`,
)
@Check(
  'CHK_auth_google_challenges_stage',
  `"stage" IN ('issued','profile_pending','link_pending','consumed')`,
)
@Check(
  'CHK_auth_google_challenges_continuation',
  `("stage" = 'issued' AND "provider_subject" IS NULL AND "provider_email" IS NULL AND "user_id" IS NULL) OR
   ("stage" = 'profile_pending' AND "provider_subject" IS NOT NULL AND "provider_email" IS NOT NULL AND "user_id" IS NULL) OR
   ("stage" = 'link_pending' AND "provider_subject" IS NOT NULL AND "provider_email" IS NOT NULL AND "user_id" IS NOT NULL) OR
   ("stage" = 'consumed' AND "consumed_at" IS NOT NULL)`,
)
export class AuthGoogleChallenge {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64, select: false })
  tokenHash!: string;

  @Column({ name: 'nonce_hash', type: 'varchar', length: 64, select: false })
  nonceHash!: string;

  @Column({ name: 'stage', type: 'varchar', length: 32 })
  stage!: GoogleChallengeStage;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({
    name: 'provider_subject',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerSubject!: string | null;

  @Column({
    name: 'provider_email',
    type: 'varchar',
    length: 320,
    nullable: true,
  })
  providerEmail!: string | null;

  @Column({ name: 'email_authoritative', type: 'boolean', nullable: true })
  emailAuthoritative!: boolean | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'failed_attempts', type: 'smallint', default: 0 })
  failedAttempts!: number;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_auth_google_challenges_user',
  })
  user!: User | null;
}
