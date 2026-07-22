import { Logger } from '@nestjs/common';
import { InvitationActivationObservability } from '../src/modules/invitations/services/invitation-activation-observability.service';

describe('InvitationActivationObservability', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  const observability = new InvitationActivationObservability();

  beforeEach(() => {
    warn.mockClear();
    log.mockClear();
    error.mockClear();
  });

  afterAll(() => {
    warn.mockRestore();
    log.mockRestore();
    error.mockRestore();
  });

  it('emits only allowlisted cryptographic and domain rejection reasons', () => {
    observability.rejected('cryptographic');
    observability.rejected('domain');
    expect(warn.mock.calls).toEqual([
      [
        JSON.stringify({
          event: 'invitation_activation_rejected',
          reason: 'cryptographic',
        }),
      ],
      [
        JSON.stringify({
          event: 'invitation_activation_rejected',
          reason: 'domain',
        }),
      ],
    ]);
  });

  it.each(['ip', 'invitation_ip', 'hash_capacity'] as const)(
    'emits the allowlisted %s rate-limit scope',
    (scope) => {
      observability.rateLimited(scope);
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'invitation_activation_rate_limited',
          scope,
        }),
      );
    },
  );

  it('emits closed success, race, and rollback events without secrets', () => {
    observability.succeeded();
    observability.emailRace();
    observability.rollback('database');
    observability.rollback('unexpected');
    const output = JSON.stringify({
      warn: warn.mock.calls,
      log: log.mock.calls,
      error: error.mock.calls,
    });
    expect(output).toContain('invitation_activation_succeeded');
    expect(output).toContain('invitation_activation_email_race');
    expect(output).toContain('invitation_activation_rollback');
    expect(output).not.toMatch(/token|password|constraint|user_id/u);
  });
});
