import {
  LeadArchiveReason,
  LeadActivityType,
  LeadCycleOpeningReason,
  LeadLostReason,
  LeadNextActionCancellationReason,
  LeadNextActionStatus,
  LeadNextActionTemporalState,
  LeadNextActionType,
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
  nextAction: LeadNextActionSummary | null;
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
  activityId: string | null;
  noteId: string | null;
  nextActionId: string | null;
  previousNextActionStatus: LeadNextActionStatus | null;
  newNextActionStatus: LeadNextActionStatus | null;
  previousDueAt: string | null;
  newDueAt: string | null;
  nextActionRevision: string | null;
  nextActionCancellationReason: LeadNextActionCancellationReason | null;
  activity: LeadActivityView | null;
  note: LeadNoteView | null;
  nextAction: LeadTimelineNextActionView | null;
  occurredAt: Date;
}

export interface LeadTimelineResponse {
  items: LeadTimelineView[];
  page: { nextCursor: string | null; limit: number };
}

export interface LeadActivityView {
  id: string;
  type: LeadActivityType;
  performedAt: string;
  recordedAt: string;
  recordedByMembershipId: string;
  responsibleMembershipId: string | null;
  outcome: string | null;
  nextActionId: string | null;
}

export interface LeadNoteView {
  id: string;
  content: string;
  authorMembershipId: string;
  createdAt: string;
}

export interface LeadNextActionSummary {
  id: string;
  type: LeadNextActionType;
  description: string;
  dueAt: string;
  responsibleMembershipId: string | null;
  status: LeadNextActionStatus;
  revision: string;
}

export interface LeadTimelineNextActionView extends LeadNextActionSummary {
  cancellationNote: string | null;
}

export interface LeadNextActionView extends LeadNextActionSummary {
  temporalState: Exclude<
    LeadNextActionTemporalState,
    LeadNextActionTemporalState.NONE
  >;
  cycleId: string;
  createdByMembershipId: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadNextActionResponse {
  item: LeadNextActionView | null;
  temporalState: LeadNextActionTemporalState;
  leadRevision: string;
}

export interface LeadCreateMutationResult {
  id: string;
  revision: string;
  replayed: boolean;
  responseStatus: number;
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
