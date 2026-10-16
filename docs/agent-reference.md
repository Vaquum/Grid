# Agent interface reference

This is the payload reference for API version 1. See [setup](agents.md),
[workflows](agent-workflows.md) and [error recovery](agent-errors.md).
All 17 tools below are available through JSON CLI, HTTP and MCP. JSON input
schemas from `grid_discover` are authoritative for required fields and bounds.
The advertised output schema describes the common envelope; the tool-specific
payload fields are documented here. Optional/profile-specific fields can be
absent. Ignore unfamiliar output fields; reject unsupported API versions.

## Transport and envelope

```sh
python3 -m grid agent --connection /tmp/grid-agent.json grid_status --args '{}'
```

The equivalent authenticated request is `POST /api/agent` with
`Authorization: Bearer TOKEN`, `Content-Type: application/json`, and:

```json
{"operation":"grid_status","arguments":{}}
```

Use a localhost/IP connection URL. `GET /api/agent` returns raw discovery,
without the tool envelope or bearer requirement; it is available only when
agent access is enabled and still obeys the server's Host checks.
For remote servers, forward a local port to the server and keep the credential
private. The public human-facing deployment URL is not an agent endpoint.

| Envelope field | Type | Meaning |
| --- | --- | --- |
| `apiVersion` | integer | Currently 1. This is separate from MCP protocol revision. |
| `ok` | boolean | The operation succeeded. Check it even after HTTP 200. |
| `result` | object or null | Tool payload on success; null on failure. |
| `error` | object or null | Null on success; `code`, `message`, `retryable` on failure. |

CLI exit codes are 0/1. `--args-file FILE` or `--args-file -` accepts an object
from a file/stdin. With MCP, read the same envelope from `structuredContent`
or the text content; operational failures set `isError: true`. RPC framing
errors have a separate JSON-RPC error object.

Below, **result** means the envelope's `result`. For `grid_analyze`, there
is an additional nested `result` containing that analysis mode's payload.
For example, cohort members are at `response.result.result.members`.

## Tool inputs and immediate results

An asterisk marks a required argument. Text values must be nonempty unless
the schema explicitly permits null. An empty argument object is still `{}`.
Unknown fields fail. Writes require a new `requestId` for each new intent.

| Tool | Arguments | Immediate result |
| --- | --- | --- |
| `grid_discover` | `{}` | `apiVersion`, `tools`, `analyses`, `project`, `semantics`; see discovery below. |
| `grid_status` | `afterVersion` integer; `timeout` integer seconds | `instance`, `version`, `runs`, `errors`, `project`; see status below. |
| `grid_analyze` | `analysis`*; `state`, `snapshot`, `generation`, `limit`, `offset`, `members` | The analysis wrapper and mode-specific payload below. |
| `grid_row` | `reference`* | `reference` (echo) and `row` (recorded row object). Column names and value types belong to that run; missing fields are not equivalent to null values. |
| `grid_reports` | `run`* (analysis ID) | `reports`: array of report entries; see reports below. |
| `grid_manifest` | `name`* | `name`, working YAML `text`, opaque content `version`. |
| `grid_validate` | `text`* | `errors`: array of `{line, path, message}`. Also returns `schemaErrors`, `executionErrors` and `executionChecked`. Empty means the schema and known worker compatibility checks passed; line may be null and path may be empty. A nonempty list is a validation failure even with envelope `ok: true`. |
| `grid_diff` | `name`*, `text`* | `against`: previous project run ID or null; `diff`: unified diff against that run's recorded manifest. No previous run means null/empty string. |
| `grid_create` | `name`*, `requestId`*; `template` or `text` | `name` of the created experiment. At least one source is needed operationally. If both are supplied, template takes precedence. |
| `grid_save` | `name`*, `text`*, `version`*, `requestId`* | New manifest `version`. Save fails if the supplied version differs from the working file; reread and reconcile before a new intent. |
| `grid_start` | `name`*, `rounds`*, `shards`*, `execution`*, `outputs`*, `version`*, `requestId`* | `run`: project run ID. Start verifies the exact manifest version and revalidates with Limen. Acceptance is not job completion. |
| `grid_stop` | `run`* (project ID), `requestId`* | `{ "ok": true }` means the stop operation was accepted. Observe stopped shards/checkpoints through status. |
| `grid_resume` | `run`* (project ID), `requestId`* | `{ "ok": true }` means resume was accepted. Observe the resumed run through status. |
| `grid_open` | `run`* (project ID) | `sweepRun`: analysis run ID. Use it in analysis, reports and row references. Opening an already-open run returns its existing ID. |
| `grid_cohort_evaluate` | `members`* (references); `fee`, `slip` (bps) | Evaluation fields below. Requires local round recordings; it does not train anything. |
| `grid_predictor_create` | `name`*, `members`*, `how`* (object), `requestId`* | `cohort`: predictor name. Observe `project.cohorts` until `made` or `failed`. `how` stores selection provenance with the artifact. |
| `grid_receipt` | `requestId`* | Durable journal record described below. This is distinct from a live run/predictor job. |

Create/save/start/stop/resume/predictor creation are journaled writes.
Manifest/validate/diff/open/receipt/predictor creation require project mode.
Status, analysis and row reads work with recorded results. Cohort evaluation
and reports require a suitable loaded Limen run, but do not require project
mode. `grid_open` changes the loaded analysis set even though it is advertised
as read-only and does not use a write receipt.

### Discovery

`ui` identifies the configured public `origin` and this service
`instance`; `projectRuns` describes automatic shared-project discovery.
Status also returns `uiOrigin`; analysis returns `ui`, including
`snapshotInstanceLocal`. Run analysis IDs and pinned snapshots belong to
one service, while recorded project runs are discovered by every service
sharing the project, including after restart.

`execution` is null without a project, otherwise the same capabilities exposed
in `project.limen.capabilities`: `parallelRounds`, `parallelFactorize` (false),
`parallelRequiresPrepEachRound`, `shardsRequireRandomSearch`, `cpuBudget`,
`factorizedRandom` (false), `factorizedGridRequiresUnshuffled` (true),
`ruleTemporalReferences` (false), and
`preflight` (scope). The effective CPU budget accounts for affinity and cgroup
quotas; fractional quotas round down to whole worker slots, with a minimum
of one. `shards * uel.workers` cannot exceed this budget. Native parallel
workers each use one native thread; serial shards divide the budget.

`grid_validate` distinguishes upstream schema errors from Grid execution
preflight. Preflight checks declarative worker/version/CPU compatibility; it
does not certify data availability or custom runner code. `uel.factorize: true`
requires `uel.workers: 1`. Parallel workers require `prep_each_round: true`
and Limen >= 5.25.0. Factorization requires an unshuffled grid; seeded
factorized random traversal depends on Limen #924 and is not available.
Grid edits/preflights `uel` as a block mapping. Start
repeats these checks before making a run directory or spawning a process.

| Field | Meaning |
| --- | --- |
| `tools[]` | Each has `name`, `description`, `inputSchema`, `outputSchema`, `annotations`. Annotations are `readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`; these are hints, not authorization checks. |
| `analyses[]` | `schema`, `board`, `pocket`, `pairs`, `features`, `trials`, `gates`, `run`, `cohort`, `manifest`. |
| `project` | Boolean: whether project operations are available. |
| `semantics.confidence` | 0.95, the default interval confidence. |
| `semantics.minimumSupport` | 30, the summary support floor. |
| `semantics.missing` | null, the numeric unavailable representation. |
| `semantics.writes` | `"requestId"`, the retry identity mechanism. |
| `semantics.references` | Summary identity fields; use the full reference object below, including `instance`. |
| `semantics.analysisRuntime` | `"Node.js >= 18"`, the server runtime requirement. |

### Status and identity domains

`grid_status` returns the current server `instance` (opaque string), sweep
`version` (integer change cursor), `runs` (analysis run metadata), `errors`
(the ten most recent ingestion diagnostics), and `project` (object or null).
`afterVersion`/`timeout` can wait for sweep evidence changes; project jobs can
change without advancing that cursor. Poll status for job completion.

| Analysis run metadata field | Meaning |
| --- | --- |
| `id`, `label`, `source` | Analysis ID, display label and source description. IDs are server-local, not project paths. |
| `generation` | Identity generation; reset/changed evidence invalidates old references. |
| `rows`, `lines` | Stored rows and consumed source lines. |
| `live`, `writtenAt` | Live source flag and source write timestamp when available. |
| `logId`, `segment` | Related log and segment index, or null. |
| `badCount`, `bad` | Malformed result-line count and diagnostic samples. |
| `schemaEvents` | Recorded column/schema changes. |
| `archivedFrom`, `archivedAt`, `archivedReason`, `archivedShard` | Reset/archive provenance, or null. |
| `resets` | Recorded source resets. |
| `format` | Source result format. |
| `experiment` | Profile/recorded manifest metadata, or null. Contains run-specific Limen information rather than a fixed agent schema. |
| `roundsBadCount`, `roundsBad` | Round-log ingestion failures and samples. |

`project` nests `project: {root, name}`, `limen: {cli, version, capabilities}`, `cores`,
`templates`, `experiments`, `runs`, and `cohorts`. Template entries contain
`name` and their Limen-provided `about` description. Experiments contain `name`,
manifest `file`/`version` (null for run-only experiments), and project `runs`
IDs. Files are relative to the server project; they are not client-local paths.

| Project run field | Meaning |
| --- | --- |
| `id`, `kind`, `experiment` | Project-relative run ID, `grid` or external run kind, experiment name. |
| `started` | Unix timestamp in seconds. |
| `state` | Aggregate `running`, `failed`, `stopped`, `incomplete` or `finished`. A running shard takes priority; inspect every shard before judging success. |
| `rows`, `planned` | Total recorded and planned rounds across shards. |
| `shards[]` | `label`, `seed`, `planned`, `rows`, `state`, `exit`, `checkpoint`, `tail`. Exit is a process code or null; failed shards expose log evidence. |
| `open` | Corresponding analysis run ID or null. |
| `note` | Opening caveat, such as a failed shard with no results. |
| `stopping` | Whether a shard has a stop in progress. |

| Predictor status field | Meaning |
| --- | --- |
| `name`, `state`, `members` | Predictor name; `training`, `made`, `failed`; member count. |
| `source`, `sources` | Original source directory or directories; optional/null for unavailable metadata. |
| `cohortId` | Limen's bound artifact ID once made; null while unavailable. |
| `startedAt`, `madeAt` | Unix timestamps, nullable. |
| `chosen` | Stored `how` provenance from creation. |
| `progress` | During training: `{member, of}` from the most recent training progress line, or null. |
| `tail` | Failed training log tail; null otherwise. |

### Row references

Always pass the object returned by Trials/cohort selection unchanged:

```json
{"instance":"SERVER_INSTANCE","run":"r0","generation":0,"i":12,"roundId":"ROUND_ID","shard":"s1"}
```

`instance`, `run`, `generation`, `i` are required. `i` is the zero-based row
index in that generation, not its rank. Optional `roundId` and `shard` (string
or null) verify the recorded identity when supplied. Refs survive append-only
arrivals, not restarts/resets. Snapshot captures preserve old analysis evidence,
but references are checked against the current server/run before row reads,
evaluation or training. An old snapshot cannot authorize a stale write.

### Reports

Each `reports[]` entry has `label` (shard label or null) and any available
Limen report fields: `convergence` and `acceptance` (nullable). These are
the recorded report objects, not reinterpreted agent statistics. Their nested
fields belong to the installed Limen report version. Empty entries or arrays
mean no report is available. Local files are reread; SSH runs return reports
captured when loaded. Reports may appear only after run completion.

### Receipts

| Field | Meaning |
| --- | --- |
| `requestId`, `operation` | Original durable intent identity and tool name. |
| `fingerprint` | Opaque digest of operation and arguments; not a client token. |
| `state` | `running` (intent recorded) or `complete` (final outcome committed). |
| `response` | Present when complete: the original success/failure envelope. |

Repeat the identical write to get the stored response directly. A completed
receipt means the operation returned, not that an asynchronous job finished.
See [lost response recovery](agent-errors.md#lost-write-responses).

## Analysis inputs and shared output

`analysis` is required. `state` defaults to the UI's initial state.
`snapshot` pins captured pack evidence. `generation` optionally asserts a
run generation. `limit`/`offset` apply only to the Trials list; `members`
controls cohort selection. Passing a parameter unused by another mode does
not make it a payload limit. See [limits](agent-errors.md#implemented-limits).

| State field | Default | Meaning |
| --- | --- | --- |
| `run` | First loaded run | Analysis run ID from status. |
| `view` | Derived from analysis | Returned view used by the UI link; schema/manifest link to Pocket. |
| `target` | Profile default | Needle ID from schema; null requests the default. |
| `context` | `[]` | Conditions defining the base population. |
| `pocket` | `[]` | Conditions selecting a subgroup inside context. |
| `pocketB` | null | Second pocket for comparison, or a condition list. |
| `edge` | null → current row count | Exclusive replay boundary: rows [0, edge). Returned state contains the resolved integer. |
| `gates` | `[]` | Explicit `{id, target, op, value}` definitions; operators `>`, `>=`, `<`, `<=`; finite numeric threshold. IDs cannot conflict with existing gates. |
| `firstHalf` | false | Read measured half-specific needles/gates on the first half. It does not halve arrival rows. |
| `found` | null → selection provenance | `first`, `whole` or null. Retain the returned value; do not erase a prior whole-window selection. |
| `order` | 2 | Pair/interaction order, 2–6. |
| `pair` | null | Explicit distinct dimension IDs of length `order`; null chooses a candidate. |
| `clusters` | `[]` | Cluster IDs from a Run query on this capture. |
| `compare` | false | With two selected clusters, compare them directly; otherwise selected clusters are compared with their complement. |
| `clusterK` | null | Automatic clustering, or requested 2–7 groups. |

A condition is `{ "dim": "DIMENSION_ID", "keys": ["LEVEL_KEY"] }`.
Keys can have the types returned by schema; do not coerce them to display
labels. Alternatives within a condition are OR; conditions are AND. Duplicate
dimensions in one list fail. A recorded null level differs from a dimension
that does not apply. Gates are observed diagnostics unless a mode explicitly
uses them to select rows (notably cohorts); setting a gate does not filter
every analysis population automatically.

| Analysis wrapper field | Meaning |
| --- | --- |
| `apiVersion` | Inner payload version, currently 1. |
| `snapshot` | `id`, `instance`, `run`, `generation`, `datasetVersion`, `edge`, `rows`, `expiresIn`. Dataset version is captured data revision; `rows` is context population support and `expiresIn` is remaining whole seconds. |
| `state` | Full resolved public state above. Reuse it to preserve the question. |
| `viewLink` | Relative pinned human UI link. Resolve against the connection URL; its snapshot ID grants access to the read-only capture. |
| `target` | Target descriptor below. |
| `summary` | Base context statistics below. |
| `warnings` | Strings identifying interpretation caveats, including needles that retain whole-window meaning despite isolation. |
| `result` | Mode-specific payload below. |

Captures last ten minutes and are limited to four per server. Reading a
capture does not refresh it. Result lists named `rowCount` are counts replacing
internal row-index arrays; they are not paginated row lists. Typed parameter
arrays are preserved, while internal per-row target arrays/codes are omitted.

### Shared descriptors and statistics

| Structure/field | Meaning |
| --- | --- |
| Target `id`, `label`, `definition` | Stable-in-run ID, display label and definition when supplied. |
| Target `kind`, `unit`, `better` | `binary`/continuous kind, reported unit, optimization direction (positive higher, negative lower, zero neutral). |
| Target `digits`, `decimals` | Display precision hints; retain numeric values rather than formatting for calculations. |
| Target `inferred`, `diagnostic`, `cost`, `group` | Optional provenance, role and grouping metadata. |
| Dimension `id`, `label`, `role`, `kind`, `levels` | Run-specific identity and type. Levels expose `key`, `label`, `value` and optional profile metadata. Values can be scalar, null or set/nested data. |
| Summary `n`, `missing`, `hits` | Measured support, unavailable target rows, binary positive count (null for continuous targets). |
| Summary `mean`, `lo`, `hi`, `sd` | Mean/rate, 95% interval and sample standard deviation. Unsupported estimates can be null. |
| Summary `shift` | Numerical centering value used by calculations, not an effect or threshold. |
| `withheld` | Support below 30; eligible estimate fields are nulled while support remains. |
| Test `p`, `q`, `detectable` | Raw test probability, BH-adjusted probability in the stated family, and detection flag at 0.05. They do not establish causal effects. |
| Test `F`, `G`, `df1`, `df2`, `test` | F or likelihood-ratio statistic, degrees of freedom and test name. Unavailable values are null. |
| Effect `omega2`, `eta2` | Bias-corrected and uncorrected explained-variance measures; omega² can be negative. |
| Effect `dim`, `levels`, `N`, `k`, `na` | Dimension ID, per-level summaries, measured total, observed level count and rows outside the dimension's scope. |
| Level `lift` | Level mean minus base mean. Pocket binary lift has different semantics (ratio). |
| Effect `spread`, `best`, `worst`, `dead` | Supported best/worst range, level summaries or null, and binary near-dead level keys. |
| `halves`, `whole`, `agree` | Where supplied: per-half effects, original whole-window detection flag, and cross-half agreement. `detectable` then requires whole and both halves to agree. |

The [statistics reference](statistics.md) defines the intervals, correction
families, interaction tests, ablation fits, clustering and uncertainty. The
API uses the same calculations as the human page; it does not replace them
with agent-specific approximations. Null is never a score of zero.

## Analysis modes

### `schema`

| Field | Meaning |
| --- | --- |
| `profile` | Recognized profile ID or null. |
| `fields[]` | Recorded/inferred column descriptions: names, roles and profile-dependent metadata. Use roles to distinguish parameters, outcomes and diagnostics. |
| `dimensions[]` | Dimension descriptors and exact level keys usable in conditions. |
| `targets[]` | Available needle descriptors. |
| `objective` | Ordered `[column, direction]` ranking rules; null/absent objective prevents Trial ranking. |
| `gates[]` | `id`, `label`, `need`, `definition` for runner/standing/custom gates. |
| `replay` | Replay `title` and optional refusal reason, or null. |

Schema is scoped to the run and explicit state, including added gates and
half-reading mode. Rediscover it when run identity/profile changes.

### `board`

`base` is the context summary; `tests` is the number of finite one-way tests;
`effects` is the ordered dimension-effect array described above. It includes
per-level support/intervals, raw and adjusted tests, best/worst/dead levels,
and half agreement where measured. `moderators` is a scan of parameters whose
effect depends on another parameter. It has `tests` and `byDim` (object keyed
by dimension ID). Each entry has `mods` and `acts`. Moderator records name
`dim`, `parent`, `label`, `p`, `F`, `omega2`, `q`, `detectable`. `acts` is null
or `{parent, label, p, q, kind, on, off, offPooled, strongest}`: `kind` is
`only`, `modulated` or `unresolved`; on/off lists contain the per-parent-level
effect tests. The correction family is the scan's tested candidates,
not every imaginable interaction. Scoped dimensions use their applicable
population. Do not read `na` as a measured null parameter value.

### `pocket`

| Field | Meaning |
| --- | --- |
| `n`, `rowCount`, `share` | Measured needle support, selected row count, selected fraction of context rows. |
| `mean`, `lo`, `hi`, `hits`, `withheld` | Pocket estimates, binary hits and support withholding. |
| `base`, `lift`, `recall` | Context summary; continuous difference or binary pocket/base rate ratio; fraction of context hits kept (binary only). |
| `halves`, `halvesP` | First/second halves by **arrival order**, their summaries and comparison p-value. These differ from measured test-window halves controlled by `firstHalf`. |
| `blocks[]` | In pocket order: `without` (summary with this condition removed), `removed` (rows this condition excludes), `p`, `q`, and `kind`: `earns`, `hurts`, `changes`, `narrows` or `few`. |
| `steps[]` | Cumulative pocket summaries, one per prefix of the condition list. |
| `suggestions[]` | Candidate condition `dim`, `dimLabel`, `key`, `label`, `n`, `mean`, `lo`, `hi`, `hits`, `bound`; ranked by conservative interval end in the better direction. |
| `comparison` | Second pocket's summary, or null when `pocketB` is null. |
| `manifest` | Narrowed manifest result described below. |

### `pairs`

| Field | Meaning |
| --- | --- |
| `pairs.dims`, `pairs.of` | Tested dimension IDs and count before the UI candidate cap. |
| `pairs.list[]`, `pairs.byKey` | Pair records, also keyed by `a|b`: `a`, `b`, `p`, `q`, `omega2`, `test`, `detectable`, `V`, `pV`, `linked`. V/pV concern parameter association, not needle interaction. |
| `pairs.rows` | Scalar context row count. |
| `plan` | For order >2: `size`, dimension `pool`, available count `of`, planned `sets`; null for order 2. |
| `sets` | Higher-order search: `size`, `pool`, `of`, `sets`, `tested`, `sparse`, `list`, scalar `rows`. List records have `dims`, `p`, `omega2`, `q`, `detectable`. Null for order 2. |
| `selected` | `dims` plus selection `why`, or null. Explicit selections have no automatic selection reason. |
| `detail` | Selected pair/combination's cell counts/means and interaction test, or null. Cell level metadata supplies axis order; sparse or unsupported cells may lack estimates. |

Higher orders test the interaction beyond lower-order terms. Candidate budgets
mean the search is not exhaustive over every dimension. Binary and continuous
needles use different tests. Read returned `test` and support.

Pair `detail` has `ka`, `kb` (axis level counts), `table[]`, `N`, `F`, `p`,
`omega2`, `dfI`, `dfW`, `SSI`, `SST`, `cells`, `test`. Each table entry is
`{a, b, n, mean, lo, hi, withheld, fitted}`; a/b are zero-based schema level
indices. Fitted is the additive mean without interaction. A binary pair adds
`D` and `dfLR` for its likelihood-ratio test. Higher-order detail has `k`
(order), `cells`, `minN`, `sparse`, `p`, `omega2`, `N`, `df`, `dfW`, `F`;
supported fits also have `SSI`, `SST` and binary `G`. Its `table` describes
combination `at` indices, level `keys`, `n`, `mean`, `lo`, `hi`, `withheld`.
Sums of squares and degrees of freedom describe the model fit, not
additional independent claims.

### `features`

`limen` is null when there is no suitable Limen feature design. Otherwise:
`design` describes groups/columns and ablation design; `halves` marks measured
half evidence; `groups` contains level summaries and paired group `contrasts`;
`columns` is null, `{missing: true}`, or `members`, `fit`, `factors`, `recorded`,
`dropped`. Missing means dropped columns were not recorded, not zero effects.

`fit` contains `terms`, `rows` (fitted support), `fitted` and `params` (parameter
count). Terms identify `members` (columns dropped together), `drops` (support)
and `mi` (member indices), plus `beta`, `se`, `keep`, `lo`, `hi`,
`p`, `q`, `detectable`, and `reason` (`few`, `aliased` or null). `keep` is the
negative drop coefficient. Factors adjust the fit for parameter variation;
the fit is not an unadjusted winner list.

`sets[]` covers generic set-valued parameters: `col`, member dimension
descriptors, `size` dimension descriptor and `res`. `res.base` is a summary;
`res.members[]` contains `id`, `name`, `nIn`, `nOut`, `inMean`, `outMean`,
`delta`, `se`, `lo`, `hi`, `z`, `p`, `share`, `binary`, `q`, `detectable`.
The delta is adjusted within subset-size strata.
Feature `design` contains `groups[]` (`name`, feature `funcs`), `always`
features, `naming` parameter IDs and `ablation` (`countKey`, `seedKey`) or null.
Group `contrasts[]` name `added`, `from`, `to`, `delta`, `lo`, `hi`, `p`, `q`,
`detectable`, plus optional half agreement. From/to are level summaries with
`key`, `label`, `groups` and `rowCount`.

### `trials`

| Field | Meaning |
| --- | --- |
| `list[]` | Ranked rows with `i`, objective `rank`, `tie`, full `reference`, replay snippet or null, `parameters` object, and `outcomes[]` of `{target, value}`. Rank is not a row index. |
| `n`, `missing` | Rows with all objective values and rows without them. |
| `cut` | Boundary tie omitted rather than split: `{rank, n, row}`, or null. |
| `movers` | Dimension descriptors used for like-row estimates. |
| `limit`, `offset` | Ranking cap (always 100) and requested page offset. Response `limit` is not the requested page length. |

No declared objective returns `{available: false, reason}` instead. Ordering
uses the runner's objective, which can differ from the selected needle.
Changing the needle does not rewrite the runner's ranking. The requested
`limit` slices the best-100 list; it cannot retrieve rank 101 onward.
Each listed row also has `like`: `j` (number of matching mover dimensions),
`dims`, `n`, and mean/interval statistics for other rows sharing those values.
This estimates what its parameters earned without that row's own result.

### `gates`

Each `gates[]` record has `id`, `label`, `need`, `unit`, `n`, `passed`, `rate`,
`lo`, `hi`, `never`, `always`, `ruleOfThree`, `quantiles`, `values` and
`correlate`. `quantiles` names `p05`, `p25`, `p50`, `p75`, `p95`, `max`.
`values` is a count, not a per-row array. `correlate` is an associated
numeric needle diagnostic `{target, label, r, n}` for never-passed gates,
otherwise null. The rule of
three is the upper rate bound when no known row passed.

`together` is null with no gates. Otherwise it contains `all` (pass all),
`decided` (all-pass/failure known), `most` (maximum gates passed), `atMost`
(rows at that maximum), and `cf` (co-failure summary or null). `cf.total` is
the near-best population size; `cf.combos[]` has `failing` gate IDs, `count`
and `share`. Missing gate values cannot establish an all-pass result.

### `run`

| Field | Meaning |
| --- | --- |
| `health` | `line`, critical `issues` count, `problems`, `rate`, `total`, `seg`: ingestion/run health and optional log/rate evidence. |
| `log` | Recorded parsed log, or null; segments, progress and sampler diagnostics depend on the source. |
| `clusters` | Cluster result described below. |
| `selection` | `whole`, `against` selected clusters' complement, or two-cluster `compare`. |
| `composition` | Parameter association with selected cluster groups; null without clusters. Includes per-level population shares and adjusted comparison evidence. |
| `distributions[]` | `target`, `drawn`, `test`, `q`, `groups`. Each group has `label`, `n`, `missing`, and five `quantiles` at 0.05, 0.25, 0.5, 0.75, 0.95. |
| `records` | `points[]` (`n`, `row`, `best`, `luck`, `mean`), `records[]` (`n`, `row`, `value`), `lastRecordRow` (-1 if none). Luck is the expected best under equal configurations plus noise, not a confidence interval. |
| `reliability` | `{rho, lo, hi, n}`: Spearman rank agreement across measured halves, or null without halves; estimates can be null with insufficient paired rows. |
| `marketHalves` | Two `{median, n}` market-return summaries, or null; suppressed in first-half mode. |
| `heldBack` | `rounds`, `never`, `held`, `nothing`, `unknown`, `short`, `reach`, `shortMedian`: recorded-output counts and threshold shortfalls for never-trading rounds, or null when unrecorded. |
| `sampler.independence` | Pair records `a`, `b`, `V`, `p`, `chi2`, `df`, `n`: parameter associations over all replay rows, before context filtering. |
| `sampler.uniformity[]` | Per-dimension `dim`, `N`, `chi2`, optional `df`, `p`, `shares`, optional `counts`; level order is schema order. |

Clusters contain `clusters[]`, `scores`, `outcomes`, `left`, scalar `rows`,
and, when available, `best`, `k`, `silhouette`, `grade`. A `reason` of `few`,
`flat` or `weak` explains no usable groups. Cluster entries include `id`,
`index`, `n`, `share`, `rowCount`, `medians`, and `standsOut` separation
diagnostics indexed by outcome. Medians follow `outcomes` order.
IDs are stable only for the same captured calculation. Do not reuse cluster
IDs after changing capture/context/count.

`drawn` marks a target used to construct clusters. Such targets are not
independent evidence that the resulting clusters differ. Tests can therefore
be null for drawn outcomes or whole-population selection. Binary comparisons
report `p`, `binary`, `ra`, `rb`; continuous rank comparisons report `p`,
`shift`, `na`, `nb`.

Composition records contain dimension descriptor `dim`, support `n`, selected
`inGroup` count, `p`, `G`, `V`, `q`, and `levels[]` of `{level, inGroup, inRef,
n, hits}`. Level inGroup/inRef are shares, while the record's inGroup is a
count. Whole selection returns one composition list per cluster; direct or
complement comparison returns a single list. Scores in `clusters.scores`
describe candidate k fits rather than separate group tests.

### `cohort`

| Field | Meaning |
| --- | --- |
| `pool`, `ranked` | Rows satisfying pocket/gates and rows with ranking evidence. |
| `members[]` | Full row references for the selected member rounds. |
| `warning` | Selection/gate overlap caveat, or null. |
| `firstHalfSelection` | Whether measured half data supports first-half ranking; do not infer this from the requested boolean alone. |
| `gates[]` | Gate read provenance: `id`, `label`, `firstHalf`. |
| `state` | Selection state (also present in the wrapper). |

Unsuitable profiles, including walk-forward, return `{available: false,
reason}`. Selection does not promise that evaluation/training prerequisites
are recorded or that a useful cohort exists. Pass references intact to the
evaluation and predictor tools; do not send `members` as an integer there.

### `manifest`

Also returned as `pocket.manifest`. Without recorded YAML it returns
`{available: false, reason}`. Otherwise: `available: true`, narrowed YAML
`text`, `changed` parameters, `problems`, `before`, `after` (combination counts).
Combination counts are decimal strings, preserving arbitrary-size integers.
The narrowing combines context/pocket conditions. Gate definitions, cluster
selection and inferred dimensions are not automatically converted into a
trainable manifest. Inspect problems and use `grid_validate` before saving it
as a new experiment. Analysis never saves this result automatically.

## Cohort evaluation payload

| Field | Meaning |
| --- | --- |
| `bars`, `first`, `last`, `step` | Common test-bar count, first/last Unix timestamps and interval in seconds. |
| `between` | Bars between members' first/second-half boundaries; excluded from both half judgements. |
| `fee`, `slip` | Applied basis-point costs (default: member-recorded common costs, with fallback). |
| `architecture`, `aggregation` | Member architecture and `probability_weighted` or `majority_vote`. |
| `fired` | Share of common bars with a long signal; not the share of entered trades. |
| `cohort` | Whole/first/second execution windows below. |
| `members[]` | Each member's `id` and equivalent windows, rebuilt with the same costs. |
| `notes[]` | Interpretation caveats: differing windows, simplified exits, calibration mixes or history-sensitive features. |
| `rows`, `dirs` | Source row indices and shard labels for evaluated members. |

Both cohort and member windows are `{whole, halves}`. `halves` is a two-element
array in first/second order, or null when a half is empty. Each window has:

| Window field | Meaning |
| --- | --- |
| `bars`, `trades` | Window bar count and reconstructed trade count. |
| `tradeMean`, `tradeT` | Mean trade return in bps and per-trade t statistic; t requires at least 30 trades and nondegenerate variance. |
| `pnl`, `cost` | Mean net return and execution costs per bar in bps. |
| `wins` | Share of bars with positive net return. |
| `inventory` | Mean deployed position notional. |
| `timing` | Gross return beyond notional exposure times mean market return, in bps; null without market data. |
| `market` | Compounded market return as a fraction, not bps. |

Execution windows compare the cohort and each member on shared bars with the
same long/flat reconstruction. This is observed recorded-signal evaluation,
not a new backtest of the trained artifact. Read the returned notes: recorded
take-profit/stop-loss exits are not recreated, and differing test windows can
leave bars outside both halves. Use the second-half windows to judge a
first-half selection. Predictor training is a separate asynchronous operation.

## Sparse halves and file-source cohort evaluation

Recorded half arrays retain unavailable values independently. An unavailable
second half never substitutes a whole-window gate for first-half evidence.
A gate without first-half measurements admits no rows and produces a warning.
`firstHalfSelection` is false if any selection gate reads the whole window.

Cohort selection reports `evaluation: {available, reason?}` after probing the
selected members. Evaluation prefers recorded `alignment.test_datetimes`.
For manifests without `kline_size`, a project uses its configured Limen Python
to rebuild the exact test-bar timestamps from the original source and recorded
manifest/parameters, including native Parquet and Arrow loaders. It performs
no model fitting. Missing, duplicate, reordered or mismatched timestamps fail
with an actionable error. Keep the original source available and unchanged;
Grid does not invent regular bars for an irregular file. Evaluation reports
`timestampSource` and a null `step` when no regular interval is declared.

## Native rule parameter references

Limen 5.27.0 resolves references in predicate `column`, `other_column`,
threshold `value`, slope `lookback`, and SQL `expr` fields. Operators,
directions, condition IDs and temporal modifiers are not templated by that
implementation. Write `recency_n` and `persistence_n` as block fields with
constant positive integers. Grid preflight rejects their unresolved references
and invalid constants with the field path and line before any run directory
or process is created. Native temporal reference resolution depends on
[Limen #925](https://github.com/Vaquum/Limen/issues/925); Grid does not resolve
these fields itself or claim factorized equivalence for unsupported references.
