import { getMetadataArgsStorage } from 'typeorm';
import { InvitationDeliveryOutbox } from '../src/modules/invitations/entities/invitation-delivery-outbox.entity';
import { OrganizationCommandIdempotency } from '../src/modules/invitations/entities/organization-command-idempotency.entity';
import { OrganizationInvitation } from '../src/modules/invitations/entities/organization-invitation.entity';
import { OrganizationAuditLog } from '../src/modules/organization-audit/entities/organization-audit-log.entity';

describe('Invitation entity metadata', () => {
  const metadata = getMetadataArgsStorage();

  it('maps the four approved tables', () => {
    expect(
      metadata.tables.find((table) => table.target === OrganizationInvitation)
        ?.name,
    ).toBe('organization_invitations');
    expect(
      metadata.tables.find((table) => table.target === OrganizationAuditLog)
        ?.name,
    ).toBe('organization_audit_logs');
    expect(
      metadata.tables.find(
        (table) => table.target === OrganizationCommandIdempotency,
      )?.name,
    ).toBe('organization_command_idempotency');
    expect(
      metadata.tables.find((table) => table.target === InvitationDeliveryOutbox)
        ?.name,
    ).toBe('invitation_delivery_outbox');
  });

  it('keeps the nonce out of default selection and has no token hash', () => {
    const nonce = metadata.columns.find(
      (column) =>
        column.target === OrganizationInvitation &&
        column.propertyName === 'tokenNonce',
    );
    expect(nonce?.options).toMatchObject({
      name: 'token_nonce',
      select: false,
    });
    expect(
      metadata.columns.find(
        (column) =>
          column.target === OrganizationInvitation &&
          /tokenHash|rawToken|mac/u.test(column.propertyName),
      ),
    ).toBeUndefined();
  });

  it('persists exactly the four approved replacement-result fields', () => {
    const resultColumns = metadata.columns
      .filter(
        (column) =>
          column.target === OrganizationCommandIdempotency &&
          column.propertyName.startsWith('result'),
      )
      .map((column) => column.options.name)
      .sort();
    expect(resultColumns).toEqual([
      'result_delivery_status_at_creation',
      'result_invitation_id',
      'result_previous_invitation_id',
      'result_state_at_creation',
    ]);
  });
});
