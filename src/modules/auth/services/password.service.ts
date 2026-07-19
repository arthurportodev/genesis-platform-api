import { Injectable } from '@nestjs/common';
import argon2, { HashOptions, argon2id } from 'argon2';
import { randomBytes } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const ARGON2ID_OPTIONS: Readonly<HashOptions> = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

export function validatePasswordPolicy(password: string): void {
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH ||
    !/\S/u.test(password)
  ) {
    throw new Error('Password does not satisfy the configured policy.');
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordPolicy(password);
  const hash: unknown = await argon2.hash(password, ARGON2ID_OPTIONS);
  if (typeof hash !== 'string') {
    throw new Error('Argon2 did not return an encoded password hash.');
  }
  return hash;
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

@Injectable()
export class PasswordService {
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
