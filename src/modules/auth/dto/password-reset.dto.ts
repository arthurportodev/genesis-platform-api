import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';
import { normalizeEmail } from '../../../common/normalization/email.normalizer';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../credentials/password-policy';

export class PasswordResetRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class PasswordResetCompleteDto extends PasswordResetRequestDto {
  @IsString()
  @Matches(/^\d{6}$/u)
  code!: string;

  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  @Matches(/\S/u, { message: 'password must not contain only whitespace' })
  password!: string;
}
