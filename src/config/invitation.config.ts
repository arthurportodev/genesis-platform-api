import { registerAs } from '@nestjs/config';
import { resolveApiPublicReplicaCount } from './app.config';

export interface InvitationConfig {
  issuanceReady: boolean;
  acceptanceReady: boolean;
  activationReady: boolean;
  workerEnabled: boolean;
  workerHealthPort: number;
  acceptanceUrl: string;
  emailFrom: string;
  resendApiKey: string | null;
  resendApiUrl: string;
  tokenCurrentVersion: number | null;
  tokenKeys: ReadonlyMap<number, Buffer>;
  rateLimitWindowSeconds: number;
  inspectIpMaxAttempts: number;
  acceptIpMaxAttempts: number;
  acceptUserIpMaxAttempts: number;
  activationIpMaxAttempts: number;
  activationInvitationIpMaxAttempts: number;
  activationHashConcurrency: number;
  publicReplicaCount: number;
  rateLimitMaxBuckets: number;
}

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';

export function assertSafeInvitationAcceptanceUrl(
  value: string,
  environment: string,
): void {
  if (value === '') return;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'INVITATION_ACCEPTANCE_URL cannot contain userinfo, query, or fragment.',
    );
  }
  if (environment === 'production') {
    if (url.protocol !== 'https:') {
      throw new Error('Production invitation acceptance URL must use HTTPS.');
    }
    return;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'HTTP invitation acceptance URL is allowed only on loopback.',
    );
  }
}

function enabled(name: string): boolean {
  return process.env[name] === 'true';
}

function parseTokenKeys(
  value: string | undefined,
): ReadonlyMap<number, Buffer> {
  if (value === undefined || value.trim() === '') return new Map();
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('INVITATION_TOKEN_KEYS must be a JSON object.');
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
      throw new Error('INVITATION_TOKEN_KEYS contains an invalid entry.');
    }
    const key = Buffer.from(rawKey, 'base64');
    if (key.length < 32 || key.toString('base64') !== rawKey) {
      throw new Error(
        'Invitation token keys must be canonical base64 and at least 32 bytes.',
      );
    }
    keys.set(version, key);
  }
  return keys;
}

export default registerAs('invitation', (): InvitationConfig => {
  const environment = process.env.NODE_ENV ?? 'development';
  const acceptanceUrl = process.env.INVITATION_ACCEPTANCE_URL ?? '';
  assertSafeInvitationAcceptanceUrl(acceptanceUrl, environment);
  const configuredResendApiUrl =
    process.env.RESEND_API_URL ?? RESEND_EMAIL_ENDPOINT;
  if (
    environment === 'production' &&
    configuredResendApiUrl !== RESEND_EMAIL_ENDPOINT
  ) {
    throw new Error('Production Resend endpoint is fixed.');
  }
  const tokenKeys = parseTokenKeys(process.env.INVITATION_TOKEN_KEYS);
  const rawCurrentVersion =
    process.env.INVITATION_TOKEN_CURRENT_VERSION?.trim();
  const tokenCurrentVersion =
    rawCurrentVersion === undefined || rawCurrentVersion === ''
      ? null
      : Number(rawCurrentVersion);
  if (
    tokenCurrentVersion !== null &&
    (!Number.isInteger(tokenCurrentVersion) ||
      !tokenKeys.has(tokenCurrentVersion))
  ) {
    throw new Error(
      'INVITATION_TOKEN_CURRENT_VERSION must reference a configured key.',
    );
  }
  const acceptanceReady = enabled('INVITATION_ACCEPTANCE_READINESS');
  const activationReady = enabled('INVITATION_ACTIVATION_READINESS');
  const publicReplicaCount = resolveApiPublicReplicaCount();
  const resendApiKey = process.env.RESEND_API_KEY?.trim() || null;
  const emailFrom = process.env.INVITATION_EMAIL_FROM ?? '';
  const workerEnabled = enabled('INVITATION_WORKER_ENABLED');
  const issuanceReady =
    enabled('INVITATION_ISSUANCE_READINESS') &&
    acceptanceReady &&
    activationReady &&
    workerEnabled &&
    publicReplicaCount === 1 &&
    acceptanceUrl !== '' &&
    emailFrom !== '' &&
    resendApiKey !== null &&
    tokenCurrentVersion !== null;
  return {
    issuanceReady,
    acceptanceReady,
    activationReady,
    workerEnabled,
    workerHealthPort: Number(process.env.INVITATION_WORKER_HEALTH_PORT ?? 3001),
    acceptanceUrl,
    emailFrom,
    resendApiKey,
    resendApiUrl:
      environment === 'production'
        ? RESEND_EMAIL_ENDPOINT
        : configuredResendApiUrl,
    tokenCurrentVersion,
    tokenKeys,
    rateLimitWindowSeconds: Number(
      process.env.INVITATION_RATE_LIMIT_WINDOW_SECONDS ?? 900,
    ),
    inspectIpMaxAttempts: Number(
      process.env.INVITATION_INSPECT_IP_MAX_ATTEMPTS ?? 30,
    ),
    acceptIpMaxAttempts: Number(
      process.env.INVITATION_ACCEPT_IP_MAX_ATTEMPTS ?? 20,
    ),
    acceptUserIpMaxAttempts: Number(
      process.env.INVITATION_ACCEPT_USER_IP_MAX_ATTEMPTS ?? 10,
    ),
    activationIpMaxAttempts: Number(
      process.env.INVITATION_ACTIVATION_IP_MAX_ATTEMPTS ?? 20,
    ),
    activationInvitationIpMaxAttempts: Number(
      process.env.INVITATION_ACTIVATION_INVITATION_IP_MAX_ATTEMPTS ?? 5,
    ),
    activationHashConcurrency: Number(
      process.env.INVITATION_ACTIVATION_HASH_CONCURRENCY ?? 2,
    ),
    publicReplicaCount,
    rateLimitMaxBuckets: Number(
      process.env.INVITATION_RATE_LIMIT_MAX_BUCKETS ?? 10_000,
    ),
  };
});
