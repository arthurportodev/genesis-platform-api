import {
  EmailMessage,
  EmailDeliveryResult,
} from '../../../common/email/email-transport';

export const INVITATION_EMAIL_DELIVERY = Symbol('INVITATION_EMAIL_DELIVERY');

export interface InvitationEmailMessage extends EmailMessage {
  readonly templateVersion: 'invitation-email/v1';
}

export type InvitationEmailDeliveryResult = EmailDeliveryResult;

export interface InvitationEmailDeliveryPort {
  send(message: InvitationEmailMessage): Promise<InvitationEmailDeliveryResult>;
}
