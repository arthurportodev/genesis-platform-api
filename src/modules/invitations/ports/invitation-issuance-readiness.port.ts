import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export const INVITATION_ISSUANCE_READINESS = Symbol(
  'INVITATION_ISSUANCE_READINESS',
);

export interface InvitationIssuanceReadiness {
  assertReady(): void;
}

@Injectable()
export class DisabledInvitationIssuanceReadiness implements InvitationIssuanceReadiness {
  assertReady(): never {
    throw new ServiceUnavailableException(
      'Invitation delivery is unavailable.',
    );
  }
}

export class EnabledInvitationIssuanceReadiness implements InvitationIssuanceReadiness {
  assertReady(): void {}
}

export class ConfiguredInvitationIssuanceReadiness implements InvitationIssuanceReadiness {
  constructor(private readonly enabled: boolean) {}

  assertReady(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Invitation delivery is unavailable.',
      );
    }
  }
}
