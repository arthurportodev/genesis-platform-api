export enum LeadIntakeChannel {
  MANUAL = 'manual',
  GENESIS_FORM = 'genesis_form',
}

export enum LeadSource {
  MANUAL = 'manual',
  LANDING_PAGE = 'landing_page',
  CAMPAIGN = 'campaign',
  LEAD_MAGNET = 'lead_magnet',
  OTHER = 'other',
}

export enum LeadStatus {
  ACTIVE = 'active',
  WON = 'won',
  LOST = 'lost',
  ARCHIVED = 'archived',
}

export enum LeadStage {
  NEW = 'new',
  QUALIFICATION = 'qualification',
  DIAGNOSIS = 'diagnosis',
  PROPOSAL = 'proposal',
  NEGOTIATION = 'negotiation',
}

export enum LeadLostReason {
  NOT_QUALIFIED = 'not_qualified',
  NO_RESPONSE = 'no_response',
  NO_BUDGET = 'no_budget',
  NOT_NOW = 'not_now',
  CHOSE_COMPETITOR = 'chose_competitor',
  OTHER = 'other',
}

export enum LeadArchiveReason {
  DUPLICATE = 'duplicate',
  SPAM = 'spam',
  TEST = 'test',
  OUTDATED = 'outdated',
  OTHER = 'other',
}

export enum LeadCycleOpeningReason {
  CREATED = 'created',
  REACTIVATED = 'reactivated',
}

export enum LeadReturnReviewStatus {
  PENDING = 'pending',
  DISMISSED = 'dismissed',
  REACTIVATED = 'reactivated',
}

export enum LeadCommand {
  MOVE = 'move',
  WIN = 'win',
  LOSE = 'lose',
  ARCHIVE = 'archive',
  REACTIVATE = 'reactivate',
  DISMISS_RETURN = 'dismiss_return',
}

export enum LeadActivityType {
  WHATSAPP = 'whatsapp',
  CALL = 'call',
  MEETING = 'meeting',
  DIAGNOSIS = 'diagnosis',
  PROPOSAL_SENT = 'proposal_sent',
  FOLLOW_UP = 'follow_up',
  INTERNAL_TASK = 'internal_task',
}

export enum LeadNextActionType {
  WHATSAPP = 'whatsapp',
  CALL = 'call',
  MEETING = 'meeting',
  DIAGNOSIS = 'diagnosis',
  SEND_PROPOSAL = 'send_proposal',
  FOLLOW_UP = 'follow_up',
  INTERNAL_TASK = 'internal_task',
}

export enum LeadNextActionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  CANCELED = 'canceled',
}

export enum LeadNextActionCancellationReason {
  MANUAL = 'manual',
  LEAD_CLOSED = 'lead_closed',
}

export enum LeadNextActionTemporalState {
  NONE = 'none',
  OVERDUE = 'overdue',
  TODAY = 'today',
  FUTURE = 'future',
}

export enum LeadFollowUpCommand {
  CREATE_ACTIVITY = 'create_activity',
  CREATE_NOTE = 'create_note',
  CREATE_NEXT_ACTION = 'create_next_action',
  RESCHEDULE_NEXT_ACTION = 'reschedule_next_action',
  COMPLETE_NEXT_ACTION = 'complete_next_action',
  CANCEL_NEXT_ACTION = 'cancel_next_action',
}

export enum LeadTimelineEventType {
  CREATED = 'lead.created',
  ENTRY_RECEIVED = 'lead.entry.received',
  BASIC_DATA_UPDATED = 'lead.basic_data.updated',
  ASSIGNMENT_CHANGED = 'lead.assignment.changed',
  ASSIGNMENT_CLEARED = 'lead.assignment.cleared',
  STAGE_CHANGED = 'lead.stage.changed',
  WON = 'lead.won',
  LOST = 'lead.lost',
  ARCHIVED = 'lead.archived',
  REACTIVATED = 'lead.reactivated',
  RETURN_RECEIVED = 'lead.return.received',
  RETURN_DISMISSED = 'lead.return.dismissed',
  ACTIVITY_CREATED = 'lead.activity.created',
  NOTE_CREATED = 'lead.note.created',
  NEXT_ACTION_CREATED = 'lead.next_action.created',
  NEXT_ACTION_RESCHEDULED = 'lead.next_action.rescheduled',
  NEXT_ACTION_COMPLETED = 'lead.next_action.completed',
  NEXT_ACTION_CANCELED = 'lead.next_action.canceled',
}
