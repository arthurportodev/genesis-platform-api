#!/bin/sh
set -eu

config_name=${TRAEFIK_STATIC_CONFIG:-traefik-internal.yml}
static_root=/etc/traefik/static
source_dynamic_root=/etc/traefik/dynamic
runtime_dynamic_root=/run/traefik/dynamic

mkdir -p "$runtime_dynamic_root"
cp "$source_dynamic_root/api-health-only.yml" "$runtime_dynamic_root/api-health-only.yml"
chmod 0600 "$runtime_dynamic_root/api-health-only.yml"

origin_key_file=${ORIGIN_PROXY_KEY_FILE:-}
if [ -n "$origin_key_file" ]; then
  if [ ! -f "$origin_key_file" ] || [ -L "$origin_key_file" ]; then
    echo 'Origin proxy key file is unavailable or irregular.' >&2
    exit 64
  fi
  origin_key=$(cat "$origin_key_file")
  case "$origin_key" in
    '' | *[!A-Za-z0-9_-]*)
      echo 'Origin proxy key format is invalid.' >&2
      exit 64
      ;;
  esac
  if [ "${#origin_key}" -lt 43 ] || [ "${#origin_key}" -gt 128 ]; then
    echo 'Origin proxy key length is invalid.' >&2
    exit 64
  fi

  functional="$runtime_dynamic_root/api-functional.yml"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *__ORIGIN_PROXY_KEY__*)
        prefix=${line%%__ORIGIN_PROXY_KEY__*}
        suffix=${line#*__ORIGIN_PROXY_KEY__}
        printf '%s%s%s\n' "$prefix" "$origin_key" "$suffix"
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$source_dynamic_root/api-functional.template.yml" >"$functional"
  unset origin_key prefix suffix line
  if grep -q '__ORIGIN_PROXY_KEY__' "$functional"; then
    echo 'Functional Traefik configuration rendering failed.' >&2
    exit 70
  fi
  chmod 0600 "$functional"
fi

case "$config_name" in
  traefik-internal.yml)
    exec /entrypoint.sh --configFile="$static_root/$config_name"
    ;;
  traefik-acme-staging.yml | traefik-acme-production.yml)
    ;;
  *)
    echo 'Unsupported Traefik static configuration.' >&2
    exit 64
    ;;
esac

acme_email=${ACME_EMAIL:-}
case "$acme_email" in
  '' | *[!A-Za-z0-9._%+@-]* | *@*@* | @* | *@ | *..*)
    echo 'ACME_EMAIL must be one safe non-secret email address.' >&2
    exit 64
    ;;
esac
case "$acme_email" in
  *@*.*) ;;
  *)
    echo 'ACME_EMAIL must be one safe non-secret email address.' >&2
    exit 64
    ;;
esac

rendered=/run/traefik/traefik.yml
sed "s|__ACME_EMAIL__|$acme_email|g" "$static_root/$config_name" >"$rendered"
if grep -q '__ACME_EMAIL__' "$rendered"; then
  echo 'Traefik static configuration rendering failed.' >&2
  exit 70
fi
chmod 0600 "$rendered"
exec /entrypoint.sh --configFile="$rendered"
