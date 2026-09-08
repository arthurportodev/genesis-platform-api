import { IsString, IsUUID, Matches } from 'class-validator';

export class EmailVerificationResendDto {
  @IsUUID('4')
  challengeId!: string;
}

export class EmailVerificationVerifyDto {
  @IsUUID('4')
  challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/u)
  code!: string;
}
