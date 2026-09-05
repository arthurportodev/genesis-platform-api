import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  OperatorOwnerCreateResult,
  OperatorOwnerError,
  OperatorOwnerIdentifiers,
  prepareOperatorOwnerIdentity,
  prepareOperatorOwnerResolution,
  PreparedOperatorOwnerInput,
  PreparedOperatorOwnerResolution,
} from './operator-owner.model';
import { OperatorOwnerService } from './operator-owner.service';
import { MaskedTtyInput } from './masked-tty-input';

type OperatorOwnerCommand = 'create' | 'resolve' | 'status';

export const PRODUCTION_OWNER_AUTHORIZATION =
  'AUTORIZO A CRIAÇÃO DA MINHA ORGANIZAÇÃO E CONTA OWNER DE PRODUÇÃO';

export interface OperatorOwnerCliArguments {
  command: OperatorOwnerCommand;
  identifiers: OperatorOwnerIdentifiers | null;
  resolution: PreparedOperatorOwnerResolution | null;
}

export interface OperatorOwnerInteraction {
  question(prompt: string): Promise<string>;
  readSecret(prompt: string): Promise<Buffer>;
  writeSanitized(value: string): void;
}

export type AuthorizedCreateExecutor = (
  identity: PreparedOperatorOwnerInput,
  password: Buffer,
) => Promise<OperatorOwnerCreateResult>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseOperatorOwnerCliArguments(
  arguments_: string[],
): OperatorOwnerCliArguments {
  const command = arguments_[0];
  if (command !== 'create' && command !== 'resolve' && command !== 'status') {
    invalidArguments();
  }
  if (command === 'create') {
    if (arguments_.length !== 1) invalidArguments();
    return { command, identifiers: null, resolution: null };
  }
  if (command === 'resolve') {
    const values = parseOptions(arguments_.slice(1), [
      '--email',
      '--organization-slug',
    ]);
    if (values.size !== 2) invalidArguments();
    return {
      command,
      identifiers: null,
      resolution: prepareOperatorOwnerResolution({
        email: values.get('--email') ?? '',
        organizationSlug: values.get('--organization-slug') ?? '',
      }),
    };
  }
  if (arguments_.length === 1) {
    return { command, identifiers: null, resolution: null };
  }
  const values = parseOptions(arguments_.slice(1), [
    '--organization-id',
    '--user-id',
    '--membership-id',
  ]);
  const identifiers = {
    organizationId: values.get('--organization-id') ?? '',
    userId: values.get('--user-id') ?? '',
    membershipId: values.get('--membership-id') ?? '',
  };
  if (
    values.size !== 3 ||
    !UUID_PATTERN.test(identifiers.organizationId) ||
    !UUID_PATTERN.test(identifiers.userId) ||
    !UUID_PATTERN.test(identifiers.membershipId)
  ) {
    invalidArguments();
  }
  return { command, identifiers, resolution: null };
}

function parseOptions(
  arguments_: string[],
  allowed: string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      value.startsWith('--') ||
      !allowed.includes(option) ||
      values.has(option)
    ) {
      invalidArguments();
    }
    values.set(option, value);
  }
  return values;
}

export async function executeAuthorizedOperatorOwnerCreate(
  interaction: OperatorOwnerInteraction,
  execute: AuthorizedCreateExecutor,
): Promise<OperatorOwnerCreateResult> {
  let password: Buffer | null = null;
  let confirmation: Buffer | null = null;
  try {
    const identity = prepareOperatorOwnerIdentity({
      organizationName: await interaction.question('Organization name: '),
      ownerName: await interaction.question('OWNER name: '),
      email: await interaction.question('OWNER email: '),
    });
    password = await interaction.readSecret('Password');
    confirmation = await interaction.readSecret('Confirm password');
    if (!password.equals(confirmation)) {
      throw new OperatorOwnerError(
        'PASSWORD_MISMATCH',
        'Password confirmation does not match.',
      );
    }
    confirmation.fill(0);
    confirmation = null;

    interaction.writeSanitized(
      `${JSON.stringify({
        status: 'WAITING_FOR_CREATION_AUTHORIZATION',
        organization: identity.organizationName,
        ownerName: identity.ownerName,
        emailNormalized: identity.emailNormalized,
        role: 'OWNER',
        initialLeads: 0,
        mechanism: 'private operator CLI',
        command: 'npm run operator:owner -- create',
        cli: 'dist/database/operator-owner/cli.js',
        image: 'immutable auxiliary image selected by digest at execution',
        transaction: 'single SERIALIZABLE transaction with full rollback',
      })}\n`,
    );
    const authorization = await interaction.question(
      `Type exactly: ${PRODUCTION_OWNER_AUTHORIZATION}\n> `,
    );
    if (authorization !== PRODUCTION_OWNER_AUTHORIZATION) {
      throw new OperatorOwnerError(
        'CREATION_NOT_AUTHORIZED',
        'Exact production OWNER creation authorization was not provided.',
      );
    }
    return await execute(identity, password);
  } catch (error) {
    if (error instanceof OperatorOwnerError) throw error;
    throw new OperatorOwnerError(
      'INPUT_CANCELLED',
      'Interactive owner onboarding input was cancelled or closed.',
    );
  } finally {
    password?.fill(0);
    confirmation?.fill(0);
  }
}

async function run(): Promise<void> {
  const arguments_ = parseOperatorOwnerCliArguments(process.argv.slice(2));
  if (arguments_.command === 'create') {
    requireTty('Owner onboarding creation requires a secure TTY.');
    const result = await executeAuthorizedOperatorOwnerCreate(
      createTtyInteraction(),
      (identity, password) =>
        withOwnerService((service) => service.create(identity, password)),
    );
    console.log(JSON.stringify(result));
    return;
  }

  if (arguments_.command === 'resolve') {
    const resolution = arguments_.resolution;
    if (resolution === null) invalidArguments();
    const result = await withOwnerService((service) =>
      service.resolve(resolution),
    );
    console.log(JSON.stringify(result));
    if (result.status !== 'RESOLVED') process.exitCode = 2;
    return;
  }

  const identifiers = arguments_.identifiers ?? (await readStatusIdentifiers());
  const result = await withOwnerService((service) =>
    service.status(identifiers),
  );
  console.log(JSON.stringify(result));
  if (result.status !== 'READY') process.exitCode = 2;
}

function createTtyInteraction(): OperatorOwnerInteraction {
  const secretInput = new MaskedTtyInput();
  return {
    question: questionTty,
    readSecret: (prompt) => secretInput.read(prompt),
    writeSanitized: (value) => {
      stdout.write(value);
    },
  };
}

async function questionTty(promptText: string): Promise<string> {
  requireTty('Interactive owner onboarding input requires a TTY.');
  const prompt = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  prompt.once('SIGINT', cancel);
  prompt.once('close', cancel);
  try {
    return await prompt.question(promptText, { signal: cancellation.signal });
  } finally {
    prompt.off('SIGINT', cancel);
    prompt.off('close', cancel);
    prompt.close();
  }
}

async function readStatusIdentifiers(): Promise<OperatorOwnerIdentifiers> {
  const organizationId = await questionTty('Organization ID: ');
  const userId = await questionTty('User ID: ');
  const membershipId = await questionTty('Membership ID: ');
  const parsed = parseOperatorOwnerCliArguments([
    'status',
    '--organization-id',
    organizationId,
    '--user-id',
    userId,
    '--membership-id',
    membershipId,
  ]);
  if (parsed.identifiers === null) invalidArguments();
  return parsed.identifiers;
}

async function withOwnerService<T>(
  operation: (service: OperatorOwnerService) => Promise<T>,
): Promise<T> {
  const imported = await import('../data-source');
  const connection = imported.default;
  let initializedHere = false;
  try {
    if (!connection.isInitialized) {
      await connection.initialize();
      initializedHere = true;
    }
    return await operation(new OperatorOwnerService(connection));
  } finally {
    if (initializedHere && connection.isInitialized) {
      await connection.destroy();
    }
  }
}

function requireTty(message: string): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new OperatorOwnerError('SECURE_TTY_REQUIRED', message);
  }
}

function invalidArguments(): never {
  throw new OperatorOwnerError(
    'INVALID_ARGUMENTS',
    'Use create without options, resolve with exact email and organization slug, or status with the three explicit identifiers.',
  );
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    const code =
      error instanceof OperatorOwnerError ? error.code : 'UNEXPECTED_FAILURE';
    console.error(JSON.stringify({ status: 'FAILED', code }));
    process.exitCode = 1;
  });
}
