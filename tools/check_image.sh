#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -t grid-backlog-smoke .
docker run --rm --cpus 2 --memory 4g --entrypoint python \
  -e PYTHONPATH=/app \
  -v "$PWD/tests/fixtures:/fixtures:ro" \
  -v "$PWD/tools/check_image.py:/tmp/check_image.py:ro" \
  grid-backlog-smoke /tmp/check_image.py
