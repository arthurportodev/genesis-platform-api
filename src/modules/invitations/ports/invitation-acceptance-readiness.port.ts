import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InvitationTokenKeyring } from './invitation-token-keyring.port';

export const INVITATION_ACCEPTANCE_READINESS = Symbol(
  'INVITATION_ACCEPTANCE_READINESS',
);

export interface InvitationAcceptanceReadiness {
  assertReady(): Promise<void>;
}

export class ConfiguredInvitationAcceptanceReadiness implements InvitationAcceptanceReadiness {
  constructor(private readonly enabled: boolean) {}

  assertReady(): Promise<void> {
    if (!this.enabled) {
      return Promise.reject(
        new ServiceUnavailableException(
          'Invitation acceptance is unavailable.',
        ),
      );
    }
    return Promise.resolve();
  }
}

export class OperationalInvitationAcceptanceReadiness implements InvitationAcceptanceReadiness {
  private readonly logger = new Logger(
    OperationalInvitationAcceptanceReadiness.name,
  );

  constructor(
    private readonly enabled: boolean,
    private readonly keyring: InvitationTokenKeyring,
    private readonly dataSource: DataSource,
  ) {}

  async assertReady(): Promise<void> {
    if (!this.enabled) this.unavailable('disabled');
    let rows: Array<{ keyVersion: number }>;
    try {
      rows = await this.dataSource.query<Array<{ keyVersion: number }>>(
        `SELECT DISTINCT token_key_version AS "keyVersion"
         FROM organization_invitations
         WHERE status = 'pending'
           AND expires_at > transaction_timestamp()
         ORDER BY token_key_version`,
      );
    } catch {
      this.unavailable('database_unavailable');
    }
    for (const row of rows) {
      let key: Buffer;
      try {
        key = this.keyring.keyFor(row.keyVersion);
      } catch {
        this.unavailable('key_unavailable');
      }
      if (key.length < 32) {
        this.unavailable('key_unavailable');
      }
    }
  }

  private unavailable(code: string): never {
    this.logger.warn(
      JSON.stringify({
        event: 'invitation_acceptance_readiness_failed',
        code,
      }),
    );
    throw new ServiceUnavailableException(
      'Invitation acceptance is unavailable.',
    );
  }
}
