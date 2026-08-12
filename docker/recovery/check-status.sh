#!/bin/bash
set -Eeuo pipefail

status_file='/var/lib/genesis/recovery/status/backup-status.v1.json'
warning_hours=18
critical_hours=24
while [ "$#" -gt 0 ]; do
  case "$1" in
    --status-file) status_file=${2:-}; shift 2 ;;
    --warning-hours) warning_hours=${2:-}; shift 2 ;;
    --critical-hours) critical_hours=${2:-}; shift 2 ;;
    *) echo "unknown check-status argument: $1" >&2; exit 3 ;;
  esac
done
[ -f "$status_file" ] || { printf '{"state":"critical","reason":"missing-status"}\n'; exit 2; }
observed=$(sed -n 's/.*"observedAt":"\([^"]*\)".*/\1/p' "$status_file")
outcome=$(sed -n 's/.*"outcome":"\([^"]*\)".*/\1/p' "$status_file")
[ "$outcome" = passed ] || { printf '{"state":"critical","reason":"last-run-failed"}\n'; exit 2; }
observed_epoch=$(date -u -d "$observed" +%s) || { printf '{"state":"critical","reason":"invalid-status"}\n'; exit 2; }
age_seconds=$(($(date -u +%s) - observed_epoch))
if [ "$age_seconds" -ge $((critical_hours * 3600)) ]; then
  printf '{"state":"critical","ageSeconds":%s}\n' "$age_seconds"; exit 2
fi
if [ "$age_seconds" -ge $((warning_hours * 3600)) ]; then
  printf '{"state":"warning","ageSeconds":%s}\n' "$age_seconds"; exit 1
fi
printf '{"state":"ok","ageSeconds":%s}\n' "$age_seconds"
