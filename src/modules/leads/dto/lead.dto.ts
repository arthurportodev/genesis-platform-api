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
  LeadListSort,
  LeadNextActionTemporalState,
  LeadNextActionType,
  LeadSource,
  LeadStage,
  LeadStatus,
} from '../enums/lead.enums';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export class LeadOperationalFiltersDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsUUID('4')
  responsibleMembershipId?: string;

  @IsOptional()
  @IsIn(['true'])
  assignedToMe?: 'true';

  @IsOptional()
  @IsIn(['true'])
  unassigned?: 'true';

  @IsOptional()
  @IsEnum(LeadSource)
  source?: LeadSource;

  @IsOptional()
  @IsEnum(LeadNextActionTemporalState)
  nextActionState?: LeadNextActionTemporalState;

  @IsOptional()
  @Matches(CIVIL_DATE)
  createdFrom?: string;

  @IsOptional()
  @Matches(CIVIL_DATE)
  createdTo?: string;

  @IsOptional()
  @Matches(CIVIL_DATE)
  lastEntryFrom?: string;

  @IsOptional()
  @Matches(CIVIL_DATE)
  lastEntryTo?: string;
}

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

export class ListLeadsDto extends LeadOperationalFiltersDto {
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
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @IsOptional()
  @IsIn(['true', 'false'])
  returnPending?: 'true' | 'false';

  @IsOptional()
  @IsEnum(LeadListSort)
  sort: LeadListSort = LeadListSort.CREATED_AT_DESC;
}

export class LeadKanbanDto extends LeadOperationalFiltersDto {
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 20;
}

export class LeadMyActionsDto {
  @IsOptional()
  @IsUUID('4')
  responsibleMembershipId?: string;

  @IsOptional()
  @IsIn([
    LeadNextActionTemporalState.OVERDUE,
    LeadNextActionTemporalState.TODAY,
    LeadNextActionTemporalState.FUTURE,
  ])
  state?: Exclude<
    LeadNextActionTemporalState,
    LeadNextActionTemporalState.NONE
  >;

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

export class LeadUnassignedQueueDto extends LeadOperationalFiltersDto {
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

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

export class LeadReturnReviewQueueDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsEnum(LeadSource)
  source?: LeadSource;

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

export class LeadMetricsDto {
  @IsOptional()
  @Matches(CIVIL_DATE)
  from?: string;

  @IsOptional()
  @Matches(CIVIL_DATE)
  to?: string;
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

export class SetLeadExpectedValueDto {
  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(19)
  @Matches(/^(0|[1-9]\d*)$/u)
  expectedValueMinor!: string | null;
}

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
