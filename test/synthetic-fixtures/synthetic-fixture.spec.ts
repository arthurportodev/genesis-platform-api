import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSyntheticFixtureCliArguments } from '../../src/database/synthetic-fixtures/cli';
import { FileSyntheticFixtureManifestStore } from '../../src/database/synthetic-fixtures/synthetic-fixture-manifest';
import {
  buildSyntheticFixtureFormula,
  parseSyntheticFixtureManifest,
  SYNTHETIC_FIXTURE_PREFIX,
  SYNTHETIC_FIXTURE_SCHEMA_VERSION,
  SyntheticFixtureManifest,
} from '../../src/database/synthetic-fixtures/synthetic-fixture.model';

describe('Synthetic fixture contract', () => {
  const runId = 'MVP09-20260815-1a2b3c4d';

  it('generates identities accepted by the existing lengths and validators', () => {
    const formula = buildSyntheticFixtureFormula(runId);
    expect(formula).toMatchObject({
      normalizedRunId: '20260815-1a2b3c4d',
      organizations: {
        tenantA: { slug: 'mvp09-20260815-1a2b3c4d-a' },
        tenantB: { slug: 'mvp09-20260815-1a2b3c4d-b' },
      },
      users: {
        ownerA: {
          email: 'mvp09+20260815-1a2b3c4d-owner-a@example.invalid',
        },
        memberA: {
          email: 'mvp09+20260815-1a2b3c4d-member-a@example.invalid',
        },
        ownerB: {
          email: 'mvp09+20260815-1a2b3c4d-owner-b@example.invalid',
        },
      },
    });
    for (const organization of Object.values(formula.organizations)) {
      expect(organization.name.startsWith(SYNTHETIC_FIXTURE_PREFIX)).toBe(true);
      expect(organization.name.length).toBeLessThanOrEqual(160);
      expect(organization.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    }
  });

  it.each([
    'mvp09-20260815-1a2b3c4d',
    'MVP09-2026815-1a2b3c4d',
    'MVP09-20260815-1A2B3C4D',
    'MVP09-20260815-1a2b3c4',
  ])('rejects invalid runId %s', (invalidRunId) => {
    expect(() => buildSyntheticFixtureFormula(invalidRunId)).toThrow(
      'runId must match',
    );
  });

  it('strictly rejects altered or expanded manifests', () => {
    const manifest = buildManifest(runId);
    expect(parseSyntheticFixtureManifest(manifest)).toEqual(manifest);
    expect(() =>
      parseSyntheticFixtureManifest({ ...manifest, password: 'forbidden' }),
    ).toThrow('missing or unexpected');
    expect(() =>
      parseSyntheticFixtureManifest({
        ...manifest,
        users: manifest.users.map((user, index) =>
          index === 0 ? { ...user, email: 'real@example.com' } : user,
        ),
      }),
    ).toThrow('formula');
  });

  it('writes a private atomic non-secret manifest and refuses overwrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genesis-mvp09-manifest-'));
    const path = join(directory, 'fixture.json');
    const store = new FileSyntheticFixtureManifestStore(
      resolve(path),
      process.cwd(),
    );
    const manifest = buildManifest(runId);
    try {
      await store.create(manifest);
      expect(await store.load()).toEqual(manifest);
      const text = await readFile(path, 'utf8');
      expect(text).not.toMatch(/password|argon2|token|hash/iu);
      expect(text.endsWith('\n')).toBe(true);
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o077).toBe(0);
      }
      await expect(store.create(manifest)).rejects.toMatchObject({
        code: 'MANIFEST_ALREADY_EXISTS',
      });
      const divergent = { ...manifest, createdAt: '2026-08-15T01:00:00.000Z' };
      await expect(store.replace(divergent, manifest)).rejects.toMatchObject({
        code: 'MANIFEST_DIVERGED',
      });
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires explicit safe arguments and has no password option', () => {
    expect(
      parseSyntheticFixtureCliArguments([
        'create',
        '--run-id',
        runId,
        '--manifest',
        'C:\\fixture.json',
      ]),
    ).toEqual({
      command: 'create',
      runId,
      manifestPath: 'C:\\fixture.json',
    });
    expect(() =>
      parseSyntheticFixtureCliArguments([
        'create',
        '--run-id',
        runId,
        '--manifest',
        'C:\\fixture.json',
        '--password',
        'must-not-be-accepted',
      ]),
    ).toThrow('Unknown or duplicate');
  });

  it('is packaged as a separate process and is absent from the HTTP runtime graph', async () => {
    const [packageText, appModule, main] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'app.module.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main.ts'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageText) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['fixture:synthetic']).toContain(
      'dist/database/synthetic-fixtures/cli.js',
    );
    expect(`${appModule}\n${main}`).not.toContain('synthetic-fixture');
  });
});

function buildManifest(runId: string): SyntheticFixtureManifest {
  const formula = buildSyntheticFixtureFormula(runId);
  const organizations = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
  };
  const users = {
    ownerA: randomUUID(),
    memberA: randomUUID(),
    ownerB: randomUUID(),
  };
  return {
    schemaVersion: SYNTHETIC_FIXTURE_SCHEMA_VERSION,
    runId,
    prefix: SYNTHETIC_FIXTURE_PREFIX,
    createdAt: '2026-08-15T00:00:00.000Z',
    deactivatedAt: null,
    organizations: [
      {
        role: 'tenantA',
        id: organizations.tenantA,
        slug: formula.organizations.tenantA.slug,
      },
      {
        role: 'tenantB',
        id: organizations.tenantB,
        slug: formula.organizations.tenantB.slug,
      },
    ],
    users: [
      { role: 'ownerA', id: users.ownerA, email: formula.users.ownerA.email },
      {
        role: 'memberA',
        id: users.memberA,
        email: formula.users.memberA.email,
      },
      { role: 'ownerB', id: users.ownerB, email: formula.users.ownerB.email },
    ],
    memberships: [
      {
        role: 'ownerA',
        id: randomUUID(),
        userId: users.ownerA,
        organizationId: organizations.tenantA,
        membershipRole: 'owner',
      },
      {
        role: 'memberA',
        id: randomUUID(),
        userId: users.memberA,
        organizationId: organizations.tenantA,
        membershipRole: 'member',
      },
      {
        role: 'ownerB',
        id: randomUUID(),
        userId: users.ownerB,
        organizationId: organizations.tenantB,
        membershipRole: 'owner',
      },
    ],
    status: 'active',
  };
}
