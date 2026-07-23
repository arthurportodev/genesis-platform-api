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

export enum LeadTimelineEventType {
  CREATED = 'lead.created',
  ENTRY_RECEIVED = 'lead.entry.received',
  BASIC_DATA_UPDATED = 'lead.basic_data.updated',
  ASSIGNMENT_CHANGED = 'lead.assignment.changed',
  ASSIGNMENT_CLEARED = 'lead.assignment.cleared',
}
