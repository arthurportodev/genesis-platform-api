import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OperationalInvitationAcceptanceReadiness } from '../src/modules/invitations/ports/invitation-acceptance-readiness.port';
import { InvitationTokenKeyring } from '../src/modules/invitations/ports/invitation-token-keyring.port';

describe('OperationalInvitationAcceptanceReadiness', () => {
  const available = new Map<number, Buffer>();
  const query = jest.fn<Promise<Array<{ keyVersion: number }>>, [string]>();
  const dataSource = { query } as unknown as DataSource;
  const keyring: InvitationTokenKeyring = {
    currentVersion: () => {
      throw new Error('acceptance must not consult current');
    },
    keyFor: (version) => {
      const key = available.get(version);
      if (key === undefined) throw new Error('missing');
      return key;
    },
  };

  beforeEach(() => {
    available.clear();
    query.mockReset();
  });

  it('is ready with a real successful query and no pending invitations', async () => {
    query.mockResolvedValue([]);
    await expect(readiness().assertReady()).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain("status = 'pending'");
    expect(query.mock.calls[0]?.[0]).toContain(
      'expires_at > transaction_timestamp()',
    );
  });

  it('requires every distinct persisted key version and supports recovery', async () => {
    query.mockResolvedValue([{ keyVersion: 2 }, { keyVersion: 7 }]);
    available.set(2, Buffer.alloc(32, 2));
    await expect(readiness().assertReady()).rejects.toMatchObject({
      status: 503,
      message: 'Invitation acceptance is unavailable.',
    });
    available.set(7, Buffer.alloc(32, 7));
    await expect(readiness().assertReady()).resolves.toBeUndefined();
  });

  it('fails closed on database error and automatically recovers', async () => {
    query.mockRejectedValueOnce(new Error('private database detail'));
    await expect(readiness().assertReady()).rejects.toEqual(
      new ServiceUnavailableException('Invitation acceptance is unavailable.'),
    );
    query.mockResolvedValueOnce([]);
    await expect(readiness().assertReady()).resolves.toBeUndefined();
  });

  it('is independent from frontend and provider configuration', async () => {
    query.mockResolvedValue([]);
    const service = new OperationalInvitationAcceptanceReadiness(
      true,
      keyring,
      dataSource,
    );
    await expect(service.assertReady()).resolves.toBeUndefined();
  });

  it('returns the same public 503 when the flag is disabled', async () => {
    await expect(
      new OperationalInvitationAcceptanceReadiness(
        false,
        keyring,
        dataSource,
      ).assertReady(),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Invitation acceptance is unavailable.',
    });
    expect(query).not.toHaveBeenCalled();
  });

  function readiness(): OperationalInvitationAcceptanceReadiness {
    return new OperationalInvitationAcceptanceReadiness(
      true,
      keyring,
      dataSource,
    );
  }
});
