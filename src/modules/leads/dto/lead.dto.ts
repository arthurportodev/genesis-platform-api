import { Type } from 'class-transformer';
import {
  IsEmail,
  IsDefined,
  IsEnum,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  LeadArchiveReason,
  LeadActivityType,
  LeadLostReason,
  LeadNextActionType,
  LeadSource,
  LeadStage,
  LeadStatus,
} from '../enums/lead.enums';

export class LeadParamsDto {
  @IsUUID('4')
  leadId!: string;
}

export class CreateLeadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  displayName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  primaryPhone!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  instagram?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  serviceInterest?: string;

  @IsEnum(LeadSource)
  source: LeadSource = LeadSource.MANUAL;

  @ValidateIf((dto: CreateLeadDto) => dto.source === LeadSource.OTHER)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  sourceDetail?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  utmMedium?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  utmCampaign?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  utmContent?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  utmTerm?: string;

  @IsOptional()
  @IsUUID('4')
  responsibleMembershipId?: string;
}

export class FormLeadDto extends CreateLeadDto {}

export class UpdateLeadDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  primaryPhone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  companyName?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  instagram?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  serviceInterest?: string | null;
}

export class AssignLeadDto {
  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  responsibleMembershipId!: string | null;
}

export class ListLeadsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsIn(['true', 'false'])
  unassigned?: 'true' | 'false';

  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @IsOptional()
  @IsIn(['true', 'false'])
  returnPending?: 'true' | 'false';
}

export class MoveLeadDto {
  @IsEnum(LeadStage)
  stage!: LeadStage;
}

export class LoseLeadDto {
  @IsEnum(LeadLostReason)
  lostReason!: LeadLostReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u)
  reasonNote?: string;
}

export class ArchiveLeadDto {
  @IsEnum(LeadArchiveReason)
  archiveReason!: LeadArchiveReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u)
  reasonNote?: string;
}

export class EmptyLeadCommandDto {}

export class ListLeadCyclesDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}

export class ListLeadTimelineDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class CreateLeadActivityDto {
  @IsEnum(LeadActivityType)
  type!: LeadActivityType;

  @IsString()
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  )
  performedAt!: string;

  @IsOptional()
  @IsString()
  outcome?: string;
}

export class CreateLeadNoteDto {
  @IsString()
  content!: string;
}

export class CreateLeadNextActionDto {
  @IsEnum(LeadNextActionType)
  type!: LeadNextActionType;

  @IsString()
  description!: string;

  @IsString()
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  )
  dueAt!: string;
}

export class RescheduleLeadNextActionDto {
  @IsString()
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  )
  dueAt!: string;
}

export class CompleteLeadNextActionDto {
  @IsString()
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  )
  performedAt!: string;

  @IsOptional()
  @IsString()
  outcome?: string;
}

export class CancelLeadNextActionDto {
  @IsOptional()
  @IsString()
  note?: string;
}
