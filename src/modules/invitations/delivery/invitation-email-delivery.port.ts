export const INVITATION_EMAIL_DELIVERY = Symbol('INVITATION_EMAIL_DELIVERY');

export interface InvitationEmailMessage {
  readonly templateVersion: 'invitation-email/v1';
  readonly idempotencyKey: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export type InvitationEmailDeliveryResult =
  | { readonly kind: 'sent'; readonly providerMessageId: string }
  | {
      readonly kind: 'retry';
      readonly errorCode: string;
      readonly retryAfterMs?: number;
      readonly retryAfterAtMs?: number;
    }
  | { readonly kind: 'dead'; readonly errorCode: string };

export interface InvitationEmailDeliveryPort {
  send(message: InvitationEmailMessage): Promise<InvitationEmailDeliveryResult>;
}
