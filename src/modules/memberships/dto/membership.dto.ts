import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  MinLength,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MembershipRole } from '../enums/membership-role.enum';
import { MembershipStatus } from '../enums/membership-status.enum';

export class MembershipParamsDto {
  @IsUUID('4')
  membershipId!: string;
}

export class ListMembershipsDto {
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
  @IsEnum(MembershipRole)
  role?: MembershipRole;

  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;
}

export class ChangeMembershipRoleDto {
  @IsIn([MembershipRole.MEMBER, MembershipRole.ADMIN])
  role!: MembershipRole.MEMBER | MembershipRole.ADMIN;
}

export class EmptyMembershipCommandDto {}
