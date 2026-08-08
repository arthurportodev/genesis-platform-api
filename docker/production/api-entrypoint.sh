#!/bin/sh
set -eu

read_secret() {
  secret_path=$1
  secret_label=$2
  if [ ! -f "$secret_path" ]; then
    echo "$secret_label file is missing." >&2
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
    echo "$secret_label is empty." >&2
    exit 1
  fi
}

read_secret /run/secrets/database_runtime_password 'runtime database password'
export DATABASE_PASSWORD=$secret_value
read_secret /run/secrets/jwt_access_secret 'JWT access secret'
export JWT_ACCESS_SECRET=$secret_value
read_secret /run/secrets/refresh_token_pepper 'refresh-token pepper'
export REFRESH_TOKEN_PEPPER=$secret_value
read_secret /run/secrets/lead_idempotency_keys 'Lead idempotency keyring'
export LEAD_IDEMPOTENCY_KEYS=$secret_value
unset secret_path secret_label secret_value secret_with_sentinel

if [ "$#" -eq 0 ]; then
  echo 'API command is missing.' >&2
  exit 1
fi
exec "$@"
