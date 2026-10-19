# Agent workflows

These examples use Grid's [public JSON CLI](agents.md), not Python internals.
Run commands from the Grid checkout with Python 3.11+ and Node.js 18+.
The [executable example](../tools/agent_workflow.py) needs no additional packages.
It prints one JSON object and exits 0 on success, 1 on failure.

## 1. Connect and choose a workflow

Start the server in one terminal; `--agent-file` must name a new file:

```sh
python3 tools/build.py
python3 -m grid serve --project ~/limen-lab --agent-file /tmp/grid-agent.json
```

The existing project must contain `limen.toml`, a working Limen installation,
and accessible data for the manifest you intend to run. Grid selects the
project's `.venv/bin/limen`, then `limen` on PATH; `--limen-cli PATH` overrides
it. Predictor training uses that installation's Python; use
`--limen-python PATH` if it cannot be inferred.

For a reproducible analysis-only example using the repository's recorded data:

```sh
python3 -m grid serve --limen tests/fixtures/limen_cohort \
  --agent-file /tmp/grid-recorded-agent.json
```

Use `/tmp/grid-recorded-agent.json` for inspection in this case. Project writes
need the project server, not this recorded-results server. These fixtures are
synthetic test evidence, not research results.

```sh
python3 -m grid agent --connection /tmp/grid-agent.json grid_discover
python3 -m grid agent --connection /tmp/grid-agent.json grid_status
```

Discovery contains the exact input schemas. Status separates `runs` (loaded
analysis runs such as `r0`) from `project.runs` (project run directories).
Copy IDs from these responses. A new project can have no loaded analysis runs
until an experiment produces results and is opened.

## 2. Inspect a pinned capture

```sh
python3 tools/agent_workflow.py --connection /tmp/grid-agent.json \
  inspect --run r0 > /tmp/grid-inspection.json
```

Substitute a loaded analysis run ID, or omit `--run` for the first loaded run.
The script reads schema, Board and five top Trials on one snapshot. It returns
`schema`, `board` and `trials`, each the `result` of a Grid analysis envelope.
They share a snapshot ID and row evidence. Use `schema.viewLink`, resolved
against the connection URL, to inspect the same capture in the human page.

To ask your own question, save an argument object and call the CLI:

```sh
python3 -m grid agent --connection /tmp/grid-agent.json grid_analyze \
  --args '{"analysis":"schema","state":{"run":"r0","firstHalf":true}}' \
  > /tmp/grid-schema.json
```

The following uses IDs and level keys from the actual response. It changes
only the question and retains the snapshot:

```sh
python3 - <<'PY' > /tmp/grid-pocket-args.json
import json
query = json.load(open('/tmp/grid-schema.json'))['result']
state = query['state']
dims = query['result']['dimensions']
dim = next((d for d in dims if d['levels']), None)
if dim:
    state['pocket'] = [{'dim': dim['id'], 'keys': [dim['levels'][0]['key']]}]
print(json.dumps({'analysis': 'pocket', 'snapshot': query['snapshot']['id'],
                  'state': state}))
PY
python3 -m grid agent --connection /tmp/grid-agent.json grid_analyze \
  --args-file /tmp/grid-pocket-args.json
```

This selects the first available dimension/level only to demonstrate the
contract. Choose a scientifically justified condition for actual work. Read
support, intervals, warnings and selection provenance before interpreting it.
Null estimates are unavailable; a pocket's binary `lift` is a ratio, while
continuous `lift` is a difference.

For a new live capture, omit `snapshot` and set `state.edge` to null. Reusing
returned state without resetting its edge preserves the old replay boundary.

## 3. Create, validate, save, run and open an experiment

Discover the available templates in `grid_status.result.project.templates`.
Then choose an unused experiment name and either a discovered template or
your own manifest file:

```sh
python3 tools/agent_workflow.py --connection /tmp/grid-agent.json \
  --journal /tmp/grid-intents.jsonl --timeout 600 \
  experiment --name agent-demo --template lightgbm_binary \
  --rounds 100 --shards 1 > /tmp/grid-experiment.json
```

Or replace `--template lightgbm_binary` with `--manifest /path/to/manifest.yaml`.
The template name above must be present in your Limen installation. Template
creation does not configure your data source: use a prepared manifest when
the template needs project-specific edits.

The script executes `grid_create` → `grid_manifest` → `grid_validate` →
`grid_diff` → `grid_save` → `grid_start` → repeated `grid_status` →
`grid_open` → pinned analysis. It refuses nonempty validation errors and
uses the returned manifest version for save and start. New runs default to
Sweep. Pass `--recording-mode inspect` to retain complete diagnostic evidence;
both named modes require Limen 5.30.2 or later.

Its result contains `projectRun`, `analysisRun`, observed terminal `job`,
`diff`, and `analysis`. A `finished` job confirms processes completed; it does
not establish scientific quality. Inspect shard exits, row counts and reports.
A timeout ends the example's wait; it does not cancel the experiment.

The private journal records each exact operation, arguments and generated
`requestId` before sending. Use a new journal path or keep it private; it
contains manifest and selection data. Rerunning `experiment` is a new intent,
not a retry: the existing name will be refused. Recover interrupted writes
as described below instead of restarting the entire workflow.

## 4. Stop and resume

Use `projectRun` from the experiment response, not the analysis run ID:

```sh
python3 tools/agent_workflow.py --connection /tmp/grid-agent.json \
  --journal /tmp/grid-intents.jsonl \
  control stop --run results/dev/agent-demo/RUN_STAMP
python3 tools/agent_workflow.py --connection /tmp/grid-agent.json \
  --journal /tmp/grid-intents.jsonl \
  control resume --run results/dev/agent-demo/RUN_STAMP
```

Replace the entire `results/...` value with the actual project run ID from
status. Stop applies to a running experiment; the earlier `experiment`
example waits until it finishes, so use another terminal to stop it while
that example is waiting. Stop returns before process watchers necessarily
record the terminal state. Wait for `state: stopped` and shard checkpoints
before resume. A checkpoint alone does not prove that the old process exited.
The control example performs the corresponding status wait.

Resume returns after launch; monitor until finished if completion is needed.
Already-finished, failed or externally started runs may not support control;
read `OPERATION_FAILED` and the project run evidence.

## 5. Evaluate a cohort and create a predictor

Choose the analysis run ID (`analysisRun` from step 3 or a loaded run in status):

```sh
python3 tools/agent_workflow.py --connection /tmp/grid-agent.json \
  --journal /tmp/grid-intents.jsonl --timeout 600 \
  cohort --run r0 --name agent-demo-cohort --members 5 \
  > /tmp/grid-cohort.json
```

This reads schema with `firstHalf: true` before selection, selects references
on that capture, calls `grid_cohort_evaluate`, then `grid_predictor_create`.
It waits for `made` and returns `selection`, `evaluation` and `predictor`.
The predictor's `cohortId` is the observed bound artifact ID, not the request
ID. Evaluation rebuilds recorded signals and returns whole/first/second
windows; review its second-half result, member comparisons and notes.

For a prechosen pocket/gates/context, supply `--state-file FILE` containing
the raw `state` object from an analysis, not the entire response. The script
refuses a whole-window provenance or an unmeasured first-half needle. Turning
isolation on after a whole-window search does not remove selection leakage.
Optional `--fee` and `--slip` are basis points and must be in [0, 10000).

Members need locally accessible round recordings, one compatible architecture,
and shared test bars. Weighted architectures require recorded probabilities.
SSH results and walk-forward trials cannot create predictors. Training success
does not certify evaluation quality; the example intentionally applies no
invented profitability threshold.

## 6. Recover a lost write response

Read the request ID from the private JSONL journal, then:

```sh
python3 tools/agent_workflow.py --connection /tmp/grid-agent.json \
  recover --request-id THE_ORIGINAL_REQUEST_ID
```

For a `complete` receipt, inspect `result.response.ok` and use the stored
response. For `running` or `OUTCOME_UNKNOWN`, inspect project state before
any new intent. To resend a known original intent, use its journal entry:

```sh
python3 - <<'PY'
import json, subprocess
entry = json.loads(open('/tmp/grid-intents.jsonl').readlines()[-1])
subprocess.run(['python3', '-m', 'grid', 'agent', '--connection',
                '/tmp/grid-agent.json', entry['operation'], '--args-file', '-'],
               input=json.dumps(entry['arguments']), text=True, check=True)
PY
```

Choose the intended journal entry; the last line is only an example. Never
edit its arguments or use a new ID to repeat the same uncertain write.
See [error-specific recovery](agent-errors.md#lost-write-responses).
