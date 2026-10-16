#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -t grid-backlog-smoke .
mkdir -p dist/image-evidence
chmod 777 dist/image-evidence
docker run --rm --cpus 2 --memory 4g --entrypoint python \
  -e PYTHONPATH=/app \
  -e GRID_RULE_EVIDENCE=/evidence/limen_rule \
  -v "$PWD/dist/image-evidence:/evidence" \
  -v "$PWD/tests/fixtures:/fixtures:ro" \
  -v "$PWD/tools/check_image.py:/tmp/check_image.py:ro" \
  grid-backlog-smoke /tmp/check_image.py
