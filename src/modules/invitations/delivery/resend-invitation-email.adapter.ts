import {
  InvitationEmailDeliveryPort,
  InvitationEmailDeliveryResult,
  InvitationEmailMessage,
} from './invitation-email-delivery.port';

export interface ResendInvitationEmailConfig {
  apiKey: string;
  apiUrl: string;
  userAgent: string;
  timeoutMs: number;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class ResendInvitationEmailAdapter implements InvitationEmailDeliveryPort {
  constructor(
    private readonly config: ResendInvitationEmailConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async send(
    message: InvitationEmailMessage,
  ): Promise<InvitationEmailDeliveryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(this.config.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
          'User-Agent': this.config.userAgent,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: controller.signal,
      });
      return await this.classify(response);
    } catch (error) {
      return {
        kind: 'retry',
        errorCode:
          error instanceof Error && error.name === 'AbortError'
            ? 'provider_timeout'
            : 'provider_network_error',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async classify(
    response: Response,
  ): Promise<InvitationEmailDeliveryResult> {
    if (response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        id?: unknown;
      } | null;
      if (
        typeof payload?.id === 'string' &&
        payload.id.length > 0 &&
        payload.id.length <= 255
      ) {
        return { kind: 'sent', providerMessageId: payload.id };
      }
      return { kind: 'retry', errorCode: 'provider_invalid_success' };
    }
    const payload = (await response.json().catch(() => null)) as {
      name?: unknown;
    } | null;
    const providerCode =
      typeof payload?.name === 'string' ? payload.name : 'unknown';
    if (response.status === 429 || response.status >= 500) {
      return {
        kind: 'retry',
        errorCode:
          response.status === 429
            ? 'provider_rate_limited'
            : 'provider_unavailable',
        ...this.retryAfter(response.headers.get('retry-after')),
      };
    }
    if (
      response.status === 409 &&
      providerCode === 'concurrent_idempotent_requests'
    ) {
      return { kind: 'retry', errorCode: 'provider_idempotency_in_progress' };
    }
    if (
      response.status === 409 &&
      providerCode === 'invalid_idempotent_request'
    ) {
      return { kind: 'dead', errorCode: 'provider_idempotency_conflict' };
    }
    return {
      kind: 'dead',
      errorCode: `provider_http_${response.status}`.slice(0, 64),
    };
  }

  private retryAfter(value: string | null): {
    retryAfterMs?: number;
    retryAfterAtMs?: number;
  } {
    if (value === null) return {};
    if (/^\d+$/u.test(value)) {
      return { retryAfterMs: Math.min(Number(value) * 1000, 86_400_000) };
    }
    const date = Date.parse(value);
    return Number.isNaN(date) ? {} : { retryAfterAtMs: date };
  }
}
