/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { InvitationEmailV1Renderer } from '../src/modules/invitations/delivery/invitation-email-v1.renderer';
import { ResendInvitationEmailAdapter } from '../src/modules/invitations/delivery/resend-invitation-email.adapter';
import { InvitationRole } from '../src/modules/invitations/enums/invitation.enums';

describe('Invitation delivery smoke', () => {
  const input = {
    outboxId: 'e9dd3f69-d46f-4d0f-b8f2-2618018723cc',
    recipientEmail: 'recipient@example.com',
    role: InvitationRole.MEMBER,
    token: 'token.value',
    expiresAt: new Date('2026-07-28T12:00:00.000Z'),
  };

  it('renders a byte-stable versioned payload without putting the bearer in the URL query', () => {
    const renderer = new InvitationEmailV1Renderer({
      acceptanceUrl: 'https://app.example.com/invitations/accept',
      from: 'Genesis <invitations@example.com>',
    });

    const first = renderer.render(input);
    const second = renderer.render(input);
    const mutableTenantLabel = renderer.render({
      ...input,
      organizationName: 'TENANT_SECRET_MARKER',
    } as typeof input);

    expect(second).toEqual(first);
    expect(mutableTenantLabel).toEqual(first);
    expect(first.templateVersion).toBe('invitation-email/v1');
    expect(first.idempotencyKey).toBe(
      `genesis-invitation-delivery/v1/${input.outboxId}`,
    );
    const exactUrl =
      'https://app.example.com/invitations/accept#token=token.value';
    expect(first.html).toContain(exactUrl);
    expect(first.html).not.toContain('?token=');
    expect(first.text).toContain(exactUrl);
    expect(first.subject + first.html + first.text).not.toContain(
      'TENANT_SECRET_MARKER',
    );
  });

  it('sends the allowlisted stable Resend headers and payload', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'provider-message-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = new ResendInvitationEmailAdapter(
      {
        apiKey: 'sending-only-test-key',
        apiUrl: 'https://api.resend.com/emails',
        userAgent: 'genesis-platform/0.1.0',
        timeoutMs: 10_000,
      },
      fetcher,
    );
    const message = new InvitationEmailV1Renderer({
      acceptanceUrl: 'https://app.example.com/invitations/accept',
      from: 'Genesis <invitations@example.com>',
    }).render(input);

    await expect(adapter.send(message)).resolves.toEqual({
      kind: 'sent',
      providerMessageId: 'provider-message-id',
    });
    await adapter.send(message);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const retryInit = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(init.headers).toEqual({
      Authorization: 'Bearer sending-only-test-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': message.idempotencyKey,
      'User-Agent': 'genesis-platform/0.1.0',
    });
    expect(typeof init.body).toBe('string');
    expect(retryInit.body).toBe(init.body);
    expect(JSON.parse(init.body as string)).toEqual({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    expect(init.body).not.toContain(input.outboxId);
    const bodyWithoutUrl = (init.body as string).replaceAll(
      'https://app.example.com/invitations/accept#token=token.value',
      '',
    );
    expect(bodyWithoutUrl).not.toContain(input.token);
  });

  it('never truncates a provider message id', async () => {
    const exact = 'p'.repeat(255);
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: exact })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: `${exact}x` })));
    const adapter = new ResendInvitationEmailAdapter(
      {
        apiKey: 'test-key',
        apiUrl: 'https://api.resend.com/emails',
        userAgent: 'test',
        timeoutMs: 10_000,
      },
      fetcher,
    );
    const message = new InvitationEmailV1Renderer({
      acceptanceUrl: 'https://app.example.com/invitations/accept',
      from: 'Genesis <invitations@example.com>',
    }).render(input);
    await expect(adapter.send(message)).resolves.toEqual({
      kind: 'sent',
      providerMessageId: exact,
    });
    await expect(adapter.send(message)).resolves.toEqual({
      kind: 'retry',
      errorCode: 'provider_invalid_success',
    });
  });

  it('preserves an HTTP-date Retry-After without consulting the process clock', async () => {
    const retryAt = new Date('2026-07-21T18:00:00.000Z');
    const fetcher = jest.fn().mockResolvedValue(
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': retryAt.toUTCString() },
      }),
    );
    const adapter = new ResendInvitationEmailAdapter(
      {
        apiKey: 'test-key',
        apiUrl: 'https://api.resend.com/emails',
        userAgent: 'test',
        timeoutMs: 10_000,
      },
      fetcher,
    );
    const message = new InvitationEmailV1Renderer({
      acceptanceUrl: 'https://app.example.com/invitations/accept',
      from: 'Genesis <invitations@example.com>',
    }).render(input);
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2099-01-01T00:00:00.000Z').getTime());
    try {
      await expect(adapter.send(message)).resolves.toEqual({
        kind: 'retry',
        errorCode: 'provider_rate_limited',
        retryAfterAtMs: retryAt.getTime(),
      });
    } finally {
      clock.mockRestore();
    }
  });
});
