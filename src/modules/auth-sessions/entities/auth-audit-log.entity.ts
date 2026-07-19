import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AuthAuditEventType } from '../enums/auth-audit-event-type.enum';

export type AuthAuditMetadata = Record<
  string,
  string | number | boolean | null
>;

@Entity({ name: 'auth_audit_logs' })
@Index('IDX_auth_audit_logs_user_id', ['userId'])
@Index('IDX_auth_audit_logs_event_type', ['eventType'])
@Index('IDX_auth_audit_logs_created_at', ['createdAt'])
export class AuthAuditLog {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId!: string | null;

  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: AuthAuditEventType;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  @Exclude({ toPlainOnly: true })
  @Column({ name: 'metadata', type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: AuthAuditMetadata;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt!: Date;
}
