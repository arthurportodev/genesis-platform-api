import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../credentials/password-policy';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export class GoogleAuthenticateDto {
  @IsString()
  @Matches(TOKEN_PATTERN)
  challengeToken!: string;

  @IsString()
  @Length(1, 16_384)
  credential!: string;
}

export class GoogleProfileDto {
  @IsString()
  @Matches(TOKEN_PATTERN)
  challengeToken!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 160)
  firstName!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 160)
  lastName!: string;
}

export class GoogleLinkDto {
  @IsString()
  @Matches(TOKEN_PATTERN)
  challengeToken!: string;

  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  @Matches(/\S/u)
  password!: string;
}
