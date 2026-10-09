# Tessera

A monitor for parameter sweeps. It follows a running sweep's results file
and log, and shows how each parameter moves the outcome, with the
uncertainty of every number. Built for the plate sweeps on s0 (grand,
PocketA, logregone); any sweep that writes one JSON object per line works.

The Board leads: a strip that sums it up, then one card per parameter,
strongest first, with how strong and how sure its effect is and the
needle at each of its values (a number's values on x, small to large; a
category's as bars), every card on one shared scale. Choosing a card opens
it in the inspector. Pockets are built by stacking value blocks.

## Run it

The page is built once; the server needs only Python's standard library.

```sh
python3 tools/build.py
```

Follow a sweep on s0 from the laptop (nothing is installed on s0: the
server runs `tail -F` there over SSH):

```sh
R=/srv/<deployment>/research
python3 -m tessera serve --ssh user@sweep-host --name PocketA \
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

A static snapshot, for reading offline or sharing:

```sh
python3 -m tessera pack --results … --log … --out sweep.pack.json.gz
python3 tools/build.py --pack sweep.pack.json.gz --out sweep.html
```

`--as LOCAL=SHOWN` makes a pack built from copied files name where they
came from.

A live demo without any real sweep: a simulated sweep writes its files at
a sweep's pace, crashes and relaunches.

```sh
python3 tools/live_demo.py --out /tmp/tessera-live --port 8765
```

## Views

| Key | View | What it answers |
| --- | --- | --- |
| 1 | Board | Which parameters move the needle, where each of their values puts it, where each acts |
| 2 | Pocket | What a stack of values holds, what a sweep inside it would hit, its code |
| 3 | Pairs | Which parameters change each other's effect; which the sampler drew together |
| 4 | Features | What including each member of a sampled subset does |
| 5 | Trials | The best rows by the runner's own objective, each replayable |
| 6 | Gates | Which gates the space can pass, what bounds the ones it cannot |
| 7 | Run | Pace, segments, crashes, warnings, invariants, the sampler, luck |

The needle (T) is the outcome every view measures: Tradeable (gates ≥ 6
and total ≥ $3,000, the definition Pocket A was mined with), any metric,
or any gate's pass. The context narrows every view to rows that hold
chosen values (C on a value; Shift C clears). The replay edge hides every
row after it (Home, [, ], Space, End). The address holds the view, so a
link reopens it. I opens the reference: every surface and every number,
with Purpose, Read and Use.

## What it reads

One row per results line. Nested dicts become dotted names, lists of
strings sets, short lists of numbers one column per position. A null value
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

## Develop

```sh
python3 tools/build.py                       # dist/tessera.html
./tools/check.sh                             # every check, stops at the first failure
TESSERA_PLAYWRIGHT=/path/to/playwright/index.mjs ./tools/check.sh   # with browser tests
```

`tools/check.sh` runs the Python tests, the JavaScript tests, pyright
(strict for `tessera/` and `tools/`), ruff, `node --check`, the build, and
the browser tests when `TESSERA_PLAYWRIGHT` is set. The reference values
need numpy, pandas and scipy: `python tools/golden_engine.py --out
tests/golden/engine.json`.

- `tessera/`: columnar store, log parser, followers (file, SSH), server, CLI
- `web/js/`: stats, pack decoding, schema and profiles, the engine, the views
- `tools/`: build, synthetic sweeps, simulator, live demo, reference values
- `tests/`: Python, JavaScript (against scipy references) and browser tests
