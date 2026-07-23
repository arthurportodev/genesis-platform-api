import { BadRequestException } from '@nestjs/common';
import { LeadSource } from '../../src/modules/leads/enums/lead.enums';
import { normalizeLeadPhone } from '../../src/modules/leads/normalization/phone.normalizer';
import {
  leadRequestFingerprint,
  normalizeLeadInput,
} from '../../src/modules/leads/security/lead-fingerprint';

describe('Lead normalization and fingerprint', () => {
  it.each([
    ['(62) 99999-9999', '+5562999999999'],
    ['+1 202-555-0123', '+12025550123'],
  ])('normalizes %s to E.164', (input, expected) => {
    expect(normalizeLeadPhone(input)).toBe(expected);
  });

  it.each(['123', '+55 62 99999-9999 ext. 2'])('rejects %s', (input) => {
    expect(() => normalizeLeadPhone(input)).toThrow(BadRequestException);
  });

  it('canonicalizes values and produces a deterministic keyed fingerprint', () => {
    const input = normalizeLeadInput(
      {
        displayName: '  Maria  ',
        primaryPhone: '(62) 99999-9999',
        email: ' MARIA@EXAMPLE.COM ',
        source: LeadSource.CAMPAIGN,
        utmCampaign: ' Summer-2026 ',
      },
      '+5562999999999',
    );
    expect(input).toMatchObject({
      displayName: 'Maria',
      email: 'maria@example.com',
      utmCampaign: 'Summer-2026',
    });
    const key = Buffer.alloc(32, 7);
    expect(leadRequestFingerprint(input, key)).toBe(
      leadRequestFingerprint(input, key),
    );
    expect(leadRequestFingerprint(input, key)).not.toBe(
      leadRequestFingerprint(input, Buffer.alloc(32, 8)),
    );
  });

  it('requires source detail only for other', () => {
    expect(() =>
      normalizeLeadInput(
        {
          displayName: 'Maria',
          primaryPhone: '+5562999999999',
          source: LeadSource.OTHER,
        },
        '+5562999999999',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeLeadInput(
        {
          displayName: 'Maria',
          primaryPhone: '+5562999999999',
          source: LeadSource.MANUAL,
          sourceDetail: 'forbidden',
        },
        '+5562999999999',
      ),
    ).toThrow(BadRequestException);
  });
});
