#!/bin/sh
set -eu

BOOTSTRAP_PASSWORD_PATH=/run/secrets/postgres_bootstrap_password
MIGRATION_PASSWORD_PATH=/run/secrets/database_migration_password
RUNTIME_PASSWORD_PATH=/run/secrets/database_runtime_password

validate_role_name() {
  role_name=$1
  role_label=$2
  case "$role_name" in
    ''|*[!a-z0-9_]*|[0-9]*)
      echo "$role_label is not a safe PostgreSQL role name." >&2
      exit 1
      ;;
  esac
  if [ "${#role_name}" -gt 63 ]; then
    echo "$role_label exceeds PostgreSQL's identifier limit." >&2
    exit 1
  fi
}

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

validate_role_name "$POSTGRES_USER" POSTGRES_USER
validate_role_name "$DATABASE_MIGRATION_USER" DATABASE_MIGRATION_USER
validate_role_name "$DATABASE_RUNTIME_ROLE" DATABASE_RUNTIME_ROLE
validate_role_name "$POSTGRES_DB" POSTGRES_DB

if [ "$POSTGRES_USER" = "$DATABASE_MIGRATION_USER" ] ||
  [ "$POSTGRES_USER" = "$DATABASE_RUNTIME_ROLE" ] ||
  [ "$DATABASE_MIGRATION_USER" = "$DATABASE_RUNTIME_ROLE" ]; then
  echo 'Bootstrap, migration and runtime roles must be distinct.' >&2
  exit 1
fi

read_secret "$BOOTSTRAP_PASSWORD_PATH" 'bootstrap password'
bootstrap_password=$secret_value
read_secret "$MIGRATION_PASSWORD_PATH" 'migration password'
migration_password=$secret_value
read_secret "$RUNTIME_PASSWORD_PATH" 'runtime password'
runtime_password=$secret_value
unset secret_value secret_with_sentinel

if [ "${POSTGRES_PASSWORD:-}" != "$bootstrap_password" ]; then
  echo 'Bootstrap password file does not match the official image environment.' >&2
  exit 1
fi
unset bootstrap_password

unexpected_roles=$(psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
  --command "SELECT count(*) FROM pg_roles WHERE rolname IN ('$DATABASE_MIGRATION_USER', '$DATABASE_RUNTIME_ROLE')")
if [ "$unexpected_roles" != '0' ]; then
  echo 'Migration or runtime role already exists during first-volume initialization.' >&2
  exit 1
fi

export GENESIS_MIGRATION_PASSWORD=$migration_password
export GENESIS_RUNTIME_PASSWORD=$runtime_password
unset migration_password runtime_password
trap 'unset GENESIS_MIGRATION_PASSWORD GENESIS_RUNTIME_PASSWORD' EXIT

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set bootstrap_role="$POSTGRES_USER" \
  --set migration_role="$DATABASE_MIGRATION_USER" \
  --set runtime_role="$DATABASE_RUNTIME_ROLE" \
  --set database_name="$POSTGRES_DB" <<'SQL'
\getenv migration_password GENESIS_MIGRATION_PASSWORD
\getenv runtime_password GENESIS_RUNTIME_PASSWORD

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'migration_role', :'migration_password'
) \gexec
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'runtime_role', :'runtime_password'
) \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'database_name', :'migration_role') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migration_role') \gexec
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', :'database_name') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO %I', :'database_name', :'migration_role') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migration_role') \gexec
SQL

unset GENESIS_MIGRATION_PASSWORD GENESIS_RUNTIME_PASSWORD
trap - EXIT

role_contract=$(psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
  --command "SELECT count(*) FROM pg_roles WHERE (rolname = '$DATABASE_MIGRATION_USER' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls) OR (rolname = '$DATABASE_RUNTIME_ROLE' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls)")
if [ "$role_contract" != '2' ]; then
  echo 'Production role attributes did not converge.' >&2
  exit 1
fi

membership_contract=$(psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
  --command "SELECT count(*) FROM pg_auth_members memberships JOIN pg_roles granted ON granted.oid = memberships.roleid JOIN pg_roles member_role ON member_role.oid = memberships.member WHERE granted.rolname IN ('$POSTGRES_USER', '$DATABASE_MIGRATION_USER', '$DATABASE_RUNTIME_ROLE') OR member_role.rolname IN ('$POSTGRES_USER', '$DATABASE_MIGRATION_USER', '$DATABASE_RUNTIME_ROLE')")
if [ "$membership_contract" != '0' ]; then
  echo 'Unexpected membership involving production roles.' >&2
  exit 1
fi

ownership_contract=$(psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
  --command "SELECT (SELECT pg_get_userbyid(datdba) = '$DATABASE_MIGRATION_USER' FROM pg_database WHERE datname = '$POSTGRES_DB') AND (SELECT pg_get_userbyid(nspowner) = '$DATABASE_MIGRATION_USER' FROM pg_namespace WHERE nspname = 'public')")
if [ "$ownership_contract" != 't' ]; then
  echo 'Migration ownership did not converge.' >&2
  exit 1
fi
