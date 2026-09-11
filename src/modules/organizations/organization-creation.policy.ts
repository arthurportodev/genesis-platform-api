import { BadRequestException, HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';

const MAX_NAME_LENGTH = 160;
const MAX_SLUG_BASE_LENGTH = 114;
const FORBIDDEN_NAME_CHARACTER =
  /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_SLUG_CHARACTERS = /[^a-z0-9]+/gu;
const EDGE_HYPHENS = /^-+|-+$/gu;

export function normalizeOrganizationName(input: string): string {
  if (FORBIDDEN_NAME_CHARACTER.test(input)) invalidRequest();
  const normalized = input.normalize('NFC').trim();
  const characterLength = Array.from(normalized).length;
  if (characterLength < 1 || characterLength > MAX_NAME_LENGTH) {
    invalidRequest();
  }
  return normalized;
}

export function deriveOrganizationSlugBase(name: string): string {
  const candidate = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_SLUG_CHARACTERS, '-')
    .replace(EDGE_HYPHENS, '')
    .slice(0, MAX_SLUG_BASE_LENGTH)
    .replace(/-+$/u, '');
  return candidate || 'organizacao';
}

export function organizationSlugForAttempt(
  slugBase: string,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 10_000) {
    throw new RangeError('Invalid organization slug attempt.');
  }
  return attempt === 1 ? slugBase : `${slugBase}-${attempt}`;
}

export function fingerprintOrganizationCreation(name: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, name }), 'utf8')
    .digest('hex');
}

function invalidRequest(): never {
  throw new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: 'ORGANIZATION_CREATION_INVALID',
    message: 'Invalid organization creation request.',
  });
}
