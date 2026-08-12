#!/bin/bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$script_dir/common.sh"

environment_file='/opt/genesis/recovery/recovery.env'
ciphertext=''
remote_object=''
expected_object_id=''
expected_sha=''
release_dir=''
run_id=''
expected_source_commit=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) environment_file=${2:-}; shift 2 ;;
    --ciphertext) ciphertext=${2:-}; shift 2 ;;
    --remote-object) remote_object=${2:-}; shift 2 ;;
    --expected-object-id) expected_object_id=${2:-}; shift 2 ;;
    --expected-sha256) expected_sha=${2:-}; shift 2 ;;
    --release-dir) release_dir=${2:-}; shift 2 ;;
    --run-id) run_id=${2:-}; shift 2 ;;
    --expected-source-commit) expected_source_commit=${2:-}; shift 2 ;;
    *) fail "unknown restore-proof argument: $1" ;;
  esac
done
require_root_control_file "$environment_file"
# shellcheck disable=SC1090
. "$environment_file"
release_dir=${release_dir:-$RECOVERY_RELEASE_DIR}
run_id=${run_id:-$(new_run_id)}
validate_run_id "$run_id"
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'expected ciphertext SHA-256 is invalid'
[[ "$expected_source_commit" =~ ^[a-f0-9]{40}$ ]] || fail 'expected committed-release source SHA is invalid'
if [ -n "$ciphertext" ] && [ -n "$remote_object" ]; then fail 'select either local ciphertext or remote object, not both'; fi
if [ -z "$ciphertext" ] && [ -z "$remote_object" ]; then fail 'ciphertext source is required'; fi
require_root_control_file "$release_dir/release-manifest.json"
require_root_control_file "$release_dir/docker/postgres/init-runtime-role.sh"
require_root_control_file "$release_dir/docker/production/api-entrypoint.sh"
require_secret_file "$RECOVERY_AGE_IDENTITY_FILE"
[[ "$RECOVERY_CONTAINER_SECRET_GID" =~ ^[0-9]+$ ]] || fail 'container secret group ID is invalid'

for secret in postgres-bootstrap-password database-migration-password database-runtime-password restore-bootstrap-pgpass jwt-access-secret refresh-token-pepper lead-idempotency-keys; do
  require_secret_file "$RECOVERY_RESTORE_SECRETS_DIR/$secret"
done

docker_bin=${RECOVERY_DOCKER_BIN:-docker}
age_bin=${RECOVERY_AGE_BIN:-$RECOVERY_BIN_DIR/age}
rclone_bin=${RECOVERY_RCLONE_BIN:-$RECOVERY_BIN_DIR/rclone}
if [ "${RECOVERY_TEST_MODE:-0}" != '1' ]; then
  [ "$docker_bin" = docker ] || fail 'Docker override is test-only'
  [ "$age_bin" = "$RECOVERY_BIN_DIR/age" ] || fail 'age override is test-only'
  [ "$rclone_bin" = "$RECOVERY_BIN_DIR/rclone" ] || fail 'rclone override is test-only'
fi
require_command "$docker_bin"
require_command flock
require_command grep
require_command sha256sum
require_root_control_file "$age_bin"
if [ -n "$remote_object" ]; then
  require_root_control_file "$rclone_bin"
  require_secret_file "$RECOVERY_RCLONE_CONFIG"
  [[ "$RECOVERY_RCLONE_REMOTE" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || fail 'rclone remote name is invalid'
  [[ "$RECOVERY_REMOTE_ROOT" =~ ^[A-Za-z0-9_-]+$ ]] || fail 'remote recovery root is invalid'
  [[ "$expected_object_id" =~ ^[A-Za-z0-9_-]+$ ]] || fail 'expected remote object ID is invalid'
  if ! [[ "$remote_object" =~ ^${RECOVERY_RCLONE_REMOTE}:${RECOVERY_REMOTE_ROOT}/regular/genesis-regular-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{16}\.dump\.age$|^${RECOVERY_RCLONE_REMOTE}:${RECOVERY_REMOTE_ROOT}/checkpoint/genesis-checkpoint-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{16}\.dump\.age$ ]]; then fail 'remote recovery object path is invalid'; fi
fi
mkdir -p -m 0700 "$RECOVERY_STAGING_DIR" "$RECOVERY_STATUS_DIR" "$(dirname "$RECOVERY_RESTORE_LOCK")"
exec 8>"$RECOVERY_RESTORE_LOCK"
flock -n 8 || fail 'another restore-proof run owns the lock'

network="genesis-recovery-net-$run_id"
volume="genesis-recovery-data-$run_id"
postgres="genesis-recovery-pg-$run_id"
api="genesis-recovery-api-$run_id"
dump_file="$RECOVERY_STAGING_DIR/restore-$run_id.dump"
remote_partial="$RECOVERY_STAGING_DIR/restore-$run_id.dump.age.partial"
remote_download="$RECOVERY_STAGING_DIR/restore-$run_id.dump.age"

cleanup() {
  rm -f -- "$dump_file" "$remote_partial" "$remote_download"
  (exact_remove_container "$docker_bin" "$api" "$run_id") || true
  (exact_remove_container "$docker_bin" "$postgres" "$run_id") || true
  (exact_remove_volume "$docker_bin" "$volume" "$run_id") || true
  (exact_remove_network "$docker_bin" "$network" "$run_id") || true
}
on_exit() {
  local code=$?
  set +e
  cleanup
  if [ "$code" -ne 0 ]; then
    write_status "$RECOVERY_STATUS_DIR" restore-status.v1.json restore-proof failed "$run_id" 'isolated restore proof failed closed'
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM
umask 077

$docker_bin run --rm --name "genesis-recovery-manifest-$run_id" --label "$RECOVERY_LABEL_KEY=$run_id" --platform "$RECOVERY_PLATFORM" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=bind,src=$release_dir/release-manifest.json,dst=/recovery/release-manifest.json,readonly" --entrypoint node "$RECOVERY_API_IMAGE" --eval "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync('/recovery/release-manifest.json','utf8'));if(m.contractVersion!=='0.8-MVP-07A.v2'||m.bundleMode!=='committed-release'||m.operational!==true||m.sourceCommit!==process.argv[1])process.exit(1)" "$expected_source_commit"

if [ -n "$remote_object" ]; then
  common_rclone=(--config "$RECOVERY_RCLONE_CONFIG" --retries 3 --low-level-retries 5 --checkers 1 --transfers 1)
  remote_entry=$("$rclone_bin" "${common_rclone[@]}" lsf --files-only --format 'pi' --separator ';' "$remote_object")
  IFS=';' read -r remote_name remote_id <<<"$remote_entry"
  [ "$remote_name" = "${remote_object##*/}" ] && [ "$remote_id" = "$expected_object_id" ] || fail 'remote recovery object identity mismatch'
  "$rclone_bin" "${common_rclone[@]}" copyto "$remote_object" "$remote_partial"
  [ -s "$remote_partial" ] || fail 'remote recovery download is empty'
  mv -- "$remote_partial" "$remote_download"
  ciphertext=$remote_download
else
  require_root_control_file "$ciphertext"
fi

actual_sha=$(sha256sum "$ciphertext" | awk '{print $1}')
[ "$actual_sha" = "$expected_sha" ] || fail 'ciphertext SHA-256 does not match the selected backup'

"$age_bin" --decrypt --identity "$RECOVERY_AGE_IDENTITY_FILE" --output "$dump_file" "$ciphertext"
[ -s "$dump_file" ] || fail 'age decryption produced an empty archive'

"$docker_bin" network create --internal --label "$RECOVERY_LABEL_KEY=$run_id" "$network" >/dev/null
"$docker_bin" volume create --label "$RECOVERY_LABEL_KEY=$run_id" "$volume" >/dev/null
"$docker_bin" run --detach --name "$postgres" --label "$RECOVERY_LABEL_KEY=$run_id" --platform "$RECOVERY_PLATFORM" --network "$network" --group-add "$RECOVERY_CONTAINER_SECRET_GID" --mount "type=volume,src=$volume,dst=/var/lib/postgresql/data" --mount "type=bind,src=$release_dir/docker/postgres/init-runtime-role.sh,dst=/docker-entrypoint-initdb.d/10-production-roles.sh,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/postgres-bootstrap-password,dst=/run/secrets/postgres_bootstrap_password,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/database-migration-password,dst=/run/secrets/database_migration_password,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/database-runtime-password,dst=/run/secrets/database_runtime_password,readonly" --env POSTGRES_DB=genesis_platform --env POSTGRES_USER=genesis_bootstrap --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_bootstrap_password --env DATABASE_MIGRATION_USER=genesis_migration --env DATABASE_RUNTIME_ROLE=genesis_runtime "$RECOVERY_POSTGRES_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if "$docker_bin" exec "$postgres" pg_isready --username genesis_bootstrap --dbname genesis_platform >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail 'isolated PostgreSQL did not become ready'

initialized=0
for _ in $(seq 1 60); do
  if "$docker_bin" logs "$postgres" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.'; then initialized=1; break; fi
  sleep 2
done
[ "$initialized" -eq 1 ] || fail 'isolated PostgreSQL initialization did not complete'
ready=0
for _ in $(seq 1 60); do
  if "$docker_bin" exec "$postgres" pg_isready --username genesis_bootstrap --dbname genesis_platform >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail 'isolated PostgreSQL final server did not become ready'

"$docker_bin" run --rm --name "genesis-recovery-restore-$run_id" --label "$RECOVERY_LABEL_KEY=$run_id" --platform "$RECOVERY_PLATFORM" --network "$network" --group-add "$RECOVERY_CONTAINER_SECRET_GID" --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=bind,src=$dump_file,dst=/recovery/backup.dump,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/restore-bootstrap-pgpass,dst=/run/secrets/restore-pgpass,readonly" --env PGPASSFILE=/run/secrets/restore-pgpass "$RECOVERY_POSTGRES_IMAGE" pg_restore --no-password --exit-on-error --no-owner --role genesis_migration --host "$postgres" --port 5432 --username genesis_bootstrap --dbname genesis_platform /recovery/backup.dump
rm -f -- "$dump_file"

verification_sql="SELECT CASE WHEN to_regclass('public.migrations') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AND pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database()))='genesis_migration' AND pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='public'))='genesis_migration' AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') AND pg_get_userbyid(c.relowner)<>'genesis_migration') AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT has_table_privilege('genesis_runtime',c.oid,'SELECT')) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)) THEN 'verified' ELSE 'invalid' END"
schema_result=$("$docker_bin" run --rm --name "genesis-recovery-verify-$run_id" --label "$RECOVERY_LABEL_KEY=$run_id" --platform "$RECOVERY_PLATFORM" --network "$network" --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/restore-bootstrap-pgpass,dst=/run/secrets/restore-pgpass,readonly" --env PGPASSFILE=/run/secrets/restore-pgpass "$RECOVERY_POSTGRES_IMAGE" psql --no-password --tuples-only --no-align --host "$postgres" --username genesis_bootstrap --dbname genesis_platform --set ON_ERROR_STOP=1 --command "$verification_sql")
[ "$schema_result" = verified ] || fail 'restored ownership, migrations, schema, RLS policies, or ACLs are invalid'

"$docker_bin" run --detach --name "$api" --label "$RECOVERY_LABEL_KEY=$run_id" --platform "$RECOVERY_PLATFORM" --network "$network" --group-add "$RECOVERY_CONTAINER_SECRET_GID" --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --entrypoint /bin/sh --mount "type=bind,src=$release_dir/docker/production/api-entrypoint.sh,dst=/opt/genesis/bin/api-entrypoint.sh,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/database-runtime-password,dst=/run/secrets/database_runtime_password,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/jwt-access-secret,dst=/run/secrets/jwt_access_secret,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/refresh-token-pepper,dst=/run/secrets/refresh_token_pepper,readonly" --mount "type=bind,src=$RECOVERY_RESTORE_SECRETS_DIR/lead-idempotency-keys,dst=/run/secrets/lead_idempotency_keys,readonly" --env NODE_ENV=production --env PORT=3000 --env APP_NAME='Genesis Platform API restore proof' --env APP_VERSION=0.1.0 --env DATABASE_HOST="$postgres" --env DATABASE_PORT=5432 --env DATABASE_NAME=genesis_platform --env DATABASE_USER=genesis_runtime --env DATABASE_RUNTIME_ROLE=genesis_runtime --env FRONTEND_URL=https://genesis.invalid --env TRUST_PROXY_HOPS=1 --env JWT_ACCESS_EXPIRES_IN=15m --env REFRESH_TOKEN_EXPIRES_IN_DAYS=30 --env API_PUBLIC_REPLICA_COUNT=1 --env INVITATION_ISSUANCE_READINESS=false --env INVITATION_ACCEPTANCE_READINESS=false --env INVITATION_ACTIVATION_READINESS=false --env INVITATION_WORKER_ENABLED=false --env LEAD_FORM_READINESS=false --env LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION=1 "$RECOVERY_API_IMAGE" /opt/genesis/bin/api-entrypoint.sh node dist/main.js >/dev/null

api_ready=0
for _ in $(seq 1 60); do
  if "$docker_bin" exec "$api" node -e "Promise.all(['/api/v1/health/live','/api/v1/health/ready'].map(path=>fetch('http://127.0.0.1:3000'+path).then(response=>{if(!response.ok)throw new Error(String(response.status));return response.json()}))).then(values=>process.exit(values.every(value=>value.status==='ok')?0:1)).catch(()=>process.exit(1))"; then api_ready=1; break; fi
  sleep 2
done
[ "$api_ready" -eq 1 ] || fail 'ephemeral API health/readiness smoke failed'

write_status "$RECOVERY_STATUS_DIR" restore-status.v1.json restore-proof passed "$run_id" "$expected_sha:postgresql17:api-readiness"
trap - EXIT INT TERM
cleanup
