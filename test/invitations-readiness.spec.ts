import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrganizationAuditService } from '../src/modules/organization-audit/services/organization-audit.service';
import { InvitationRole } from '../src/modules/invitations/enums/invitation.enums';
import { DisabledInvitationIssuanceReadiness } from '../src/modules/invitations/ports/invitation-issuance-readiness.port';
import { InvitationsService } from '../src/modules/invitations/services/invitations.service';
import { MembershipRole } from '../src/modules/memberships/enums/membership-role.enum';

describe('Invitation issuance readiness', () => {
  it('rejects create and replace before opening a transaction', async () => {
    const transaction = jest.fn();
    const dataSource = { transaction } as unknown as DataSource;
    const service = new InvitationsService(
      dataSource,
      {} as OrganizationAuditService,
      new DisabledInvitationIssuanceReadiness(),
      {
        currentVersion: jest.fn(() => {
          throw new Error('must not be called');
        }),
        keyFor: jest.fn(),
      },
    );
    const tenant = {
      userId: '00000000-0000-4000-8000-000000000001',
      organizationId: '00000000-0000-4000-8000-000000000002',
      membershipId: '00000000-0000-4000-8000-000000000003',
      role: MembershipRole.OWNER,
    };

    await expect(
      service.create(
        tenant,
        { email: 'member@example.com', role: InvitationRole.MEMBER },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      service.replace(
        tenant,
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000005',
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
