#!/bin/sh
set -eu

secret_path=/run/secrets/database_migration_password
if [ ! -f "$secret_path" ]; then
  echo 'Required migration secret file is missing.' >&2
  exit 1
fi
secret_with_sentinel=$(cat "$secret_path"; printf x)
secret_value=${secret_with_sentinel%x}
case "$secret_value" in
  *"
") secret_value=${secret_value%"
"} ;;
esac
if [ -z "$secret_value" ]; then
  echo 'Required migration secret is empty.' >&2
  exit 1
fi
export DATABASE_MIGRATION_PASSWORD=$secret_value
unset secret_path secret_value secret_with_sentinel

if [ "$#" -eq 0 ]; then
  echo 'Migration command is missing.' >&2
  exit 1
fi
exec "$@"
