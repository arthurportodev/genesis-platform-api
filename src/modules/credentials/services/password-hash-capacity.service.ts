import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationConfig } from '../../../config/invitation.config';

@Injectable()
export class PasswordHashCapacity {
  private active = 0;

  constructor(private readonly config: ConfigService) {}

  async run<T>(
    operation: () => Promise<T>,
    onRejected?: () => void,
  ): Promise<T> {
    const limit =
      this.config.getOrThrow<InvitationConfig>(
        'invitation',
      ).activationHashConcurrency;
    if (this.active >= limit) {
      onRejected?.();
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'AUTH_PASSWORD_HASH_CAPACITY_EXCEEDED',
          message: 'Too many requests.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }
}
