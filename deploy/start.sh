#!/bin/sh
set -eu
if [ ! -e /data/project ]; then
    limen new /data/project --backup-remote ""
fi
exec python -m grid serve --project /data/project \
    --bind 127.0.0.1 --port 8490 --public-origin https://grid.vaquum.fi \
    --limen-cli /usr/local/bin/limen --limen-python /usr/local/bin/python
