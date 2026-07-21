import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  InvitationRevocationReason,
  InvitationRole,
  InvitationStatus,
} from '../enums/invitation.enums';

@Entity({ name: 'organization_invitations' })
@Index(
  'UQ_organization_invitations_id_organization',
  ['id', 'organizationId'],
  { unique: true },
)
@Index(
  'UQ_organization_invitations_live_email',
  ['organizationId', 'emailNormalized'],
  {
    unique: true,
    where: `"status" = 'pending'`,
  },
)
@Index(
  'UQ_organization_invitations_token_nonce',
  ['tokenKeyVersion', 'tokenNonce'],
  {
    unique: true,
  },
)
@Index(
  'UQ_organization_invitations_superseded_by',
  ['supersededByInvitationId'],
  {
    unique: true,
    where: '"superseded_by_invitation_id" IS NOT NULL',
  },
)
@Index('IDX_organization_invitations_org_status_created', [
  'organizationId',
  'status',
  'createdAt',
  'id',
])
@Index('IDX_organization_invitations_org_email_created', [
  'organizationId',
  'emailNormalized',
  'createdAt',
])
@Index('IDX_organization_invitations_issuer_created', [
  'invitedByMembershipId',
  'createdAt',
])
@Index('IDX_organization_invitations_status_expires', ['status', 'expiresAt'])
export class OrganizationInvitation {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'email_normalized', type: 'varchar', length: 320 })
  emailNormalized!: string;

  @Column({
    name: 'role',
    type: 'enum',
    enum: InvitationRole,
    enumName: 'organization_invitation_role_enum',
  })
  role!: InvitationRole;

  @Column({
    name: 'status',
    type: 'enum',
    enum: InvitationStatus,
    enumName: 'organization_invitation_status_enum',
    default: InvitationStatus.PENDING,
  })
  status!: InvitationStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'invited_by_membership_id', type: 'uuid' })
  invitedByMembershipId!: string;

  @Column({ name: 'accepted_by_user_id', type: 'uuid', nullable: true })
  acceptedByUserId!: string | null;

  @Column({ name: 'resulting_membership_id', type: 'uuid', nullable: true })
  resultingMembershipId!: string | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'revoked_by_membership_id', type: 'uuid', nullable: true })
  revokedByMembershipId!: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({
    name: 'revocation_reason',
    type: 'enum',
    enum: InvitationRevocationReason,
    enumName: 'organization_invitation_revocation_reason_enum',
    nullable: true,
  })
  revocationReason!: InvitationRevocationReason | null;

  @Column({ name: 'superseded_by_invitation_id', type: 'uuid', nullable: true })
  supersededByInvitationId!: string | null;

  @Column({ name: 'token_key_version', type: 'smallint' })
  tokenKeyVersion!: number;

  @Column({ name: 'token_version', type: 'smallint', default: 1 })
  tokenVersion!: number;

  @Exclude({ toPlainOnly: true })
  @Column({ name: 'token_nonce', type: 'varchar', length: 43, select: false })
  tokenNonce!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updatedAt!: Date;
}
