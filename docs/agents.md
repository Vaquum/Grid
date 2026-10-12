# Grid for agents

Grid's agent interface uses the same model and analytical calculations as
the human interface. It covers all nine views through one versioned JSON
API, a JSON CLI, and a local MCP stdio adapter. Headless analysis needs
Node.js 18 or later; serving the human page still needs only Python 3.11.
No browser is needed for agent operations.

## Connect

Start a project server and create a private connection file at a new path:

```sh
python3 tools/build.py
python3 -m grid serve --project ~/limen-lab --agent-file /tmp/grid-agent.json
```

The file contains the server URL and an agent credential, is created with
mode `0600`, and is never embedded in the page. Existing files are refused.
After restarting the server, use a new file path. Protect and remove the
connection file as a credential. The page's token does not authorize agent
requests. Cross-origin browser requests and indirect Host names are refused.
For read-only sweep analysis, `serve --limen DIR` or `serve --results PATH`
also accepts `--agent-file`; project operations then return `PROJECT_REQUIRED`.

Discover the contract and read the project's state:

```sh
python3 -m grid agent --connection /tmp/grid-agent.json grid_discover
python3 -m grid agent --connection /tmp/grid-agent.json grid_status
python3 -m grid agent --connection /tmp/grid-agent.json grid_analyze \
  --args '{"analysis":"schema"}'
```

Every command prints one JSON envelope to stdout and returns exit code 0
on success or 1 on failure. `--args-file FILE` reads an argument object;
`--args-file -` reads stdin. Results carry `apiVersion`, `ok`, `result` and
`error`. Errors have `code`, `message` and `retryable`; missing numbers are
JSON null, never zero. Estimates below the page's sample floor of 30
carry `withheld: true` and a null estimate; the support count remains.

## MCP

Configure any MCP client that supports local stdio with this command,
running in the Grid checkout (or with Grid installed on its Python path):

```json
{
  "command": "python3",
  "args": ["-m", "grid", "mcp", "--connection", "/tmp/grid-agent.json"]
}
```

The adapter implements MCP initialization, ping, tool discovery and calls,
with JSON Schema inputs and outputs. It negotiates protocol revisions
2025-11-25, 2025-06-18 and 2024-11-05. Notifications receive no response;
stdout contains only newline-delimited JSON-RPC. Tool results contain both
structured JSON and a text copy; operational failures set `isError`.
The adapter is a client of the existing Grid server, so human and agent
operations affect the same project and jobs.

## Operations

`grid_discover` returns the authoritative tool schemas. `GET /api/agent`
also returns discovery when agents are enabled. Calls use
`POST /api/agent`, `Authorization: Bearer TOKEN`, and an `application/json`
body with `operation` and `arguments`.

| Tool | Purpose |
| --- | --- |
| `grid_status` | Runs, errors, experiments, templates, cores, predictor progress; optional `afterVersion` and `timeout` (0–30 seconds) |
| `grid_analyze` | Schema, Board, Pocket, Pairs, Features, Trials, Gates, Run, Cohort selection, narrowed manifest |
| `grid_row` | One row, using its generation-bound reference |
| `grid_reports` | Fresh convergence and walk-forward selection reports |
| `grid_manifest` | Working manifest text and its version |
| `grid_validate`, `grid_diff` | Validate with Limen; compare with the previous run's manifest |
| `grid_create`, `grid_save` | Create from template/text; save the exact version read |
| `grid_start`, `grid_stop`, `grid_resume`, `grid_open` | Start, stop, resume and open project runs |
| `grid_cohort_evaluate` | Judge recorded member rounds on the held-out half |
| `grid_predictor_create` | Train and bind selected members; monitor with status |
| `grid_receipt` | Recover a durable write outcome by `requestId` |

## Analysis state and reproducibility

Ask `schema` first to discover target IDs, dimension IDs and level keys.
Conditions use `{ "dim": "use_calibration", "keys": ["false"] }`;
keys are the schema's keys, not inferred display labels. Context and pocket
are lists of conditions; keys within a condition are alternatives, and
conditions are combined with AND. Null parameter values remain distinct
from parameters that do not apply. Unknown dimensions, targets, levels,
gates and state fields fail instead of silently changing the question.

```json
{
  "analysis": "pocket",
  "state": {
    "run": "r0",
    "target": "backtest_pnl_per_bar_bps",
    "firstHalf": true,
    "context": [],
    "pocket": [{"dim":"use_calibration","keys":["false"]}],
    "gates": [{"id":"positive","target":"backtest_pnl_per_bar_bps","op":">","value":0}]
  }
}
```

Each result returns the explicit state, a snapshot (run, generation,
server instance, replay edge, support, ID and expiry), and `viewLink`.
Resolve the link against the connection's URL to open the equivalent UI.
The link reads the exact captured pack without a live stream; its snapshot
ID grants access to that read-only snapshot, so share it deliberately.
Reuse the returned state and snapshot ID in subsequent queries: the same
rows, schema and round evidence are used even while new rows arrive.
Snapshots expire after ten minutes, on server restart, or when displaced
by four newer snapshots. An expired ID returns `SNAPSHOT_EXPIRED`.
Save the returned state to reuse the question on a new snapshot later.

Pairs accepts `state.order` (2–6) and optional `state.pair` dimension IDs;
the search uses the UI's sample floors, budgets and correction families.
Run accepts `state.clusters`, `compare` and `clusterK` for the same cluster
comparisons and parameter composition. Trials lists the UI's best 100,
with `offset` and `limit` to bound output; ties follow the runner's objective.
Cohort accepts `members` (count, default 5), selecting from the pocket and
gates by the first-half needle. Pass its returned references to evaluation
and predictor creation. Walk-forward trials cannot become predictors.

`firstHalf` reads measured needles and gates on the first half, preserving
the held-out half for cohort judgement. Needles not measured on both halves
retain their whole-window meaning and return a warning. Selection provenance
is retained in `state.found`; turning isolation on does not erase an
earlier whole-window selection. All uncertainty and multiple-testing
corrections use the same calculations as the page.

Row references include the server instance, run, generation and index, plus
the recorded round ID and shard. A restart, reset or changed identity is
rejected with `STALE_REFERENCE`. Append-only arrivals preserve references.

## Writes and job progress

Use a new `requestId` for each new intent; retry with the identical ID and
arguments after a lost response. Grid records the intent before executing,
then keeps the outcome in the project's `.grid/agent-requests/`. The same
request returns the original receipt even after restart; different arguments
with that ID return `REQUEST_CONFLICT`. An interrupted write without a final
receipt returns `OUTCOME_UNKNOWN`: inspect status before issuing a new intent.
Failed receipts are also retained; corrected arguments require a new ID.

Create from a template; read, validate and save the returned manifest version;
start with that exact version and explicit rounds, shards and recording flags.
Start returns a project run ID. Status reports each shard's progress, state,
exit and log tail; open returns the analysis run ID once results exist.
Stop and resume use the project run ID. Predictor creation returns its name;
status reports `training`, `made` with its cohort ID, or `failed` with log evidence.
Completion is the job's observed state, not acceptance of its start request.
