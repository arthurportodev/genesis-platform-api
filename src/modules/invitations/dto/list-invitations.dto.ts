import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import {
  InvitationEffectiveState,
  InvitationRole,
} from '../enums/invitation.enums';

export class ListInvitationsDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsEnum(InvitationEffectiveState)
  state?: InvitationEffectiveState;

  @IsOptional()
  @IsEnum(InvitationRole)
  role?: InvitationRole;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
