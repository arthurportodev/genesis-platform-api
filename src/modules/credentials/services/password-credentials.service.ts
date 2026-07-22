import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PasswordHasher } from '../ports/password-hasher.port';
import { PasswordLoginVerifier } from '../ports/password-login-verifier.port';
import { hashPassword, verifyPassword } from '../password-policy';

@Injectable()
export class PasswordCredentialsService
  implements PasswordHasher, PasswordLoginVerifier
{
  private readonly dummyHash: Promise<string>;

  constructor() {
    this.dummyHash = hashPassword(randomBytes(32).toString('base64url'));
  }

  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verifyForLogin(
    passwordHash: string | null,
    password: string,
  ): Promise<boolean> {
    const hash = passwordHash ?? (await this.dummyHash);
    const valid = await verifyPassword(hash, password);
    return passwordHash !== null && valid;
  }
}
