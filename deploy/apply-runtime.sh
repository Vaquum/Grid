#!/bin/sh
# Applied only by the merged deployment workflow, with administrative access.
set -eu
test "$(id -u)" -eq 0
cd "$(dirname "$0")/.."
/usr/local/libexec/grid-storage-check --cwd
systemctl stop grid-docker.service
python3 deploy/grid_network.py --restore-primary
sh deploy/provision-storage.sh
