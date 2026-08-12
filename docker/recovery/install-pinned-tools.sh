#!/bin/bash
set -Eeuo pipefail

destination='/opt/genesis/recovery/bin'
if [ "${1:-}" = '--destination' ]; then
  destination=${2:-}
  [ -n "$destination" ] || { echo 'destination is required' >&2; exit 1; }
  shift 2
fi
[ "$#" -eq 0 ] || { echo 'unknown install-pinned-tools argument' >&2; exit 1; }

case "$destination" in
  /opt/genesis/recovery/bin|/tmp/genesis-recovery-tools-*) ;;
  *) echo 'destination is outside the recovery prefix' >&2; exit 1 ;;
esac

require_command() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require_command curl
require_command sha256sum
require_command tar
require_command unzip

age_version='1.3.1'
age_archive="age-v${age_version}-linux-amd64.tar.gz"
age_url="https://github.com/FiloSottile/age/releases/download/v${age_version}/${age_archive}"
age_sha='bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377'
rclone_version='1.74.4'
rclone_archive="rclone-v${rclone_version}-linux-amd64.zip"
rclone_url="https://downloads.rclone.org/v${rclone_version}/${rclone_archive}"
rclone_sha='fe435e0c36228e7c2f116a8701f01127bb1f694005fc11d1f27186c8bca4115d'

temporary=$(mktemp -d /tmp/genesis-recovery-tools.XXXXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
umask 077

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$temporary/$age_archive" "$age_url"
printf '%s  %s\n' "$age_sha" "$temporary/$age_archive" | sha256sum --check --strict
tar -xzf "$temporary/$age_archive" -C "$temporary"

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$temporary/$rclone_archive" "$rclone_url"
printf '%s  %s\n' "$rclone_sha" "$temporary/$rclone_archive" | sha256sum --check --strict
unzip -q "$temporary/$rclone_archive" -d "$temporary"

install -d -m 0755 "$destination"
install -m 0755 "$temporary/age/age" "$destination/age"
install -m 0755 "$temporary/age/age-keygen" "$destination/age-keygen"
install -m 0755 "$temporary/rclone-v${rclone_version}-linux-amd64/rclone" "$destination/rclone"

"$destination/age" --version | grep -Fx "v${age_version}" >/dev/null
"$destination/rclone" version | grep -Fx "rclone v${rclone_version}" >/dev/null
printf 'installed verified recovery tools in %s\n' "$destination"
