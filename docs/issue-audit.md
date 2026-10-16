# Issue audit — 16 October 2026

All 37 issues were reviewed against main (`023df44`) and merged PRs.
The 24 closed issues already have merged implementations; none needs reopening.
This change addresses the remaining 13 issues in one PR.

| Issue | Disposition |
| --- | --- |
| [#73](https://github.com/Vaquum/Grid/issues/73) | Include Node 24, the analysis worker and ES-module metadata in the final image; exercise the agent against recorded data in that image. |
| [#74](https://github.com/Vaquum/Grid/issues/74) | Derive parameter roles exclusively from the Limen manifest, recognize native rule metrics and map supported test metrics to recorded halves. |
| [#75](https://github.com/Vaquum/Grid/issues/75) | Expose execution preflight separately from schema validation and reject unsupported worker combinations before creating a run. Advertise the restrictions. |
| [#76](https://github.com/Vaquum/Grid/issues/76) | Use affinity and cgroup quotas for capacity, shard admission and native thread allocation, including manifest workers. |
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
