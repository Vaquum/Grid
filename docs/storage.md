# Production storage

The entire Grid deployment has a hard disk boundary. `/var/lib/grid.ext4`
is a fixed 199,000,000,000-byte sparse image mounted at `/srv/grid`. All
payloads stay inside, including the checkout, build intermediates, images,
volumes and logs. A 1 GB margin covers host filesystem bookkeeping and
small unit/configuration files. Other services retain their existing engine.
Grid's isolated data and execution roots follow Docker's
[multiple-daemon configuration](https://docs.docker.com/reference/cli/dockerd/#run-multiple-daemons).

At capacity, Linux refuses writes with ENOSPC. Runs may fail and need resuming
after space is freed. No automatic deletion or image growth occurs. Actual
allocated bytes grow with use; the backing host must still have free space.
Runtime temporary files use RAM; build temporary files use `/srv/grid/tmp`.
Docker logs rotate at 10 MB with three files. The mount starts at boot;
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

During migration, count both copies toward 200 GB. If there is insufficient
room for a full second copy, do not begin this procedure; use a separately
reviewed migration. The initial deployment had approximately 99 GB decimal
of project data and a 1.5 GB image.

## Administration

```sh
/usr/local/libexec/grid-storage-check
df -B1 /srv/grid
du -B1 /var/lib/grid.ext4
DOCKER_HOST=unix:///run/grid-docker.sock docker system df
DOCKER_HOST=unix:///run/grid-docker.sock docker compose -f /srv/grid/checkout/docker-compose.yml ps
```

GitHub deployment verifies the mount and checkout before rsync, then uses
only the isolated engine. `DEPLOY_DIR` overrides must resolve to
`/srv/grid/checkout`. Never build deployment images on the shared engine.
Free space through deliberate cleanup of obsolete Grid data or unused Grid
images/cache, within the same engine.

`tools/check_storage.sh` runs as root only on disposable Linux CI runners.
It checks actual ENOSPC and rejects oversized images, missing mounts and
unrelated filesystems, using a small filesystem in a sparse device.
