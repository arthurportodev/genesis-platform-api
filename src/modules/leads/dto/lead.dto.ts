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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { LeadSource } from '../enums/lead.enums';

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
}
