# Grid

A monitor for parameter sweeps. It follows a running sweep's results file
and log, and shows how each parameter moves the outcome, with the
uncertainty of every number. Built for the plate sweeps on s0 (grand,
PocketA, logregone); any sweep that writes one JSON object per line works.

The Board leads: a strip that sums it up, then one card per parameter,
strongest first, with how strong and how sure its effect is and the
needle at each of its values (a number's values on x, small to large; a
category's as bars), every card on one shared scale. Choosing a card opens
it in the inspector. Pockets are built by stacking value blocks.

The Run view is the whole run on one page: a card per outcome's
distribution, and the rows grouped into clusters by what they did (their
score and the activity, risk and model skill behind it). Choose clusters
to set them against every row, or compare two; what makes each cluster is
tested on the parameters, never on the outcomes the clusters are drawn
on. No cluster is drawn when the rows do not fall into groups.

## Run it

The page is built once; the server needs only Python's standard library.

```sh
python3 tools/build.py
```

Follow a sweep on s0 from the laptop (nothing is installed on s0: the
server runs `tail -F` there over SSH):

```sh
R=/srv/<deployment>/research
python3 -m grid serve --ssh user@sweep-host --name PocketA \
  --results $R/data/pocketA/results.jsonl --log $R/pocketA_sweep.log \
  --run "pre-P0=$R/data/pocketA/results_preP0_20261008_182937.jsonl#0" \
  --run "label=logregone,results=$R/data/logregone/results.jsonl,log=$R/logregone_sweep.log" \
  --open
```

Follow local files the same way without `--ssh`. `--results` is the run
being written now, `--log` its stdout. `--run LABEL=PATH#SEGMENT` adds an
earlier run kept under another name (its rows came from that segment of
the same log); `--run label=…,results=…,log=…` adds a run with a log of its
own.

A Limen experiment, live while `limen run` writes it: give the result
directory. Its `metadata.json` holds the manifest, whose `sfd.params` are
the parameters; every other column of `results.csv` is one of Limen's
round metrics (named and given a direction once, in
`web/js/profiles.js`) or the round's bookkeeping. Nothing is inferred.
A run recorded with `uel.record_model_outputs` (Limen 5.17) also says,
round by round, how near its test probabilities came to its threshold,
and its Run view sets apart the rounds that never traded: those the
threshold held back, their models still ranking the test bars, and those
that found nothing. LightGBM's and XGBoost's `best_iteration` is a fit
diagnostic. A run recorded with `uel.record_execution` (Limen 5.16) says
what each round's test window did, bar by bar: its trades (with their
mean and per-trade t, and Grid's gates at 30 entries and a t of 2), and
each half of the window read as a window of its own, so an effect counts
only when it shows in both, Trials sets every row's first-half rank
against its second half, and the Run view gives the halves' rank
agreement as the run's reliability. From Limen 5.20, which records the
market's return on each bar too, each round's timing: its gross return
beyond its deployed notional times the market's. From Limen 5.23,
whether each round recorded a convergence warning is a fit diagnostic,
and the Run view gives the report Limen writes at the run's end. A
walk-forward run (Limen 5.21, `split_walk_forward`) reads a row a trial,
its means over its folds, with its selection report in the Run view (the
deflated Sharpe probability, the probability of backtest overfitting and
the declared thresholds' verdicts, Limen 5.22); Limen replays none of its
trials and makes no sensor of one, so Grid offers neither.

```sh
python3 -m grid serve --limen ~/dev/Limen/results/dev/lightgbm_binary_full_20261009_091248 --open
```

Several `limen run` side by side on one manifest, each with its own
search seed (`uel.search_strategy.seed`), write as many result
directories: give each with `--limen`, or the folder that holds them, and
they read as one run, each row with its directory in `shard`. Directories
whose manifests differ in more than the seed are refused.

On a Limen project (a folder with `limen.toml`, as `limen new` makes),
Grid also makes and runs its experiments. The Experiment view (0) edits
each working manifest in `manifests/`, checked by `limen validate` as you
type, with its problems on their lines and the size of its search space;
starts a new one from a template, from the run in view, or from any
view's manifest narrowed to the pocket; compares it with the manifest its
last run started from; and runs it in shards side by side (`limen run` on
copies whose search seeds differ, each on its share of the rounds and the
cores, recording each round's execution and model outputs), with Limen's
own stop and resume. A run opens in the analysis views once each shard
has written a round.

```sh
python3 -m grid serve --project ~/limen-lab --open
```

On a Limen run that recorded its model outputs and execution, the Cohort
view (8) takes the pocket found with the other views to a cohort. The
pool is the rows in view that are in the pocket and pass every gate set
in Gates; its members are the pool's best by the needle on the first half
of the test window, from any of the run's result directories (each shard
is a manifest of its own, and Limen 5.24's `Cohort` binds the rounds of
several).
The cohort is judged on the second half, which chose nothing: rebuilt
from what the run recorded (the members aggregated as Limen's Cohort
aggregates their architecture, by their probabilities averaged or by
their votes, and executed as Limen executes a signal), against its best
member alone and its members' mean. On a
project, Make predictor has Limen's `Trainer` train each member again on
the data its round used and Limen's `Cohort` bind them, into
`cohorts/<name>/`: Limen's cohort id, each member's sensor beside a
sidecar of the versions it was made with (the layout Furnace reads), in a
result directory of them for each one they come from, and how its members
were chosen. Members from several result directories need Limen 5.24 or
later.

Grid reaches Limen through its command line (`--limen-cli`, by default
the project's own `.venv/bin/limen`, else the one on the PATH) and, to
make a predictor, a script run in Limen's own Python
(`grid/limen_cohort.py`; `--limen-python`, by default the one the limen
command's script names); Grid's server imports nothing of Limen.
A write needs the page's own token, from the page's own origin; on a
project the server answers only requests that name it by its address or
as `localhost`.

A static snapshot, for reading offline or sharing:

```sh
python3 -m grid pack --results … --log … --out sweep.pack.json.gz
python3 tools/build.py --pack sweep.pack.json.gz --out sweep.html
```

`--as LOCAL=SHOWN` makes a pack built from copied files name where they
came from.

A live demo without any real sweep: a simulated sweep writes its files at
a sweep's pace, crashes and relaunches.

```sh
python3 tools/live_demo.py --out /tmp/grid-live --port 8765
```

## Agents

Agents can use every analytical view and the experiment/cohort workflow
through a JSON CLI/API or MCP stdio. Start with
`python3 -m grid serve --project ~/limen-lab --agent-file /tmp/grid-agent.json`,
then `python3 -m grid agent --connection /tmp/grid-agent.json grid_discover`.
For MCP, use `python3 -m grid mcp --connection /tmp/grid-agent.json`.
Headless analysis requires Node.js 18 or later. See
[the connection guide](docs/agents.md), [tool and response reference](docs/agent-reference.md),
[runnable workflows](docs/agent-workflows.md), and [error recovery and limits](docs/agent-errors.md).

## Views

| Key | View | What it answers |
| --- | --- | --- |
| 0 | Experiment | On a Limen project: its experiments, a manifest checked as it is typed, a run in shards, stopped and resumed |
| 1 | Board | Which parameters move the needle, where each of their values puts it, where each acts |
| 2 | Pocket | What a stack of values holds, what a sweep inside it would hit, its code |
| 3 | Pairs | Which parameters change each other's effect; which the sampler drew together |
| 4 | Features | What including each member of a sampled subset does |
| 5 | Trials | The best rows by the runner's own objective, each replayable |
| 6 | Gates | Which gates the space can pass, what bounds the ones it cannot |
| 7 | Run | Pace, segments, crashes, warnings, invariants, the sampler, luck |
| 8 | Cohort | On a Limen run: a cohort chosen on the first half of the test window, judged on the second, made a predictor |

The needle (T) is the outcome every view measures: Tradeable (gates ≥ 6
and total ≥ $3,000, the definition Pocket A was mined with), any metric,
or any gate's pass. On a run whose needles are measured on each half of
the test window, First half (H) reads every one of them on the first half
only, gates set on them too, and no view shows the second: the half the
Cohort view judges a cohort on stays unseen while its pocket is found. A
needle not measured on each half reads the whole window and says so. The
context narrows every view to rows that hold
chosen values (C on a value; Shift C clears). The replay edge hides every
row after it (Home, [, ], Space, End). The address holds the view, so a
link reopens it. I opens the reference: every surface and every number,
with Purpose, Read and Use.

## What it reads

One row per results line (JSON lines, or a Limen `results.csv`, whose
empty fields are none and `True`/`False` booleans). Nested dicts become
dotted names, lists of strings sets, short lists of numbers one column
per position. A null value
(`tp: null`, no take-profit) is a value; an absent key (no `max_depth` on a
logreg row) means the parameter does not apply. The plate profile
(`web/js/profiles.js`) names the roles of grand and PocketA fields, the
nine monthly gates and their needs, the runner's objective and the
invariants the runner promises; other fields are inferred and marked.

The log parser rebuilds the runs in a log (starts, relaunch markers,
progress, the closing summary), groups chained and multiprocessing
tracebacks into one crash at the innermost frame in the sweep's own code,
and counts warnings once per kind. A results file that starts over keeps
the rows already read as a run of its own.

## Statistics

Intervals are 95% (Wilson for rates, t for means); values with fewer than
30 rows are withheld. One-way effects: ω² with the F test, or the G-test
for a 0/1 needle. q-values: Benjamini–Hochberg over the tests shown
together. Interactions: variance beyond an additive fit (F), or a logistic
likelihood-ratio test for a 0/1 needle. Moderators are corrected across
the whole board. Feature inclusion is stratified by subset size. The luck
line is the expected best of n equally good configurations. All of it is
checked against scipy, an OLS fit, `chi2_contingency` and pandas on a
synthetic sweep with planted effects (`tests/golden`, `tools/golden_engine.py`).
See [docs/statistics.md](docs/statistics.md).

## Deploy

Grid runs on the Explorer/Composer host, `37.27.112.167`, from
`/srv/grid/checkout` (`/opt/grid` remains an administration symlink).
Docker serves only `127.0.0.1:8490`; the host's Caddy, maintained in
[Vaquum/Portal](https://github.com/Vaquum/Portal), exposes
`https://grid.vaquum.fi` behind Portal's login and provides its landing card.
The page, API and event stream all pass through that authentication gate.

The container includes Limen 5.30.2 and creates an official Limen project
at `/data/project` on first start. The `grid_project` volume keeps its
manifests, experiment results and cohorts across image rebuilds and
redeployments. It runs as an unprivileged user with a read-only image;
only the project volume and temporary files are writable.
The production service also writes a private mode-0600 agent connection to
`/tmp/grid-agent.json`, usable over an SSH tunnel to the loopback listener.
Retrieve it through the host/container administration channel and protect the
local copy; it is regenerated on container restart. Agent requests still require
a localhost/IP Host header and their separate bearer token. Portal protects
the public page; no credential is included in it.
Every service discovers active runs from shared project storage within a
second. Historical runs appear in the catalog after restart and load when
selected for analysis. The project page opens with this lightweight catalog,
independent of historical trial data; only the selected run streams rows. Analysis IDs and pinned snapshots remain local to
each service; agent discovery/status identify its UI origin and instance.
Production confines the checkout and all Docker data (images, builds, project
data and logs) to a fixed 199,000,000,000-byte filesystem mounted at `/srv/grid`.
The isolated engine uses `unix:///run/grid-docker.sock`; temporary runtime
state stays in RAM. The kernel refuses writes at capacity; research data is
never automatically deleted. The 1 GB margin keeps host bookkeeping below
the 200 GB decimal ceiling. Startup and deployment reject a missing or
resized mount. See [storage setup and migration](docs/storage.md).
The configured
`--public-origin https://grid.vaquum.fi` permits that exact public Host
and HTTPS browser Origin, retaining the page token and cross-origin checks.

Every push to main runs the full reusable checks on the same commit, then
syncs it over SSH and rebuilds the service. The host, user, deployment
directory and pinned SSH host key default to this production setup;
repository variables `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_DIR` and
`DEPLOY_KNOWN_HOSTS` can override them. Set `DEPLOY_SSH_KEY` as a repository
secret (or share the organisation's TDW secrets).
The deploy waits for `/api/health` before reporting success.

Container capacity uses the smaller of host CPUs, process affinity and visible
cgroup CPU quotas. Fractional quotas round down to whole worker slots (at least
one). Shards and manifest `uel.workers` share this budget; parallel Limen
workers use one native thread each. `grid_validate` reports schema and known
execution compatibility errors separately. Factorized grids require
`uel.workers: 1`; native parallel rounds require `prep_each_round: true` and
Limen 5.25 or later. Custom code and data availability are checked by Limen
at runtime. See [the issue audit](docs/issue-audit.md).

## Develop

```sh
python3 tools/build.py                       # dist/grid.html
python3 tools/check_agent_docs.py            # links, JSON and agent contract coverage
./tools/check.sh                             # every check, stops at the first failure
GRID_PLAYWRIGHT=/path/to/playwright/index.mjs ./tools/check.sh   # with browser tests
```

`tools/check.sh` runs the Python tests, the JavaScript tests, pyright
(strict for `grid/` and `tools/`), ruff, `node --check`, the build, and
the browser tests when `GRID_PLAYWRIGHT` is set. The same checks run on
every pull request and every push to main
([.github/workflows/checks.yml](.github/workflows/checks.yml)), on Python
3.11 and Node 24 with pyright, ruff and Playwright at the versions pinned
there. Every hour, the limen-updates workflow
([.github/workflows/limen-updates.yml](.github/workflows/limen-updates.yml))
opens an issue for each new Limen release, titled with its version and
the pull request it merged and linking to it (`tools/limen_updates.py`,
with the workflow's own token). The reference values need numpy, pandas
and scipy: `python tools/golden_engine.py --out tests/golden/engine.json`.

- `grid/`: columnar store, log parser, followers (file, SSH), server, CLI
- `web/js/`: stats, pack decoding, schema and profiles, the engine, the views
- `tools/`: build, synthetic sweeps, simulator, live demo, reference values,
  Limen's releases as issues
- `tests/`: Python, JavaScript (against scipy references) and browser tests

## License

[MIT License](LICENSE).
