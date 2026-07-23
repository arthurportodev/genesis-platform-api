export const RUNTIME_EXECUTABLE_FUNCTIONS = [
  'app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)',
  'app_private.apply_existing_user_invitation_membership(uuid,uuid)',
  'app_private.execute_membership_command(uuid,uuid,uuid,app_private.membership_command_enum,membership_role_enum,uuid,inet,text)',
  'app_private.lock_auth_refresh_user(uuid)',
  'app_private.lock_invitation_context(uuid[],uuid[],uuid[])',
] as const;

export type RuntimeExecutableFunction =
  (typeof RUNTIME_EXECUTABLE_FUNCTIONS)[number];

export const LEAD_RUNTIME_EXECUTABLE_FUNCTIONS = [
  'app_private.assign_lead(uuid,uuid,uuid,uuid,uuid,bigint)',
  'app_private.ingest_lead(uuid,uuid,uuid,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,uuid,smallint,text,jsonb)',
  'app_private.required_lead_fingerprint_key_versions()',
  'app_private.update_lead(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text)',
] as const;

export const CURRENT_RUNTIME_EXECUTABLE_FUNCTIONS = [
  ...RUNTIME_EXECUTABLE_FUNCTIONS,
  ...LEAD_RUNTIME_EXECUTABLE_FUNCTIONS,
].sort();
