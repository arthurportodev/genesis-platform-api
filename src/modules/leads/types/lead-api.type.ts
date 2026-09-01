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
  items: LeadListItem[];
  page: LeadOperationalPage;
}

export interface LeadOperationalPage {
  nextCursor: string | null;
  limit: number;
  total: number;
  asOf: string;
}

export interface LeadListItem {
  id: string;
  displayName: string;
  primaryPhone: string;
  email: string | null;
  companyName: string | null;
  responsibleMembershipId: string | null;
  status: LeadStatus;
  stage: LeadStage;
  expectedValueMinor: string | null;
  source: string;
  lastEntryAt: string;
  nextAction: LeadNextActionSummary | null;
  temporalState: LeadNextActionTemporalState;
  returnPending: boolean;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadKanbanColumn {
  stage: LeadStage;
  total: number;
  expectedValueTotalMinor: string;
  withoutExpectedValue: number;
  items: LeadListItem[];
  page: { nextCursor: string | null; limit: number };
}

export interface LeadKanbanResponse {
  columns: LeadKanbanColumn[];
  asOf: string;
  currency: 'BRL';
  expectedValueTotalMinor: string;
  withoutExpectedValue: number;
}

export interface LeadReturnReviewItem {
  lead: LeadListItem;
  review: {
    id: string;
    cycleId: string;
    entryCount: string;
    openedAt: string;
    updatedAt: string;
    firstEntry: { id: string; source: string; receivedAt: string };
    latestEntry: { id: string; source: string; receivedAt: string };
  };
}

export interface LeadReturnReviewQueueResponse {
  items: LeadReturnReviewItem[];
  page: LeadOperationalPage;
}

export interface LeadMetricsResponse {
  asOf: string;
  timeZone: string;
  snapshot: {
    active: number;
    unassigned: number;
    overdue: number;
    withoutNextAction: number;
    pendingReturns: number;
  };
  period: {
    from: string;
    to: string;
    created: number;
    won: number;
    lost: number;
    createdBySource: Array<{ source: string; count: number }>;
  };
}

export interface LeadDetailView extends LeadView {
  latestEntry: {
    id: string;
    sequence: string;
    intakeChannel: string;
    source: string;
    receivedAt: string;
  };
  latestCycle: LeadCommercialCycleView;
  pendingReturn: {
    id: string;
    cycleId: string;
    entryCount: string;
    openedAt: string;
    updatedAt: string;
  } | null;
  counts: {
    timeline: number;
    cycles: number;
    activities: number;
    notes: number;
  };
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
  previousExpectedValueMinor: string | null;
  newExpectedValueMinor: string | null;
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
  expectedValueMinor: string | null;
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
