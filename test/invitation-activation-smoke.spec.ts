import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivateInvitationDto } from '../src/modules/invitations/dto/activate-invitation.dto';
import { InvitationActivationHashCapacity } from '../src/modules/invitations/services/invitation-activation-hash-capacity.service';
import { InvitationActivationObservability } from '../src/modules/invitations/services/invitation-activation-observability.service';

const token =
  '123e4567-e89b-42d3-a456-426614174000.2.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('Invitation activation public boundary', () => {
  it('accepts the exact allowlist, trims the name, and preserves the password', () => {
    const dto = ActivateInvitationDto.parse({
      token,
      name: '  New User  ',
      password: '  Str0ng pass  ',
    });
    expect(dto).toMatchObject({
      token,
      name: 'New User',
      password: '  Str0ng pass  ',
    });
  });

  it.each([
    null,
    [],
    { token, name: 'User', password: 'Password1!', role: 'owner' },
    { token, name: 'User\u202e', password: 'Password1!' },
    { token, name: 'User\u0085', password: 'Password1!' },
    { token, name: 'User', password: '          ' },
    { token, name: 'User', password: 'short1!' },
  ])('rejects invalid or over-posted input without field detail', (input) => {
    expect(ActivateInvitationDto.parse(input)).toBeNull();
  });

  it('measures password limits as UTF-16 code units', () => {
    expect(
      ActivateInvitationDto.parse({
        token,
        name: 'User',
        password: `${'a'.repeat(126)}😀`,
      }),
    ).not.toBeNull();
    expect(
      ActivateInvitationDto.parse({
        token,
        name: 'User',
        password: `${'a'.repeat(127)}😀`,
      }),
    ).toBeNull();
  });

  it('rejects excess concurrent hashing without a queue and recovers capacity', async () => {
    const config = {
      getOrThrow: () => ({ activationHashConcurrency: 1 }),
    } as unknown as ConfigService;
    const rateLimited = jest.fn();
    const observability = {
      rateLimited,
    } as unknown as InvitationActivationObservability;
    const capacity = new InvitationActivationHashCapacity(
      config,
      observability,
    );
    let release: (() => void) | undefined;
    const first = capacity.run(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await expect(capacity.run(() => Promise.resolve())).rejects.toEqual(
      new HttpException('Too many requests.', 429),
    );
    expect(rateLimited).toHaveBeenCalledWith('hash_capacity');
    release?.();
    await first;
    await expect(
      capacity.run(() => Promise.resolve('available')),
    ).resolves.toBe('available');
  });
});
