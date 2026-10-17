# Analytical evidence retention

Grid can retain sealed Limen runs without their large per-permutation logs.
Every CSV occurrence, failure, typed parameter, diagnostic and round stays
available. The dashboard reads cached native whole/half-window and threshold
summaries. Cohort and Trainer reads resolve exact evidence when needed.

Numerical tolerance is **zero**. Integer predictions are bit-packed; floating
vectors preserve float64 bits, negative zero, nulls and order. Unknown numeric
types use lossless JSON. Unsupported records retain their complete original
wire payload. Trial occurrences are never deduplicated by parameter hash.

## Compact a sealed run

Stop its producer and close its Grid readers. `--sealed` is an operator
assertion that the producer will not append; Grid also checks managed producer
state, Linux write descriptors, reader leases and source identities. It cannot
coordinate an external writer that ignores that contract.

```sh
python -m grid retain --run /data/project/results/dev/EXPERIMENT/RUN/s1 \
  --store /data/project/.grid-evidence/evidence.sqlite3 --sealed --prune
```

Repeat `--run` for related directories and use the same store. Omitting
`--prune` leaves originals in place for inspection. The command reconstructs
each valid record exactly before publication, verifies compressed CSV bytes,
flushes dependencies, then atomically publishes `.grid-retained.json`.
Only a published, verified archive permits original log/market removal.
Metadata, YAML, checkpoints and reports remain in the result directory.

Default retention keeps shared exact vectors and needs no scientific runtime
for reading. Serving a project also persists its native analytical reductions
in this store. Standalone `serve`/`pack` can opt into a shared cache with
`--evidence-store PATH`.

## Optional verified native replay

Snapshot execution can be regenerated from immutable source bytes, recorded
predictions, dated alignment and original execution options. Admitted
deterministic LightGBM output can be regenerated from its original inputs and
parameters. Each omitted field first passes exact comparison against recorded
evidence. A failure preserves its vectors. Walk-forward, event execution,
unknown architectures and stochastic model outputs are not admitted.

On the Docker host, retain a real native environment:

```sh
python3 tools/pin_replay_runtime.py \
  --docker-host unix:///run/grid-docker.sock \
  --store /srv/grid/docker/volumes/grid_project/_data/project/.grid-evidence \
  --image IMAGE_ID
```

This freezes Grid's replay code and creates a container referencing the
immutable image. It has no network, a read-only filesystem, bounded CPU/RAM,
read-only input/code mounts and a private socket. Grid receives no Docker
socket. The returned runtime identity includes image, code, CPU platform and
numeric thread settings. Supply it to retention with `--runtime SHA256`.
Current replay admission targets Limen 5.29.0; other versions retain vectors.

Keep the pin container and image for as long as archives reference them.
A digest/version alone is not a runtime backup. Preserve its numeric platform
or materialize complete native evidence before moving to another platform.
Cold model materialization requires fitting; bounded worker caches amortize
repeated reads. This changes availability/latency, never numeric precision.

Identical immutable output artifacts may share a verified materialization
recipe even when trial parameters differ. The original typed parameters and
occurrences remain separate; only content-identical values share storage.
Preparation state is keyed by its causal parameters/source/runtime; immutable
feature matrices are interned independently from target labels, including
shape, dtype, layout and content.

## Native export and checkpoint resume

```sh
python -m grid materialize --run RETAINED_DIR --out NEW_NATIVE_DIR
python -m grid verify-retention --run RETAINED_DIR
```

Full export reconstructs native round records and the exact original CSV.
Trainer's selected export resolves only its selected rounds. Original source
files used by training must still match the retained source snapshot.

With the producer and readers stopped, `materialize --run DIR --in-place`
restores full native files for `limen run --resume DIR`. The previous retained
run remains accessible at `DIR/.grid-history/ARCHIVE_ID`. Limen owns checkpoint
rewind and continuation. Grid can restore an unopened retained shard before
resuming; an open reader must close first. Full evidence is restored for every
resume mode; serial ID-only receipts are not emitted by this implementation.

## Format, recovery and measurement

Each result directory keeps `round_data.grid.jsonl.gz`, `results.csv.gz` and
its descriptor. Numeric objects, checked replay recipes and round-ID indexes
live in the shared SQLite store; immutable source/definition files and runtime
pins live beside it. Copy retained run directories **and** the shared store,
assets and required runtime pins together. Never edit retained metadata.

An interrupted staging attempt leaves originals authoritative. An interrupted
prune is retried with the same command. Partial gzip members, changed sources,
missing objects, corrupt hashes and incompatible runtimes fail before eviction.
Unpublished content-addressed objects may remain and can be reused on retry;
they are never deleted speculatively across related runs.

Measure archive/CSV/store/assets separately from runtime image layers,
temporary native exports, caches and live uncommitted tails. Include migration,
verification, fsynced outputs, cold and steady reads, selected exports and peak
RSS in comparisons. Component estimates are not whole-deployment savings.
Native execution-permutation fit reuse already exists and is not a new gain.

Continuous live-file disposal needs a producer acknowledgement boundary. The
generic optional capability suggestion is [Limen #933](https://github.com/Vaquum/Limen/issues/933).
