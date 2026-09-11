import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CreateSelfServiceOrganizations1789245600000 } from '../src/database/migrations/1789245600000-CreateSelfServiceOrganizations';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../src/database/runtime-executable-functions';
import { OperationalOrganizationCreationReadiness } from '../src/modules/organizations/ports/organization-creation-readiness.port';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

interface CreationRow {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  membership_id: string;
  membership_role: string;
  replayed: boolean;
}

describe('Self-service organization database boundary', () => {
  let owner: DataSource;
  let runtime: DataSource;

  beforeAll(async () => {
    configureIntegrationRuntimeEnvironment();
    owner = createIntegrationDataSource({ includeOrganizationCreation: true });
    await owner.initialize();
    await prepareIntegrationRuntimeRole(owner);
    await owner.dropDatabase();
    await owner.runMigrations();
    runtime = createIntegrationRuntimeDataSource();
    await runtime.initialize();
  }, 120_000);

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (owner?.isInitialized) {
      await owner.dropDatabase();
      await owner.destroy();
    }
  });

  it('atomically creates the active tenant, OWNER, audit and default pipeline', async () => {
    const userId = await createVerifiedUser('owner');
    const key = randomUUID();
    const [created] = await createOrganization(
      userId,
      key,
      'Agência Gênesis',
      'agencia-genesis',
    );
    expect(created).toMatchObject({
      organization_name: 'Agência Gênesis',
      organization_slug: 'agencia-genesis',
      membership_role: 'owner',
      replayed: false,
    });

    const [state] = await owner.query<
      Array<{
        organizationStatus: string;
        membershipStatus: string;
        membershipRole: string;
        auditCount: number;
        pipelineCount: number;
        stageCount: number;
        claimCount: number;
      }>
    >(
      `SELECT organization.status AS "organizationStatus",
              membership.status AS "membershipStatus",
              membership.role AS "membershipRole",
              (SELECT count(*)::int FROM public.organization_audit_logs audit
               WHERE audit.organization_id = organization.id
                 AND audit.event_type = 'organization.created'
                 AND audit.actor_user_id = $1
                 AND audit.actor_membership_id = membership.id
                 AND audit.correlation_id = $2) AS "auditCount",
              (SELECT count(*)::int FROM public.pipelines pipeline
               WHERE pipeline.organization_id = organization.id
                 AND pipeline.is_default) AS "pipelineCount",
              (SELECT count(*)::int FROM public.pipeline_stages stage
               WHERE stage.organization_id = organization.id) AS "stageCount",
              (SELECT count(*)::int
               FROM public.organization_creation_idempotency claim
               WHERE claim.actor_user_id = $1
                 AND claim.idempotency_key = $2
                 AND claim.result_organization_id = organization.id
                 AND claim.result_membership_id = membership.id
                 AND claim.response_status = 201) AS "claimCount"
       FROM public.organizations organization
       JOIN public.memberships membership
         ON membership.organization_id = organization.id
        AND membership.user_id = $1
       WHERE organization.id = $3`,
      [userId, key, created?.organization_id],
    );
    expect(state).toEqual({
      organizationStatus: 'active',
      membershipStatus: 'active',
      membershipRole: 'owner',
      auditCount: 1,
      pipelineCount: 1,
      stageCount: 5,
      claimCount: 1,
    });
    expect(
      await owner.query<Array<{ name: string; position: number }>>(
        `SELECT stage.name, stage.position
         FROM public.pipeline_stages stage
         WHERE stage.organization_id = $1
         ORDER BY stage.position`,
        [created?.organization_id],
      ),
    ).toEqual([
      { name: 'Novo', position: 1 },
      { name: 'Qualificação', position: 2 },
      { name: 'Diagnóstico', position: 3 },
      { name: 'Proposta', position: 4 },
      { name: 'Negociação', position: 5 },
    ]);
  });

  it('replays the same key and rejects a different canonical payload', async () => {
    const userId = await createVerifiedUser('replay');
    const key = randomUUID();
    const [first] = await createOrganization(
      userId,
      key,
      'Empresa Replay',
      'empresa-replay',
    );
    const [replay] = await createOrganization(
      userId,
      key,
      'Empresa Replay',
      'empresa-replay',
      false,
    );
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      createOrganization(
        userId,
        key,
        'Empresa Diferente',
        'empresa-diferente',
        false,
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P4002' } });
    await expect(
      createOrganization(
        userId,
        randomUUID(),
        'Nova Bloqueada',
        'nova-bloqueada',
        false,
      ),
    ).rejects.toMatchObject({ driverError: { code: 'P4005' } });
    expect(
      await owner.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM public.memberships
         WHERE user_id = $1`,
        [userId],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('serializes concurrent same-key calls into one creation and one replay', async () => {
    const userId = await createVerifiedUser('same-key');
    const key = randomUUID();
    const results = await Promise.all([
      createOrganization(
        userId,
        key,
        'Empresa Concorrente',
        'empresa-concorrente',
      ),
      createOrganization(
        userId,
        key,
        'Empresa Concorrente',
        'empresa-concorrente',
      ),
    ]);
    expect(
      results
        .flat()
        .map((row) => row.replayed)
        .sort(),
    ).toEqual([false, true]);
    expect(
      await owner.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM public.memberships
         WHERE user_id = $1`,
        [userId],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('permits distinct intentions for the same User and resolves slug races', async () => {
    const userId = await createVerifiedUser('multi');
    const slug = `same-name-${randomUUID().slice(0, 8)}`;
    const results = await Promise.all([
      createOrganization(userId, randomUUID(), 'Mesmo Nome', slug),
      createOrganization(userId, randomUUID(), 'Mesmo Nome', slug),
    ]);
    expect(
      results
        .flat()
        .map((row) => row.organization_slug)
        .sort(),
    ).toEqual([slug, `${slug}-2`]);
    expect(
      await owner.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM public.memberships
         WHERE user_id = $1`,
        [userId],
      ),
    ).toEqual([{ count: 2 }]);
  });

  it('allows different Users to use the same visible name without tenant merging', async () => {
    const firstUser = await createVerifiedUser('first-name');
    const secondUser = await createVerifiedUser('second-name');
    const slug = `shared-${randomUUID().slice(0, 8)}`;
    const [[first], [second]] = await Promise.all([
      createOrganization(firstUser, randomUUID(), 'Nome Compartilhado', slug),
      createOrganization(secondUser, randomUUID(), 'Nome Compartilhado', slug),
    ]);
    expect(first?.organization_id).not.toBe(second?.organization_id);
    expect(first?.organization_name).toBe(second?.organization_name);
    expect(first?.organization_slug).not.toBe(second?.organization_slug);
  });

  it('keeps invitation membership acceptance compatible with Organizations A and B', async () => {
    const userId = await createVerifiedUser('invited-after-create');
    await createOrganization(
      userId,
      randomUUID(),
      'Organization A',
      `organization-a-${randomUUID().slice(0, 8)}`,
    );
    const [target] = await owner.query<Array<{ email: string }>>(
      'SELECT email FROM public.users WHERE id = $1',
      [userId],
    );
    if (!target) throw new Error('Could not load invited User.');

    const [invitation] = await owner.query<
      Array<{ id: string; organizationId: string }>
    >(
      `WITH issuer_user AS (
         INSERT INTO public.users (
           id,email,name,status,email_verified_at,created_at,updated_at
         ) VALUES (
           gen_random_uuid(),$1,'Invitation Owner','active',transaction_timestamp(),
           transaction_timestamp(),transaction_timestamp()
         ) RETURNING id
       ), invited_organization AS (
         INSERT INTO public.organizations (id,name,slug,status,created_at,updated_at)
         VALUES (
           gen_random_uuid(),'Organization B',$2,'active',
           transaction_timestamp(),transaction_timestamp()
         ) RETURNING id
       ), issuer_membership AS (
         INSERT INTO public.memberships (
           id,user_id,organization_id,role,status,created_at,updated_at
         )
         SELECT gen_random_uuid(),issuer_user.id,invited_organization.id,
                'owner','active',transaction_timestamp(),transaction_timestamp()
         FROM issuer_user CROSS JOIN invited_organization
         RETURNING id, organization_id
       )
       INSERT INTO public.organization_invitations (
         id,organization_id,email_normalized,role,status,expires_at,
         invited_by_membership_id,token_key_version,token_version,token_nonce,
         created_at,updated_at
       )
       SELECT gen_random_uuid(),issuer_membership.organization_id,$3,'member',
              'pending',transaction_timestamp() + interval '1 day',
              issuer_membership.id,1,1,$4,transaction_timestamp(),
              transaction_timestamp()
       FROM issuer_membership
       RETURNING id, organization_id AS "organizationId"`,
      [
        `issuer-${randomUUID()}@example.test`,
        `organization-b-${randomUUID().slice(0, 8)}`,
        target.email,
        randomBytes(32).toString('base64url'),
      ],
    );
    if (!invitation) throw new Error('Could not create invitation fixture.');

    await runtime.query(
      `SELECT app_private.apply_existing_user_invitation_membership($1,$2)`,
      [invitation.id, userId],
    );
    const memberships = await owner.query<
      Array<{ organizationId: string; role: string }>
    >(
      `SELECT organization_id AS "organizationId", role::text AS role
       FROM public.memberships WHERE user_id = $1`,
      [userId],
    );
    expect(memberships).toHaveLength(2);
    expect(memberships).toContainEqual({
      organizationId: invitation.organizationId,
      role: 'member',
    });
    expect(memberships.some((membership) => membership.role === 'owner')).toBe(
      true,
    );
  });

  it('rejects inactive or unverified Users without partial writes', async () => {
    const inactive = await createVerifiedUser('inactive');
    await owner.query(
      `UPDATE public.users SET status = 'inactive' WHERE id = $1`,
      [inactive],
    );
    const unverified = await createVerifiedUser('unverified');
    await owner.query(
      `UPDATE public.users SET email_verified_at = NULL WHERE id = $1`,
      [unverified],
    );
    for (const userId of [inactive, unverified]) {
      await expect(
        createOrganization(userId, randomUUID(), 'Bloqueada', 'bloqueada'),
      ).rejects.toMatchObject({ driverError: { code: 'P4001' } });
      expect(
        await owner.query<Array<{ count: number }>>(
          `SELECT count(*)::int AS count
           FROM public.organization_creation_idempotency
           WHERE actor_user_id = $1`,
          [userId],
        ),
      ).toEqual([{ count: 0 }]);
    }
  });

  it('serializes with concurrent User inactivation and creates no partial tenant', async () => {
    const userId = await createVerifiedUser('inactivation-race');
    const key = randomUUID();
    const slug = `inactivation-race-${randomUUID().slice(0, 8)}`;
    const locker = owner.createQueryRunner();
    await locker.connect();
    await locker.startTransaction();
    try {
      await locker.query(
        'SELECT id FROM public.users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const creation = createOrganization(
        userId,
        key,
        'Inactivation Race',
        slug,
      ).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      await waitForCreationLockWait();
      await locker.query(
        `UPDATE public.users SET status = 'inactive',
          updated_at = transaction_timestamp() WHERE id = $1`,
        [userId],
      );
      await locker.commitTransaction();
      const outcome = await creation;
      expect(outcome.error).toMatchObject({
        driverError: { code: 'P4001' },
      });
    } finally {
      if (locker.isTransactionActive) await locker.rollbackTransaction();
      await locker.release();
    }
    await expectNoCreationEffects(userId, key, slug);
  });

  it('rolls back Organization, pipeline and claim when OWNER creation fails', async () => {
    const userId = await createVerifiedUser('rollback');
    const key = randomUUID();
    await owner.query(`
      CREATE FUNCTION public.reject_test_membership_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '${userId}'::uuid THEN
          RAISE EXCEPTION 'synthetic membership failure';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await owner.query(`
      CREATE TRIGGER TRG_test_reject_membership_insert
      BEFORE INSERT ON public.memberships
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_membership_insert()
    `);
    try {
      await expect(
        createOrganization(
          userId,
          key,
          'Rollback Integral',
          'rollback-integral',
        ),
      ).rejects.toBeDefined();
    } finally {
      await owner.query(
        'DROP TRIGGER TRG_test_reject_membership_insert ON public.memberships',
      );
      await owner.query('DROP FUNCTION public.reject_test_membership_insert()');
    }
    expect(
      await owner.query<Array<{ organizations: number; claims: number }>>(
        `SELECT
          (SELECT count(*)::int FROM public.organizations
           WHERE slug = 'rollback-integral') AS organizations,
          (SELECT count(*)::int FROM public.organization_creation_idempotency
           WHERE actor_user_id = $1 AND idempotency_key = $2) AS claims`,
        [userId, key],
      ),
    ).toEqual([{ organizations: 0, claims: 0 }]);
  });

  it('rolls back after Membership when audit insertion fails', async () => {
    const userId = await createVerifiedUser('audit-rollback');
    const key = randomUUID();
    const slug = `audit-rollback-${randomUUID().slice(0, 8)}`;
    await owner.query(`
      CREATE FUNCTION public.reject_test_creation_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.correlation_id = '${key}'::uuid THEN
          RAISE EXCEPTION 'synthetic audit failure';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await owner.query(`
      CREATE TRIGGER TRG_test_reject_creation_audit
      BEFORE INSERT ON public.organization_audit_logs
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_creation_audit()
    `);
    try {
      await expect(
        createOrganization(userId, key, 'Audit Rollback', slug),
      ).rejects.toBeDefined();
    } finally {
      await owner.query(
        'DROP TRIGGER TRG_test_reject_creation_audit ON public.organization_audit_logs',
      );
      await owner.query('DROP FUNCTION public.reject_test_creation_audit()');
    }
    await expectNoCreationEffects(userId, key, slug);
  });

  it('rolls back Organization, Membership, audit and pipeline when snapshot completion fails', async () => {
    const userId = await createVerifiedUser('snapshot-rollback');
    const key = randomUUID();
    const slug = `snapshot-rollback-${randomUUID().slice(0, 8)}`;
    await owner.query(`
      CREATE FUNCTION public.reject_test_creation_snapshot()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.actor_user_id = '${userId}'::uuid
           AND NEW.idempotency_key = '${key}'::uuid
           AND NEW.result_organization_id IS NOT NULL THEN
          RAISE EXCEPTION 'synthetic snapshot failure';
        END IF;
        RETURN NEW;
      END; $$
    `);
    await owner.query(`
      CREATE TRIGGER TRG_test_reject_creation_snapshot
      BEFORE UPDATE ON public.organization_creation_idempotency
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_creation_snapshot()
    `);
    try {
      await expect(
        createOrganization(userId, key, 'Snapshot Rollback', slug),
      ).rejects.toBeDefined();
    } finally {
      await owner.query(
        'DROP TRIGGER TRG_test_reject_creation_snapshot ON public.organization_creation_idempotency',
      );
      await owner.query('DROP FUNCTION public.reject_test_creation_snapshot()');
    }
    await expectNoCreationEffects(userId, key, slug);
  });

  it('hardens the function and preserves runtime least privilege', async () => {
    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE!;
    const [boundary] = await owner.query<
      Array<{
        securityDefiner: boolean;
        volatility: string;
        parallelSafety: string;
        configuration: string[];
        publicCanExecute: boolean;
        canMutateCentral: boolean;
        executableFunctions: string[];
      }>
    >(
      `SELECT procedure.prosecdef AS "securityDefiner",
              procedure.provolatile AS volatility,
              procedure.proparallel AS "parallelSafety",
              procedure.proconfig AS configuration,
              EXISTS(
                SELECT 1 FROM aclexplode(
                  COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
                ) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS "publicCanExecute",
              EXISTS(
                SELECT 1 FROM unnest(ARRAY[
                  'organizations','memberships','pipelines','pipeline_stages',
                  'organization_creation_idempotency'
                ]) central(table_name)
                WHERE has_table_privilege(
                  $1, 'public.' || central.table_name,
                  'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                ) OR has_any_column_privilege(
                  $1, 'public.' || central.table_name,
                  'INSERT,UPDATE,REFERENCES'
                )
              ) AS "canMutateCentral",
              ARRAY(
                SELECT executable.oid::regprocedure::text
                FROM pg_proc executable
                JOIN pg_namespace namespace
                  ON namespace.oid = executable.pronamespace
                WHERE namespace.nspname = 'app_private'
                  AND has_function_privilege($1, executable.oid, 'EXECUTE')
                ORDER BY executable.oid::regprocedure::text
              ) AS "executableFunctions"
       FROM pg_proc procedure
       WHERE procedure.oid = to_regprocedure(
         'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)'
       )`,
      [runtimeRole],
    );
    expect(boundary).toEqual({
      securityDefiner: true,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: ['search_path=pg_catalog, app_private, pg_temp'],
      publicCanExecute: false,
      canMutateCentral: false,
      executableFunctions: CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS,
    });

    const readiness = new OperationalOrganizationCreationReadiness(1, runtime);
    await expect(readiness.assertReady()).resolves.toBeUndefined();
    await owner.query(`
      ALTER TABLE public.organization_creation_idempotency
      RENAME CONSTRAINT UQ_organization_creation_actor_key
      TO UQ_organization_creation_actor_key_drift
    `);
    try {
      await expect(readiness.assertReady()).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      await owner.query(`
        ALTER TABLE public.organization_creation_idempotency
        RENAME CONSTRAINT UQ_organization_creation_actor_key_drift
        TO UQ_organization_creation_actor_key
      `);
    }
    await owner.query(`
      ALTER TABLE public.organization_audit_logs
      RENAME CONSTRAINT CHK_organization_audit_logs_event
      TO CHK_organization_audit_logs_event_drift
    `);
    try {
      await expect(readiness.assertReady()).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      await owner.query(`
        ALTER TABLE public.organization_audit_logs
        RENAME CONSTRAINT CHK_organization_audit_logs_event_drift
        TO CHK_organization_audit_logs_event
      `);
    }
    await expect(readiness.assertReady()).resolves.toBeUndefined();
    await owner.query(
      `DROP TRIGGER trg_organization_creation_commands_insert
       ON public.organization_creation_commands`,
    );
    try {
      await expect(readiness.assertReady()).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      await owner.query(
        `CREATE TRIGGER trg_organization_creation_commands_insert
         INSTEAD OF INSERT ON public.organization_creation_commands
         FOR EACH ROW EXECUTE FUNCTION
           app_private.execute_organization_creation_command()`,
      );
    }
    await owner.query(
      `GRANT SELECT (actor_user_id)
       ON public.organization_creation_commands TO "${runtimeRole}"`,
    );
    try {
      await expect(readiness.assertReady()).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      await owner.query(
        `REVOKE SELECT (actor_user_id)
         ON public.organization_creation_commands FROM "${runtimeRole}"`,
      );
    }
    await expect(readiness.assertReady()).resolves.toBeUndefined();

    const userId = await createVerifiedUser('hostile-path');
    const queryRunner = runtime.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query(`SET search_path = public, pg_temp`);
      const rows = (await queryRunner.query(
        `INSERT INTO public.organization_creation_commands (
          actor_user_id,idempotency_key,request_fingerprint,organization_name,
          slug_base,ip_address,user_agent,create_permitted
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING
          result_organization_id AS organization_id,
          result_organization_name AS organization_name,
          result_organization_slug AS organization_slug,
          result_membership_id AS membership_id,
          result_membership_role AS membership_role,
          result_replayed AS replayed`,
        [
          userId,
          randomUUID(),
          fingerprint('Hostile Path'),
          'Hostile Path',
          `hostile-${randomUUID().slice(0, 8)}`,
          '127.0.0.1',
          'integration-test',
          true,
        ],
      )) as CreationRow[];
      expect(rows[0]?.membership_role).toBe('owner');
    } finally {
      await queryRunner.release();
    }
  });

  it('exposes only the approved command columns and exact trigger boundary', async () => {
    const runtimeRole = process.env.DATABASE_RUNTIME_ROLE!;
    const [boundary] = await owner.query<
      Array<{
        relationKind: string;
        visibleRows: number;
        triggerCount: number;
        runtimeInternalExecute: boolean;
        runtimeTriggerExecute: boolean;
        publicFunctionExecute: boolean;
        publicViewAccess: boolean;
        broadViewPrivilege: boolean;
        forbiddenColumnPrivilege: boolean;
        inputPrivileges: boolean;
        outputPrivileges: boolean;
        columnAclCount: number;
      }>
    >(
      `WITH target_functions AS (
         SELECT procedure.* FROM pg_proc AS procedure
         WHERE procedure.oid = ANY(ARRAY[
           'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)'::regprocedure,
           'app_private.execute_organization_creation_command()'::regprocedure
         ])
       ), command_columns AS (
         SELECT attribute.attname, attribute.attacl
         FROM pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.organization_creation_commands'::regclass
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
       )
       SELECT
         (SELECT relkind FROM pg_class
          WHERE oid = 'public.organization_creation_commands'::regclass)
           AS "relationKind",
         (SELECT count(*)::int FROM public.organization_creation_commands)
           AS "visibleRows",
         (SELECT count(*)::int FROM pg_trigger
          WHERE tgrelid = 'public.organization_creation_commands'::regclass
            AND NOT tgisinternal
            AND tgname = 'trg_organization_creation_commands_insert'
            AND tgfoid =
              'app_private.execute_organization_creation_command()'::regprocedure
            AND tgtype = 69 AND tgenabled = 'O') AS "triggerCount",
         has_function_privilege(
           $1,
           'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)',
           'EXECUTE'
         ) AS "runtimeInternalExecute",
         has_function_privilege(
           $1, 'app_private.execute_organization_creation_command()', 'EXECUTE'
         ) AS "runtimeTriggerExecute",
         EXISTS(
           SELECT 1 FROM target_functions
           CROSS JOIN LATERAL aclexplode(
             COALESCE(proacl, acldefault('f', proowner))
           ) AS acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ) AS "publicFunctionExecute",
         EXISTS(
           SELECT 1 FROM pg_class AS relation
           CROSS JOIN LATERAL aclexplode(
             COALESCE(relation.relacl, '{}'::aclitem[])
           ) AS acl
           WHERE relation.oid = 'public.organization_creation_commands'::regclass
             AND acl.grantee = 0
         ) OR EXISTS(
           SELECT 1 FROM command_columns
           CROSS JOIN LATERAL aclexplode(
             COALESCE(attacl, '{}'::aclitem[])
           ) AS acl
           WHERE acl.grantee = 0
         ) AS "publicViewAccess",
         has_table_privilege(
           $1, 'public.organization_creation_commands',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
         ) AS "broadViewPrivilege",
         has_any_column_privilege(
           $1, 'public.organization_creation_commands', 'UPDATE,REFERENCES'
         ) AS "forbiddenColumnPrivilege",
         NOT EXISTS(
           SELECT 1 FROM unnest(ARRAY[
             'actor_user_id','idempotency_key','request_fingerprint',
             'organization_name','slug_base','ip_address','user_agent',
             'create_permitted'
           ]) AS input(column_name)
           WHERE NOT has_column_privilege(
             $1, 'public.organization_creation_commands', input.column_name,
             'INSERT'
           ) OR has_column_privilege(
             $1, 'public.organization_creation_commands', input.column_name,
             'SELECT'
           )
         ) AS "inputPrivileges",
         NOT EXISTS(
           SELECT 1 FROM unnest(ARRAY[
             'result_organization_id','result_organization_name',
             'result_organization_slug','result_membership_id',
             'result_membership_role','result_replayed'
           ]) AS output(column_name)
           WHERE NOT has_column_privilege(
             $1, 'public.organization_creation_commands', output.column_name,
             'SELECT'
           ) OR has_column_privilege(
             $1, 'public.organization_creation_commands', output.column_name,
             'INSERT'
           )
         ) AS "outputPrivileges",
         (SELECT count(*)::int FROM command_columns
          CROSS JOIN LATERAL aclexplode(
            COALESCE(attacl, '{}'::aclitem[])
          ) AS acl
          WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
            AND NOT acl.is_grantable) AS "columnAclCount"`,
      [runtimeRole],
    );
    expect(boundary).toEqual({
      relationKind: 'v',
      visibleRows: 0,
      triggerCount: 1,
      runtimeInternalExecute: false,
      runtimeTriggerExecute: false,
      publicFunctionExecute: false,
      publicViewAccess: false,
      broadViewPrivilege: false,
      forbiddenColumnPrivilege: false,
      inputPrivileges: true,
      outputPrivileges: true,
      columnAclCount: 14,
    });

    await expect(
      runtime.query(
        'SELECT actor_user_id FROM public.organization_creation_commands',
      ),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
    await expect(
      runtime.query(
        'SELECT result_organization_id FROM public.organization_creation_commands',
      ),
    ).resolves.toEqual([]);
    await expect(
      runtime.query(
        `INSERT INTO public.organization_creation_commands (
           result_organization_id
         ) VALUES ($1::uuid)`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
    await expect(
      runtime.query(
        `UPDATE public.organization_creation_commands
         SET organization_name = 'forbidden'`,
      ),
    ).rejects.toBeDefined();
    await expect(
      runtime.query('DELETE FROM public.organization_creation_commands'),
    ).rejects.toBeDefined();
    await expect(
      runtime.query('TRUNCATE public.organization_creation_commands'),
    ).rejects.toBeDefined();
    await expect(
      runtime.query(
        `SELECT * FROM app_private.create_self_service_organization(
           $1,$2,$3,$4,$5,$6,$7,$8
         )`,
        [
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          'Forbidden',
          'forbidden',
          '127.0.0.1',
          'integration-test',
          true,
        ],
      ),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
    await expect(
      runtime.query(
        'SELECT app_private.execute_organization_creation_command()',
      ),
    ).rejects.toMatchObject({ driverError: { code: '42501' } });
  });

  it('refuses destructive down after organization creation facts exist', async () => {
    const queryRunner = owner.createQueryRunner();
    await queryRunner.connect();
    try {
      await expect(
        new CreateSelfServiceOrganizations1789245600000().down(queryRunner),
      ).rejects.toThrow(
        'Self-service organization rollback requires empty creation data.',
      );
    } finally {
      await queryRunner.release();
    }
    await expect(
      runtime.query(
        'SELECT result_organization_id FROM public.organization_creation_commands',
      ),
    ).resolves.toEqual([]);
  });

  async function createVerifiedUser(label: string): Promise<string> {
    const [user] = await owner.query<Array<{ id: string }>>(
      `INSERT INTO public.users (
        id,email,name,status,password_hash,password_changed_at,email_verified_at,
        created_at,updated_at
      ) VALUES (
        gen_random_uuid(),$1,$2,'active',NULL,NULL,transaction_timestamp(),
        transaction_timestamp(),transaction_timestamp()
      ) RETURNING id`,
      [`${label}-${randomUUID()}@example.test`, `User ${label}`],
    );
    if (!user) throw new Error('Could not create integration User.');
    return user.id;
  }

  async function waitForCreationLockWait(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [state] = await owner.query<Array<{ blocked: boolean }>>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE datname = pg_catalog.current_database()
            AND pid <> pg_catalog.pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%organization_creation_commands%'
        ) AS blocked
      `);
      if (state?.blocked) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Creation did not reach the expected User lock wait.');
  }

  async function expectNoCreationEffects(
    userId: string,
    key: string,
    slug: string,
  ): Promise<void> {
    const [state] = await owner.query<
      Array<{
        organizations: number;
        memberships: number;
        pipelines: number;
        audits: number;
        claims: number;
      }>
    >(
      `SELECT
        (SELECT count(*)::int FROM public.organizations
         WHERE slug = $3) AS organizations,
        (SELECT count(*)::int FROM public.memberships
         WHERE user_id = $1) AS memberships,
        (SELECT count(*)::int FROM public.pipelines pipeline
         JOIN public.organizations organization
           ON organization.id = pipeline.organization_id
         WHERE organization.slug = $3) AS pipelines,
        (SELECT count(*)::int FROM public.organization_audit_logs
         WHERE correlation_id = $2) AS audits,
        (SELECT count(*)::int FROM public.organization_creation_idempotency
         WHERE actor_user_id = $1 AND idempotency_key = $2) AS claims`,
      [userId, key, slug],
    );
    expect(state).toEqual({
      organizations: 0,
      memberships: 0,
      pipelines: 0,
      audits: 0,
      claims: 0,
    });
  }

  function createOrganization(
    userId: string,
    key: string,
    name: string,
    slugBase: string,
    createPermitted = true,
  ): Promise<CreationRow[]> {
    return runtime.query(
      `INSERT INTO public.organization_creation_commands (
        actor_user_id,idempotency_key,request_fingerprint,organization_name,
        slug_base,ip_address,user_agent,create_permitted
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING
        result_organization_id AS organization_id,
        result_organization_name AS organization_name,
        result_organization_slug AS organization_slug,
        result_membership_id AS membership_id,
        result_membership_role AS membership_role,
        result_replayed AS replayed`,
      [
        userId,
        key,
        fingerprint(name),
        name,
        slugBase,
        '127.0.0.1',
        'integration-test',
        createPermitted,
      ],
    );
  }

  function fingerprint(name: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ version: 1, name }), 'utf8')
      .digest('hex');
  }
});
