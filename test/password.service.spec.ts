import { randomBytes } from 'node:crypto';
import {
  PasswordService,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
} from '../src/modules/auth/services/password.service';

describe('PasswordService', () => {
  const password = randomBytes(24).toString('base64url');

  it('hashes passwords with Argon2id and verifies the correct value', async () => {
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
    await expect(verifyPassword(hash, `${password}x`)).resolves.toBe(false);
  });

  it('rejects passwords outside the policy without trimming them', () => {
    expect(() => validatePasswordPolicy('          ')).toThrow();
    expect(() => validatePasswordPolicy('short')).toThrow();
    expect(() => validatePasswordPolicy(` ${password} `)).not.toThrow();
  });

  it('performs a dummy verification when no stored hash exists', async () => {
    const service = new PasswordService();
    await expect(service.verifyForLogin(null, password)).resolves.toBe(false);
  });
});
