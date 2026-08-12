#!/bin/bash
set -Eeuo pipefail
mode=''
output=''
input=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --encrypt|--decrypt) mode=$1; shift ;;
    --recipient|--identity) shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) input=$1; shift ;;
  esac
done
[ -n "$mode" ] && [ -n "$output" ] && [ -f "$input" ]
if [ "$mode" = '--encrypt' ]; then
  { printf 'age-encryption.org/v1\n'; cat "$input"; } >"$output"
else
  tail -n +2 "$input" >"$output"
fi
