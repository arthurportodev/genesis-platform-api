import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import { AuthGoogleConfig } from '../../../config/auth-google.config';
import {
  AuthGoogleChallenge,
  GoogleChallengeStage,
} from '../entities/auth-google-challenge.entity';

export interface IssuedGoogleChallenge {
  challengeToken: string;
  nonce: string;
  expiresAt: string;
}

@Injectable()
export class GoogleChallengeService {
  private readonly config: AuthGoogleConfig;

  constructor(
    @InjectRepository(AuthGoogleChallenge)
    private readonly challenges: Repository<AuthGoogleChallenge>,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AuthGoogleConfig>('authGoogle');
  }

  async issue(): Promise<IssuedGoogleChallenge> {
    await this.challenges
      .createQueryBuilder()
      .delete()
      .where('expires_at <= CURRENT_TIMESTAMP')
      .execute();
    const active = await this.challenges.countBy({
      expiresAt: MoreThan(new Date()),
    });
    if (active >= this.config.maxBuckets) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'AUTH_GOOGLE_UNAVAILABLE',
        message: 'Google authentication is unavailable.',
      });
    }
    const challengeToken = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.config.challengeTtlSeconds * 1_000,
    );
    await this.challenges.save(
      this.challenges.create({
        tokenHash: this.hash(challengeToken),
        nonceHash: this.hash(nonce),
        stage: 'issued',
        userId: null,
        providerSubject: null,
        providerEmail: null,
        emailAuthoritative: null,
        expiresAt,
        failedAttempts: 0,
        consumedAt: null,
      }),
    );
    return { challengeToken, nonce, expiresAt: expiresAt.toISOString() };
  }

  async resolve(
    manager: EntityManager,
    challengeToken: string,
    allowedStages: readonly GoogleChallengeStage[],
  ): Promise<AuthGoogleChallenge> {
    const challenge = await manager
      .getRepository(AuthGoogleChallenge)
      .createQueryBuilder('challenge')
      .addSelect(['challenge.tokenHash', 'challenge.nonceHash'])
      .setLock('pessimistic_write')
      .where('challenge.tokenHash = :tokenHash', {
        tokenHash: this.hash(challengeToken),
      })
      .getOne();
    if (
      challenge === null ||
      !allowedStages.includes(challenge.stage) ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.failedAttempts >= this.config.maxAttempts ||
      challenge.consumedAt !== null
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'AUTH_GOOGLE_INVALID',
        message: 'Google authentication ceremony is invalid or expired.',
      });
    }
    return challenge;
  }

  nonceMatches(challenge: AuthGoogleChallenge, nonce: string): boolean {
    return challenge.nonceHash === this.hash(nonce);
  }

  markFailed(challenge: AuthGoogleChallenge): void {
    challenge.failedAttempts += 1;
  }

  consume(challenge: AuthGoogleChallenge): void {
    challenge.stage = 'consumed';
    challenge.consumedAt = new Date();
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
