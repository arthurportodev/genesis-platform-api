import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationConfig } from '../../../config/invitation.config';
import { InvitationActivationObservability } from './invitation-activation-observability.service';

@Injectable()
export class InvitationActivationHashCapacity {
  private active = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly observability: InvitationActivationObservability,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const limit =
      this.config.getOrThrow<InvitationConfig>(
        'invitation',
      ).activationHashConcurrency;
    if (this.active >= limit) {
      this.observability.rateLimited('hash_capacity');
      throw new HttpException(
        'Too many requests.',
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
