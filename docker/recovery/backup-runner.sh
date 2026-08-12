#!/bin/bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$script_dir/common.sh"

mode='regular'
environment_file='/opt/genesis/recovery/recovery.env'
run_id=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode=${2:-}; shift 2 ;;
    --env-file) environment_file=${2:-}; shift 2 ;;
    --run-id) run_id=${2:-}; shift 2 ;;
    *) fail "unknown backup argument: $1" ;;
  esac
done
case "$mode" in regular|checkpoint) ;; *) fail 'backup mode must be regular or checkpoint' ;; esac
require_root_control_file "$environment_file"
# shellcheck disable=SC1090
. "$environment_file"

run_id=${run_id:-$(new_run_id)}
validate_run_id "$run_id"
docker_bin=${RECOVERY_DOCKER_BIN:-docker}
age_bin=${RECOVERY_AGE_BIN:-$RECOVERY_BIN_DIR/age}
rclone_bin=${RECOVERY_RCLONE_BIN:-$RECOVERY_BIN_DIR/rclone}
if [ "${RECOVERY_TEST_MODE:-0}" != '1' ]; then
  [ "$docker_bin" = docker ] || fail 'Docker override is test-only'
  [ "$age_bin" = "$RECOVERY_BIN_DIR/age" ] || fail 'age override is test-only'
  [ "$rclone_bin" = "$RECOVERY_BIN_DIR/rclone" ] || fail 'rclone override is test-only'
fi

require_command flock
require_command sha256sum
require_command "$docker_bin"
require_root_control_file "$age_bin"
require_root_control_file "$rclone_bin"
require_root_control_file "$RECOVERY_AGE_RECIPIENT_FILE"
require_secret_file "$RECOVERY_BACKUP_PGPASS_FILE"
require_secret_file "$RECOVERY_RCLONE_CONFIG"
mkdir -p -m 0700 "$RECOVERY_STAGING_DIR" "$RECOVERY_STATUS_DIR" "$(dirname "$RECOVERY_BACKUP_LOCK")"
exec 9>"$RECOVERY_BACKUP_LOCK"
flock -n 9 || fail 'another backup run owns the lock'

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
basename="genesis-${mode}-${timestamp}-${run_id}.dump.age"
category="${mode}"
dump_file="$RECOVERY_STAGING_DIR/${basename%.age}"
cipher_partial="$RECOVERY_STAGING_DIR/${basename}.partial"
cipher_file="$RECOVERY_STAGING_DIR/$basename"
download_partial="$RECOVERY_STAGING_DIR/${basename}.download.partial"
download_file="$RECOVERY_STAGING_DIR/${basename}.download"
remote_path="$RECOVERY_RCLONE_REMOTE:$RECOVERY_REMOTE_ROOT/$category/$basename"
marker_file="$RECOVERY_STAGING_DIR/${basename}.verified.json"
marker_remote="$RECOVERY_RCLONE_REMOTE:$RECOVERY_REMOTE_ROOT/$category/${basename}.verified.json"
dump_container="genesis-recovery-dump-$run_id"
dump_stderr="$RECOVERY_STAGING_DIR/${basename}.pg_dump.stderr"

cleanup() {
  rm -f -- "$dump_file" "$dump_stderr" "$cipher_partial" "$download_partial" "$download_file" "$marker_file"
}
on_exit() {
  local code=$?
  set +e
  cleanup
  if [ "$code" -ne 0 ]; then
    write_status "$RECOVERY_STATUS_DIR" backup-status.v1.json backup failed "$run_id" 'backup pipeline failed closed'
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM
umask 077

rls_sql="WITH me AS (SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user), denied AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND NOT has_table_privilege(current_user,c.oid,'SELECT')) SELECT CASE WHEN (SELECT bypass FROM me) AND NOT EXISTS (SELECT 1 FROM denied) THEN 'complete' ELSE 'incomplete' END"
rls_result=$($docker_bin run --rm --name "$dump_container" --label "$RECOVERY_LABEL_KEY=$run_id" --platform "$RECOVERY_PLATFORM" --network "$RECOVERY_PRODUCTION_NETWORK" --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=bind,src=$RECOVERY_BACKUP_PGPASS_FILE,dst=/run/secrets/backup-pgpass,readonly" --env PGPASSFILE=/run/secrets/backup-pgpass "$RECOVERY_POSTGRES_IMAGE" psql --no-password --tuples-only --no-align --host "$RECOVERY_DATABASE_HOST" --port "$RECOVERY_DATABASE_PORT" --username "$RECOVERY_BACKUP_DATABASE_USER" --dbname "$RECOVERY_DATABASE_NAME" --set ON_ERROR_STOP=1 --command "$rls_sql")
[ "$rls_result" = complete ] || fail 'backup credential does not prove complete RLS table access'

if ! $docker_bin run --rm --name "$dump_container" --label "$RECOVERY_LABEL_KEY=$run_id" --platform "$RECOVERY_PLATFORM" --network "$RECOVERY_PRODUCTION_NETWORK" --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=bind,src=$RECOVERY_BACKUP_PGPASS_FILE,dst=/run/secrets/backup-pgpass,readonly" --env PGPASSFILE=/run/secrets/backup-pgpass "$RECOVERY_POSTGRES_IMAGE" pg_dump --no-password --host "$RECOVERY_DATABASE_HOST" --port "$RECOVERY_DATABASE_PORT" --username "$RECOVERY_BACKUP_DATABASE_USER" --format=custom --compress=zstd:6 --lock-wait-timeout=60s --dbname "$RECOVERY_DATABASE_NAME" >"$dump_file" 2>"$dump_stderr"; then
  fail 'pg_dump returned a non-zero status'
fi
[ -s "$dump_file" ] || fail 'pg_dump produced an empty archive'
if [ -s "$dump_stderr" ]; then
  fail 'pg_dump produced warning or error output'
fi
rm -f -- "$dump_stderr"

recipient=$(tr -d '\r\n' <"$RECOVERY_AGE_RECIPIENT_FILE")
[[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || fail 'age recipient is invalid'
"$age_bin" --encrypt --recipient "$recipient" --output "$cipher_partial" "$dump_file"
[ -s "$cipher_partial" ] || fail 'age produced an empty ciphertext'
rm -f -- "$dump_file"
cipher_sha=$(sha256sum "$cipher_partial" | awk '{print $1}')
mv -- "$cipher_partial" "$cipher_file"

common_rclone=(--config "$RECOVERY_RCLONE_CONFIG" --retries 3 --low-level-retries 5 --checkers 1 --transfers 1)
"$rclone_bin" "${common_rclone[@]}" --immutable copyto "$cipher_file" "$remote_path"
remote_entry=$("$rclone_bin" "${common_rclone[@]}" lsf --files-only --hash MD5 --format 'hspi' --separator ';' "$remote_path")
IFS=';' read -r remote_checksum remote_size remote_name remote_id <<<"$remote_entry"
[ "$remote_name" = "$basename" ] || fail 'remote object path mismatch after upload'
[ "$remote_size" = "$(stat -c '%s' "$cipher_file")" ] || fail 'remote object size mismatch after upload'
[ -n "$remote_id" ] || fail 'remote object ID is unavailable'
[ -n "$remote_checksum" ] || fail 'remote object checksum is unavailable'

"$rclone_bin" "${common_rclone[@]}" copyto "$remote_path" "$download_partial"
[ -s "$download_partial" ] || fail 'recovery-route download is empty'
download_sha=$(sha256sum "$download_partial" | awk '{print $1}')
[ "$download_sha" = "$cipher_sha" ] || fail 'downloaded ciphertext SHA-256 mismatch'
mv -- "$download_partial" "$download_file"

printf '{"contractVersion":"0.8-MVP-07A.remote-verification.v1","objectPath":"%s","objectId":"%s","size":%s,"remoteChecksum":"%s","ciphertextSha256":"%s","verifiedAt":"%s"}\n' "$RECOVERY_REMOTE_ROOT/$category/$basename" "$(json_escape "$remote_id")" "$remote_size" "$(json_escape "$remote_checksum")" "$cipher_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$marker_file"
"$rclone_bin" "${common_rclone[@]}" --immutable copyto "$marker_file" "$marker_remote"

/bin/bash "$script_dir/retention-runner.sh" --env-file "$environment_file" --category "$category"
write_status "$RECOVERY_STATUS_DIR" backup-status.v1.json backup passed "$run_id" "$category:$basename:$cipher_sha:$remote_id"
trap - EXIT INT TERM
cleanup
