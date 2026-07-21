#!/bin/sh
set -eu

case "${DATABASE_RUNTIME_ROLE}" in
  ''|*[!a-z0-9_]*|[0-9]*)
    echo "DATABASE_RUNTIME_ROLE is not a safe PostgreSQL role name." >&2
    exit 1
    ;;
esac

if [ "${#DATABASE_RUNTIME_ROLE}" -gt 63 ]; then
  echo "DATABASE_RUNTIME_ROLE exceeds PostgreSQL's identifier limit." >&2
  exit 1
fi

if [ "${DATABASE_RUNTIME_ROLE}" = "${POSTGRES_USER}" ]; then
  echo "Runtime and migration owner roles must be distinct." >&2
  exit 1
fi

psql --set ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  --set runtime_role="${DATABASE_RUNTIME_ROLE}" \
  --set runtime_password="${DATABASE_RUNTIME_PASSWORD}" <<-'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'runtime_role', :'runtime_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role'
) \gexec
SQL
