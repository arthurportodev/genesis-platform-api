import invitationConfig from '../src/config/invitation.config';

describe('invitation production rollout configuration', () => {
  const names = [
    'NODE_ENV',
    'INVITATION_ISSUANCE_READINESS',
    'INVITATION_ACCEPTANCE_READINESS',
    'INVITATION_ACTIVATION_READINESS',
    'INVITATION_WORKER_ENABLED',
    'API_PUBLIC_REPLICA_COUNT',
    'INVITATION_PUBLIC_REPLICA_COUNT',
    'INVITATION_ACCEPTANCE_URL',
    'INVITATION_EMAIL_FROM',
    'INVITATION_TOKEN_CURRENT_VERSION',
    'INVITATION_TOKEN_KEYS',
    'RESEND_API_KEY',
  ] as const;
  const original = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const name of names) original.set(name, process.env[name]);
  });

  afterEach(() => {
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('opens issuance only when every production precondition is explicit', () => {
    configureCompleteRollout();
    expect(invitationConfig()).toMatchObject({
      issuanceReady: true,
      acceptanceReady: true,
      activationReady: true,
      workerEnabled: true,
      publicReplicaCount: 1,
    });
  });

  it.each([
    ['INVITATION_ACCEPTANCE_READINESS', 'false'],
    ['INVITATION_ACTIVATION_READINESS', 'false'],
    ['INVITATION_WORKER_ENABLED', 'false'],
    ['API_PUBLIC_REPLICA_COUNT', '2'],
    ['RESEND_API_KEY', ''],
  ])('fails issuance closed when %s is not ready', (name, value) => {
    configureCompleteRollout();
    process.env[name] = value;
    expect(invitationConfig().issuanceReady).toBe(false);
  });

  it('temporarily accepts the legacy replica name and rejects conflicts', () => {
    configureCompleteRollout();
    delete process.env.API_PUBLIC_REPLICA_COUNT;
    process.env.INVITATION_PUBLIC_REPLICA_COUNT = '1';
    expect(invitationConfig().publicReplicaCount).toBe(1);

    process.env.API_PUBLIC_REPLICA_COUNT = '2';
    expect(() => invitationConfig()).toThrow(
      'API_PUBLIC_REPLICA_COUNT conflicts with INVITATION_PUBLIC_REPLICA_COUNT.',
    );
  });

  function configureCompleteRollout(): void {
    process.env.NODE_ENV = 'production';
    process.env.INVITATION_ISSUANCE_READINESS = 'true';
    process.env.INVITATION_ACCEPTANCE_READINESS = 'true';
    process.env.INVITATION_ACTIVATION_READINESS = 'true';
    process.env.INVITATION_WORKER_ENABLED = 'true';
    process.env.API_PUBLIC_REPLICA_COUNT = '1';
    delete process.env.INVITATION_PUBLIC_REPLICA_COUNT;
    process.env.INVITATION_ACCEPTANCE_URL =
      'https://app.example.com/invitations/accept';
    process.env.INVITATION_EMAIL_FROM = 'Genesis <invites@example.com>';
    process.env.INVITATION_TOKEN_CURRENT_VERSION = '1';
    process.env.INVITATION_TOKEN_KEYS = JSON.stringify({
      1: Buffer.alloc(32, 1).toString('base64'),
    });
    process.env.RESEND_API_KEY = 'test-provider-key';
  }
});
