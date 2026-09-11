import { DataSource } from 'typeorm';
import { CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS } from '../src/database/runtime-executable-functions';
import {
  configureIntegrationRuntimeEnvironment,
  createIntegrationDataSource,
  createIntegrationRuntimeDataSource,
  prepareIntegrationRuntimeRole,
} from './support/integration-data-source';

describe('Self-service organization migration compatibility', () => {
  let base: DataSource;
  let corrected: DataSource;
  let runtime: DataSource;

  beforeAll(async () => {
    configureIntegrationRuntimeEnvironment();
    base = createIntegrationDataSource({
      includeOrganizationCreationBase: true,
    });
    await base.initialize();
    await prepareIntegrationRuntimeRole(base);
    await base.dropDatabase();
    await base.runMigrations({ transaction: 'all' });
    runtime = createIntegrationRuntimeDataSource();
    await runtime.initialize();
  }, 120_000);

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (corrected?.isInitialized) await corrected.destroy();
    if (base?.isInitialized) {
      await base.dropDatabase();
      await base.destroy();
    }
  });

  it('keeps the factual runtime executable set unchanged and reverses cleanly', async () => {
    const before = await runtimeExecutableFunctions(runtime);
    expect(before).toEqual(CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS);

    corrected = createIntegrationDataSource({
      includeOrganizationCreation: true,
    });
    await corrected.initialize();
    const applied = await corrected.runMigrations({ transaction: 'all' });
    expect(applied.map((migration) => migration.name)).toEqual([
      'CreateSelfServiceOrganizations1789245600000',
    ]);

    const after = await runtimeExecutableFunctions(runtime);
    expect(after).toEqual(before);
    expect(after).not.toContain(
      'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)',
    );
    expect(after).not.toContain(
      'app_private.execute_organization_creation_command()',
    );

    await corrected.undoLastMigration({ transaction: 'all' });
    const [removed] = await base.query<
      Array<{
        viewExists: boolean;
        tableExists: boolean;
        internalFunctionExists: boolean;
        triggerFunctionExists: boolean;
        eventStillAllowed: boolean;
      }>
    >(`SELECT
      to_regclass('public.organization_creation_commands') IS NOT NULL
        AS "viewExists",
      to_regclass('public.organization_creation_idempotency') IS NOT NULL
        AS "tableExists",
      to_regprocedure(
        'app_private.create_self_service_organization(uuid,uuid,text,text,text,inet,text,boolean)'
      ) IS NOT NULL AS "internalFunctionExists",
      to_regprocedure('app_private.execute_organization_creation_command()')
        IS NOT NULL AS "triggerFunctionExists",
      EXISTS(
        SELECT 1 FROM pg_constraint AS audit_constraint
        WHERE audit_constraint.conrelid =
                'public.organization_audit_logs'::regclass
          AND audit_constraint.conname = 'chk_organization_audit_logs_event'
          AND strpos(
            pg_get_constraintdef(audit_constraint.oid),
            'organization.created'
          ) > 0
      ) AS "eventStillAllowed"`);
    expect(removed).toEqual({
      viewExists: false,
      tableExists: false,
      internalFunctionExists: false,
      triggerFunctionExists: false,
      eventStillAllowed: false,
    });
    expect(await runtimeExecutableFunctions(runtime)).toEqual(before);
  });

  async function runtimeExecutableFunctions(
    connection: DataSource,
  ): Promise<string[]> {
    const [row] = await connection.query<
      Array<{ executableFunctions: string[] }>
    >(`SELECT ARRAY(
      SELECT procedure.oid::regprocedure::text
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'app_private'
        AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
      ORDER BY procedure.oid::regprocedure::text
    ) AS "executableFunctions"`);
    return row?.executableFunctions ?? [];
  }
});
