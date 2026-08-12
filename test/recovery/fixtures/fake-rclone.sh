#!/bin/bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_RCLONE_LOG"
args=("$@")
command=''
command_index=-1
for index in "${!args[@]}"; do
  case "${args[$index]}" in copyto|lsf|cat|deletefile) command=${args[$index]}; command_index=$index; break ;; esac
done
[ "$command_index" -ge 0 ] || exit 64
remote_to_path() {
  local value=$1
  case "$value" in fake:*) printf '%s/%s' "$FAKE_DRIVE_ROOT" "${value#fake:}" ;; *) printf '%s' "$value" ;; esac
}
object_id() { sha256sum <<<"$1" | awk '{print substr($1,1,24)}'; }
case "$command" in
  copyto)
    source_value=${args[$((command_index + 1))]}
    target_value=${args[$((command_index + 2))]}
    source_path=$(remote_to_path "$source_value")
    target_path=$(remote_to_path "$target_value")
    if [ "${FAKE_RCLONE_SIMULATE_RETRY:-0}" = 1 ] && [ ! -e "$FAKE_RCLONE_STATE/retry-observed" ]; then
      mkdir -p "$FAKE_RCLONE_STATE"
      printf 'transient failure retried internally\n' >>"$FAKE_RCLONE_LOG"
      touch "$FAKE_RCLONE_STATE/retry-observed"
    fi
    if [[ " $* " == *' --immutable '* ]] && [ -e "$target_path" ]; then exit 9; fi
    mkdir -p "$(dirname "$target_path")"
    cp -- "$source_path" "$target_path"
    ;;
  lsf)
    target_value=${args[-1]}
    target_path=$(remote_to_path "$target_value")
    format='p'
    for index in "${!args[@]}"; do [ "${args[$index]}" = '--format' ] && format=${args[$((index + 1))]}; done
    emit() {
      local path=$1 base size timestamp id
      base=$(basename "$path"); size=$(stat -c '%s' "$path"); timestamp=$(date -u -r "$path" +%Y-%m-%dT%H:%M:%SZ); id=$(object_id "$path")
      if [ "${FAKE_RCLONE_ID_DRIFT:-0}" = 1 ] && [ -e "$FAKE_RCLONE_STATE/directory-listed" ] && [ -f "$target_path" ]; then id="drift-$id"; fi
      case "$format" in
        hspi) printf '%s;%s;%s;%s\n' "$(sha256sum "$path" | awk '{print $1}')" "$size" "$base" "$id" ;;
        spi) printf '%s;%s;%s\n' "$size" "$base" "$id" ;;
        pi) printf '%s;%s\n' "$base" "$id" ;;
        tspi) printf '%s;%s;%s;%s\n' "$timestamp" "$size" "$base" "$id" ;;
        *) printf '%s\n' "$base" ;;
      esac
    }
    if [ -f "$target_path" ]; then emit "$target_path"; else
      mkdir -p "$FAKE_RCLONE_STATE"
      touch "$FAKE_RCLONE_STATE/directory-listed"
      shopt -s nullglob
      for path in "$target_path"/*.verified.json; do emit "$path"; done
    fi
    ;;
  cat)
    target_value=${args[-1]}
    target_path=$(remote_to_path "$target_value")
    cat "$target_path"
    ;;
  deletefile)
    target_value=${args[$((command_index + 1))]}
    target_path=$(remote_to_path "$target_value")
    mkdir -p "$FAKE_DRIVE_TRASH"
    mv -- "$target_path" "$FAKE_DRIVE_TRASH/$(basename "$target_path")"
    ;;
esac
