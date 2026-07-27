import {
  LeadArchiveReason,
  LeadCycleOpeningReason,
  LeadLostReason,
  LeadStage,
  LeadStatus,
} from '../enums/lead.enums';

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
  status: LeadStatus;
  stage: LeadStage;
  latestCycleNumber: string;
  returnReviewPending: boolean;
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
  cycleId: string | null;
  returnReviewId: string | null;
  previousStatus: LeadStatus | null;
  newStatus: LeadStatus | null;
  previousStage: LeadStage | null;
  newStage: LeadStage | null;
  lostReason: LeadLostReason | null;
  archiveReason: LeadArchiveReason | null;
  occurredAt: Date;
}

export interface LeadCommercialCycleView {
  id: string;
  cycleNumber: string;
  openingReason: LeadCycleOpeningReason;
  startingStage: LeadStage;
  openedByMembershipId: string | null;
  openedAt: Date;
  closedByMembershipId: string | null;
  closedAt: Date | null;
  closingStatus: Exclude<LeadStatus, LeadStatus.ACTIVE> | null;
  stageAtClose: LeadStage | null;
  lostReason: LeadLostReason | null;
  archiveReason: LeadArchiveReason | null;
  reasonNote: string | null;
}

export interface LeadCycleListResponse {
  items: LeadCommercialCycleView[];
  page: { nextCursor: string | null; limit: number };
}

export interface LeadCommandResult {
  revision: string;
  replayed: boolean;
  responseStatus: number;
}

export interface LeadIngestResult {
  responseStatus: number;
  replayed: boolean;
  lead: LeadView | null;
}
