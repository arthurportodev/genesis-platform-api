import { Injectable, Logger } from '@nestjs/common';

export type InvitationActivationRejection = 'cryptographic' | 'domain';
export type InvitationActivationRateScope =
  'ip' | 'invitation_ip' | 'hash_capacity';
export type InvitationActivationRollbackCode = 'database' | 'unexpected';

@Injectable()
export class InvitationActivationObservability {
  private readonly logger = new Logger(InvitationActivationObservability.name);

  rejected(reason: InvitationActivationRejection): void {
    this.logger.warn(
      JSON.stringify({ event: 'invitation_activation_rejected', reason }),
    );
  }

  rateLimited(scope: InvitationActivationRateScope): void {
    this.logger.warn(
      JSON.stringify({ event: 'invitation_activation_rate_limited', scope }),
    );
  }

  succeeded(): void {
    this.logger.log(
      JSON.stringify({ event: 'invitation_activation_succeeded' }),
    );
  }

  emailRace(): void {
    this.logger.warn(
      JSON.stringify({ event: 'invitation_activation_email_race' }),
    );
  }

  rollback(code: InvitationActivationRollbackCode): void {
    this.logger.error(
      JSON.stringify({ event: 'invitation_activation_rollback', code }),
    );
  }
}
