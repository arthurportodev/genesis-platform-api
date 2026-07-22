import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  PASSWORD_HASHER,
  PasswordHasher,
} from '../../credentials/ports/password-hasher.port';
import { OrganizationStatus } from '../../organizations/enums/organization-status.enum';
import { ActivateInvitationDto } from '../dto/activate-invitation.dto';
import { InvitationRole, InvitationStatus } from '../enums/invitation.enums';
import {
  INVITATION_ACTIVATION_READINESS,
  InvitationActivationReadiness,
} from '../ports/invitation-activation-readiness.port';
import { InvitationRequestContext } from '../types/invitation-api.type';
import { InvitationActivationHashCapacity } from './invitation-activation-hash-capacity.service';
import { InvitationActivationObservability } from './invitation-activation-observability.service';
import { InvitationAcceptanceRateLimiter } from './invitation-acceptance-rate-limiter.service';
import {
  InvitationTokenCodec,
  InvitationTokenFields,
} from './invitation-token-codec.service';

interface ActivationPreRead extends InvitationTokenFields {
  status: InvitationStatus;
  organizationStatus: OrganizationStatus;
  databaseNow: Date;
  userExists: boolean;
}

type ActivationLockedRow = ActivationPreRead;

interface ActivationDatabaseResult {
  organization_id: string;
  user_id: string;
  membership_id: string;
}

interface PostgresDriverError {
  code?: string;
  constraint?: string;
}

export interface InvitationActivationResponse {
  organizationId: string;
  membershipId: string;
}

@Injectable()
export class InvitationActivationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly codec: InvitationTokenCodec,
    private readonly limiter: InvitationAcceptanceRateLimiter,
    private readonly hashCapacity: InvitationActivationHashCapacity,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasher,
    @Inject(INVITATION_ACTIVATION_READINESS)
    private readonly readiness: InvitationActivationReadiness,
    private readonly observability: InvitationActivationObservability,
  ) {}

  async activate(
    input: unknown,
    context: InvitationRequestContext,
  ): Promise<InvitationActivationResponse> {
    const dto = ActivateInvitationDto.parse(input);
    if (dto === null) {
      throw new BadRequestException('Invalid activation request.');
    }
    await this.readiness.assertReady();
    const parsed = this.codec.parse(dto.token);
    if (parsed === null) this.unavailable('cryptographic');
    const preRead = await this.preRead(parsed.invitationId);
    if (!this.codec.verifySafely(dto.token, preRead)) {
      this.unavailable('cryptographic');
    }
    try {
      this.limiter.consume(
        'activate-invitation-ip',
        `${parsed.invitationId}:${context.ipAddress ?? 'unknown'}`,
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429) {
        this.observability.rateLimited('invitation_ip');
      }
      throw error;
    }
    const passwordHash = await this.hashCapacity.run(() =>
      this.passwordHasher.hash(dto.password),
    );

    try {
      const response = await this.dataSource.transaction(async (manager) => {
        const scope = await manager.query<Array<{ organizationId: string }>>(
          `SELECT organization_id AS "organizationId"
           FROM public.organization_invitations WHERE id = $1`,
          [parsed.invitationId],
        );
        const organizationId = scope[0]?.organizationId;
        if (organizationId === undefined) this.unavailable('domain');
        await manager.query(
          `SELECT app_private.lock_invitation_context(
             $1::uuid[], $2::uuid[], $3::uuid[]
           )`,
          [[organizationId], [], []],
        );
        const row = await this.readLocked(manager.query.bind(manager), {
          invitationId: parsed.invitationId,
        });
        if (
          row === null ||
          row.organizationId !== organizationId ||
          !this.codec.verifySafely(dto.token, row) ||
          row.status !== InvitationStatus.PENDING ||
          row.organizationStatus !== OrganizationStatus.ACTIVE ||
          !Object.values(InvitationRole).includes(row.role) ||
          row.userExists ||
          row.expiresAt.getTime() <= row.databaseNow.getTime()
        ) {
          this.unavailable('domain');
        }
        const rows = await manager.query<ActivationDatabaseResult[]>(
          `SELECT * FROM app_private.activate_new_user_invitation(
             $1::uuid, $2::text, $3::text, $4::uuid, $5::inet, $6::text
           )`,
          [
            row.invitationId,
            dto.name,
            passwordHash,
            randomUUID(),
            context.ipAddress,
            context.userAgent,
          ],
        );
        const result = rows[0];
        if (
          result === undefined ||
          result.organization_id !== row.organizationId
        ) {
          throw new Error('Invitation activation returned an invalid result.');
        }
        return {
          organizationId: result.organization_id,
          membershipId: result.membership_id,
        };
      });
      this.observability.succeeded();
      return response;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (this.isUnavailableDatabaseError(error)) {
        if (this.isEmailRace(error)) {
          this.observability.emailRace();
        }
        this.unavailable('domain');
      }
      const databaseError =
        error instanceof QueryFailedError
          ? (error.driverError as PostgresDriverError)
          : undefined;
      this.observability.rollback(databaseError ? 'database' : 'unexpected');
      throw error;
    }
  }

  private async preRead(
    invitationId: string,
  ): Promise<ActivationPreRead | null> {
    const rows = await this.dataSource.query<ActivationPreRead[]>(
      `${this.selectActivationSql()}
       WHERE invitation.id = $1`,
      [invitationId],
    );
    return rows[0] ?? null;
  }

  private async readLocked(
    query: <T>(sql: string, parameters?: unknown[]) => Promise<T>,
    input: { invitationId: string },
  ): Promise<ActivationLockedRow | null> {
    const rows = await query<ActivationLockedRow[]>(
      `${this.selectActivationSql()}
       WHERE invitation.id = $1
       FOR UPDATE OF invitation`,
      [input.invitationId],
    );
    return rows[0] ?? null;
  }

  private selectActivationSql(): string {
    return `SELECT invitation.id AS "invitationId",
      invitation.token_key_version AS "keyVersion",
      invitation.token_version AS "tokenVersion",
      invitation.organization_id AS "organizationId",
      invitation.email_normalized AS "emailNormalized",
      invitation.role, invitation.expires_at AS "expiresAt",
      invitation.token_nonce AS nonce, invitation.status,
      organization.status AS "organizationStatus",
      transaction_timestamp() AS "databaseNow",
      EXISTS (
        SELECT 1 FROM public.users AS application_user
        WHERE application_user.email = invitation.email_normalized
      ) AS "userExists"
      FROM public.organization_invitations AS invitation
      JOIN public.organizations AS organization
        ON organization.id = invitation.organization_id`;
  }

  private isEmailRace(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driver = error.driverError as PostgresDriverError;
    return driver.code === '23505' && driver.constraint === 'UQ_users_email';
  }

  private isUnavailableDatabaseError(error: unknown): boolean {
    if (this.isEmailRace(error)) return true;
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as PostgresDriverError).code === 'P1001';
  }

  private unavailable(rejection: 'cryptographic' | 'domain' = 'domain'): never {
    this.observability.rejected(rejection);
    throw new NotFoundException('Invitation unavailable.');
  }
}
