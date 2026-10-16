# Production storage

The entire Grid deployment has a hard disk boundary. `/var/lib/grid.ext4`
is a fixed 199,000,000,000-byte sparse image mounted at `/srv/grid`. All
payloads stay inside, including the checkout, build intermediates, images,
volumes and logs. A 1 GB margin covers host filesystem bookkeeping and
small unit/configuration files. Other services retain their existing engine.
Grid has its own containerd service, namespace, socket and persistent root
under `/srv/grid/containerd`; it never uses the host's shared runtime root.
Grid's isolated data and execution roots follow Docker's
[multiple-daemon configuration](https://docs.docker.com/reference/cli/dockerd/#run-multiple-daemons).

At capacity, Linux refuses writes with ENOSPC. Runs may fail and need resuming
after space is freed. No automatic deletion or image growth occurs. Actual
allocated bytes grow with use; the backing host must still have free space.
Runtime temporary files use RAM; build temporary files use `/srv/grid/tmp`.
Docker logs rotate at 10 MB with three files. The mount starts at boot;
Daemon logs also rotate at 10 MB with three compressed archives, checked
every minute; their state file and temporary rotation copies stay inside
the same cap. Provisioning requires Python 3 and logrotate on the host.
its loss stops the engine. Startup checks the exact loop device and size.

## Initial setup and migration

Run `sh deploy/provision-storage.sh` as root on the production Linux host.
It creates and enables the mount and separate Docker engine. Existing
images are never formatted or resized. An interrupted initial format needs
operator inspection; rerunning refuses to reformat an existing image.

For the existing deployment, stop `grid-grid-1` on the default engine before
copying its project volume. Preserve the running image using a streamed
`docker image save ... | docker --host unix:///run/grid-docker.sock image load`;
do not create an extra archive. Copy the checkout into `/srv/grid/checkout`,
create `grid_project` on the new engine, and copy the old volume using
`rsync -aHAX --numeric-ids`. Verify rsync reports no differences before
starting the copied checkout using the new engine and `--no-build`.
Check `/api/health` and the catalog before removing the stopped legacy Grid
container and volume. Keep only the capped copy after verification.
Replace `/opt/grid` with a symlink to `/srv/grid/checkout`.
Never prune the shared engine or delete unrelated volumes/images.

During migration, count temporary overlap toward 200 GB. The production
migration used `rsync --remove-source-files`: rsync verifies each transfer
before removing its source, limiting overlap to one file. Record a sorted
path/size inventory before transfer and compare it with the destination
afterward. Preserve the inventory if a transfer needs resuming. With
106.5 GB of data and a largest file of 38 GB, this stays below the ceiling.
Check this bound, image costs and filesystem overhead before migrating
another deployment. Do not make a full second copy if it would exceed
200 GB. There is no automatic rollback copy after per-file removal.

## Administration

```sh
/usr/local/libexec/grid-storage-check
df -B1 /srv/grid
du -B1 /var/lib/grid.ext4
DOCKER_HOST=unix:///run/grid-docker.sock docker system df
DOCKER_HOST=unix:///run/grid-docker.sock docker compose -f /srv/grid/checkout/docker-compose.yml ps
```

GitHub deployment pins the receiver's working directory before checking
its device, then writes to a relative checkout path. A lazy unmount leaves
the receiver on the capped filesystem. Each runtime service also binds
the filesystem into its own mount namespace and checks inside that namespace
before executing. GitHub then uses only the isolated engine.
`DEPLOY_DIR` overrides must resolve to
`/srv/grid/checkout`. Never build deployment images on the shared engine.
Free space through deliberate cleanup of obsolete Grid data or unused Grid
images/cache, within the same engine.

`tools/check_storage.sh` runs as root only on disposable Linux CI runners.
It checks actual ENOSPC and rejects oversized images, missing mounts and
unrelated filesystems, using a small filesystem in a sparse device.
