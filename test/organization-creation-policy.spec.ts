import {
  deriveOrganizationSlugBase,
  fingerprintOrganizationCreation,
  normalizeOrganizationName,
  organizationSlugForAttempt,
} from '../src/modules/organizations/organization-creation.policy';

describe('Organization creation policy', () => {
  it('normalizes the authoritative name to trimmed NFC', () => {
    expect(normalizeOrganizationName('  Age\u0302ncia Ge\u0301nesis  ')).toBe(
      'Agência Génesis',
    );
  });

  it.each([
    '',
    '   ',
    `a\u0000b`,
    `a\ud800b`,
    `a\u061cb`,
    `a\u200eb`,
    `a\u2028b`,
    `a\u2029b`,
    `a\u202eb`,
    `a\u2066b`,
    'a'.repeat(161),
  ])('rejects invalid names', (name) => {
    expect(() => normalizeOrganizationName(name)).toThrow(
      'Invalid organization creation request.',
    );
  });

  it('counts Unicode code points consistently with PostgreSQL char_length', () => {
    expect(normalizeOrganizationName('😀'.repeat(160))).toHaveLength(320);
    expect(() => normalizeOrganizationName('😀'.repeat(161))).toThrow(
      'Invalid organization creation request.',
    );
  });

  it('derives an ASCII slug base with a bounded suffix reserve', () => {
    expect(deriveOrganizationSlugBase('Agência Gênesis')).toBe(
      'agencia-genesis',
    );
    expect(deriveOrganizationSlugBase('東京')).toBe('organizacao');
    expect(deriveOrganizationSlugBase('Á'.repeat(160))).toHaveLength(114);
    expect(organizationSlugForAttempt('agencia-genesis', 1)).toBe(
      'agencia-genesis',
    );
    expect(organizationSlugForAttempt('agencia-genesis', 2)).toBe(
      'agencia-genesis-2',
    );
    expect(organizationSlugForAttempt('a'.repeat(114), 10_000)).toHaveLength(
      120,
    );
  });

  it('fingerprints the versioned canonical payload deterministically', () => {
    expect(fingerprintOrganizationCreation('Agência Gênesis')).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(fingerprintOrganizationCreation('Agência Gênesis')).toBe(
      fingerprintOrganizationCreation('Agência Gênesis'),
    );
    expect(fingerprintOrganizationCreation('Agência Gênesis')).not.toBe(
      fingerprintOrganizationCreation('Outra'),
    );
  });
});
