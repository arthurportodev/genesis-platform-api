import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { parseLeadKeyring } from '../../config/lead.config';
import { MaskedTtyPasswordReader } from './masked-password-reader';
import { FileSyntheticFixtureManifestStore } from './synthetic-fixture-manifest';
import { SyntheticFixtureError } from './synthetic-fixture.model';
import { SyntheticFixtureService } from './synthetic-fixture.service';

type SyntheticFixtureCommand = 'create' | 'status' | 'deactivate';

export interface SyntheticFixtureCliArguments {
  command: SyntheticFixtureCommand;
  manifestPath: string;
  runId: string | null;
}

export async function assertSyntheticFixtureOperationalRole(
  connection: DataSource,
): Promise<void> {
  const [role] = await connection.query<
    Array<{
      canLogin: boolean;
      superuser: boolean;
      createDatabase: boolean;
      createRole: boolean;
      inherit: boolean;
      bypassRls: boolean;
      ownsDatabase: boolean;
      ownsPublicSchema: boolean;
      memberships: number;
    }>
  >(
    `SELECT role.rolcanlogin AS "canLogin", role.rolsuper AS superuser,
            role.rolcreatedb AS "createDatabase",
            role.rolcreaterole AS "createRole", role.rolinherit AS inherit,
            role.rolbypassrls AS "bypassRls",
            pg_get_userbyid(database.datdba) = current_user AS "ownsDatabase",
            pg_get_userbyid(namespace.nspowner) = current_user AS "ownsPublicSchema",
            (SELECT count(*)::int FROM pg_auth_members membership
             WHERE membership.member = role.oid OR membership.roleid = role.oid)
              AS memberships
       FROM pg_roles role
       JOIN pg_database database ON database.datname = current_database()
       JOIN pg_namespace namespace ON namespace.nspname = 'public'
      WHERE role.rolname = current_user`,
  );
  if (
    role === undefined ||
    !role.canLogin ||
    role.superuser ||
    role.createDatabase ||
    role.createRole ||
    role.inherit ||
    role.bypassRls ||
    !role.ownsDatabase ||
    !role.ownsPublicSchema ||
    role.memberships !== 0
  ) {
    throw new SyntheticFixtureError(
      'UNSAFE_DATABASE_ROLE',
      'Synthetic fixture CLI requires the approved migration-owner role.',
    );
  }
}

export function parseSyntheticFixtureCliArguments(
  arguments_: string[],
): SyntheticFixtureCliArguments {
  const command = arguments_[0];
  if (
    command !== 'create' &&
    command !== 'status' &&
    command !== 'deactivate'
  ) {
    throw new SyntheticFixtureError(
      'INVALID_COMMAND',
      'Command must be create, status or deactivate.',
    );
  }
  let manifestPath: string | null = null;
  let runId: string | null = null;
  for (let index = 1; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new SyntheticFixtureError(
        'INVALID_ARGUMENTS',
        'Every CLI option requires one value.',
      );
    }
    if (option === '--manifest' && manifestPath === null) {
      manifestPath = value;
    } else if (option === '--run-id' && runId === null) {
      runId = value;
    } else {
      throw new SyntheticFixtureError(
        'INVALID_ARGUMENTS',
        'Unknown or duplicate CLI option.',
      );
    }
  }
  if (manifestPath === null) {
    throw new SyntheticFixtureError(
      'INVALID_ARGUMENTS',
      '--manifest is required.',
    );
  }
  if ((command === 'create') !== (runId !== null)) {
    throw new SyntheticFixtureError(
      'INVALID_ARGUMENTS',
      '--run-id is required only for create.',
    );
  }
  return { command, manifestPath, runId };
}

async function run(): Promise<void> {
  const arguments_ = parseSyntheticFixtureCliArguments(process.argv.slice(2));
  const repositoryRoot = resolve(__dirname, '../../..');
  const manifestStore = new FileSyntheticFixtureManifestStore(
    arguments_.manifestPath,
    repositoryRoot,
  );
  await manifestStore.assertExternalPath(arguments_.command === 'create');

  const imported = await import('../data-source');
  const connection = imported.default;
  let initializedHere = false;
  try {
    if (!connection.isInitialized) {
      await connection.initialize();
      initializedHere = true;
    }
    await assertSyntheticFixtureOperationalRole(connection);
    const leadIdempotencyKeys =
      arguments_.command === 'deactivate'
        ? parseLeadKeyring(
            'LEAD_IDEMPOTENCY_KEYS',
            process.env.LEAD_IDEMPOTENCY_KEYS,
          )
        : new Map<number, Buffer>();
    const leadIdempotencyCurrentKeyVersion =
      arguments_.command === 'deactivate'
        ? parseCurrentVersion(
            process.env.LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION,
            leadIdempotencyKeys,
          )
        : null;
    const service = new SyntheticFixtureService(
      connection,
      manifestStore,
      new MaskedTtyPasswordReader(),
      { leadIdempotencyKeys, leadIdempotencyCurrentKeyVersion },
    );
    if (arguments_.command === 'create') {
      console.log(
        JSON.stringify(await service.create(arguments_.runId as string)),
      );
      return;
    }
    if (arguments_.command === 'status') {
      const status = await service.status();
      console.log(JSON.stringify(status));
      if (status.state === 'PARTIAL') process.exitCode = 2;
      if (status.state === 'INVALID') process.exitCode = 3;
      return;
    }
    console.log(JSON.stringify(await service.deactivate()));
  } finally {
    if (initializedHere && connection.isInitialized) {
      await connection.destroy();
    }
  }
}

function parseCurrentVersion(
  raw: string | undefined,
  keys: ReadonlyMap<number, Buffer>,
): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const version = Number(raw);
  if (!Number.isInteger(version) || !keys.has(version)) {
    throw new SyntheticFixtureError(
      'INVALID_LEAD_KEYRING',
      'Lead idempotency current version is not available in the configured keyring.',
    );
  }
  return version;
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    if (error instanceof SyntheticFixtureError) {
      console.error(JSON.stringify({ status: 'FAILED', code: error.code }));
    } else {
      console.error(
        JSON.stringify({ status: 'FAILED', code: 'UNEXPECTED_FAILURE' }),
      );
    }
    process.exitCode = 1;
  });
}
