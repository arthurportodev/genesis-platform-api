import { InvitationAcceptanceService } from '../src/modules/invitations/services/invitation-acceptance.service';

describe('Invitation acceptance smoke', () => {
  it('masks email without exposing identifiers or full personal data', () => {
    expect(InvitationAcceptanceService.maskEmail('arthur@example.com')).toBe(
      'a***r@e***.com',
    );
    expect(InvitationAcceptanceService.maskEmail('a@x.io')).toBe(
      'a***@x***.io',
    );
  });

  it('keeps the public inspect response allowlisted', () => {
    expect(
      InvitationAcceptanceService.toInspectResponse({
        organizationName: 'Genesis',
        emailNormalized: 'arthur@example.com',
        role: 'member',
        expiresAt: new Date('2026-07-28T12:00:00.000Z'),
      }),
    ).toEqual({
      organization: { name: 'Genesis' },
      emailMasked: 'a***r@e***.com',
      role: 'member',
      expiresAt: '2026-07-28T12:00:00.000Z',
    });
  });
});
