import { randomBytes, randomUUID } from 'node:crypto';
import { InvitationRole } from '../src/modules/invitations/enums/invitation.enums';
import { InvitationTokenKeyring } from '../src/modules/invitations/ports/invitation-token-keyring.port';
import {
  InvitationTokenCodec,
  InvitationTokenFields,
} from '../src/modules/invitations/services/invitation-token-codec.service';

describe('InvitationTokenCodec', () => {
  const keys = new Map([
    [1, randomBytes(32)],
    [2, randomBytes(48)],
  ]);
  const keyring: InvitationTokenKeyring = {
    currentVersion: () => 2,
    keyFor: (version) => {
      const key = keys.get(version);
      if (key === undefined) throw new Error('unknown key');
      return key;
    },
  };
  const codec = new InvitationTokenCodec(keyring);
  const fields: InvitationTokenFields = {
    invitationId: randomUUID(),
    keyVersion: 1,
    tokenVersion: 1,
    organizationId: randomUUID(),
    emailNormalized: 'member@example.com',
    role: InvitationRole.MEMBER,
    expiresAt: new Date('2026-08-01T12:34:56.789Z'),
    nonce: randomBytes(32).toString('base64url'),
  };

  it('is deterministic and verifies the exact persisted fields', () => {
    const first = codec.issue(fields);
    expect(codec.issue(fields)).toBe(first);
    expect(codec.verify(first, fields)).toBe(true);
    expect(first.split('.')).toHaveLength(4);
  });

  it.each([
    ['organizationId', randomUUID()],
    ['emailNormalized', 'other@example.com'],
    ['role', InvitationRole.ADMIN],
    ['expiresAt', new Date('2026-08-01T12:34:56.790Z')],
    ['nonce', randomBytes(32).toString('base64url')],
    ['tokenVersion', 2],
    ['keyVersion', 2],
  ] as const)('rejects tampering of %s', (property, value) => {
    const token = codec.issue(fields);
    expect(codec.verify(token, { ...fields, [property]: value })).toBe(false);
  });

  it('preserves millisecond precision across a PostgreSQL-style timestamp roundtrip', () => {
    const roundtrip = new Date(fields.expiresAt.toISOString());
    expect(codec.issue({ ...fields, expiresAt: roundtrip })).toBe(
      codec.issue(fields),
    );
  });

  it('issues with the current v2 key while continuing to resolve v1 tokens', () => {
    const current = { ...fields, keyVersion: keyring.currentVersion() };
    const v2 = codec.issue(current);
    const v1 = codec.issue(fields);
    expect(codec.verify(v2, current)).toBe(true);
    expect(codec.verify(v1, fields)).toBe(true);
    expect(v2.split('.')[1]).toBe('2');
  });

  it.each([
    '!',
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(42)}=`,
    `${'a'.repeat(42)}+`,
    `${'a'.repeat(42)}/`,
  ])('rejects non-canonical MAC %s', (mac) => {
    const [id, keyVersion, tokenVersion] = codec.issue(fields).split('.');
    expect(
      codec.verify(`${id}.${keyVersion}.${tokenVersion}.${mac}`, fields),
    ).toBe(false);
  });

  it.each([
    { nonce: `${fields.nonce.slice(0, 42)}=` },
    { nonce: fields.nonce.slice(0, 42) },
    { invitationId: '00000000-0000-3000-8000-000000000001' },
    { organizationId: 'not-a-uuid' },
    { keyVersion: 0 },
    { tokenVersion: 1.5 },
  ])('rejects invalid canonical fields %#', (override) => {
    const invalid = { ...fields, ...override };
    expect(() => codec.issue(invalid)).toThrow(
      'Invalid invitation token fields.',
    );
    expect(codec.verify(codec.issue(fields), invalid)).toBe(false);
  });

  it('rejects keys shorter than 32 bytes', () => {
    const short = new InvitationTokenCodec({
      currentVersion: () => 1,
      keyFor: () => randomBytes(31),
    });
    expect(() => short.issue(fields)).toThrow(
      'Invitation token key must contain at least 32 bytes.',
    );
  });
});
