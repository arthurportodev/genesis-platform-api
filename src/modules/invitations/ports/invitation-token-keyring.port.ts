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

export class ConfiguredInvitationTokenKeyring implements InvitationTokenKeyring {
  constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    private readonly current: number | null,
  ) {}

  currentVersion(): number {
    if (this.current === null) {
      throw new Error('Invitation token current key is unavailable.');
    }
    return this.current;
  }

  keyFor(version: number): Buffer {
    const key = this.keys.get(version);
    if (key === undefined) {
      throw new Error('Invitation token key version is unavailable.');
    }
    return Buffer.from(key);
  }
}
