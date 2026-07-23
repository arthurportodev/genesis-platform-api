export interface LeadView {
  id: string;
  displayName: string;
  primaryPhone: string;
  email: string | null;
  companyName: string | null;
  instagram: string | null;
  city: string | null;
  serviceInterest: string | null;
  responsibleMembershipId: string | null;
  status: 'active';
  stage: 'new';
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  initialAttribution: LeadAttributionView;
  lastAttribution: LeadAttributionView;
}

export interface LeadAttributionView {
  source: string;
  sourceDetail: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  receivedAt: string;
}

export interface LeadListResponse {
  items: LeadView[];
  page: { nextCursor: string | null; limit: number };
}

export interface LeadTimelineView {
  id: string;
  sequence: string;
  eventType: string;
  actorMembershipId: string | null;
  leadEntryId: string | null;
  previousResponsibleMembershipId: string | null;
  newResponsibleMembershipId: string | null;
  changedFields: string[] | null;
  occurredAt: Date;
}

export interface LeadIngestResult {
  responseStatus: number;
  replayed: boolean;
  lead: LeadView | null;
}
