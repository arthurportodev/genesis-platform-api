import { IsUUID } from 'class-validator';

export class InvitationParamsDto {
  @IsUUID('4')
  invitationId!: string;
}

export class EmptyInvitationCommandDto {}
