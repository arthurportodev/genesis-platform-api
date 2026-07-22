export const PASSWORD_LOGIN_VERIFIER = Symbol('PASSWORD_LOGIN_VERIFIER');

export interface PasswordLoginVerifier {
  verifyForLogin(
    passwordHash: string | null,
    password: string,
  ): Promise<boolean>;
}
