#!/bin/bash
set -Eeuo pipefail

RECOVERY_POSTGRES_IMAGE='postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'
RECOVERY_API_IMAGE='ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659'
RECOVERY_PLATFORM='linux/amd64'
RECOVERY_LABEL_KEY='com.genesis.recovery.run'

fail() {
  printf 'recovery: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_regular_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || fail "required regular file is unavailable: $1"
}

require_root_control_file() {
  require_regular_file "$1"
  [ "$(stat -c '%u' "$1")" = 0 ] || fail "control file must be owned by root: $1"
  local permissions
  permissions=$(stat -c '%a' "$1")
  (( (8#$permissions & 8#022) == 0 )) || fail "control file must not be group/world writable: $1"
}

require_secret_file() {
  require_root_control_file "$1"
  local permissions group_id expected_group_id
  permissions=$(stat -c '%a' "$1")
  case "$permissions" in
    400|600) ;;
    440|640)
      group_id=$(stat -c '%g' "$1")
      expected_group_id=${RECOVERY_CONTAINER_SECRET_GID:-70}
      [ "$group_id" = "$expected_group_id" ] || fail "group-readable secret has an unexpected group: $1"
      ;;
    *) fail "secret file permissions must be 0400, 0440, 0600 or 0640: $1" ;;
  esac
}

validate_run_id() {
  [[ "$1" =~ ^[a-f0-9]{16}$ ]] || fail 'run ID must contain exactly 16 lowercase hexadecimal characters'
}

new_run_id() {
  od -An -N8 -tx1 /dev/urandom | tr -d ' \n'
}

atomic_write() {
  local target=$1
  local partial="${target}.partial"
  umask 077
  cat >"$partial"
  sync "$partial"
  mv -f -- "$partial" "$target"
}

json_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  printf '%s' "$value"
}

write_status() {
  local status_dir=$1
  local filename=$2
  local operation=$3
  local outcome=$4
  local run_id=$5
  local detail=$6
  mkdir -p -m 0700 "$status_dir"
  printf '{"contractVersion":"0.8-MVP-07A.status.v1","operation":"%s","outcome":"%s","runId":"%s","observedAt":"%s","detail":"%s"}\n' \
    "$operation" "$outcome" "$run_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "$detail")" |
    atomic_write "$status_dir/$filename"
}

assert_recovery_resource() {
  local docker_bin=$1
  local resource_type=$2
  local resource_name=$3
  local run_id=$4
  local prefix
  case "$resource_type" in
    container) prefix='genesis-recovery-' ;;
    network) prefix='genesis-recovery-net-' ;;
    volume) prefix='genesis-recovery-data-' ;;
    *) fail "unsupported recovery resource type: $resource_type" ;;
  esac
  [[ "$resource_name" == "$prefix"* ]] || fail "refusing cleanup outside recovery prefix: $resource_name"
  local label format
  format="{{ index .Labels \"$RECOVERY_LABEL_KEY\" }}"
  [ "$resource_type" != container ] || format="{{ index .Config.Labels \"$RECOVERY_LABEL_KEY\" }}"
  label=$($docker_bin inspect --type "$resource_type" --format "$format" "$resource_name" 2>/dev/null) ||
    fail "cannot verify recovery resource ownership: $resource_name"
  [ "$label" = "$run_id" ] || fail "recovery resource label mismatch: $resource_name"
}

exact_remove_container() {
  local docker_bin=$1 name=$2 run_id=$3
  if $docker_bin container inspect "$name" >/dev/null 2>&1; then
    assert_recovery_resource "$docker_bin" container "$name" "$run_id"
    $docker_bin rm -f -- "$name" >/dev/null
  fi
}

exact_remove_network() {
  local docker_bin=$1 name=$2 run_id=$3
  if $docker_bin network inspect "$name" >/dev/null 2>&1; then
    assert_recovery_resource "$docker_bin" network "$name" "$run_id"
    $docker_bin network rm -- "$name" >/dev/null
  fi
}

exact_remove_volume() {
  local docker_bin=$1 name=$2 run_id=$3
  [ "$name" != 'genesis-postgres-data' ] || fail 'active production volume is denied'
  if $docker_bin volume inspect "$name" >/dev/null 2>&1; then
    assert_recovery_resource "$docker_bin" volume "$name" "$run_id"
    $docker_bin volume rm -- "$name" >/dev/null
  fi
}
