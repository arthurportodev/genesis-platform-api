import { normalizeAndValidateUserName } from '../../credentials/name-policy';
import { validatePasswordPolicy } from '../../credentials/password-policy';

const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.\d{1,10}\.\d{1,10}\.[A-Za-z0-9_-]{43}$/iu;

export class ActivateInvitationDto {
  private constructor(
    readonly token: string,
    readonly name: string,
    readonly password: string,
  ) {}

  static parse(input: unknown): ActivateInvitationDto | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return null;
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'name,password,token') return null;
    if (
      typeof record.token !== 'string' ||
      record.token.length > 256 ||
      !TOKEN_PATTERN.test(record.token) ||
      typeof record.name !== 'string' ||
      typeof record.password !== 'string'
    ) {
      return null;
    }
    try {
      const name = normalizeAndValidateUserName(record.name);
      validatePasswordPolicy(record.password);
      return new ActivateInvitationDto(record.token, name, record.password);
    } catch {
      return null;
    }
  }
}
