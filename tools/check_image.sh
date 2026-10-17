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
sudo python3 tools/pin_replay_runtime.py \
  --store "$PWD/dist/image-evidence/cas" --image grid-backlog-smoke \
  > dist/image-evidence/replay-pin.json
replay_name=$(python3 -c 'import json; print(json.load(open("dist/image-evidence/replay-pin.json"))["name"])')
cleanup() {
  docker rm -f "$replay_name" >/dev/null || true
  sudo chmod -R a+rX dist/image-evidence
}
trap cleanup EXIT
docker run --rm --cpus 1 --memory 1g --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m --entrypoint python \
  -e PYTHONPATH=/app -e GRID_CPU_BUDGET=1 \
  -e OMP_NUM_THREADS=1 -e OPENBLAS_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e POLARS_MAX_THREADS=1 -e PYTHONHASHSEED=0 -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$PWD/dist/image-evidence:/evidence" \
  -v "$PWD/tests/fixtures:/fixtures:ro" \
  -v "$PWD/tools/check_retention_image.py:/tmp/check_retention_image.py:ro" \
  grid-backlog-smoke /tmp/check_retention_image.py
