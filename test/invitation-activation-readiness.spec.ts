import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OperationalInvitationActivationReadiness } from '../src/modules/invitations/ports/invitation-activation-readiness.port';
import { InvitationTokenKeyring } from '../src/modules/invitations/ports/invitation-token-keyring.port';

describe('OperationalInvitationActivationReadiness', () => {
  const validSchema = {
    hasColumn: true,
    hasFunction: true,
    canExecute: true,
    canUseSchema: true,
    canCreateSchema: false,
    publicCanExecute: false,
    canAssumeOwner: false,
    canMutateUsers: false,
    canMutateMemberships: false,
    canMutateUserColumn: false,
    canMutateMembershipColumn: false,
    executableFunctions: [
      'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
      'app_private.apply_existing_user_invitation_membership(uuid,uuid)',
      'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,membership_role_enum,uuid,inet,text)',
      'app_private.lock_auth_refresh_user(uuid)',
      'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
    ],
  };
  const keys = new Map<number, Buffer>();
  const keyring: InvitationTokenKeyring = {
    currentVersion: () => 1,
    keyFor: (version) => {
      const key = keys.get(version);
      if (key === undefined) throw new Error('missing');
      return key;
    },
  };
  const query = jest.fn();
  const dataSource = { query } as unknown as DataSource;

  beforeEach(() => {
    keys.clear();
    query.mockReset();
  });

  it('requires the schema, execute grant, one replica, and every live key', async () => {
    query
      .mockResolvedValueOnce([{ keyVersion: 2 }])
      .mockResolvedValueOnce([validSchema]);
    await expect(readiness().assertReady()).rejects.toMatchObject({
      status: 503,
      message: 'Invitation activation is unavailable.',
    });
    keys.set(2, Buffer.alloc(32));
    query
      .mockResolvedValueOnce([{ keyVersion: 2 }])
      .mockResolvedValueOnce([validSchema]);
    await expect(readiness().assertReady()).resolves.toBeUndefined();
  });

  it.each([
    { hasColumn: false },
    { hasFunction: false },
    { canExecute: false },
    { canUseSchema: false },
    { canCreateSchema: true },
    { publicCanExecute: true },
    { canAssumeOwner: true },
    { canMutateUsers: true },
    { canMutateMemberships: true },
    { canMutateUserColumn: true },
    { canMutateMembershipColumn: true },
    { executableFunctions: [] },
  ])(
    'fails closed when the database boundary is incomplete',
    async (schema) => {
      query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ...validSchema, ...schema }]);
      await expect(readiness().assertReady()).rejects.toEqual(
        new ServiceUnavailableException(
          'Invitation activation is unavailable.',
        ),
      );
    },
  );

  it('does not query when disabled or horizontally replicated', async () => {
    await expect(readiness(false, 1).assertReady()).rejects.toMatchObject({
      status: 503,
    });
    await expect(readiness(true, 2).assertReady()).rejects.toMatchObject({
      status: 503,
    });
    expect(query).not.toHaveBeenCalled();
  });

  function readiness(
    enabled = true,
    replicas = 1,
  ): OperationalInvitationActivationReadiness {
    return new OperationalInvitationActivationReadiness(
      enabled,
      replicas,
      keyring,
      dataSource,
    );
  }
});
