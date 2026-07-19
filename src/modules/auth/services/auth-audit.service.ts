import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  AuthAuditLog,
  AuthAuditMetadata,
} from '../../auth-sessions/entities/auth-audit-log.entity';
import { AuthAuditEventType } from '../../auth-sessions/enums/auth-audit-event-type.enum';
import { AuthRequestContext } from '../types/authenticated-user.type';

export interface AuthAuditInput extends AuthRequestContext {
  eventType: AuthAuditEventType;
  userId?: string | null;
  sessionId?: string | null;
  metadata?: AuthAuditMetadata;
}

const SENSITIVE_METADATA_KEY = /password|token|secret|hash|authorization/i;

export function sanitizeAuditMetadata(
  metadata: AuthAuditMetadata = {},
): AuthAuditMetadata {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !SENSITIVE_METADATA_KEY.test(key))
      .map(([key, value]) => [
        key,
        typeof value === 'string' ? value.slice(0, 256) : value,
      ]),
  );
}

@Injectable()
export class AuthAuditService {
  constructor(
    @InjectRepository(AuthAuditLog)
    private readonly auditLogs: Repository<AuthAuditLog>,
  ) {}

  async record(input: AuthAuditInput, manager?: EntityManager): Promise<void> {
    const repository = manager
      ? manager.getRepository(AuthAuditLog)
      : this.auditLogs;
    await repository.save(
      repository.create({
        eventType: input.eventType,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        metadata: sanitizeAuditMetadata(input.metadata),
      }),
    );
  }
}
