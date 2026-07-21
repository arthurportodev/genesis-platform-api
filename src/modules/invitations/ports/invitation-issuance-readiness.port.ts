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
