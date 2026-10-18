# Issue audit — 16 October 2026

The initial 37 issues were reviewed against main (`023df44`) and merged PRs.
The 24 closed issues already have merged implementations; none needs reopening.
This audit covers the initial 13 open issues and eleven requests filed during
implementation (#78, #80, #81, #82, #83, #84, #85, #87, #89, #90, #92). Remaining
changes share this PR; merged work and existing PRs are recorded below.

| Issue | Disposition |
| --- | --- |
| [#73](https://github.com/Vaquum/Grid/issues/73) | Include Node 24, the analysis worker and ES-module metadata in the final image; exercise the agent against recorded data in that image. |
| [#74](https://github.com/Vaquum/Grid/issues/74) | Derive parameter roles exclusively from the Limen manifest, recognize native rule metrics and map supported test metrics to recorded halves. |
| [#75](https://github.com/Vaquum/Grid/issues/75) | Expose execution preflight separately from schema validation and reject unsupported worker combinations before creating a run. Advertise the restrictions. |
| [#76](https://github.com/Vaquum/Grid/issues/76) | Use affinity and cgroup quotas for capacity, shard admission and native thread allocation, including manifest workers. |
| [#78](https://github.com/Vaquum/Grid/issues/78) | Automatically discover all project runs across shared services and restart; enable a private agent connection on the production service and identify the UI origin/instance. |
| [#80](https://github.com/Vaquum/Grid/issues/80) | Preserve sparse/all-null half arrays, fail closed on unavailable first-half gates, and report mixed-scope selection without certifying isolation. |
| [#81](https://github.com/Vaquum/Grid/issues/81) | Prefer recorded timestamps; otherwise recover exact test bars through the original manifest in Limen, supporting native Parquet/Arrow sources and rejecting missing or inconsistent timestamps. |
| [#82](https://github.com/Vaquum/Grid/issues/82) | Remains open: native factorized random traversal requires [Limen #924](https://github.com/Vaquum/Limen/issues/924). Advertise the missing capability and reject random/shuffled factorized manifests. This PR does not claim randomized factorial levels satisfy random candidate sampling. |
| [#83](https://github.com/Vaquum/Grid/issues/83) | Reject unresolved `recency_n`/`persistence_n` references and invalid constants before starting a run. Constant positive integers remain supported; native reference resolution is tracked in [Limen #925](https://github.com/Vaquum/Limen/issues/925). |
| [#84](https://github.com/Vaquum/Grid/issues/84) | Merged in [PR #86](https://github.com/Vaquum/Grid/pull/86). Integrate its deferred run loading with shared-project discovery: enumerate unopened histories without counting CSV rows, resolve selected project IDs, and preserve its retry/reconnect behavior. |
| [#85](https://github.com/Vaquum/Grid/issues/85) | Rank cohorts exclusively on finite first-half evidence, regardless of second-half values or availability; preserve unavailable held-out results. |
| [#87](https://github.com/Vaquum/Grid/issues/87) | Already implemented in [PR #88](https://github.com/Vaquum/Grid/pull/88), with passing local and CI checks. Omit duplicate Trials changes from this PR. |
| [#89](https://github.com/Vaquum/Grid/issues/89) | Capture only the selected run for agent analysis and pinned snapshots; avoid a full-pack parse/serialize pass, defer Board effects for schema/gates/cohort/manifest queries, and report capture/envelope/worker times and retained bytes. Compare identical evidence with an unrelated 5,000-row telemetry run. |
| [#90](https://github.com/Vaquum/Grid/issues/90) | Already has [PR #91](https://github.com/Vaquum/Grid/pull/91): a bounded 199 GB filesystem, dedicated Docker engine, migration and fail-closed deployment checks. Its production migration and validation remain owned by that PR; do not duplicate or claim its deployment here. |
| [#92](https://github.com/Vaquum/Grid/issues/92) | Already implemented in [PR #93](https://github.com/Vaquum/Grid/pull/93), covering non-root storage checks while preserving the kernel boundary. Omit duplicate deployment changes. |
| [#54](https://github.com/Vaquum/Grid/issues/54), v5.24.1 | Upstream documentation update. Grid already invokes the documented CLI/Python routes. No feature change. |
| [#57](https://github.com/Vaquum/Grid/issues/57), v5.25.0 | Already installed in the image. Native workers remain distinct from Grid shards; admission and CPU budgeting are covered by #75/#76. |
| [#66](https://github.com/Vaquum/Grid/issues/66), v5.25.1 | Captured aggregates and nullable CSV fixes are upstream. Grid already reads CSV aggregates and preserves nulls. Included in the new image pin. |
| [#67](https://github.com/Vaquum/Grid/issues/67), v5.25.2 | Preparation reuse is upstream execution behavior. Included in the new image pin; no Grid analysis contract change. |
| [#68](https://github.com/Vaquum/Grid/issues/68), v5.25.3 | Polars/sklearn conversions belong to upstream fitting. Included in the new image pin. |
| [#69](https://github.com/Vaquum/Grid/issues/69), v5.25.4 | Calibration decision preservation is upstream. Included in the new image pin. |
| [#70](https://github.com/Vaquum/Grid/issues/70), v5.26.0 | Target source exclusions are applied by Limen during preparation/inference. Grid preserves the manifest and delegates both routes. Included in the new image pin. |
| [#71](https://github.com/Vaquum/Grid/issues/71), v5.26.1 | Fixed trade-source reuse is upstream. Included in the new image pin. |
| [#72](https://github.com/Vaquum/Grid/issues/72), v5.27.0 | Declared column shims are prepared by Limen. Grid preserves their declarations; no separate transform implementation is needed. Pin the image to this release. |

Release dispositions use the linked upstream PRs and the corresponding
[Limen releases](https://github.com/Vaquum/Limen/releases). They do not imply
new upstream support for combining factorization and parallel rounds.

## 17 October 2026: compressed artifacts

- [#97](https://github.com/Vaquum/Grid/issues/97): support Limen 5.29's
  `gzip-jsonl-v1` metadata, concatenated gzip round members and shared
  `round_market/<sha256>.json.gz` blobs. Local and SSH followers wait for
  complete members; cohort reads retain compressed offsets. Market reads
  validate gzip integrity, content hashes and array lengths. Training
  exports hydrate selected records into legacy JSONL with matching metadata.
- [#96](https://github.com/Vaquum/Grid/issues/96): install Limen 5.29.0,
  including 5.28's XGBoost manifest controls and Python SFD extensions.
  Grid already preserves model parameters and delegates execution to Limen.
- #82 remains open while Limen #924 is open; this upgrade adds no native
  factorized random traversal.

## 18 October 2026: Limen 5.29.1–5.30.2

All eleven open release notices are processed together. The previous batch
was merged in PR #98 through Limen 5.29.0; no closed release is reopened.
The image now installs 5.30.2. Historical fixtures retain their original
recorded versions.

| Issue / release | Upstream change and Grid disposition |
| --- | --- |
| [#103](https://github.com/Vaquum/Grid/issues/103), 5.29.1 | [Limen #932](https://github.com/Vaquum/Limen/pull/932) resolves temporal rule parameters. Advertise support from the actual runtime; delegate modern validation to Limen and preserve rejection on older runtimes. |
| [#104](https://github.com/Vaquum/Grid/issues/104), 5.29.2 | [Limen #931](https://github.com/Vaquum/Limen/pull/931) accelerates indicators without changing their output contract. Adopt via the image pin. |
| [#109](https://github.com/Vaquum/Grid/issues/109), 5.29.3 | [Limen #935](https://github.com/Vaquum/Limen/pull/935) accelerates composite price lines. Adopt upstream implementation; no Grid calculation changes. |
| [#112](https://github.com/Vaquum/Grid/issues/112), 5.29.4 | [Limen #939](https://github.com/Vaquum/Limen/pull/939) accelerates remaining candlestick indicators. Adopt via the image pin. |
| [#113](https://github.com/Vaquum/Grid/issues/113), 5.29.5 | [Limen #956](https://github.com/Vaquum/Limen/pull/956) changes upstream coverage instrumentation only. No Grid CI or interpreter changes required. |
| [#114](https://github.com/Vaquum/Grid/issues/114), 5.29.6 | [Limen #954](https://github.com/Vaquum/Limen/pull/954) accelerates parameter materialization and repairs upstream worker tests. Adopt native parameter construction; preserve Grid CPU admission. |
| [#115](https://github.com/Vaquum/Grid/issues/115), 5.29.7 | [Limen #958](https://github.com/Vaquum/Limen/pull/958) corrects upstream coverage/governance contracts. No downstream CI change. |
| [#116](https://github.com/Vaquum/Grid/issues/116), 5.29.8 | [Limen #940](https://github.com/Vaquum/Limen/pull/940) accelerates extrema and ultimate oscillator calculations. Adopt via the image pin. |
| [#117](https://github.com/Vaquum/Grid/issues/117), 5.30.0 | [Limen #943](https://github.com/Vaquum/Limen/pull/943) adds native recording policies. Preserve manifest declarations/defaults, verify omitted-prediction market alignment, and document unavailable cohort evidence and native resume restrictions. |
| [#118](https://github.com/Vaquum/Grid/issues/118), 5.30.1 | [Limen #941](https://github.com/Vaquum/Limen/pull/941) accelerates SMA and reuses MAMA. Adopt via the image pin; no alternate indicator implementation. |
| [#119](https://github.com/Vaquum/Grid/issues/119), 5.30.2 | [Limen #960](https://github.com/Vaquum/Limen/pull/960) strengthens upstream coverage regression tests. No Grid CI change. |

The batch does not resolve #82, #99–#102, #105, #110 or #111. Exact retained
evidence in #106/#107 remains the separate PR #108. Configurable omission
is not lossless analytical retention and does not enable lighter-run resume.
