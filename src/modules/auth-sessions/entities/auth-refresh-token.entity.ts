import { Exclude } from 'class-transformer';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AuthRefreshTokenStatus } from '../enums/auth-refresh-token-status.enum';
import { AuthSession } from './auth-session.entity';

@Entity({ name: 'auth_refresh_tokens' })
@Index('UQ_auth_refresh_tokens_token_hash', ['tokenHash'], { unique: true })
@Index('IDX_auth_refresh_tokens_session_id', ['sessionId'])
@Index('IDX_auth_refresh_tokens_status', ['status'])
@Index('IDX_auth_refresh_tokens_expires_at', ['expiresAt'])
@Check('CHK_auth_refresh_tokens_token_hash', `"token_hash" ~ '^[a-f0-9]{64}$'`)
@Check(
  'CHK_auth_refresh_tokens_state',
  `
    ("status" = 'active' AND "consumed_at" IS NULL AND "revoked_at" IS NULL)
    OR ("status" = 'consumed' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL)
    OR ("status" = 'revoked' AND "consumed_at" IS NULL AND "revoked_at" IS NOT NULL)
  `,
)
export class AuthRefreshToken {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Exclude({ toPlainOnly: true })
  @Column({ name: 'token_hash', type: 'varchar', length: 64, select: false })
  tokenHash!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: AuthRefreshTokenStatus,
    enumName: 'auth_refresh_token_status_enum',
    default: AuthRefreshTokenStatus.ACTIVE,
  })
  status!: AuthRefreshTokenStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'replaced_by_token_id', type: 'uuid', nullable: true })
  replacedByTokenId!: string | null;

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

  @ManyToOne(() => AuthSession, (session) => session.refreshTokens, {
    nullable: false,
    eager: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_auth_refresh_tokens_session',
  })
  session!: AuthSession;

  @OneToOne(() => AuthRefreshToken, {
    nullable: true,
    eager: false,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'replaced_by_token_id',
    foreignKeyConstraintName: 'FK_auth_refresh_tokens_replacement',
  })
  replacedByToken!: AuthRefreshToken | null;
}
