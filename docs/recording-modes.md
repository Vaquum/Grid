# Sweep and Inspect recording

Sweep is the default for new runs. It retains scalar results, typed sampled
parameters, manifest copies, seeds, diagnostics and available source/runtime
provenance. Inspect retains the detailed evidence needed by supported trade,
probability, cohort and reconstruction workflows. Changing a mode creates new
evidence; it cannot restore bars omitted by a historical run.

| Native Limen setting | Sweep | Inspect |
| --- | --- | --- |
| `uel.record_execution` | `false` | `true` |
| `uel.record_model_outputs` | `false` | `true` |
| `uel.recording.predictions` | `false` | `true` |
| `uel.recording.alignment` | `false` | `true` |
| `uel.recording.trade_ledger` | `false` | `true` |
| `uel.recording.fold_details` | `false` | `true` |

Limen 5.30.2 supports these controls. Its alignment switch omits per-bar
`missing_datetimes` and `test_datetimes`; small dated bounds and learning
bindings remain. Source market data remains necessary to execute either mode.
Recording switches govern saved evidence, preserving model/strategy settings,
splits, costs and scalar meanings.

Limen 5.30.2 has a diagnostic omission: LightGBM's `best_iteration` scalar is
written only when `record_model_outputs` is true
(`limen/sfd/reference_architecture/lightgbm_binary.py`, lines 154–156).
XGBoost uses the same condition (`xgboost_regressor.py`, lines 62–66).
Sweep therefore omits this column under the required native policy. The
benchmark reports this schema difference separately from shared score/backtest
values; complete scalar-column parity must not be claimed. Recovering this
diagnostic while keeping model-output recording disabled needs an upstream
Limen change.

Ordinary Limen 5.30.2 round records do not include a market-input content hash
or runtime source identity. Grid retains those separately at launch, together
with a content-addressed local source snapshot. Native recording policy alone
cannot establish that a mutable source path still names the original data.

| Capability | Sweep | Inspect |
| --- | --- | --- |
| CSV metrics, parameter comparisons, filters, pockets | Available | Available |
| Trades, first/second halves, timing | Unavailable by policy | Requires recorded execution |
| Probability/threshold diagnostics | Unavailable by policy | Requires supported model outputs |
| Recorded cohort evaluation/reconstruction | Unavailable by policy | Requires compatible complete evidence |
| Native lightweight resume | Unsupported | Native complete-evidence requirements apply |

Historical runs retain their actual policies and capabilities. Missing evidence
is separate from an unfinished ingestion, failed execution, or a failed metric
gate. Whole-window results cannot stand in for missing first-half evidence.
Inspect does not guarantee every advanced diagnostic: architecture and runtime
compatibility still matter. Limen rejects PBO acceptance (`max_pbo`) without
alignment/fold evidence, and rejects resume under a lighter recording policy.

Pocket-to-Inspect creates a linked run of the explicit selected parameter
region. Review its projected permutations and manifest difference. The source
run/snapshot, selection and native request identity provide provenance and
retry safety; source data, costs, dates, runtime and seeds carry forward unless
explicitly changed. Pocket discovery remains exploratory; independent
validation requires separately protected evidence.

Named Grid launches snapshot supported local file sources into the shared,
content-addressed `.grid/sources` store and execute from that retained copy.
The original path, content hash and byte count remain provenance. Native Python,
Limen source and package versions identify the runtime. Linked Inspect checks
both the retained source bytes and runtime fingerprint before creating a run.
These small identities also travel in the exact native manifest's comments.

Historical native runs and remote data providers may lack verifiable source
content. Limen 5.30.2 does not persist a dataset content hash or runtime source
hash for ordinary ML Sweep records. Grid reports linked inspection unavailable
for those runs; matching a path or version string cannot prove the same inputs.
Run a new Sweep from a retained local source to establish that provenance.
Source snapshots are required execution inputs and are counted separately
from per-permutation result payloads; Grid does not delete them automatically.

## Native benchmark

`tools/benchmark_recording.py` executes native Limen 5.30.2 on the existing real
BTC hourly snapshot in `tests/fixtures/retention/btc_spot_hourly.parquet`
(SHA-256 `a8e482179a7bf2b0a2a1d006a25298618e5a89cf501304baa0dac956211d01c4`).
It uses the recorded LightGBM workload's 2020–2022 training, 2023 validation and
2024–2025 test dates, with its full features, target and costs. A rule workload
uses the same bars, splits and cost/exit domains with a 24-hour return entry.
Both modes receive the same sampled parameters and random-search seed 133;
the LightGBM model seed is 42. Factorization is disabled; numeric threads and
round workers are limited to one. Default execution is 60 rounds per run,
three alternating matched repetitions per workload/mode (720 native rounds).

Publish the implementation before running local validation or this benchmark:

```sh
python3 tools/benchmark_recording.py \
  --limen-python /path/to/limen-5.30.2/bin/python \
  --work /tmp/grid-recording-benchmark-new \
  --out /tmp/grid-recording-benchmark.json
```

The source corpus is read-only; work must be a new directory. Each generated
native manifest and log remains there. The report contains actual file lengths
for every run, shared market blobs, the source input, runtime/native code and
dataset-cache growth. It reports native execution and fresh-process Grid
ingestion/pack latency and peak RSS separately. Ingestion includes Grid imports
and a fsynced compressed pack; disk caches are not flushed. Shared runtime and
code inventories can overlap and must not be added twice; filesystem allocation
and operating-system libraries are excluded.

The report compares every CSV field except elapsed time and generated row IDs,
lists all scientific/diagnostic differences without a numerical tolerance,
checks the exact typed sampled parameters and requires every round to succeed.
It audits native Sweep records for predictions, probabilities, execution,
market payloads/references, trade ledgers, fold arrays and timestamp arrays,
and publishes all remaining array paths/lengths. Size reductions describe the
measured workloads only. They are not extrapolated campaign estimates or a
promise of deterministic results on other runtimes.

After a Grid implementation change, reuse completed native evidence only by
checking its recorded scientific inputs and remeasuring ingestion:

```sh
python3 tools/benchmark_recording.py \
  --limen-python /path/to/limen-5.30.2/bin/python \
  --remeasure-existing /tmp/grid-recording-benchmark-new \
  --out /tmp/grid-recording-benchmark.json
```

This checks the source checksum, exact native configuration and manifest copy,
native Python/Limen source/dependency identities, successful rounds, typed
parameters and scalar agreement. Each remeasurement hashes native evidence for
future tamper checks and archives the previous report by content hash. Reports
created before head attribution was added also need `--native-head COMMIT`,
using the head recorded by the original validation gateway. Native generation
receipts keep that attribution; new ingestion measurements name the current
Grid head and code digest.

Remeasurement also invokes Grid's actual launch-identity helper for both modes,
retains the shared content-addressed source snapshot, and measures identity
JSON/portable-manifest bytes separately. This overhead probe does not execute
a strategy or count a Project run journal. Native campaign totals exclude
these explicitly itemized Grid wrapper artifacts. No size-reduction claim is
derived from the overhead probe.
