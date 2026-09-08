export interface EmailMessage {
  readonly idempotencyKey: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export type EmailDeliveryResult =
  | { readonly kind: 'sent'; readonly providerMessageId: string }
  | {
      readonly kind: 'retry';
      readonly errorCode: string;
      readonly retryAfterMs?: number;
      readonly retryAfterAtMs?: number;
    }
  | { readonly kind: 'dead'; readonly errorCode: string };

export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}
