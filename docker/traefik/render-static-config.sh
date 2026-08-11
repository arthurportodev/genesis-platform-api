#!/bin/sh
set -eu

config_name=${TRAEFIK_STATIC_CONFIG:-traefik-internal.yml}
static_root=/etc/traefik/static

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
