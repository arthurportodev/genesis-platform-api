#!/bin/bash
# Prepared executable contract for 0.8-MVP-09E. Do not run without the
# separately recorded human authorization for the immutable digest deployment.

set -Eeuo pipefail
umask 077

if [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ] && [ -n "${GENESIS_09E_TEST_RELEASE_ROOT:-}" ]; then
  GENESIS_RELEASE_ROOT="$GENESIS_09E_TEST_RELEASE_ROOT"
else
  GENESIS_RELEASE_ROOT='/opt/genesis/release'
fi
readonly GENESIS_RELEASE_ROOT
readonly GENESIS_STATE_RELATIVE='deployment-state'
readonly GENESIS_STATE_ROOT="$GENESIS_RELEASE_ROOT/$GENESIS_STATE_RELATIVE"
readonly GENESIS_OVERLAYS_ROOT="$GENESIS_STATE_ROOT/overlays"
readonly GENESIS_POINTER_FILE="$GENESIS_STATE_ROOT/pointers.json"
readonly TARGET_IMAGE='ghcr.io/arthurportodev/genesis-platform-api@sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb'
readonly ROLLBACK_IMAGE='ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a'
readonly TARGET_DIGEST='b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb'
readonly ROLLBACK_DIGEST='a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a'

credential_parent=''
credential_parent_resolved=''
docker_config_dir=''
docker_config_resolved=''
docker_config_device_inode=''
cleanup_effective=0
cleanup_marker=''
raw_evidence_dir=''
cookie_jar=''
deploymentStartedAt=''
observationEndedAt=''
last_sanitized_log=''
target_mutated=0
keep_committed=0
rollback_complete=0
api_restarts_before=''
postgres_id_before=''
traefik_id_before=''
rollback_in_progress=0
rollback_baseline_relative=''
rollback_baseline_image=''
previous_http5xx_total=0
http5xx_breach_streak=0
latency_breach_streak=0
resource_breach_streak=0

fatal() {
  printf 'ERROR: %s\n' "$1" >&2
  return "${2:-1}"
}

canonical_existing_directory() {
  [ -n "${1:-}" ] || return 1
  [ ! -L "$1" ] || return 1
  [ -d "$1" ] || return 1
  realpath -e -- "$1"
}

validate_private_docker_config() {
  local candidate candidate_parent basename current_identity
  candidate="${docker_config_dir:-}"
  [ -n "$candidate" ] || return 1
  case "$candidate" in
    /|/run|"${HOME:-__unset_home__}") return 1 ;;
  esac
  [ ! -L "$candidate" ] || return 1
  [ -d "$candidate" ] || return 1
  candidate="$(canonical_existing_directory "$candidate")" || return 1
  candidate_parent="$(dirname -- "$candidate")"
  basename="$(basename -- "$candidate")"
  [ "$candidate_parent" = "$credential_parent_resolved" ] || return 1
  case "$basename" in genesis-ghcr-09e.[A-Za-z0-9]*) ;; *) return 1 ;; esac
  [ "$candidate" != "$credential_parent_resolved" ] || return 1
  current_identity="$(stat -c '%d:%i' -- "$candidate")" || return 1
  if [ -n "$docker_config_device_inode" ]; then
    [ "$current_identity" = "$docker_config_device_inode" ] || return 1
  fi
  docker_config_resolved="$candidate"
}

create_private_docker_config() {
  local requested_parent
  requested_parent="${GENESIS_09E_CREDENTIAL_PARENT:-/run}"
  if [ "$requested_parent" != /run ] && [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ]; then
    fatal 'credential parent override is test-only'
    return 1
  fi
  credential_parent="$(canonical_existing_directory "$requested_parent")" || return 1
  credential_parent_resolved="$credential_parent"
  if [ -n "${GENESIS_09E_FORCED_CONFIG_PATH:-}" ]; then
    [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ] || return 1
    docker_config_dir="$GENESIS_09E_FORCED_CONFIG_PATH"
  else
    docker_config_dir="$(mktemp -d -- "$credential_parent/genesis-ghcr-09e.XXXXXXXX")" || return 1
  fi
  validate_private_docker_config || return 1
  chmod 0700 -- "$docker_config_resolved"
  docker_config_device_inode="$(stat -c '%d:%i' -- "$docker_config_resolved")"
}

cleanup_registry_auth() {
  local cleanup_status=0
  [ "$cleanup_effective" -eq 0 ] || return 0
  cleanup_effective=1
  if [ -n "${docker_config_dir:-}" ]; then
    if validate_private_docker_config; then
      if [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ] && command -v docker >/dev/null 2>&1; then
        env DOCKER_CONFIG="$docker_config_resolved" docker logout ghcr.io >/dev/null 2>&1 || true
      fi
      rm -rf -- "$docker_config_resolved" || cleanup_status=1
      if [ -e "$docker_config_resolved" ] || [ -L "$docker_config_resolved" ]; then
        cleanup_status=1
      fi
    else
      cleanup_status=1
      printf 'ERROR: refusing unsafe credential cleanup target\n' >&2
    fi
  fi
  docker_config_dir=''
  docker_config_resolved=''
  docker_config_device_inode=''
  if [ -n "${cleanup_marker:-}" ]; then
    printf 'effective-cleanup\n' >> "$cleanup_marker"
  fi
  return "$cleanup_status"
}

cleanup_synthetic_cookie() {
  local cleanup_status=0 resolved
  [ -n "${cookie_jar:-}" ] || return 0
  if [ -z "${raw_evidence_dir:-}" ] || [ -L "$cookie_jar" ]; then
    cleanup_status=1
  elif [ -e "$cookie_jar" ]; then
    resolved="$(realpath -e -- "$cookie_jar")" || cleanup_status=1
    if [ "$cleanup_status" -eq 0 ] && [ "$(dirname -- "$resolved")" = "$raw_evidence_dir" ] &&
      [ "$(basename -- "$resolved")" = 'csrf-cookie.jar' ] && [ -f "$resolved" ]; then
      rm -f -- "$resolved" || cleanup_status=1
    else
      cleanup_status=1
    fi
  fi
  cookie_jar=''
  return "$cleanup_status"
}

cleanup_on_exit() {
  local original_status=$?
  trap - EXIT INT TERM HUP
  if [ "$target_mutated" -eq 1 ] && [ "$keep_committed" -eq 0 ] && [ "$rollback_complete" -eq 0 ]; then
    rollback_09e || original_status=125
  fi
  cleanup_synthetic_cookie || original_status=125
  cleanup_registry_auth || true
  if [ -n "${raw_evidence_dir:-}" ] && [ -d "$raw_evidence_dir" ] && [ ! -L "$raw_evidence_dir" ]; then
    rm -rf -- "$raw_evidence_dir"
  fi
  exit "$original_status"
}

handle_signal() {
  exit "$1"
}

install_cleanup_traps() {
  trap cleanup_on_exit EXIT
  trap 'handle_signal 130' INT
  trap 'handle_signal 143' TERM
  trap 'handle_signal 129' HUP
}

read_registry_token() {
  local supplied=''
  if [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ]; then
    IFS= read -r supplied
  else
    IFS= read -rs -p 'GHCR token: ' supplied </dev/tty
    printf '\n' >/dev/tty
  fi
  [ -n "$supplied" ] || return 1
  printf '%s' "$supplied"
}

credential_phase() {
  local registry_token=''
  # ORDER: create_private_docker_config
  create_private_docker_config
  # ORDER: validate_private_docker_config
  validate_private_docker_config
  # ORDER: install_cleanup_traps
  install_cleanup_traps

  case "${GENESIS_09E_SIMULATION_SCENARIO:-}" in
    fail-before-login) return 41 ;;
  esac

  # ORDER: read_registry_token
  registry_token="$(read_registry_token)"
  if [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ]; then
    printf '{"auths":{"ghcr.io":{"auth":"%s"}}}\n' "$registry_token" > "$docker_config_resolved/config.json"
  else
    # ORDER: docker login
    printf '%s' "$registry_token" | env DOCKER_CONFIG="$docker_config_resolved" \
      docker login ghcr.io -u arthurportodev --password-stdin >/dev/null
  fi
  unset registry_token

  case "${GENESIS_09E_SIMULATION_SCENARIO:-}" in
    fail-after-login) return 42 ;;
    wait-signal)
      printf 'ready\n' > "${GENESIS_09E_READY_FILE:?}"
      while :; do sleep 1; done
      ;;
  esac
}

assert_under_release_root() {
  local resolved
  [ -n "${1:-}" ] || return 1
  case "$1" in /*|*'..'*|*\\*) return 1 ;; esac
  resolved="$(realpath -m -- "$GENESIS_RELEASE_ROOT/$1")"
  case "$resolved" in "$GENESIS_RELEASE_ROOT"/*) ;; *) return 1 ;; esac
  printf '%s\n' "$resolved"
}

validate_existing_directory_nofollow() {
  local candidate="$1" expected_parent="$2" canonical parent
  [ -n "$candidate" ] && [ -n "$expected_parent" ] || return 1
  [ -e "$candidate" ] || [ -L "$candidate" ] || return 2
  [ ! -L "$candidate" ] && [ -d "$candidate" ] || return 1
  canonical="$(realpath -e -- "$candidate")" || return 1
  parent="$(dirname -- "$canonical")"
  [ "$parent" = "$expected_parent" ] || return 1
  [ "$canonical" = "$candidate" ] || return 1
}

ensure_safe_child_directory() {
  local parent="$1" child="$2" mode="$3" status=0
  validate_existing_directory_nofollow "$child" "$parent" || status=$?
  case "$status" in
    0) ;;
    2) install -d -o 0 -g 0 -m "$mode" -- "$child" ;;
    *) return 1 ;;
  esac
  validate_existing_directory_nofollow "$child" "$parent" || return 1
  if [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ]; then
    [ "$(stat -c '%u:%g:%a' -- "$child")" = "0:0:${mode#0}" ] || return 1
  fi
}

prepare_state_directories() {
  local release_parent
  [ -e "$GENESIS_RELEASE_ROOT" ] || return 1
  [ ! -L "$GENESIS_RELEASE_ROOT" ] && [ -d "$GENESIS_RELEASE_ROOT" ] || return 1
  [ "$(realpath -e -- "$GENESIS_RELEASE_ROOT")" = "$GENESIS_RELEASE_ROOT" ] || return 1
  release_parent="$(dirname -- "$GENESIS_RELEASE_ROOT")"
  validate_existing_directory_nofollow "$GENESIS_RELEASE_ROOT" "$release_parent" || return 1
  if [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ] || [ "${GENESIS_09E_ENFORCE_ROOT_METADATA:-0}" = 1 ]; then
    [ "$(stat -c '%u:%g:%a' -- "$GENESIS_RELEASE_ROOT")" = '0:0:755' ] || return 1
  fi
  ensure_safe_child_directory "$GENESIS_RELEASE_ROOT" "$GENESIS_STATE_ROOT" 0755
  ensure_safe_child_directory "$GENESIS_STATE_ROOT" "$GENESIS_OVERLAYS_ROOT" 0755
  ensure_safe_child_directory "$GENESIS_STATE_ROOT" "$GENESIS_STATE_ROOT/evidence" 0700
}

render_overlay() {
  local image="$1" destination="$2"
  case "$image" in
    ghcr.io/arthurportodev/genesis-platform-api@sha256:[a-f0-9][a-f0-9]*) ;;
    *) return 1 ;;
  esac
  printf '{"services":{"api":{"image":"%s"}}}\n' "$image" > "$destination"
  chmod 0644 -- "$destination"
}

publish_overlay_no_replace() {
  local digest="$1" image="$2" destination stage overlay
  destination="$(assert_under_release_root "deployment-state/overlays/$digest")" || return 1
  overlay="$destination/compose.api-image.json"
  if [ -e "$destination" ]; then
    [ ! -L "$destination" ] && [ -d "$destination" ] && [ -f "$overlay" ] && [ ! -L "$overlay" ]
    return 0
  fi
  stage="$(mktemp -d -- "$GENESIS_STATE_ROOT/.staging-${digest}.XXXXXXXX")" || return 1
  [ ! -L "$stage" ] || return 1
  chmod 0700 -- "$stage"
  render_overlay "$image" "$stage/compose.api-image.json"
  chown -R 0:0 -- "$stage"
  chmod 0755 -- "$stage"
  mv -T -- "$stage" "$destination"
}

recover_interrupted_state() {
  local entry
  [ -d "$GENESIS_STATE_ROOT" ] && [ ! -L "$GENESIS_STATE_ROOT" ] || return 1
  while IFS= read -r -d '' entry; do
    [ ! -L "$entry" ] || return 1
    case "$(basename -- "$entry")" in
      .pointers.*) [ -f "$entry" ] || return 1; rm -f -- "$entry" ;;
      .staging-*) [ -d "$entry" ] || return 1; rm -rf -- "$entry" ;;
      *) return 1 ;;
    esac
  done < <(find "$GENESIS_STATE_ROOT" -mindepth 1 -maxdepth 1 \
    \( -name '.pointers.*' -o -name '.staging-*' \) -print0)
  if [ -e "$GENESIS_POINTER_FILE" ]; then
    [ -f "$GENESIS_POINTER_FILE" ] && [ ! -L "$GENESIS_POINTER_FILE" ] || return 1
  fi
}

validate_overlay() {
  local digest="$1" image="$2" directory overlay expected actual
  directory="$(assert_under_release_root "deployment-state/overlays/$digest")" || return 1
  overlay="$directory/compose.api-image.json"
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  [ -f "$overlay" ] && [ ! -L "$overlay" ] || return 1
  [ "$(stat -c '%u:%g:%a' -- "$directory")" = '0:0:755' ] || return 1
  [ "$(stat -c '%u:%g:%a' -- "$overlay")" = '0:0:644' ] || return 1
  expected="$(printf '{"services":{"api":{"image":"%s"}}}\n' "$image" | sha256sum | awk '{print $1}')"
  actual="$(sha256sum -- "$overlay" | awk '{print $1}')"
  [ "$actual" = "$expected" ]
}

validate_pointer_document() {
  local expected_current="$1" expected_previous="$2"
  [ -f "$GENESIS_POINTER_FILE" ] && [ ! -L "$GENESIS_POINTER_FILE" ] || return 1
  python3 - "$GENESIS_POINTER_FILE" "$expected_current" "$expected_previous" <<'PY'
import json, os, stat, sys
path, current, previous = sys.argv[1:]
info = os.lstat(path)
assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
assert stat.S_IMODE(info.st_mode) == 0o644
with open(path, encoding="utf-8") as source:
    value = json.load(source)
assert set(value) == {"schemaVersion", "current", "previous"}
assert value == {"schemaVersion": "1.0.0", "current": current, "previous": previous}
for pointer in (current, previous):
    assert pointer.startswith("deployment-state/overlays/")
    assert ".." not in pointer and not os.path.isabs(pointer)
PY
}

read_pointer_pair() {
  python3 - "$GENESIS_POINTER_FILE" <<'PY'
import json, os, stat, sys
path = sys.argv[1]
info = os.lstat(path)
assert stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)
with open(path, encoding="utf-8") as source:
    value = json.load(source)
assert set(value) == {"schemaVersion", "current", "previous"}
assert value["schemaVersion"] == "1.0.0"
print(value["current"] + "|" + value["previous"])
PY
}

atomic_pointer_update() {
  local current="$1" previous="$2" temporary
  validate_overlay "${current##*/}" "${3:?current image required}" || return 1
  validate_overlay "${previous##*/}" "${4:?previous image required}" || return 1
  temporary="$(mktemp -- "$GENESIS_STATE_ROOT/.pointers.XXXXXXXX")" || return 1
  printf '{"schemaVersion":"1.0.0","current":"%s","previous":"%s"}\n' "$current" "$previous" > "$temporary"
  chown 0:0 -- "$temporary"
  chmod 0644 -- "$temporary"
  if [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ]; then
    mv -Tf -- "$temporary" "$GENESIS_POINTER_FILE"
    [ "$(cat -- "$GENESIS_POINTER_FILE")" = \
      "{\"schemaVersion\":\"1.0.0\",\"current\":\"$current\",\"previous\":\"$previous\"}" ]
    return 0
  fi
  python3 - "$temporary" "$GENESIS_STATE_ROOT" <<'PY'
import os, sys
path, parent = sys.argv[1:]
fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
try: os.fsync(fd)
finally: os.close(fd)
parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try: os.fsync(parent_fd)
finally: os.close(parent_fd)
PY
  mv -Tf -- "$temporary" "$GENESIS_POINTER_FILE"
  python3 - "$GENESIS_STATE_ROOT" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try: os.fsync(fd)
finally: os.close(fd)
PY
  validate_pointer_document "$current" "$previous"
}

sanitize_log_snapshot() {
  local raw="$1" sanitized="$2" interval_start="$3" interval_end="$4"
  awk '
    {
      timestamp=$1
      line=tolower($0)
      severity="other"
      if (line ~ /fatal|unhandled|uncaught/) severity="fatal"
      else if (line ~ /econnrefused|database.*(error|failed|timeout)|connection.*(lost|terminated)/) severity="database-error"
      else if (line ~ /(^|[^0-9])5[0-9][0-9]([^0-9]|$)/) severity="http-5xx"
      if (timestamp ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/ && timestamp >= start && timestamp <= finish) print timestamp "|" severity
    }
  ' start="$interval_start" finish="$interval_end" "$raw" > "$sanitized"
  chmod 0600 -- "$sanitized"
}

shift_utc_nanosecond() {
  local value="$1" direction="$2" second fraction shifted
  case "$value" in
    ????-??-??T??:??:??.?????????Z) ;;
    *) return 1 ;;
  esac
  second="${value%%.*}"
  fraction="${value#*.}"; fraction="${fraction%Z}"
  if [ "$direction" = before ]; then
    if [ "$fraction" -gt 0 ]; then
      fraction=$((10#$fraction - 1))
    else
      second="$(date -u -d "$second UTC - 1 second" +%Y-%m-%dT%H:%M:%S)" || return 1
      fraction=999999999
    fi
  elif [ "$direction" = after ]; then
    if [ "$fraction" -lt 999999999 ]; then
      fraction=$((10#$fraction + 1))
    else
      second="$(date -u -d "$second UTC + 1 second" +%Y-%m-%dT%H:%M:%S)" || return 1
      fraction=0
    fi
  else
    return 1
  fi
  printf '%s.%09dZ\n' "$second" "$fraction"
}

docker_observe() {
  if [ -n "${GENESIS_09E_DOCKER_BIN:-}" ]; then
    [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ] || return 1
    "$GENESIS_09E_DOCKER_BIN" "$@"
  else
    docker "$@"
  fi
}

curl_observe() {
  if [ -n "${GENESIS_09E_CURL_BIN:-}" ]; then
    [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ] || return 1
    "$GENESIS_09E_CURL_BIN" "$@"
  else
    curl "$@"
  fi
}

python_observe() {
  if [ -n "${GENESIS_09E_PYTHON_BIN:-}" ]; then
    [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ] || return 1
    "$GENESIS_09E_PYTHON_BIN" "$@"
  else
    python3 "$@"
  fi
}

collect_cumulative_logs() {
  local label="$1" interval_end="${2:-}" raw sanitized digest captured_at query_since query_until
  [ -n "$deploymentStartedAt" ] || return 1
  captured_at="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  [ -n "$interval_end" ] || interval_end="$captured_at"
  query_since="$(shift_utc_nanosecond "$deploymentStartedAt" before)" || return 1
  query_until="$(shift_utc_nanosecond "$interval_end" after)" || return 1
  raw="$raw_evidence_dir/${label}.raw"
  sanitized="$GENESIS_STATE_ROOT/evidence/${label}.sanitized.log"
  docker_observe logs --timestamps --since "$query_since" --until "$query_until" genesis-api-1 > "$raw" 2>&1 || return 1
  sanitize_log_snapshot "$raw" "$sanitized" "$deploymentStartedAt" "$interval_end"
  digest="$(sha256sum -- "$sanitized" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$(basename -- "$sanitized")" > "$sanitized.sha256"
  chmod 0600 -- "$sanitized.sha256"
  last_sanitized_log="$sanitized"
  printf 'checkpoint=%s deploymentStartedAt=%s capturedAt=%s sha256=%s\n' \
    "$label" "$deploymentStartedAt" "$captured_at" "$digest"
}

evaluate_sanitized_logs() {
  local snapshot="$1" fatal_count db_error_count http5xx_count
  [ -f "$snapshot" ] && [ ! -L "$snapshot" ] || return 1
  fatal_count="$(awk -F '|' '$2 == "fatal" { count++ } END { print count + 0 }' "$snapshot")" || return 1
  db_error_count="$(awk -F '|' '$2 == "database-error" { count++ } END { print count + 0 }' "$snapshot")" || return 1
  http5xx_count="$(awk -F '|' '$2 == "http-5xx" { count++ } END { print count + 0 }' "$snapshot")" || return 1
  [ "$fatal_count" -eq 0 ] || return 1
  [ "$db_error_count" -eq 0 ] || return 1
  [ "$http5xx_count" -ge "$previous_http5xx_total" ] || return 1
  if [ "$http5xx_count" -gt "$previous_http5xx_total" ]; then
    http5xx_breach_streak=$((http5xx_breach_streak + 1))
  else
    http5xx_breach_streak=0
  fi
  previous_http5xx_total="$http5xx_count"
  [ "$http5xx_breach_streak" -lt 2 ] || return 1
  printf 'logs=fatal:%s,database-error:%s,http-5xx:%s,new-5xx-streak:%s\n' \
    "$fatal_count" "$db_error_count" "$http5xx_count" "$http5xx_breach_streak"
}

negative_auth_smoke() {
  local csrf_json='' csrf_token='' auth_status='' status=0
  [ -n "${raw_evidence_dir:-}" ] && [ -d "$raw_evidence_dir" ] && [ ! -L "$raw_evidence_dir" ] || return 1
  cookie_jar="$raw_evidence_dir/csrf-cookie.jar"
  [ ! -e "$cookie_jar" ] && [ ! -L "$cookie_jar" ] || return 1
  csrf_json="$(curl_observe -fsS --max-time 10 -c "$cookie_jar" \
    https://app.agenciagenesismkt.com.br/api/v1/auth/csrf)" || status=1
  if [ "$status" -eq 0 ]; then
    csrf_token="$(printf '%s' "$csrf_json" | python_observe -c \
      'import json,sys; value=json.load(sys.stdin); token=value.get("csrfToken"); assert isinstance(token,str) and token; print(token)')" || status=1
  fi
  if [ "$status" -eq 0 ]; then
    auth_status="$(curl_observe -sS --max-time 10 -o /dev/null -w '%{http_code}' -b "$cookie_jar" \
      -H "X-CSRF-Token: $csrf_token" -H 'Content-Type: application/json' \
      --data '{"email":"mvp09e-invalid@invalid.example","password":"synthetic-invalid-09e"}' \
      https://app.agenciagenesismkt.com.br/api/v1/auth/login)" || status=1
  fi
  [ "$status" -ne 0 ] || [ "$auth_status" = 401 ] || status=1
  unset csrf_json csrf_token auth_status
  cleanup_synthetic_cookie || status=1
  return "$status"
}

reset_observation_streaks() {
  previous_http5xx_total=0
  http5xx_breach_streak=0
  latency_breach_streak=0
  resource_breach_streak=0
}

create_raw_evidence_directory() {
  local parent
  parent="${GENESIS_09E_RAW_PARENT:-/run}"
  if [ "$parent" != /run ] && [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ]; then
    return 1
  fi
  parent="$(canonical_existing_directory "$parent")" || return 1
  raw_evidence_dir="$(mktemp -d -- "$parent/genesis-09e-logs.XXXXXXXX")" || return 1
  [ ! -L "$raw_evidence_dir" ] && [ -d "$raw_evidence_dir" ] || return 1
  [ "$(dirname -- "$(realpath -e -- "$raw_evidence_dir")")" = "$parent" ] || return 1
  chmod 0700 -- "$raw_evidence_dir"
}

compose_base() {
  docker compose --project-directory "$GENESIS_RELEASE_ROOT" --project-name genesis \
    --env-file /opt/genesis/shared/config/production.env \
    --env-file /opt/genesis/shared/config/edge.env \
    -f "$GENESIS_RELEASE_ROOT/compose.production.yml" \
    -f "$GENESIS_RELEASE_ROOT/compose.traefik-public-full.yml" \
    -f "$GENESIS_RELEASE_ROOT/compose.production.functional.yml" "$@"
}

valid_finite_nonnegative_decimal() {
  local value="${1:-}"
  printf '%s\n' "$value" | LC_ALL=C grep -Eq '^[0-9]+([.][0-9]+)?$' || return 1
  LC_ALL=C awk -v value="$value" 'BEGIN {
    numeric=value + 0
    rendered=tolower(sprintf("%.17g", numeric))
    exit (rendered ~ /inf|nan/ || numeric < 0)
  }'
}

checkpoint() {
  # Contract failureAction: rollback-and-block-keep.
  local label="$1" expected_image="$2" interval_end="${3:-}" observed container_image_id ready_status
  local public_probe public_status latency missing_status method_status stats cpu_pct mem_pct resource_breach=0
  export GENESIS_09E_CHECKPOINT_LABEL="$label"
  observed="$(docker_observe inspect --format '{{.Config.Image}}|{{.State.Status}}|{{.State.Health.Status}}|{{.RestartCount}}' genesis-api-1)" || return 1
  [ "$observed" = "$expected_image|running|healthy|$api_restarts_before" ] || return 1
  container_image_id="$(docker_observe inspect --format '{{.Image}}' genesis-api-1)" || return 1
  docker_observe image inspect --format '{{json .RepoDigests}}' "$container_image_id" | grep -F -- "$expected_image" >/dev/null || return 1
  [ "$(docker_observe inspect --format '{{.Id}}' genesis-postgres-1)" = "$postgres_id_before" ] || return 1
  [ "$(docker_observe inspect --format '{{.Id}}' genesis-traefik-1)" = "$traefik_id_before" ] || return 1

  ready_status="$(docker_observe exec genesis-api-1 node -e \
    "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(2))")" || return 1
  [ "$ready_status" = 200 ] || return 1
  public_probe="$(curl_observe -sS --max-time 10 -o /dev/null -w '%{http_code}|%{time_total}' \
    https://api.agenciagenesismkt.com.br/health)" || return 1
  IFS='|' read -r public_status latency <<< "$public_probe"
  [ "$public_probe" = "$public_status|$latency" ] || return 1
  [ "$public_status" = 200 ] || return 1
  valid_finite_nonnegative_decimal "$latency" || return 1
  missing_status="$(curl_observe -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    https://api.agenciagenesismkt.com.br/__genesis_09e_missing)" || return 1
  [ "$missing_status" = 404 ] || return 1
  method_status="$(curl_observe -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
    https://api.agenciagenesismkt.com.br/health)" || return 1
  [ "$method_status" = 404 ] || return 1
  negative_auth_smoke || return 1

  if awk -v value="$latency" 'BEGIN { exit !(value > 2.0) }'; then
    latency_breach_streak=$((latency_breach_streak + 1))
  else
    latency_breach_streak=0
  fi
  [ "$latency_breach_streak" -lt 2 ] || return 1

  stats="$(docker_observe stats --no-stream --format '{{.CPUPerc}}|{{.MemPerc}}' genesis-api-1)" || return 1
  IFS='|' read -r cpu_pct mem_pct <<< "$stats"
  [ "$stats" = "$cpu_pct|$mem_pct" ] || return 1
  case "$cpu_pct|$mem_pct" in
    *%\|*%) ;;
    *) return 1 ;;
  esac
  cpu_pct="${cpu_pct%%%}"
  mem_pct="${mem_pct%%%}"
  valid_finite_nonnegative_decimal "$cpu_pct" || return 1
  valid_finite_nonnegative_decimal "$mem_pct" || return 1
  awk -v value="$cpu_pct" 'BEGIN { exit !(value > 90.0) }' && resource_breach=1
  awk -v value="$mem_pct" 'BEGIN { exit !(value > 85.0) }' && resource_breach=1
  if [ "$resource_breach" -eq 1 ]; then
    resource_breach_streak=$((resource_breach_streak + 1))
  else
    resource_breach_streak=0
  fi
  [ "$resource_breach_streak" -lt 2 ] || return 1

  collect_cumulative_logs "$label" "$interval_end" || return 1
  evaluate_sanitized_logs "$last_sanitized_log" || return 1
  printf 'checkpoint=%s status=PASS latency=%s latency-streak=%s cpu=%s%% memory=%s%% resource-streak=%s\n' \
    "$label" "$latency" "$latency_breach_streak" "$cpu_pct" "$mem_pct" "$resource_breach_streak"
}

rollback_09e() {
  local baseline_digest
  [ "$rollback_in_progress" -eq 0 ] || return 1
  [ -n "$rollback_baseline_relative" ] && [ -n "$rollback_baseline_image" ] || return 1
  baseline_digest="${rollback_baseline_relative##*/}"
  if [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ] || [ "${GENESIS_09E_SIMULATE_POINTER_CYCLE:-0}" = 1 ]; then
    validate_overlay "$baseline_digest" "$rollback_baseline_image" || return 1
  fi
  rollback_in_progress=1
  if [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ]; then
    [ "${GENESIS_09E_FAIL_ROLLBACK_STAGE:-}" != recreate ] || return 1
    if [ "${GENESIS_09E_SIMULATE_CRASH_RECOVERY:-0}" = 1 ]; then
      printf '%s\n' "$rollback_baseline_image" > "${GENESIS_09E_LIVE_IMAGE_FILE:?}"
      printf 'rollback-recreated\n' >> "${GENESIS_09E_RECOVERY_TRACE:?}"
    fi
  elif ! compose_base -f "$GENESIS_RELEASE_ROOT/$rollback_baseline_relative/compose.api-image.json" \
    up -d --no-deps --pull never --wait --wait-timeout 120 api; then
    return 1
  fi
  if [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ]; then
    [ "${GENESIS_09E_FAIL_ROLLBACK_STAGE:-}" != health ] || return 1
    if [ "${GENESIS_09E_SIMULATE_CRASH_RECOVERY:-0}" = 1 ]; then
      [ "$(cat -- "${GENESIS_09E_LIVE_IMAGE_FILE:?}")" = "$rollback_baseline_image" ] || return 1
      printf 'rollback-health-validated\n' >> "${GENESIS_09E_RECOVERY_TRACE:?}"
    fi
  else
    reset_observation_streaks
    if ! checkpoint rollback "$rollback_baseline_image"; then
      return 1
    fi
  fi
  if [ "${GENESIS_09E_TEST_MODE:-0}" = 1 ]; then
    [ "${GENESIS_09E_FAIL_ROLLBACK_STAGE:-}" != pointer ] || return 1
  fi
  if [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ] || [ "${GENESIS_09E_SIMULATE_POINTER_CYCLE:-0}" = 1 ] ||
    [ "${GENESIS_09E_SIMULATE_CRASH_RECOVERY:-0}" = 1 ]; then
    atomic_pointer_update "$rollback_baseline_relative" "deployment-state/overlays/$TARGET_DIGEST" \
      "$rollback_baseline_image" "$TARGET_IMAGE" || return 1
  fi
  rollback_complete=1
  target_mutated=0
  if [ -n "${GENESIS_09E_ROLLBACK_MARKER:-}" ]; then
    printf 'rollback-complete\n' > "$GENESIS_09E_ROLLBACK_MARKER"
  fi
  return 0
}

image_for_overlay_relative() {
  case "$1" in
    "deployment-state/overlays/$TARGET_DIGEST") printf '%s\n' "$TARGET_IMAGE" ;;
    "deployment-state/overlays/$ROLLBACK_DIGEST") printf '%s\n' "$ROLLBACK_IMAGE" ;;
    *) return 1 ;;
  esac
}

validate_pointer_bundles() {
  local pointer_pair="$1" current_relative previous_relative current_image previous_image
  current_relative="${pointer_pair%%|*}"
  previous_relative="${pointer_pair#*|}"
  validate_pointer_document "$current_relative" "$previous_relative" || return 1
  current_image="$(image_for_overlay_relative "$current_relative")" || return 1
  previous_image="$(image_for_overlay_relative "$previous_relative")" || return 1
  validate_overlay "${current_relative##*/}" "$current_image" || return 1
  validate_overlay "${previous_relative##*/}" "$previous_image" || return 1
}

recover_interrupted_activation() {
  local live_image="$1" pointer_pair="$2" current_relative previous_relative
  current_relative="${pointer_pair%%|*}"
  previous_relative="${pointer_pair#*|}"
  [ "$live_image" = "$TARGET_IMAGE" ] || return 2
  [ "$current_relative" = "deployment-state/overlays/$ROLLBACK_DIGEST" ] || return 2
  case "$previous_relative" in
    "deployment-state/overlays/$TARGET_DIGEST"|"deployment-state/overlays/$ROLLBACK_DIGEST") ;;
    *) return 1 ;;
  esac
  validate_pointer_bundles "$pointer_pair" || return 1
  rollback_baseline_relative="$current_relative"
  rollback_baseline_image="$ROLLBACK_IMAGE"
  if [ "${GENESIS_09E_TEST_MODE:-0}" != 1 ]; then
    [ -n "${raw_evidence_dir:-}" ] || create_raw_evidence_directory || return 1
    deploymentStartedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  fi
  reset_observation_streaks
  rollback_complete=0
  target_mutated=1
  rollback_09e || return 1
  rollback_complete=0
  rollback_in_progress=0
  printf 'INTERRUPTED_TARGET_RECOVERED_TO_BASELINE\n'
  return 0
}

bind_rollback_baseline() {
  local live_image="$1" pointer_pair="$2" current_relative current_digest
  current_relative="${pointer_pair%%|*}"
  current_digest="${current_relative##*/}"
  case "$live_image|$current_relative" in
    "$TARGET_IMAGE|deployment-state/overlays/$TARGET_DIGEST"|"$ROLLBACK_IMAGE|deployment-state/overlays/$ROLLBACK_DIGEST") ;;
    *) return 1 ;;
  esac
  validate_overlay "$current_digest" "$live_image" || return 1
  rollback_baseline_relative="$current_relative"
  rollback_baseline_image="$live_image"
}

run_authorized_deployment() {
  local target_relative rollback_relative live_image pointer_pair
  [ "$(id -u)" -eq 0 ] || fatal 'root is required'
  [ "${GENESIS_09E_HUMAN_AUTHORIZATION:-}" = 'AUTHORIZED_B45425D7' ] || fatal 'separate human authorization is absent'
  exec 9>/run/lock/genesis-09e-deployment.lock
  flock -n 9 || fatal 'another deployment operation holds the lock'
  install_cleanup_traps
  prepare_state_directories
  find "$GENESIS_STATE_ROOT" -xdev -type l -print -quit | grep -q . && fatal 'unexpected symlink in deployment state'
  recover_interrupted_state
  publish_overlay_no_replace "$ROLLBACK_DIGEST" "$ROLLBACK_IMAGE"
  publish_overlay_no_replace "$TARGET_DIGEST" "$TARGET_IMAGE"
  validate_overlay "$ROLLBACK_DIGEST" "$ROLLBACK_IMAGE"
  validate_overlay "$TARGET_DIGEST" "$TARGET_IMAGE"
  target_relative="deployment-state/overlays/$TARGET_DIGEST"
  rollback_relative="deployment-state/overlays/$ROLLBACK_DIGEST"

  live_image="$(docker inspect --format '{{.Config.Image}}' genesis-api-1)"
  api_restarts_before="$(docker inspect --format '{{.RestartCount}}' genesis-api-1)"
  postgres_id_before="$(docker inspect --format '{{.Id}}' genesis-postgres-1)"
  traefik_id_before="$(docker inspect --format '{{.Id}}' genesis-traefik-1)"
  docker image inspect "$ROLLBACK_IMAGE" >/dev/null
  [ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$ROLLBACK_IMAGE")" = linux/amd64 ]
  if [ -e "$GENESIS_POINTER_FILE" ]; then
    pointer_pair="$(read_pointer_pair)" || fatal 'pointer document is invalid'
    case "$live_image|$pointer_pair" in
      "$TARGET_IMAGE|$target_relative|$rollback_relative")
        validate_pointer_document "$target_relative" "$rollback_relative"
        [ "$api_restarts_before" = 0 ] || fatal 'kept target restart count is not zero'
        printf 'TARGET_ALREADY_KEPT\n'
        return 0
        ;;
      "$TARGET_IMAGE|$rollback_relative|$target_relative"|"$TARGET_IMAGE|$rollback_relative|$rollback_relative")
        api_restarts_before=0
        recover_interrupted_activation "$live_image" "$pointer_pair" ||
          fatal 'interrupted target activation could not recover its current baseline' 125
        live_image="$(docker inspect --format '{{.Config.Image}}' genesis-api-1)"
        pointer_pair="$(read_pointer_pair)" || fatal 'recovered pointer document is invalid'
        [ "$live_image|$pointer_pair" = "$ROLLBACK_IMAGE|$rollback_relative|$target_relative" ] ||
          fatal 'interrupted target recovery did not converge' 125
        bind_rollback_baseline "$live_image" "$pointer_pair"
        ;;
      "$ROLLBACK_IMAGE|$rollback_relative|$target_relative"|"$ROLLBACK_IMAGE|$rollback_relative|$rollback_relative")
        validate_pointer_document "${pointer_pair%%|*}" "${pointer_pair#*|}"
        [ "$api_restarts_before" = 0 ] || fatal 'baseline restart count is not zero'
        bind_rollback_baseline "$live_image" "$pointer_pair"
        ;;
      *) fatal 'live image and current/previous pointers diverge' ;;
    esac
  else
    [ "$live_image" = "$ROLLBACK_IMAGE" ] || fatal 'pointer initialization requires the rollback live image'
    atomic_pointer_update "$rollback_relative" "$rollback_relative" "$ROLLBACK_IMAGE" "$ROLLBACK_IMAGE"
    pointer_pair="$rollback_relative|$rollback_relative"
    [ "$api_restarts_before" = 0 ] || fatal 'baseline restart count is not zero'
    bind_rollback_baseline "$live_image" "$pointer_pair"
  fi
  curl -fsS --max-time 10 https://api.agenciagenesismkt.com.br/health >/dev/null

  # The registry deletion-administration endpoint is intentionally absent.
  # F-09E-L01: RESOLVED_AS_NON_REQUIRED_CHECK. Manifest, tag, digest and image
  # availability are sufficient and do not require expanded token scopes.

  credential_phase
  export DOCKER_CONFIG="$docker_config_resolved"
  compose_base \
    -f "$GENESIS_RELEASE_ROOT/$target_relative/compose.api-image.json" pull api
  [ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$TARGET_IMAGE")" = linux/amd64 ]
  docker image inspect --format '{{json .RepoDigests}}' "$TARGET_IMAGE" | grep -F -- "$TARGET_IMAGE" >/dev/null
  unset DOCKER_CONFIG
  cleanup_registry_auth
  [ -n "${raw_evidence_dir:-}" ] || create_raw_evidence_directory

  deploymentStartedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  reset_observation_streaks
  rollback_complete=0
  rollback_in_progress=0
  target_mutated=1
  compose_base -f "$GENESIS_RELEASE_ROOT/$target_relative/compose.api-image.json" \
    up -d --no-deps --pull never --wait --wait-timeout 120 api
  checkpoint t-plus-0 "$TARGET_IMAGE"
  sleep 120; checkpoint t-plus-2 "$TARGET_IMAGE"
  sleep 180; checkpoint t-plus-5 "$TARGET_IMAGE"
  sleep 300; checkpoint t-plus-10 "$TARGET_IMAGE"
  sleep 300; checkpoint t-plus-15 "$TARGET_IMAGE"
  observationEndedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  collect_cumulative_logs final "$observationEndedAt"

  atomic_pointer_update "$target_relative" "$rollback_relative" "$TARGET_IMAGE" "$ROLLBACK_IMAGE"
  checkpoint keep "$TARGET_IMAGE"
  keep_committed=1
  target_mutated=0
}

run_cleanup_simulation() {
  [ "$#" -eq 3 ] || fatal 'simulation requires scenario, directory and marker'
  export GENESIS_09E_TEST_MODE=1
  export GENESIS_09E_SIMULATION_SCENARIO="$1"
  export GENESIS_09E_CREDENTIAL_PARENT="$2"
  cleanup_marker="$3"
  credential_phase
}

run_state_preflight_simulation() {
  [ "$#" -eq 1 ] || fatal 'state preflight simulation requires a release root'
  export GENESIS_09E_TEST_MODE=1
  prepare_state_directories
}

run_rollback_failure_simulation() {
  [ "$#" -eq 2 ] || fatal 'rollback simulation requires stage and marker'
  export GENESIS_09E_TEST_MODE=1
  export GENESIS_09E_FAIL_ROLLBACK_STAGE="$1"
  export GENESIS_09E_ROLLBACK_MARKER="$2"
  rollback_baseline_relative="deployment-state/overlays/$ROLLBACK_DIGEST"
  rollback_baseline_image="$ROLLBACK_IMAGE"
  target_mutated=1
  install_cleanup_traps
  return 42
}

run_pointer_cycle_simulation() {
  [ "$#" -eq 2 ] || fatal 'pointer cycle simulation requires root and marker'
  export GENESIS_09E_TEST_MODE=1
  export GENESIS_09E_SIMULATE_POINTER_CYCLE=1
  export GENESIS_09E_ROLLBACK_MARKER="$2"
  prepare_state_directories
  publish_overlay_no_replace "$ROLLBACK_DIGEST" "$ROLLBACK_IMAGE"
  publish_overlay_no_replace "$TARGET_DIGEST" "$TARGET_IMAGE"
  local target_relative="deployment-state/overlays/$TARGET_DIGEST"
  local rollback_relative="deployment-state/overlays/$ROLLBACK_DIGEST"
  atomic_pointer_update "$target_relative" "$rollback_relative" "$TARGET_IMAGE" "$ROLLBACK_IMAGE"
  atomic_pointer_update "$rollback_relative" "$target_relative" "$ROLLBACK_IMAGE" "$TARGET_IMAGE"
  bind_rollback_baseline "$ROLLBACK_IMAGE" "$rollback_relative|$target_relative"
  target_mutated=1
  install_cleanup_traps
  return 42
}

run_crash_state_simulation() {
  [ "$#" -eq 3 ] || fatal 'crash-state simulation requires root, live image file and trace'
  export GENESIS_09E_TEST_MODE=1
  [ "$1" = "$GENESIS_RELEASE_ROOT" ] || return 1
  prepare_state_directories
  publish_overlay_no_replace "$ROLLBACK_DIGEST" "$ROLLBACK_IMAGE"
  publish_overlay_no_replace "$TARGET_DIGEST" "$TARGET_IMAGE"
  local target_relative="deployment-state/overlays/$TARGET_DIGEST"
  local rollback_relative="deployment-state/overlays/$ROLLBACK_DIGEST"
  atomic_pointer_update "$rollback_relative" "$target_relative" "$ROLLBACK_IMAGE" "$TARGET_IMAGE"
  printf '%s\n' "$TARGET_IMAGE" > "$2"
  printf 'target-live-current-baseline\n' >> "$3"
  sync
  kill -KILL "$$"
}

run_crash_recovery_simulation() {
  [ "$#" -eq 3 ] || fatal 'crash recovery simulation requires root, live image file and trace'
  export GENESIS_09E_TEST_MODE=1
  export GENESIS_09E_SIMULATE_CRASH_RECOVERY=1
  export GENESIS_09E_LIVE_IMAGE_FILE="$2"
  export GENESIS_09E_RECOVERY_TRACE="$3"
  [ "$1" = "$GENESIS_RELEASE_ROOT" ] || return 1
  prepare_state_directories
  publish_overlay_no_replace "$ROLLBACK_DIGEST" "$ROLLBACK_IMAGE"
  publish_overlay_no_replace "$TARGET_DIGEST" "$TARGET_IMAGE"
  validate_overlay "$ROLLBACK_DIGEST" "$ROLLBACK_IMAGE"
  validate_overlay "$TARGET_DIGEST" "$TARGET_IMAGE"
  local pointer_pair live_image rollback_relative target_relative
  rollback_relative="deployment-state/overlays/$ROLLBACK_DIGEST"
  target_relative="deployment-state/overlays/$TARGET_DIGEST"
  pointer_pair="$(read_pointer_pair)" || return 1
  live_image="$(cat -- "$GENESIS_09E_LIVE_IMAGE_FILE")" || return 1
  [ "$live_image|$pointer_pair" = "$TARGET_IMAGE|$rollback_relative|$target_relative" ] || return 1
  recover_interrupted_activation "$live_image" "$pointer_pair" || return 1
  [ "$(cat -- "$GENESIS_09E_LIVE_IMAGE_FILE")" = "$ROLLBACK_IMAGE" ] || return 1
  validate_pointer_document "$rollback_relative" "$target_relative" || return 1
  printf 'new-attempt-allowed\n' >> "$GENESIS_09E_RECOVERY_TRACE"
}

run_observation_simulation() {
  [ "$#" -eq 4 ] || fatal 'observation simulation requires root, scenario, rollback marker and keep marker'
  export GENESIS_09E_TEST_MODE=1
  export GENESIS_09E_OBSERVATION_SCENARIO="$2"
  export GENESIS_09E_ROLLBACK_MARKER="$3"
  [ "$1" = "$GENESIS_RELEASE_ROOT" ] || return 1
  raw_evidence_dir="$1/raw"
  [ -d "$raw_evidence_dir" ] && [ -d "$GENESIS_STATE_ROOT/evidence" ] || return 1
  deploymentStartedAt='2026-08-20T20:00:00.000000000Z'
  api_restarts_before=0
  postgres_id_before='postgres-stable-id'
  traefik_id_before='traefik-stable-id'
  rollback_baseline_relative="deployment-state/overlays/$ROLLBACK_DIGEST"
  rollback_baseline_image="$ROLLBACK_IMAGE"
  reset_observation_streaks
  rollback_complete=0
  target_mutated=1
  install_cleanup_traps
  checkpoint t-plus-0 "$TARGET_IMAGE" '2026-08-20T20:00:00.000000000Z'
  checkpoint t-plus-2 "$TARGET_IMAGE" '2026-08-20T20:02:00.000000000Z'
  checkpoint t-plus-5 "$TARGET_IMAGE" '2026-08-20T20:05:00.000000000Z'
  checkpoint t-plus-10 "$TARGET_IMAGE" '2026-08-20T20:10:00.000000000Z'
  checkpoint t-plus-15 "$TARGET_IMAGE" '2026-08-20T20:15:00.000000000Z'
  printf 'keep-allowed\n' > "$4"
  keep_committed=1
  target_mutated=0
}

run_raw_cleanup_simulation() {
  [ "$#" -eq 2 ] || fatal 'raw cleanup simulation requires scenario and parent'
  export GENESIS_09E_TEST_MODE=1
  export GENESIS_09E_RAW_PARENT="$2"
  install_cleanup_traps
  case "$1" in
    no-op) return 0 ;;
    fail-pre-credential) return 43 ;;
    fail-after-create) create_raw_evidence_directory; return 44 ;;
    *) return 64 ;;
  esac
}

run_log_collection_simulation() {
  [ "$#" -eq 4 ] || fatal 'log simulation requires root, start, end and label'
  export GENESIS_09E_TEST_MODE=1
  deploymentStartedAt="$2"
  observationEndedAt="$3"
  raw_evidence_dir="$1/raw"
  [ -d "$raw_evidence_dir" ] && [ -d "$GENESIS_STATE_ROOT/evidence" ] || return 1
  collect_cumulative_logs "$4" "$observationEndedAt"
}

run_log_sanitizer_simulation() {
  [ "$#" -eq 4 ] || fatal 'log sanitizer simulation requires raw, sanitized, start and end'
  export GENESIS_09E_TEST_MODE=1
  sanitize_log_snapshot "$1" "$2" "$3" "$4"
}

case "${1:-}" in
  --execute)
    run_authorized_deployment
    ;;
  --simulate-credential-cleanup)
    shift
    run_cleanup_simulation "$@"
    ;;
  --simulate-state-preflight)
    shift
    run_state_preflight_simulation "$@"
    ;;
  --simulate-rollback-failure)
    shift
    run_rollback_failure_simulation "$@"
    ;;
  --simulate-pointer-cycle)
    shift
    run_pointer_cycle_simulation "$@"
    ;;
  --simulate-crash-state)
    shift
    run_crash_state_simulation "$@"
    ;;
  --simulate-crash-recovery)
    shift
    run_crash_recovery_simulation "$@"
    ;;
  --simulate-observation)
    shift
    run_observation_simulation "$@"
    ;;
  --simulate-raw-cleanup)
    shift
    run_raw_cleanup_simulation "$@"
    ;;
  --simulate-log-collection)
    shift
    run_log_collection_simulation "$@"
    ;;
  --simulate-log-sanitizer)
    shift
    run_log_sanitizer_simulation "$@"
    ;;
  *)
    printf 'Prepared only. Usage after separate approval: %s --execute\n' "$0" >&2
    exit 64
    ;;
esac
