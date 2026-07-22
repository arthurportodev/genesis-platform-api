export enum MembershipCommand {
  CHANGE_ROLE = 'change_role',
  PROMOTE_OWNER = 'promote_owner',
  DEMOTE_OWNER = 'demote_owner',
  DEACTIVATE = 'deactivate',
  REACTIVATE = 'reactivate',
  LEAVE = 'leave',
}

export enum MembershipCommandOutcome {
  CHANGED = 'changed',
  NO_CHANGE = 'no_change',
  BLOCKED_LAST_OWNER = 'blocked_last_owner',
}
