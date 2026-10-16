#!/bin/sh
# Run as root on the Linux production host before the one-time migration.
# Never resize an existing image or touch the shared Docker engine.
set -eu
test "$(id -u)" -eq 0
command -v python3 >/dev/null
command -v logrotate >/dev/null
cd "$(dirname "$0")"
image=/var/lib/grid.ext4
if [ ! -e "$image" ]; then
    # Sparse allocation avoids reserving 199 GB immediately. The file cannot
    # grow through filesystem writes; ext4 rejects writes at its boundary.
    (umask 077; set -C; : > "$image")
    truncate -s 199000000000 "$image"
    mkfs.ext4 -q -m 0 -E nodiscard "$image"
fi
test "$(stat -c %s "$image")" -eq 199000000000
install -d /srv/grid /usr/local/libexec /etc/docker
install -m 755 grid-storage-check /usr/local/libexec/grid-storage-check
install -m 755 grid-runtime /usr/local/libexec/grid-runtime
install -m 755 grid_network.py /usr/local/libexec/grid-network
install -m 644 srv-grid.mount grid-docker.service \
    grid-logrotate.service grid-logrotate.timer /etc/systemd/system/
install -m 644 grid-docker.json /etc/docker/grid.json
install -m 644 grid-containerd.toml /etc/docker/grid-containerd.toml
install -m 644 grid-runtime.logrotate /etc/docker/grid-runtime.logrotate
systemctl daemon-reload
systemctl enable --now srv-grid.mount
/usr/local/libexec/grid-storage-check
install -d /srv/grid/tmp /srv/grid/checkout
systemctl enable --now grid-docker.service
systemctl enable --now grid-logrotate.timer
docker --host unix:///run/grid-docker.sock info --format '{{.DockerRootDir}}'
