import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { AuthSessionStatus } from '../enums/auth-session-status.enum';
import { AuthRefreshToken } from './auth-refresh-token.entity';

@Entity({ name: 'auth_sessions' })
@Index('IDX_auth_sessions_user_id', ['userId'])
@Index('IDX_auth_sessions_status', ['status'])
@Index('IDX_auth_sessions_expires_at', ['expiresAt'])
@Check(
  'CHK_auth_sessions_revocation_state',
  `("status" = 'active' AND "revoked_at" IS NULL) OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)`,
)
export class AuthSession {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: AuthSessionStatus,
    enumName: 'auth_session_status_enum',
    default: AuthSessionStatus.ACTIVE,
  })
  status!: AuthSessionStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({
    name: 'revoke_reason',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  revokeReason!: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

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

  @ManyToOne(() => User, (user) => user.authSessions, {
    nullable: false,
    eager: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_auth_sessions_user',
  })
  user!: User;

  @OneToMany(() => AuthRefreshToken, (token) => token.session)
  refreshTokens!: AuthRefreshToken[];
}
