export const INVITATION_TOKEN_KEYRING = Symbol('INVITATION_TOKEN_KEYRING');

export interface InvitationTokenKeyring {
  currentVersion(): number;
  keyFor(version: number): Buffer;
}

export class UnavailableInvitationTokenKeyring implements InvitationTokenKeyring {
  currentVersion(): never {
    throw new Error('Invitation token keyring is unavailable.');
  }

  keyFor(): never {
    throw new Error('Invitation token keyring is unavailable.');
  }
}
