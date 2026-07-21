import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, MaxLength } from 'class-validator';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import { InvitationRole } from '../enums/invitation.enums';

export class CreateInvitationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsEnum(InvitationRole)
  role!: InvitationRole;
}
