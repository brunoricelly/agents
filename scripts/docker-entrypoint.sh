#!/bin/sh
set -eu

if [ "${1#-}" != "$1" ]; then
  set -- bun "$@"
fi

if [ "$(id -u)" -eq 0 ]; then
  bun_uid="$(id -u bun)"
  for dir in /app/logs /app/storage /app/data; do
    mkdir -p "$dir"
    if [ "$(stat -c '%u' "$dir")" -ne "$bun_uid" ]; then
      chown -R bun:bun "$dir"
    fi
  done
  exec su-exec bun:bun "$@"
fi

exec "$@"
