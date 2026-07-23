import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FormLeadDto } from '../dto/lead.dto';
import { LeadSource } from '../enums/lead.enums';
import { FormRateLimitGuard } from '../guards/form-rate-limit.guard';
import { FormSignatureGuard } from '../guards/form-signature.guard';
import { FormLeadReadinessGuard } from '../guards/lead-readiness.guards';
import { LeadsService } from '../services/leads.service';

@Controller('lead-intake/genesis-form')
export class FormLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Post()
  @UseGuards(FormLeadReadinessGuard, FormRateLimitGuard, FormSignatureGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async create(
    @Body() dto: FormLeadDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<void> {
    if (
      dto.source === LeadSource.MANUAL ||
      dto.responsibleMembershipId !== undefined ||
      typeof idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        idempotencyKey,
      )
    ) {
      throw new BadRequestException('Invalid form lead request.');
    }
    await this.leads.createFromForm(dto, idempotencyKey);
  }
}
