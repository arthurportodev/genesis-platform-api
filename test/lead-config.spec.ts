import leadConfig from '../src/config/lead.config';

describe('lead production rollout configuration', () => {
  const names = [
    'LEAD_FORM_READINESS',
    'LEAD_FORM_ORGANIZATION_ID',
    'LEAD_FORM_KEY_CURRENT_VERSION',
    'LEAD_FORM_KEYS',
    'LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION',
    'LEAD_IDEMPOTENCY_KEYS',
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

  it('fails fast when the public lead form is enabled incompletely', () => {
    process.env.LEAD_FORM_READINESS = 'true';
    delete process.env.LEAD_FORM_ORGANIZATION_ID;
    delete process.env.LEAD_FORM_KEY_CURRENT_VERSION;
    delete process.env.LEAD_FORM_KEYS;
    delete process.env.LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION;
    delete process.env.LEAD_IDEMPOTENCY_KEYS;

    expect(() => leadConfig()).toThrow(
      'Lead form was enabled without complete runtime configuration.',
    );
  });

  it('accepts a complete synthetic lead form configuration', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    process.env.LEAD_FORM_READINESS = 'true';
    process.env.LEAD_FORM_ORGANIZATION_ID =
      '4d55c325-bb9a-4aac-9cf0-4cb9c5a37cb0';
    process.env.LEAD_FORM_KEY_CURRENT_VERSION = '1';
    process.env.LEAD_FORM_KEYS = JSON.stringify({ 1: key });
    process.env.LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION = '1';
    process.env.LEAD_IDEMPOTENCY_KEYS = JSON.stringify({ 1: key });

    expect(leadConfig()).toMatchObject({
      formReadiness: true,
      formCurrentKeyVersion: 1,
      idempotencyCurrentKeyVersion: 1,
    });
  });
});
