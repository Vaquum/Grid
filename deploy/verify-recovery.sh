#!/bin/sh
set -eu
test "$(id -u)" -eq 0
cd "$(dirname "$0")/.."
/usr/local/libexec/grid-storage-check --cwd
python3 deploy/grid_network.py --verify-primary
curl --fail --show-error http://127.0.0.1:8490/api/health
