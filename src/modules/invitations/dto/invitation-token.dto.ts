import { IsString, Matches, MaxLength } from 'class-validator';

export class InvitationTokenDto {
  @IsString()
  @MaxLength(256)
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.\d{1,10}\.\d{1,10}\.[A-Za-z0-9_-]{43}$/iu,
  )
  token!: string;
}
