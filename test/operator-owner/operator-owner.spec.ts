import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DataSource } from 'typeorm';
import {
  executeAuthorizedOperatorOwnerCreate,
  OperatorOwnerInteraction,
  parseOperatorOwnerCliArguments,
  PRODUCTION_OWNER_AUTHORIZATION,
} from '../../src/database/operator-owner/cli';
import { MaskedTtyInput } from '../../src/database/operator-owner/masked-tty-input';
import {
  OperatorOwnerError,
  prepareOperatorOwnerIdentity,
  slugifyOrganizationName,
} from '../../src/database/operator-owner/operator-owner.model';
import { OperatorOwnerService } from '../../src/database/operator-owner/operator-owner.service';

const organizationId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const membershipId = '33333333-3333-4333-8333-333333333333';

describe('private operator OWNER CLI contract', () => {
  it('accepts create with no data in argv and requires exact scoped IDs for status', () => {
    expect(parseOperatorOwnerCliArguments(['create'])).toEqual({
      command: 'create',
      identifiers: null,
    });
    expect(parseOperatorOwnerCliArguments(['status'])).toEqual({
      command: 'status',
      identifiers: null,
    });
    expect(
      parseOperatorOwnerCliArguments([
        'status',
        '--organization-id',
        organizationId,
        '--user-id',
        userId,
        '--membership-id',
        membershipId,
      ]),
    ).toEqual({
      command: 'status',
      identifiers: { organizationId, userId, membershipId },
    });
  });

  it.each([
    ['create', '--password', 'not-allowed'],
    ['create', '--email', 'owner@example.com'],
    ['status', '--organization-id', organizationId],
    [
      'status',
      '--organization-id',
      organizationId,
      '--user-id',
      userId,
      '--membership-id',
      'not-a-uuid',
    ],
  ])('rejects unsafe or unscoped arguments: %j', (...arguments_) => {
    expect(
      captureError(() => parseOperatorOwnerCliArguments(arguments_)),
    ).toMatchObject({ code: 'INVALID_ARGUMENTS' });
  });

  it('uses the official email normalization and deterministic safe slug', () => {
    expect(
      prepareOperatorOwnerIdentity({
        organizationName: '  Agência Gênesis  ',
        ownerName: '  Arthur Porto  ',
        email: '  Arthur+Owner@Example.COM  ',
      }),
    ).toEqual({
      organizationName: 'Agência Gênesis',
      organizationSlug: 'agencia-genesis',
      ownerName: 'Arthur Porto',
      emailNormalized: 'arthur+owner@example.com',
    });
    expect(slugifyOrganizationName('São João & Filhos')).toBe(
      'sao-joao-filhos',
    );
  });

  it.each([
    {
      organizationName: '',
      ownerName: 'Owner',
      email: 'owner@example.com',
      code: 'INVALID_ORGANIZATION_NAME',
    },
    {
      organizationName: 'Organização',
      ownerName: '',
      email: 'owner@example.com',
      code: 'INVALID_OWNER_NAME',
    },
    {
      organizationName: 'Organização',
      ownerName: 'Owner',
      email: 'not-an-email',
      code: 'INVALID_EMAIL',
    },
    {
      organizationName: '東京',
      ownerName: 'Owner',
      email: 'owner@example.com',
      code: 'INVALID_ORGANIZATION_NAME',
    },
  ])('rejects invalid identity input without reflecting it', (scenario) => {
    expect(
      captureError(() => prepareOperatorOwnerIdentity(scenario)),
    ).toMatchObject({ code: scenario.code });
  });

  it('clears an invalid password buffer and never reflects the secret', async () => {
    const password = Buffer.from('short');
    const identity = prepareOperatorOwnerIdentity({
      organizationName: 'Production Owner Test',
      ownerName: 'Owner Test',
      email: 'owner@example.com',
    });
    const query = jest.fn();
    const connection = {
      query,
    } as unknown as DataSource;
    const service = new OperatorOwnerService(connection);

    let failure: unknown;
    try {
      await service.create(identity, password);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OperatorOwnerError);
    expect(failure).toMatchObject({ code: 'INVALID_PASSWORD' });
    expect(JSON.stringify(failure)).not.toContain('short');
    expect([...password]).toEqual(new Array(password.length).fill(0));
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the CLI outside AppModule/main and adds no controller, endpoint or migration', () => {
    const repositoryRoot = join(__dirname, '../..');
    const appModule = readFileSync(
      join(repositoryRoot, 'src/app.module.ts'),
      'utf8',
    );
    const main = readFileSync(join(repositoryRoot, 'src/main.ts'), 'utf8');
    const cli = readFileSync(
      join(repositoryRoot, 'src/database/operator-owner/cli.ts'),
      'utf8',
    );
    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const migrations = readdirSync(
      join(repositoryRoot, 'src/database/migrations'),
    ).filter((file) => file.endsWith('.ts'));

    expect(packageJson.scripts['operator:owner']).toBe(
      'node dist/database/operator-owner/cli.js',
    );
    expect(`${appModule}\n${main}`).not.toMatch(
      /operator-owner|operator:owner/u,
    );
    expect(cli).not.toMatch(/@(Controller|Get|Post|Put|Patch|Delete)\b/u);
    expect(migrations).toHaveLength(10);
    expect(migrations).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/operator|owner-onboarding/iu),
      ]),
    );
  });
});

describe('production OWNER authorization orchestration', () => {
  const passwordText = 'never-log-this-password-10A';

  it('prints the sanitized summary, requires the exact phrase and calls create exactly once', async () => {
    const password = Buffer.from(passwordText);
    const confirmation = Buffer.from(passwordText);
    const harness = createInteractionHarness({
      questions: [
        'Agência Produção',
        'Arthur Porto',
        'Arthur@Example.COM',
        PRODUCTION_OWNER_AUTHORIZATION,
      ],
      secrets: [password, confirmation],
    });
    let passwordAtExecution = '';
    const execute = jest.fn((_identity: unknown, value: Buffer) => {
      passwordAtExecution = value.toString('utf8');
      return Promise.resolve(createResult());
    });

    await expect(
      executeAuthorizedOperatorOwnerCreate(harness.interaction, execute),
    ).resolves.toEqual(createResult());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(passwordAtExecution).toBe(passwordText);
    expect(harness.writes).toHaveLength(1);
    const summary = JSON.parse(harness.writes[0] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      status: 'WAITING_FOR_CREATION_AUTHORIZATION',
      organization: 'Agência Produção',
      ownerName: 'Arthur Porto',
      emailNormalized: 'arthur@example.com',
      role: 'OWNER',
      initialLeads: 0,
      mechanism: 'private operator CLI',
      command: 'npm run operator:owner -- create',
      cli: 'dist/database/operator-owner/cli.js',
      image: 'immutable auxiliary image selected by digest at execution',
      transaction: 'single SERIALIZABLE transaction with full rollback',
    });
    expect(harness.writes.join('')).not.toContain(passwordText);
    expect(JSON.stringify(summary)).not.toMatch(
      /passwordHash|argon2|tokenHash/iu,
    );
    expectZeroed(password);
    expectZeroed(confirmation);
  });

  it('rejects password mismatch before summary or create and wipes both buffers', async () => {
    const password = Buffer.from(passwordText);
    const confirmation = Buffer.from('different-password-10A');
    const harness = createInteractionHarness({
      questions: ['Org', 'Owner', 'owner@example.com'],
      secrets: [password, confirmation],
    });
    const execute = jest.fn();

    await expect(
      executeAuthorizedOperatorOwnerCreate(harness.interaction, execute),
    ).rejects.toMatchObject({ code: 'PASSWORD_MISMATCH' });
    expect(execute).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);
    expectZeroed(password);
    expectZeroed(confirmation);
  });

  it.each(['wrong phrase', ''])(
    'rejects wrong or missing authorization (%j), calls create zero times and wipes secrets',
    async (authorization) => {
      const password = Buffer.from(passwordText);
      const confirmation = Buffer.from(passwordText);
      const harness = createInteractionHarness({
        questions: ['Org', 'Owner', 'owner@example.com', authorization],
        secrets: [password, confirmation],
      });
      const execute = jest.fn();
      let failure: unknown;
      try {
        await executeAuthorizedOperatorOwnerCreate(
          harness.interaction,
          execute,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'CREATION_NOT_AUTHORIZED' });
      expect(execute).not.toHaveBeenCalled();
      expect(
        `${harness.writes.join('')} ${JSON.stringify(failure)}`,
      ).not.toContain(passwordText);
      expectZeroed(password);
      expectZeroed(confirmation);
    },
  );

  it('fails closed on authorization EOF/cancel, calls create zero times and wipes secrets', async () => {
    const password = Buffer.from(passwordText);
    const confirmation = Buffer.from(passwordText);
    const harness = createInteractionHarness({
      questions: ['Org', 'Owner', 'owner@example.com'],
      secrets: [password, confirmation],
      questionFailureAt: 3,
    });
    const execute = jest.fn();

    await expect(
      executeAuthorizedOperatorOwnerCreate(harness.interaction, execute),
    ).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
    expect(execute).not.toHaveBeenCalled();
    expect(harness.writes.join('')).not.toContain(passwordText);
    expectZeroed(password);
    expectZeroed(confirmation);
  });

  it('wipes the first secret if confirmation input is cancelled', async () => {
    const password = Buffer.from(passwordText);
    const interaction: OperatorOwnerInteraction = {
      question: jest
        .fn()
        .mockResolvedValueOnce('Org')
        .mockResolvedValueOnce('Owner')
        .mockResolvedValueOnce('owner@example.com'),
      readSecret: jest
        .fn()
        .mockResolvedValueOnce(password)
        .mockRejectedValueOnce(new Error('cancelled')),
      writeSanitized: jest.fn(),
    };
    const execute = jest.fn();
    await expect(
      executeAuthorizedOperatorOwnerCreate(interaction, execute),
    ).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
    expect(execute).not.toHaveBeenCalled();
    expectZeroed(password);
  });
});

describe('masked TTY secret input', () => {
  it('returns secret bytes without echoing them and clears the source chunk', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const reader = new MaskedTtyInput(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    const reading = reader.read('Password');
    const chunk = Buffer.from('hidden-value\r');
    input.emit('data', chunk);
    const value = await reading;

    expect(value.toString('utf8')).toBe('hidden-value');
    expect(output.writes.join('')).toBe('Password (input hidden): \n');
    expect(output.writes.join('')).not.toContain('hidden-value');
    expectZeroed(chunk);
    value.fill(0);
  });

  it('fails closed on Ctrl+C without exposing input', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const reader = new MaskedTtyInput(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    const reading = reader.read('Password');
    const chunk = Buffer.from([0x03]);
    input.emit('data', chunk);
    await expect(reading).rejects.toMatchObject({
      code: 'PASSWORD_INPUT_CANCELLED',
    });
    expect(output.writes.join('')).not.toContain('never-log-this-password-10A');
    expectZeroed(chunk);
  });
});

function captureError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function createInteractionHarness(options: {
  questions: string[];
  secrets: Buffer[];
  questionFailureAt?: number;
}): { interaction: OperatorOwnerInteraction; writes: string[] } {
  let questionIndex = 0;
  let secretIndex = 0;
  const writes: string[] = [];
  return {
    interaction: {
      question: () => {
        if (questionIndex === options.questionFailureAt) {
          return Promise.reject(new Error('EOF'));
        }
        const value = options.questions[questionIndex];
        questionIndex += 1;
        return value === undefined
          ? Promise.reject(new Error('EOF'))
          : Promise.resolve(value);
      },
      readSecret: () => {
        const value = options.secrets[secretIndex];
        secretIndex += 1;
        return value === undefined
          ? Promise.reject(new Error('EOF'))
          : Promise.resolve(value);
      },
      writeSanitized: (value) => {
        writes.push(value);
      },
    },
    writes,
  };
}

function createResult() {
  return {
    status: 'CREATED' as const,
    organizationId,
    userId,
    membershipId,
    organization: 'Agência Produção',
    organizationSlug: 'agencia-producao',
    emailNormalized: 'arthur@example.com',
    role: 'OWNER' as const,
    organizationActive: true as const,
    userActive: true as const,
    membershipActive: true as const,
    initialLeads: 0 as const,
    initialSessions: 0 as const,
    initialRefreshTokens: 0 as const,
    createdAt: '2026-08-21T00:00:00.000Z',
    loginInstruction: 'Open the CRM.',
  };
}

function expectZeroed(value: Buffer): void {
  expect([...value]).toEqual(new Array(value.length).fill(0));
}

class FakeTtyInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

class FakeTtyOutput {
  readonly isTTY = true;
  readonly writes: string[] = [];

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }
}
