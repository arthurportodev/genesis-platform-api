import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { getTrustedClientIp } from '../../../common/http/trusted-client-ip';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AccessTokenGuard } from '../../auth/guards/access-token.guard';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { OrganizationCreationReadinessGuard } from '../guards/organization-creation-readiness.guard';
import { OrganizationCreationRateLimitException } from '../services/organization-creation-rate-limiter.service';
import { OrganizationsService } from '../services/organizations.service';
import { CreatedOrganizationResponse } from '../types/organization-creation.type';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @UseGuards(AccessTokenGuard, OrganizationCreationReadinessGuard)
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateOrganizationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatedOrganizationResponse> {
    try {
      const result = await this.organizations.create(
        currentUser.userId,
        idempotencyKey,
        input,
        {
          ipAddress: getTrustedClientIp(request),
          userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
        },
      );
      response.setHeader(
        'Location',
        `/api/v1/organizations/${result.response.id}`,
      );
      if (result.replayed) {
        response.setHeader('Idempotency-Replayed', 'true');
      }
      return result.response;
    } catch (error) {
      if (error instanceof OrganizationCreationRateLimitException) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
  }
}
