import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  deriveOrganizationSlugBase,
  fingerprintOrganizationCreation,
  normalizeOrganizationName,
} from '../organization-creation.policy';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import {
  OrganizationCreationRateLimitException,
  OrganizationCreationRateLimiter,
} from './organization-creation-rate-limiter.service';
import {
  OrganizationCreationRequestContext,
  OrganizationCreationResult,
} from '../types/organization-creation.type';

interface CreationRow {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  membership_id: string;
  membership_role: string;
  replayed: boolean;
}

interface PostgresError {
  code?: string;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rateLimiter: OrganizationCreationRateLimiter,
  ) {}

  async create(
    actorUserId: string,
    idempotencyKey: string | undefined,
    input: CreateOrganizationDto,
    context: OrganizationCreationRequestContext,
  ): Promise<OrganizationCreationResult> {
    if (!idempotencyKey || !isUUID(idempotencyKey, '4')) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'ORGANIZATION_IDEMPOTENCY_KEY_INVALID',
        message: 'Invalid Idempotency-Key.',
      });
    }
    const name = normalizeOrganizationName(input.name);
    const slugBase = deriveOrganizationSlugBase(name);
    const fingerprint = fingerprintOrganizationCreation(name);
    const rateLimit = this.rateLimiter.reserve(
      actorUserId,
      context.ipAddress,
      idempotencyKey,
    );

    try {
      const rows = await this.dataSource.query<CreationRow[]>(
        `SELECT * FROM app_private.create_self_service_organization(
           $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::inet, $7::text,
           $8::boolean
         )`,
        [
          actorUserId,
          idempotencyKey,
          fingerprint,
          name,
          slugBase,
          context.ipAddress,
          context.userAgent,
          rateLimit.creationPermitted,
        ],
      );
      const row = rows[0];
      if (
        !row ||
        row.membership_role !== 'owner' ||
        !isUUID(row.organization_id) ||
        !isUUID(row.membership_id)
      ) {
        return this.unavailable();
      }
      if (row.replayed && rateLimit.newlyReserved) {
        this.rateLimiter.release(actorUserId, idempotencyKey);
      }
      return {
        replayed: row.replayed,
        response: {
          id: row.organization_id,
          name: row.organization_name,
          slug: row.organization_slug,
          membershipId: row.membership_id,
          role: 'owner',
        },
      };
    } catch (error) {
      const code = this.postgresCode(error);
      if (code === 'P4001') {
        throw new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          code: 'ORGANIZATION_CREATION_UNAUTHORIZED',
          message: 'Organization creation is not authorized.',
        });
      }
      if (code === '22023') {
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          code: 'ORGANIZATION_CREATION_INVALID',
          message: 'Invalid organization creation request.',
        });
      }
      if (code === 'P4002') {
        if (rateLimit.newlyReserved) {
          this.rateLimiter.release(actorUserId, idempotencyKey);
        }
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          code: 'ORGANIZATION_IDEMPOTENCY_CONFLICT',
          message: 'Idempotency-Key was already used for another request.',
        });
      }
      if (code === 'P4005') {
        throw new OrganizationCreationRateLimitException(
          rateLimit.retryAfterSeconds ?? 3600,
        );
      }
      if (error instanceof ServiceUnavailableException) throw error;
      return this.unavailable();
    }
  }

  private postgresCode(error: unknown): string | undefined {
    if (!(error instanceof QueryFailedError)) return undefined;
    return (error.driverError as PostgresError).code;
  }

  private unavailable(): never {
    throw new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'ORGANIZATION_CREATION_UNAVAILABLE',
      message: 'Organization creation is unavailable.',
    });
  }
}
