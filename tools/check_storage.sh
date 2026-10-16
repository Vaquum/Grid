#!/bin/sh
# Fixed paths: use only a disposable Linux CI runner, in a private mount namespace.
set -eu
test "${GRID_STORAGE_TEST_RUNNER:-}" = disposable
test "$(id -u)" -eq 0
if [ "${1:-}" != --namespace ]; then
    exec unshare --mount --propagation private sh "$0" --namespace
fi
cd "$(dirname "$0")/.."
repo_dir=$PWD
test ! -e /var/lib/grid.ext4
test ! -e /srv/grid
mkdir /srv/grid
cleanup() {
    umount /srv/grid 2>/dev/null || true
    rm -f /var/lib/grid.ext4
    rmdir /srv/grid
}
trap cleanup EXIT
truncate -s 199000000000 /var/lib/grid.ext4
# Small filesystem, production-size sparse device: exercise ENOSPC cheaply.
mkfs.ext4 -q -F -b 4096 -m 0 /var/lib/grid.ext4 16384
mount -o loop /var/lib/grid.ext4 /srv/grid
sh deploy/grid-storage-check
chmod 600 /var/lib/grid.ext4
su -s /bin/sh nobody -c \
    "cd /srv/grid && sh '$repo_dir/deploy/grid-storage-check' --cwd"
# systemd BindPaths adds a second mount entry for the same filesystem.
mount --bind /srv/grid /srv/grid
sh deploy/grid-storage-check
umount /srv/grid
if sh deploy/grid-storage-check --cwd; then
    echo 'FAIL: uncapped working directory accepted' >&2
    exit 1
fi
if dd if=/dev/zero of=/srv/grid/full bs=1M count=80 2>/dev/null; then
    echo 'FAIL: writes escaped the filesystem boundary' >&2
    exit 1
fi
rm /srv/grid/full
truncate -s 200000000000 /var/lib/grid.ext4
if sh deploy/grid-storage-check; then
    echo 'FAIL: oversized backing image accepted' >&2
    exit 1
fi
truncate -s 199000000000 /var/lib/grid.ext4
(
    cd /srv/grid
    sh "$OLDPWD/deploy/grid-storage-check" --cwd
    umount -l /srv/grid
    # A detached mount must still constrain the pinned receiver's writes.
    if dd if=/dev/zero of=detached-full bs=1M count=80 2>/dev/null; then
        echo 'FAIL: detached receiver escaped the cap' >&2
        exit 1
    fi
    test ! -e /srv/grid/detached-full
    rm detached-full
)
if sh deploy/grid-storage-check; then
    echo 'FAIL: unmounted host directory accepted' >&2
    exit 1
fi
mount -t tmpfs tmpfs /srv/grid
if sh deploy/grid-storage-check; then
    echo 'FAIL: unrelated filesystem accepted' >&2
    exit 1
fi
echo 'storage boundary and fail-closed checks passed'
