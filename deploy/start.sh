#!/bin/sh
set -eu
if [ ! -e /data/project ]; then
    limen new /data/project --backup-remote ""
fi
exec "$@"
