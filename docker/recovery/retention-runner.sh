#!/bin/bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
. "$script_dir/common.sh"

environment_file='/opt/genesis/recovery/recovery.env'
category=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) environment_file=${2:-}; shift 2 ;;
    --category) category=${2:-}; shift 2 ;;
    *) fail "unknown retention argument: $1" ;;
  esac
done
case "$category" in regular|checkpoint) ;; *) fail 'retention category must be regular or checkpoint' ;; esac
require_root_control_file "$environment_file"
# shellcheck disable=SC1090
. "$environment_file"
rclone_bin=${RECOVERY_RCLONE_BIN:-$RECOVERY_BIN_DIR/rclone}
if [ "${RECOVERY_TEST_MODE:-0}" != '1' ] && [ "$rclone_bin" != "$RECOVERY_BIN_DIR/rclone" ]; then
  fail 'rclone override is test-only'
fi
require_root_control_file "$rclone_bin"
require_secret_file "$RECOVERY_RCLONE_CONFIG"

retention_days=30
[ "$category" = checkpoint ] && retention_days=90
remote_dir="$RECOVERY_RCLONE_REMOTE:$RECOVERY_REMOTE_ROOT/$category"
common_rclone=(--config "$RECOVERY_RCLONE_CONFIG" --retries 3 --low-level-retries 5 --drive-use-trash=true)
mapfile -t markers < <("$rclone_bin" "${common_rclone[@]}" lsf --files-only --format 'tspi' --separator ';' --include 'genesis-*.dump.age.verified.json' "$remote_dir" | sort -r)
[ "${#markers[@]}" -ge 2 ] || exit 0
now=$(date -u +%s)

for index in "${!markers[@]}"; do
  IFS=';' read -r modified size marker_path marker_id <<<"${markers[$index]}"
  [[ "$marker_path" =~ ^genesis-(regular|checkpoint)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{16}\.dump\.age\.verified\.json$ ]] || fail 'retention marker path is invalid'
  [ -n "$marker_id" ] || fail 'retention marker object ID is unavailable'
  modified_epoch=$(date -u -d "$modified" +%s)
  age_seconds=$((now - modified_epoch))
  [ "$age_seconds" -ge $((retention_days * 86400)) ] || continue
  cipher_path=${marker_path%.verified.json}

  current_marker=$("$rclone_bin" "${common_rclone[@]}" lsf --files-only --format 'pi' --separator ';' "$remote_dir/$marker_path")
  IFS=';' read -r current_marker_path current_marker_id <<<"$current_marker"
  [ "$current_marker_path" = "$marker_path" ] && [ "$current_marker_id" = "$marker_id" ] || fail 'retention marker identity changed'
  current_cipher=$("$rclone_bin" "${common_rclone[@]}" lsf --files-only --format 'pi' --separator ';' "$remote_dir/$cipher_path")
  IFS=';' read -r current_cipher_path current_cipher_id <<<"$current_cipher"
  [ "$current_cipher_path" = "$cipher_path" ] && [ -n "$current_cipher_id" ] || fail 'retention ciphertext identity is unavailable'
  [[ "$current_cipher_id" =~ ^[A-Za-z0-9_-]+$ ]] || fail 'retention ciphertext object ID is invalid'
  marker_json=$("$rclone_bin" "${common_rclone[@]}" cat --count 4096 "$remote_dir/$marker_path")
  expected_object_path="$RECOVERY_REMOTE_ROOT/$category/$cipher_path"
  [[ "$marker_json" == *"\"objectPath\":\"$expected_object_path\""* ]] || fail 'retention marker path binding mismatch'
  [[ "$marker_json" == *"\"objectId\":\"$current_cipher_id\""* ]] || fail 'retention marker object ID binding mismatch'
  [ "$index" -ge 2 ] || continue

  "$rclone_bin" "${common_rclone[@]}" deletefile "$remote_dir/$marker_path"
  "$rclone_bin" "${common_rclone[@]}" deletefile "$remote_dir/$cipher_path"
done
