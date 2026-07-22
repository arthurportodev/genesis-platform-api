export const RUNTIME_EXECUTABLE_FUNCTIONS = [
  'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
  'app_private.apply_existing_user_invitation_membership(uuid,uuid)',
  'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,membership_role_enum,uuid,inet,text)',
  'app_private.lock_auth_refresh_user(uuid)',
  'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
] as const;

export type RuntimeExecutableFunction =
  (typeof RUNTIME_EXECUTABLE_FUNCTIONS)[number];
