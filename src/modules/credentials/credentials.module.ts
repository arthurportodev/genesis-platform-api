import { Module } from '@nestjs/common';
import { PASSWORD_HASHER } from './ports/password-hasher.port';
import { PASSWORD_LOGIN_VERIFIER } from './ports/password-login-verifier.port';
import { PasswordCredentialsService } from './services/password-credentials.service';
import { PasswordHashCapacity } from './services/password-hash-capacity.service';

@Module({
  providers: [
    PasswordCredentialsService,
    PasswordHashCapacity,
    { provide: PASSWORD_HASHER, useExisting: PasswordCredentialsService },
    {
      provide: PASSWORD_LOGIN_VERIFIER,
      useExisting: PasswordCredentialsService,
    },
  ],
  exports: [PASSWORD_HASHER, PASSWORD_LOGIN_VERIFIER, PasswordHashCapacity],
})
export class CredentialsModule {}
