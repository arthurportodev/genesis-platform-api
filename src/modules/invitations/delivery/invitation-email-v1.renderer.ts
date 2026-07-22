import { InvitationRole } from '../enums/invitation.enums';
import { InvitationEmailMessage } from './invitation-email-delivery.port';

export interface InvitationEmailV1RendererConfig {
  acceptanceUrl: string;
  from: string;
}

export interface InvitationEmailV1Input {
  outboxId: string;
  recipientEmail: string;
  role: InvitationRole;
  token: string;
  expiresAt: Date;
}

export class InvitationEmailV1Renderer {
  constructor(private readonly config: InvitationEmailV1RendererConfig) {}

  render(input: InvitationEmailV1Input): InvitationEmailMessage {
    const url = `${this.config.acceptanceUrl}#token=${encodeURIComponent(input.token)}`;
    const subject = 'You were invited to Genesis Platform';
    const text = [
      'You were invited to join an organization in Genesis Platform.',
      `Invited role: ${input.role}`,
      `This invitation expires at ${input.expiresAt.toISOString()}.`,
      `Open the invitation: ${url}`,
      'If you did not expect this invitation, ignore this email.',
    ].join('\n\n');
    const escapedUrl = this.escapeHtml(url);
    const html =
      '<!doctype html><html><body>' +
      '<p>You were invited to join an organization in Genesis Platform.</p>' +
      `<p>Invited role: ${input.role}</p>` +
      `<p>This invitation expires at ${input.expiresAt.toISOString()}.</p>` +
      `<p><a href="${escapedUrl}">Open the invitation</a></p>` +
      '<p>If you did not expect this invitation, ignore this email.</p>' +
      '</body></html>';
    return Object.freeze({
      templateVersion: 'invitation-email/v1',
      idempotencyKey: `genesis-invitation-delivery/v1/${input.outboxId}`,
      from: this.config.from,
      to: input.recipientEmail,
      subject,
      html,
      text,
    });
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
}
