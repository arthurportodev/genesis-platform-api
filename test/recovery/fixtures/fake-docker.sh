#!/bin/bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  *' psql '*) printf '%s\n' "${FAKE_DOCKER_RLS_RESULT:-complete}" ;;
  *' pg_dump '*) printf 'PGDMP synthetic fixture\n' ;;
  *) exit 1 ;;
esac
