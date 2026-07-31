import { registerAs } from '@nestjs/config';
import { resolveApiPublicReplicaCount } from './app.config';

export interface LeadConfig {
  formReadiness: boolean;
  formOrganizationId: string | null;
  formCurrentKeyVersion: number | null;
  formKeys: ReadonlyMap<number, Buffer>;
  idempotencyCurrentKeyVersion: number | null;
  idempotencyKeys: ReadonlyMap<number, Buffer>;
  publicReplicaCount: number;
  rateLimitWindowSeconds: number;
  formIpMaxAttempts: number;
  formKeyMaxAttempts: number;
  rateLimitMaxBuckets: number;
  readRateLimitWindowSeconds: number;
  readMembershipMaxAttempts: number;
  readIpMaxAttempts: number;
  metricsMembershipMaxAttempts: number;
  readRateLimitMaxBuckets: number;
  readStatementTimeoutMs: number;
}

export function parseLeadKeyring(
  name: string,
  value: string | undefined,
): ReadonlyMap<number, Buffer> {
  if (value === undefined || value.trim() === '') return new Map();
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  const keys = new Map<number, Buffer>();
  for (const [rawVersion, rawKey] of Object.entries(parsed)) {
    const version = Number(rawVersion);
    if (
      !Number.isInteger(version) ||
      version < 1 ||
      version > 32767 ||
      typeof rawKey !== 'string'
    ) {
      throw new Error(`${name} contains an invalid entry.`);
    }
    const key = Buffer.from(rawKey, 'base64');
    if (key.length < 32 || key.toString('base64') !== rawKey) {
      throw new Error(
        `${name} keys must be canonical base64 and at least 32 bytes.`,
      );
    }
    keys.set(version, key);
  }
  return keys;
}

function parseCurrentVersion(
  name: string,
  value: string | undefined,
  keys: ReadonlyMap<number, Buffer>,
): number | null {
  const raw = value?.trim();
  if (raw === undefined || raw === '') return null;
  const version = Number(raw);
  if (!Number.isInteger(version) || !keys.has(version)) {
    throw new Error(`${name} must reference a configured key.`);
  }
  return version;
}

export default registerAs('lead', (): LeadConfig => {
  const formKeys = parseLeadKeyring(
    'LEAD_FORM_KEYS',
    process.env.LEAD_FORM_KEYS,
  );
  const idempotencyKeys = parseLeadKeyring(
    'LEAD_IDEMPOTENCY_KEYS',
    process.env.LEAD_IDEMPOTENCY_KEYS,
  );
  const formReadiness = process.env.LEAD_FORM_READINESS === 'true';
  const formOrganizationId =
    process.env.LEAD_FORM_ORGANIZATION_ID?.trim() || null;
  const formCurrentKeyVersion = parseCurrentVersion(
    'LEAD_FORM_KEY_CURRENT_VERSION',
    process.env.LEAD_FORM_KEY_CURRENT_VERSION,
    formKeys,
  );
  const idempotencyCurrentKeyVersion = parseCurrentVersion(
    'LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION',
    process.env.LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION,
    idempotencyKeys,
  );
  if (
    formReadiness &&
    (formOrganizationId === null ||
      formCurrentKeyVersion === null ||
      idempotencyCurrentKeyVersion === null)
  ) {
    throw new Error(
      'Lead form was enabled without complete runtime configuration.',
    );
  }
  return {
    formReadiness,
    formOrganizationId,
    formCurrentKeyVersion,
    formKeys,
    idempotencyCurrentKeyVersion,
    idempotencyKeys,
    publicReplicaCount: resolveApiPublicReplicaCount(),
    rateLimitWindowSeconds: Number(
      process.env.LEAD_FORM_RATE_LIMIT_WINDOW_SECONDS ?? 900,
    ),
    formIpMaxAttempts: Number(process.env.LEAD_FORM_IP_MAX_ATTEMPTS ?? 30),
    formKeyMaxAttempts: Number(process.env.LEAD_FORM_KEY_MAX_ATTEMPTS ?? 300),
    rateLimitMaxBuckets: Number(
      process.env.LEAD_FORM_RATE_LIMIT_MAX_BUCKETS ?? 10_000,
    ),
    readRateLimitWindowSeconds: Number(
      process.env.LEAD_READ_RATE_LIMIT_WINDOW_SECONDS ?? 60,
    ),
    readMembershipMaxAttempts: Number(
      process.env.LEAD_READ_MEMBERSHIP_MAX_ATTEMPTS ?? 120,
    ),
    readIpMaxAttempts: Number(process.env.LEAD_READ_IP_MAX_ATTEMPTS ?? 300),
    metricsMembershipMaxAttempts: Number(
      process.env.LEAD_METRICS_MEMBERSHIP_MAX_ATTEMPTS ?? 30,
    ),
    readRateLimitMaxBuckets: Number(
      process.env.LEAD_READ_RATE_LIMIT_MAX_BUCKETS ?? 10_000,
    ),
    readStatementTimeoutMs: Number(
      process.env.LEAD_READ_STATEMENT_TIMEOUT_MS ?? 3_000,
    ),
  };
});
