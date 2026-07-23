import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { CreateLeadDto } from '../dto/lead.dto';
import { LeadSource } from '../enums/lead.enums';

export interface NormalizedLeadInput {
  displayName: string;
  primaryPhone: string;
  email: string | null;
  companyName: string | null;
  instagram: string | null;
  city: string | null;
  serviceInterest: string | null;
  source: string;
  sourceDetail: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  responsibleMembershipId: string | null;
}

const optional = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized === '') throw new BadRequestException('Invalid lead text.');
  return normalized;
};

export function normalizeLeadInput(
  dto: CreateLeadDto,
  primaryPhone: string,
): NormalizedLeadInput {
  if (
    (dto.source === LeadSource.OTHER && dto.sourceDetail === undefined) ||
    (dto.source !== LeadSource.OTHER && dto.sourceDetail !== undefined)
  ) {
    throw new BadRequestException('Invalid lead source detail.');
  }
  const displayName = dto.displayName.trim();
  if (displayName === '') {
    throw new BadRequestException('Invalid lead display name.');
  }
  return {
    displayName,
    primaryPhone,
    email:
      dto.email === undefined
        ? null
        : (optional(dto.email)?.toLowerCase() ?? null),
    companyName: optional(dto.companyName),
    instagram: optional(dto.instagram),
    city: optional(dto.city),
    serviceInterest: optional(dto.serviceInterest),
    source: dto.source,
    sourceDetail: optional(dto.sourceDetail),
    utmSource: optional(dto.utmSource),
    utmMedium: optional(dto.utmMedium),
    utmCampaign: optional(dto.utmCampaign),
    utmContent: optional(dto.utmContent),
    utmTerm: optional(dto.utmTerm),
    responsibleMembershipId: dto.responsibleMembershipId ?? null,
  };
}

export function leadRequestFingerprint(
  input: NormalizedLeadInput,
  key: Buffer,
): string {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        1,
        input.displayName,
        input.primaryPhone,
        input.email,
        input.companyName,
        input.instagram,
        input.city,
        input.serviceInterest,
        input.source,
        input.sourceDetail,
        input.utmSource,
        input.utmMedium,
        input.utmCampaign,
        input.utmContent,
        input.utmTerm,
        input.responsibleMembershipId,
      ]),
      'utf8',
    )
    .digest('hex');
}
