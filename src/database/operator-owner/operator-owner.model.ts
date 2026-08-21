import { isEmail } from 'class-validator';
import { normalizeEmail } from '../../common/normalization/email.normalizer';
import { normalizeAndValidateUserName } from '../../modules/credentials/name-policy';

export type OperatorOwnerFailureCode =
  | 'CONFLICT'
  | 'CREATION_NOT_AUTHORIZED'
  | 'INPUT_CANCELLED'
  | 'INVARIANT_VIOLATION'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_EMAIL'
  | 'INVALID_ORGANIZATION_NAME'
  | 'INVALID_OWNER_NAME'
  | 'INVALID_PASSWORD'
  | 'PASSWORD_INPUT_CANCELLED'
  | 'PASSWORD_MISMATCH'
  | 'SCHEMA_ATTESTATION_FAILED'
  | 'SECURE_TTY_REQUIRED'
  | 'UNSAFE_DATABASE_ROLE'
  | 'UNEXPECTED_FAILURE';

export class OperatorOwnerError extends Error {
  constructor(
    readonly code: OperatorOwnerFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'OperatorOwnerError';
  }
}

export interface PreparedOperatorOwnerInput {
  organizationName: string;
  organizationSlug: string;
  ownerName: string;
  emailNormalized: string;
}

export interface OperatorOwnerIdentifiers {
  organizationId: string;
  userId: string;
  membershipId: string;
}

export interface OperatorOwnerCreateResult extends OperatorOwnerIdentifiers {
  status: 'CREATED';
  organization: string;
  organizationSlug: string;
  emailNormalized: string;
  role: 'OWNER';
  organizationActive: true;
  userActive: true;
  membershipActive: true;
  initialLeads: 0;
  initialSessions: 0;
  initialRefreshTokens: 0;
  createdAt: string;
  loginInstruction: string;
}

export interface OperatorOwnerStatusResult extends OperatorOwnerIdentifiers {
  status: 'READY' | 'INVALID' | 'NOT_FOUND';
  organization?: string;
  organizationSlug?: string;
  emailNormalized?: string;
  role?: 'OWNER';
  organizationActive: boolean;
  userActive: boolean;
  membershipActive: boolean;
  leads: number;
  sessions: number;
  refreshTokens: number;
  effectiveOwners: number;
  invariantsValid: boolean;
  issues: string[];
  checkedAt: string;
}

export function prepareOperatorOwnerIdentity(input: {
  organizationName: string;
  ownerName: string;
  email: string;
}): PreparedOperatorOwnerInput {
  let organizationName: string;
  let ownerName: string;
  try {
    organizationName = normalizeAndValidateUserName(input.organizationName);
  } catch {
    throw new OperatorOwnerError(
      'INVALID_ORGANIZATION_NAME',
      'Organization name does not satisfy the configured policy.',
    );
  }
  try {
    ownerName = normalizeAndValidateUserName(input.ownerName);
  } catch {
    throw new OperatorOwnerError(
      'INVALID_OWNER_NAME',
      'Owner name does not satisfy the configured policy.',
    );
  }
  const emailNormalized = normalizeEmail(input.email);
  if (emailNormalized.length > 320 || !isEmail(emailNormalized)) {
    throw new OperatorOwnerError(
      'INVALID_EMAIL',
      'Email does not satisfy the authentication contract.',
    );
  }
  const organizationSlug = slugifyOrganizationName(organizationName);
  if (organizationSlug.length === 0 || organizationSlug.length > 120) {
    throw new OperatorOwnerError(
      'INVALID_ORGANIZATION_NAME',
      'Organization name cannot produce a valid organization slug.',
    );
  }
  return {
    organizationName,
    organizationSlug,
    ownerName,
    emailNormalized,
  };
}

export function slugifyOrganizationName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}
