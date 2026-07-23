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
  return {
    formReadiness: process.env.LEAD_FORM_READINESS === 'true',
    formOrganizationId: process.env.LEAD_FORM_ORGANIZATION_ID?.trim() || null,
    formCurrentKeyVersion: parseCurrentVersion(
      'LEAD_FORM_KEY_CURRENT_VERSION',
      process.env.LEAD_FORM_KEY_CURRENT_VERSION,
      formKeys,
    ),
    formKeys,
    idempotencyCurrentKeyVersion: parseCurrentVersion(
      'LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION',
      process.env.LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION,
      idempotencyKeys,
    ),
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
  };
});
