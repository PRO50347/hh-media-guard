#!/bin/sh
set -eu
umask 077
node /app/scripts/config-init.mjs
if [ "$(id -u)" = 0 ]; then
  exec su-exec "${PUID:-100}:${PGID:-101}" "$@"
fi
exec "$@"
