import { AuthAuditLog } from '../src/modules/auth-sessions/entities/auth-audit-log.entity';
import { AuthAuditEventType } from '../src/modules/auth-sessions/enums/auth-audit-event-type.enum';
import {
  AuthAuditService,
  sanitizeAuditMetadata,
} from '../src/modules/auth/services/auth-audit.service';
import { Repository } from 'typeorm';

describe('AuthAuditService', () => {
  it('removes sensitive metadata keys and bounds strings', () => {
    const sanitized = sanitizeAuditMetadata({
      reason: 'invalid_credentials',
      password: 'must-not-be-stored',
      refreshTokenHash: 'must-not-be-stored',
      detail: 'x'.repeat(300),
    });

    expect(sanitized).toEqual({
      reason: 'invalid_credentials',
      detail: 'x'.repeat(256),
    });
  });

  it('persists only the sanitized event context', async () => {
    const create = jest.fn((value: AuthAuditLog) => value);
    const save = jest.fn().mockResolvedValue(undefined);
    const repository = { create, save } as unknown as Repository<AuthAuditLog>;
    const service = new AuthAuditService(repository);

    await service.record({
      eventType: AuthAuditEventType.LOGIN_FAILED,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      metadata: { reason: 'invalid_credentials', token: 'not-stored' },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AuthAuditEventType.LOGIN_FAILED,
        metadata: { reason: 'invalid_credentials' },
      }),
    );
  });
});
