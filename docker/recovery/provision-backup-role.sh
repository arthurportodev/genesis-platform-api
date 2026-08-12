#!/bin/bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$script_dir/common.sh"

action='provision'
environment_file='/opt/genesis/recovery/recovery.env'
run_id=''
authorized=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --action) action=${2:-}; shift 2 ;;
    --env-file) environment_file=${2:-}; shift 2 ;;
    --window-run-id) run_id=${2:-}; shift 2 ;;
    --authorize-production-mutation) authorized=1; shift ;;
    *) fail "unknown backup-role argument: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail 'backup-role provisioning requires root'
[ "$authorized" = 1 ] || fail 'explicit production-mutation flag is required'
[ "${RECOVERY_PRODUCTION_MUTATION_AUTHORIZED:-false}" = true ] || fail 'production mutation authorization environment is required'
validate_run_id "$run_id"
case "$action" in provision|rollback) ;; *) fail 'action must be provision or rollback' ;; esac

require_root_control_file "$environment_file"
# shellcheck disable=SC1090
. "$environment_file"

docker_bin=${RECOVERY_DOCKER_BIN:-docker}
[ "${RECOVERY_TEST_MODE:-0}" = 1 ] || [ "$docker_bin" = docker ] || fail 'Docker override is test-only'
require_command "$docker_bin"
require_secret_file "$RECOVERY_BOOTSTRAP_PGPASS_FILE"

: "${RECOVERY_BACKUP_PGPASS_FILE:?missing backup pgpass path}"
: "${RECOVERY_BACKUP_ROLE_PROVENANCE_FILE:?missing provenance path}"
: "${RECOVERY_DATABASE_HOST:?missing database host}"
: "${RECOVERY_DATABASE_PORT:?missing database port}"
: "${RECOVERY_DATABASE_NAME:?missing database name}"
: "${RECOVERY_PRODUCTION_NETWORK:?missing production network}"

admin_user='genesis_bootstrap'
backup_user='genesis_backup'
container_name="genesis-recovery-role-$run_id"
created_role=0
created_pgpass=0
created_oid=''
completed=0

psql_admin() {
  local interactive=()
  [ "${PSQL_ADMIN_INTERACTIVE:-0}" != 1 ] || interactive=(--interactive)
  "$docker_bin" run --rm "${interactive[@]}" --name "$container_name" --label "$RECOVERY_LABEL_KEY=$run_id" \
    --platform "$RECOVERY_PLATFORM" --network "$RECOVERY_PRODUCTION_NETWORK" --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=$RECOVERY_BOOTSTRAP_PGPASS_FILE,dst=/run/secrets/admin-pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/admin-pgpass "$RECOVERY_POSTGRES_IMAGE" \
    psql --no-password --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --host "$RECOVERY_DATABASE_HOST" --port "$RECOVERY_DATABASE_PORT" \
    --username "$admin_user" --dbname "$RECOVERY_DATABASE_NAME" "$@"
}

psql_admin_stdin() {
  PSQL_ADMIN_INTERACTIVE=1 psql_admin "$@"
}

psql_backup() {
  "$docker_bin" run --rm --name "$container_name" --label "$RECOVERY_LABEL_KEY=$run_id" \
    --platform "$RECOVERY_PLATFORM" --network "$RECOVERY_PRODUCTION_NETWORK" --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=$RECOVERY_BACKUP_PGPASS_FILE,dst=/run/secrets/backup-pgpass,readonly" \
    --env PGPASSFILE=/run/secrets/backup-pgpass "$RECOVERY_POSTGRES_IMAGE" \
    psql --no-password --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --host "$RECOVERY_DATABASE_HOST" --port "$RECOVERY_DATABASE_PORT" \
    --username "$backup_user" --dbname "$RECOVERY_DATABASE_NAME" "$@"
}

role_oid() {
  psql_admin --command "SELECT oid FROM pg_roles WHERE rolname='$backup_user'"
}

ownership_count() {
  psql_admin --command "SELECT count(*) FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=(SELECT oid FROM pg_roles WHERE rolname='$backup_user') AND deptype='o'"
}

role_state() {
  local oid attrs memberships owned writes schema_create members_of_role
  oid=$(role_oid)
  [ -n "$oid" ] || { printf 'absent'; return; }
  attrs=$(psql_admin --command "SELECT rolcanlogin||'|'||rolinherit||'|'||rolsuper||'|'||rolcreatedb||'|'||rolcreaterole||'|'||rolreplication||'|'||rolbypassrls||'|'||rolconnlimit FROM pg_roles WHERE oid=$oid")
  memberships=$(psql_admin --command "SELECT count(*)||'|'||coalesce(bool_and(r.rolname='pg_read_all_data' AND NOT m.admin_option AND m.inherit_option AND NOT m.set_option),false) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=$oid")
  owned=$(ownership_count)
  writes=$(psql_admin --command "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND (has_table_privilege('$backup_user',c.oid,'INSERT') OR has_table_privilege('$backup_user',c.oid,'UPDATE') OR has_table_privilege('$backup_user',c.oid,'DELETE') OR has_table_privilege('$backup_user',c.oid,'TRUNCATE') OR has_table_privilege('$backup_user',c.oid,'TRIGGER'))")
  schema_create=$(psql_admin --command "SELECT count(*) FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege('$backup_user',n.oid,'CREATE')")
  members_of_role=$(psql_admin --command "SELECT count(*) FROM pg_auth_members WHERE roleid=$oid")
  if [ "$attrs" = 'true|true|false|false|false|false|true|1' ] && \
    [ "$memberships" = '1|true' ] && [ "$owned" = 0 ] && [ "$writes" = 0 ] && \
    [ "$schema_create" = 0 ] && [ "$members_of_role" = 0 ] && \
    [ "$(psql_admin --command "SELECT has_database_privilege('$backup_user',current_database(),'CONNECT')")" = t ]; then
    printf 'conformant'
  else
    printf 'divergent:attrs=%s,memberships=%s,owned=%s,writes=%s,schemaCreate=%s,members=%s' \
      "$attrs" "$memberships" "$owned" "$writes" "$schema_create" "$members_of_role"
  fi
}

cleanup_on_error() {
  local code=$?
  set +e
  if [ "$completed" != 1 ] && [ "$created_role" = 1 ] && [ -n "$created_oid" ] && \
    [ "$(role_oid 2>/dev/null)" = "$created_oid" ] && [ "$(ownership_count 2>/dev/null)" = 0 ]; then
    printf "REVOKE CONNECT ON DATABASE %s FROM %s; DROP ROLE %s;\n" "$RECOVERY_DATABASE_NAME" "$backup_user" "$backup_user" | psql_admin_stdin >/dev/null 2>&1
  fi
  if [ "$completed" != 1 ] && [ "$created_pgpass" = 1 ]; then rm -f -- "$RECOVERY_BACKUP_PGPASS_FILE"; fi
  exit "$code"
}
trap cleanup_on_error EXIT

[ "$(psql_admin --command "SELECT current_user||'|'||rolsuper FROM pg_roles WHERE rolname=current_user")" = 'genesis_bootstrap|true' ] || fail 'administrative identity must be the genesis_bootstrap superuser'
cluster_id=$(psql_admin --command 'SELECT system_identifier FROM pg_control_system()')
state=$(role_state)

if [ "$action" = rollback ]; then
  require_root_control_file "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE"
  marker=$(tr -d '\r\n ' <"$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE")
  expected="{\"contractVersion\":\"0.8-MVP-07A.backup-role-provenance.v1\",\"windowRunId\":\"$run_id\",\"clusterSystemIdentifier\":\"$cluster_id\",\"roleName\":\"$backup_user\",\"roleOid\":"
  [[ "$marker" == "$expected"* ]] || fail 'backup-role provenance does not match this window and cluster'
  marker_oid=$(printf '%s' "$marker" | sed -n 's/.*"roleOid":\([0-9][0-9]*\).*/\1/p')
  [[ "$marker" == *'"roleCreated":true'* ]] || fail 'rollback cannot drop a role not created by this window'
  [ "$state" = conformant ] || fail 'rollback requires the exact conformant role state'
  [ "$(role_oid)" = "$marker_oid" ] || fail 'rollback role OID mismatch'
  [ "$(psql_admin --command "SELECT count(*) FROM pg_stat_activity WHERE usename='$backup_user'")" = 0 ] || fail 'rollback requires zero active backup-role sessions'
  printf "BEGIN; REVOKE CONNECT ON DATABASE %s FROM %s; DROP ROLE %s; COMMIT;\n" "$RECOVERY_DATABASE_NAME" "$backup_user" "$backup_user" | psql_admin_stdin >/dev/null
  if [[ "$marker" == *'"pgpassCreated":true'* ]]; then rm -f -- "$RECOVERY_BACKUP_PGPASS_FILE"; fi
  rm -f -- "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE"
  completed=1
  trap - EXIT
  printf 'backup-role: rolled-back\n'
  exit 0
fi

[[ "$state" != divergent:* ]] || fail "preexisting genesis_backup role is $state; no mutation performed"

password=''
if [ ! -e "$RECOVERY_BACKUP_PGPASS_FILE" ]; then
  IFS= read -r -s password || fail 'backup password must be supplied on stdin'
  [[ "$password" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || fail 'backup password must be 32-128 URL-safe characters'
elif [ -f "$RECOVERY_BACKUP_PGPASS_FILE" ] && [ ! -L "$RECOVERY_BACKUP_PGPASS_FILE" ]; then
  require_secret_file "$RECOVERY_BACKUP_PGPASS_FILE"
else
  fail 'backup pgpass must be an existing regular secret or absent'
fi

if [ "$state" = absent ]; then
  [ -n "$password" ] || fail 'password input is required to create genesis_backup'
  failure_sql=''
  if [ "${RECOVERY_TEST_INJECT_PROVISION_FAILURE:-0}" = 1 ]; then
    [ "${RECOVERY_TEST_MODE:-0}" = 1 ] || fail 'failure injection is test-only'
    failure_sql='SELECT 1/0;'
  fi
  printf "BEGIN; CREATE ROLE %s LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 1 PASSWORD '%s'; GRANT pg_read_all_data TO %s WITH INHERIT TRUE, SET FALSE; GRANT CONNECT ON DATABASE %s TO %s; %s COMMIT;\n" \
    "$backup_user" "$password" "$backup_user" "$RECOVERY_DATABASE_NAME" "$backup_user" "$failure_sql" | psql_admin_stdin >/dev/null
  created_role=1
  created_oid=$(role_oid)
fi

if [ -n "$password" ]; then
  mkdir -p -m 0700 "$(dirname "$RECOVERY_BACKUP_PGPASS_FILE")"
  printf '%s:%s:%s:%s:%s\n' "$RECOVERY_DATABASE_HOST" "$RECOVERY_DATABASE_PORT" "$RECOVERY_DATABASE_NAME" "$backup_user" "$password" | atomic_write "$RECOVERY_BACKUP_PGPASS_FILE"
  chmod 0600 "$RECOVERY_BACKUP_PGPASS_FILE"
  chown 0:0 "$RECOVERY_BACKUP_PGPASS_FILE"
  created_pgpass=1
fi
unset password

verified_state=$(role_state)
[ "$verified_state" = conformant ] || fail "backup role verification failed: $verified_state"
rls_proof=$(psql_backup --command "WITH denied AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND NOT has_table_privilege(current_user,c.oid,'SELECT')) SELECT CASE WHEN current_user='$backup_user' AND (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AND NOT EXISTS (SELECT 1 FROM denied) THEN 'complete' ELSE 'incomplete' END")
[ "$rls_proof" = complete ] || fail 'backup role does not prove complete RLS read access'

role_id=$(role_oid)
mkdir -p -m 0700 "$(dirname "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE")"
if [ -f "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE" ] && [ ! -L "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE" ]; then
  prior_marker=$(tr -d '\r\n ' <"$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE")
  prior_prefix="{\"contractVersion\":\"0.8-MVP-07A.backup-role-provenance.v1\",\"windowRunId\":\"$run_id\",\"clusterSystemIdentifier\":\"$cluster_id\",\"roleName\":\"$backup_user\",\"roleOid\":$role_id,"
  if [[ "$prior_marker" == "$prior_prefix"* ]]; then
    [[ "$prior_marker" == *'"roleCreated":true'* ]] && created_role=1
    [[ "$prior_marker" == *'"pgpassCreated":true'* ]] && created_pgpass=1
  else
    fail 'existing backup-role provenance does not match this window, cluster, and role'
  fi
fi
printf '{"contractVersion":"0.8-MVP-07A.backup-role-provenance.v1","windowRunId":"%s","clusterSystemIdentifier":"%s","roleName":"genesis_backup","roleOid":%s,"roleCreated":%s,"pgpassCreated":%s,"classification":"conformant"}\n' \
  "$run_id" "$cluster_id" "$role_id" "$([ "$created_role" = 1 ] && printf true || printf false)" "$([ "$created_pgpass" = 1 ] && printf true || printf false)" | atomic_write "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE"
chmod 0600 "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE"
chown 0:0 "$RECOVERY_BACKUP_ROLE_PROVENANCE_FILE"
completed=1
trap - EXIT
printf 'backup-role: conformant roleOid=%s created=%s\n' "$role_id" "$created_role"
