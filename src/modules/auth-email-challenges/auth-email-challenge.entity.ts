import { Exclude } from 'class-transformer';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { EmailChallengePurpose } from './otp-codec';

@Entity({ name: 'auth_email_challenges' })
@Index('UQ_auth_email_challenges_user_purpose', ['userId', 'purpose'], {
  unique: true,
})
@Index('IDX_auth_email_challenges_expires_at', ['expiresAt'])
export class AuthEmailChallenge {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @Column({ type: 'varchar', length: 32 }) purpose!: EmailChallengePurpose;
  @Exclude({ toPlainOnly: true })
  @Column({
    name: 'secret_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
    select: false,
  })
  secretHash!: string | null;
  @Column({ type: 'varchar', length: 16 }) stage!:
    'otp' | 'consumed' | 'invalidated';
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
  @Column({ name: 'failed_attempts', type: 'integer' }) failedAttempts!: number;
  @Column({ name: 'last_sent_at', type: 'timestamptz' }) lastSentAt!: Date;
  @Column({ name: 'send_window_started_at', type: 'timestamptz' })
  sendWindowStartedAt!: Date;
  @Column({ name: 'send_count', type: 'integer' }) sendCount!: number;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
