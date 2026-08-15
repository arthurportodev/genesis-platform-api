import { isEmail, isUUID } from 'class-validator';

export const SYNTHETIC_FIXTURE_SCHEMA_VERSION = '1.0.0';
export const SYNTHETIC_FIXTURE_PREFIX = '[MVP09-SYNTHETIC]';
export const SYNTHETIC_RUN_ID_PATTERN = /^MVP09-[0-9]{8}-[0-9a-f]{8}$/u;

export type SyntheticOrganizationRole = 'tenantA' | 'tenantB';
export type SyntheticUserRole = 'ownerA' | 'memberA' | 'ownerB';
export type SyntheticFixtureStatus = 'active' | 'deactivated';
export type SyntheticDatabaseState =
  'ACTIVE' | 'PARTIAL' | 'DEACTIVATED' | 'INVALID';

export interface SyntheticOrganizationManifestEntry {
  role: SyntheticOrganizationRole;
  id: string;
  slug: string;
}

export interface SyntheticUserManifestEntry {
  role: SyntheticUserRole;
  id: string;
  email: string;
}

export interface SyntheticMembershipManifestEntry {
  role: SyntheticUserRole;
  id: string;
  userId: string;
  organizationId: string;
  membershipRole: 'owner' | 'member';
}

export interface SyntheticFixtureManifest {
  schemaVersion: typeof SYNTHETIC_FIXTURE_SCHEMA_VERSION;
  runId: string;
  prefix: typeof SYNTHETIC_FIXTURE_PREFIX;
  createdAt: string;
  deactivatedAt: string | null;
  organizations: SyntheticOrganizationManifestEntry[];
  users: SyntheticUserManifestEntry[];
  memberships: SyntheticMembershipManifestEntry[];
  status: SyntheticFixtureStatus;
}

export interface SyntheticFixtureFormula {
  runId: string;
  normalizedRunId: string;
  organizations: Record<
    SyntheticOrganizationRole,
    { name: string; slug: string }
  >;
  users: Record<SyntheticUserRole, { name: string; email: string }>;
}

export class SyntheticFixtureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyntheticFixtureError';
  }
}

export function buildSyntheticFixtureFormula(
  runId: string,
): SyntheticFixtureFormula {
  if (!SYNTHETIC_RUN_ID_PATTERN.test(runId)) {
    throw new SyntheticFixtureError(
      'INVALID_RUN_ID',
      'runId must match MVP09-YYYYMMDD-8hex.',
    );
  }
  const normalizedRunId = runId.slice('MVP09-'.length).toLowerCase();
  const formula: SyntheticFixtureFormula = {
    runId,
    normalizedRunId,
    organizations: {
      tenantA: {
        name: `${SYNTHETIC_FIXTURE_PREFIX} Tenant A ${runId}`,
        slug: `mvp09-${normalizedRunId}-a`,
      },
      tenantB: {
        name: `${SYNTHETIC_FIXTURE_PREFIX} Tenant B ${runId}`,
        slug: `mvp09-${normalizedRunId}-b`,
      },
    },
    users: {
      ownerA: {
        name: `${SYNTHETIC_FIXTURE_PREFIX} Owner A ${runId}`,
        email: `mvp09+${normalizedRunId}-owner-a@example.invalid`,
      },
      memberA: {
        name: `${SYNTHETIC_FIXTURE_PREFIX} Member A ${runId}`,
        email: `mvp09+${normalizedRunId}-member-a@example.invalid`,
      },
      ownerB: {
        name: `${SYNTHETIC_FIXTURE_PREFIX} Owner B ${runId}`,
        email: `mvp09+${normalizedRunId}-owner-b@example.invalid`,
      },
    },
  };
  validateFormula(formula);
  return formula;
}

export function parseSyntheticFixtureManifest(
  value: unknown,
): SyntheticFixtureManifest {
  const root = requireRecord(value, 'manifest');
  requireExactKeys(root, [
    'createdAt',
    'deactivatedAt',
    'memberships',
    'organizations',
    'prefix',
    'runId',
    'schemaVersion',
    'status',
    'users',
  ]);
  if (root.schemaVersion !== SYNTHETIC_FIXTURE_SCHEMA_VERSION) {
    invalidManifest('Unsupported schemaVersion.');
  }
  if (root.prefix !== SYNTHETIC_FIXTURE_PREFIX) {
    invalidManifest('Unexpected synthetic prefix.');
  }
  if (typeof root.runId !== 'string') invalidManifest('Invalid runId.');
  const formula = buildSyntheticFixtureFormula(root.runId);
  if (!isIsoInstant(root.createdAt)) invalidManifest('Invalid createdAt.');
  if (root.status !== 'active' && root.status !== 'deactivated') {
    invalidManifest('Invalid fixture status.');
  }
  const status = root.status;
  let deactivatedAt: string | null;
  if (status === 'active') {
    if (root.deactivatedAt !== null) {
      invalidManifest('Invalid deactivation timestamp.');
    }
    deactivatedAt = null;
  } else {
    if (!isIsoInstant(root.deactivatedAt)) {
      invalidManifest('Invalid deactivation timestamp.');
    }
    deactivatedAt = root.deactivatedAt;
  }

  const organizations = parseOrganizations(root.organizations, formula);
  const users = parseUsers(root.users, formula);
  const memberships = parseMemberships(root.memberships, organizations, users);
  const allIds = [
    ...organizations.map(({ id }) => id),
    ...users.map(({ id }) => id),
    ...memberships.map(({ id }) => id),
  ];
  if (new Set(allIds).size !== allIds.length) {
    invalidManifest('Manifest IDs must be unique.');
  }

  return {
    schemaVersion: SYNTHETIC_FIXTURE_SCHEMA_VERSION,
    runId: formula.runId,
    prefix: SYNTHETIC_FIXTURE_PREFIX,
    createdAt: root.createdAt,
    deactivatedAt,
    organizations,
    users,
    memberships,
    status,
  };
}

function validateFormula(formula: SyntheticFixtureFormula): void {
  for (const organization of Object.values(formula.organizations)) {
    if (
      !organization.name.startsWith(SYNTHETIC_FIXTURE_PREFIX) ||
      organization.name.length > 160 ||
      organization.name !== organization.name.trim() ||
      organization.slug.length > 120 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(organization.slug)
    ) {
      throw new SyntheticFixtureError(
        'INVALID_FORMULA',
        'Generated organization identity violates the existing schema.',
      );
    }
  }
  for (const user of Object.values(formula.users)) {
    if (
      !user.name.startsWith(SYNTHETIC_FIXTURE_PREFIX) ||
      user.name.length > 160 ||
      user.name !== user.name.trim() ||
      user.email.length > 320 ||
      user.email !== user.email.toLowerCase() ||
      !isEmail(user.email)
    ) {
      throw new SyntheticFixtureError(
        'INVALID_FORMULA',
        'Generated user identity violates the existing validators.',
      );
    }
  }
}

function parseOrganizations(
  value: unknown,
  formula: SyntheticFixtureFormula,
): SyntheticOrganizationManifestEntry[] {
  if (!Array.isArray(value) || value.length !== 2) {
    invalidManifest('Expected exactly two organizations.');
  }
  const entries: SyntheticOrganizationManifestEntry[] = value.map((item) => {
    const entry = requireRecord(item, 'organization');
    requireExactKeys(entry, ['id', 'role', 'slug']);
    if (entry.role !== 'tenantA' && entry.role !== 'tenantB') {
      invalidManifest('Invalid organization role.');
    }
    assertUuid(entry.id);
    if (entry.slug !== formula.organizations[entry.role].slug) {
      invalidManifest('Organization slug does not match the formula.');
    }
    const role = entry.role;
    return { role, id: entry.id, slug: formula.organizations[role].slug };
  });
  assertRoles(entries, ['tenantA', 'tenantB']);
  return entries;
}

function parseUsers(
  value: unknown,
  formula: SyntheticFixtureFormula,
): SyntheticUserManifestEntry[] {
  if (!Array.isArray(value) || value.length !== 3) {
    invalidManifest('Expected exactly three users.');
  }
  const entries: SyntheticUserManifestEntry[] = value.map((item) => {
    const entry = requireRecord(item, 'user');
    requireExactKeys(entry, ['email', 'id', 'role']);
    if (
      entry.role !== 'ownerA' &&
      entry.role !== 'memberA' &&
      entry.role !== 'ownerB'
    ) {
      invalidManifest('Invalid user role.');
    }
    assertUuid(entry.id);
    if (entry.email !== formula.users[entry.role].email) {
      invalidManifest('User email does not match the formula.');
    }
    const role = entry.role;
    return { role, id: entry.id, email: formula.users[role].email };
  });
  assertRoles(entries, ['ownerA', 'memberA', 'ownerB']);
  return entries;
}

function parseMemberships(
  value: unknown,
  organizations: SyntheticOrganizationManifestEntry[],
  users: SyntheticUserManifestEntry[],
): SyntheticMembershipManifestEntry[] {
  if (!Array.isArray(value) || value.length !== 3) {
    invalidManifest('Expected exactly three memberships.');
  }
  const organizationByRole = new Map(
    organizations.map((entry) => [entry.role, entry]),
  );
  const userByRole = new Map(users.map((entry) => [entry.role, entry]));
  const expected = {
    ownerA: {
      organizationId: organizationByRole.get('tenantA')?.id,
      membershipRole: 'owner',
    },
    memberA: {
      organizationId: organizationByRole.get('tenantA')?.id,
      membershipRole: 'member',
    },
    ownerB: {
      organizationId: organizationByRole.get('tenantB')?.id,
      membershipRole: 'owner',
    },
  } as const;
  const entries: SyntheticMembershipManifestEntry[] = value.map((item) => {
    const entry = requireRecord(item, 'membership');
    requireExactKeys(entry, [
      'id',
      'membershipRole',
      'organizationId',
      'role',
      'userId',
    ]);
    if (
      entry.role !== 'ownerA' &&
      entry.role !== 'memberA' &&
      entry.role !== 'ownerB'
    ) {
      invalidManifest('Invalid membership role.');
    }
    assertUuid(entry.id);
    assertUuid(entry.userId);
    assertUuid(entry.organizationId);
    const role = entry.role;
    const expectedRelationship = expected[role];
    if (
      entry.userId !== userByRole.get(role)?.id ||
      entry.organizationId !== expectedRelationship.organizationId ||
      entry.membershipRole !== expectedRelationship.membershipRole
    ) {
      invalidManifest('Membership relationship does not match the fixture.');
    }
    return {
      role,
      id: entry.id,
      userId: entry.userId,
      organizationId: entry.organizationId,
      membershipRole: expectedRelationship.membershipRole,
    };
  });
  assertRoles(entries, ['ownerA', 'memberA', 'ownerB']);
  return entries;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidManifest(`Invalid ${label} object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    invalidManifest('Manifest contains missing or unexpected fields.');
  }
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isUUID(value, '4')) {
    invalidManifest('Invalid UUID in manifest.');
  }
}

function assertRoles<T extends { role: string }>(
  values: T[],
  expected: string[],
): void {
  if (
    values
      .map(({ role }) => role)
      .sort()
      .join(',') !== [...expected].sort().join(',')
  ) {
    invalidManifest('Manifest roles must be unique and complete.');
  }
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function invalidManifest(message: string): never {
  throw new SyntheticFixtureError('INVALID_MANIFEST', message);
}
