# Tessera design

Tessera monitors a running parameter sweep and explains how each parameter
moves the outcome. It reads what the sweep already writes (a results JSONL
with one row per evaluated configuration, and the runner's stdout log) and
needs nothing from the runner itself.

The reference sweep is PocketA on s0 (`research/pocket_a.py`,
`pocketA_space.yaml`, `pocketA_sweep.log`, `data/pocketA/results.jsonl`):
random search over about 30 dimensions plus a 36-feature subset, every row
scored by the nine monthly plate gates. The grand sweep (552k rows) sets the
scale target: one million rows must stay interactive.

## Sources of the design

- **blockable** (eka-foundation): every interaction is a block, and a block
  reveals itself in five degrees of depth: colour, icon, attributes,
  arguments, code. Blocks are arranged in two dimensions, side by side or on
  top of each other, and the arrangement computes code.
- **Market State Cube Explorer**: every number says what it measures, its
  basis, its support and its clipping; a value below its sample floor is
  withheld, never drawn; missing is never zero; the address holds the view;
  every control has a key and a label; a reference pane explains each
  surface with Purpose, Read and Use; replay hides everything after an edge.

## Data model

A **run** is one results file and, optionally, its log. A sweep can hold
several runs (PocketA keeps its pre-P0 rows as a separate file). Rows are
kept in arrival order; the row index is the replay axis.

Each field gets a **role**:

| Role | Meaning | Example |
| --- | --- | --- |
| param | sampled by the sweep | `model`, `C_meta`, `tp` |
| set | a sampled subset; each member becomes a binary param | `feats` |
| nested | a dict of params, scoped to the value of the param it varies under | `hpcfg.learning_rate@lgbm_hp` |
| effective | a param the runner resolved from others | `cal_applied`, `pf_applied` |
| metric | an outcome | `mean_mo`, `auc`, `sec` |
| gate | a pass/fail check with a value | `gates_detail.wr` |
| diagnostic | an outcome about the fit, not the strategy | `lr_nit_dir`, `cal_fb` |
| id | unique per row | `seed` |
| fixed | one value in every row | `fsize`, `sizem` |

Roles come from a **profile** when one matches (the plate profile covers
grand and PocketA). Without a profile they are inferred, and the page says
which roles were inferred and why. A null param is a level of its own
(`tp = none` means no take-profit). A null metric is missing: it is
excluded from that metric's statistics and counted where it is shown.

A param is treated as **sampled** only if the data shows it is independent
of every other param (Cramér's V below 0.05 in the rows where both are
active). Independence is what makes a marginal difference a causal effect
averaged over the rest of the space; where it fails (PocketA never draws
`pf_frac` for `stack_dir`) the page says so and analyses that param inside
the context where it was sampled.

## Targets

A target is what "the needle" is. The plate profile defines:

- **Tradeable** (default): `gates >= 6 and total >= 3000`, the definition
  used to mine Pocket A.
- **Gates >= 7**, **Gates** (0 to 9), **Mean %/mo**, **Total $**,
  **Max drawdown $** (lower is better), **AUC**, **Log-loss dir / meta**
  (lower is better), **Win days %**, **Signal days**, **Seconds per row**
  (cost, lower is better), and the pass of each of the nine gates.

The leaderboard order is the runner's own objective: gates descending, then
mean %/mo descending.

## Statistics

All statistics are computed on the rows in the current **context** (a
pocket, see below) and up to the replay edge.

- **Per value**: n, mean, 95% interval. Binary targets use the Wilson
  interval; continuous targets use mean ± t(0.975, n−1)·s/√n. A value with
  n < 30 is withheld: drawn as a hollow mark, never as a number.
- **Lift**: value mean minus context mean, in target units.
- **Effect strength**: ω² (bias-corrected share of target variance explained
  by the param alone), with the one-way ANOVA F test. p-values across all
  params tested for the same target and context are corrected with
  Benjamini–Hochberg; q < 0.05 is "detectable". No param is ever called
  inert: the page says "no detectable effect" and bounds the largest lift.
- **Set members** (features): inclusion effect = mean when included minus
  mean when excluded, stratified by subset size (subset size is itself
  sampled and could confound every member), with its interval and q.
- **Conditional activity**: for each param and each other categorical param,
  the param's ω² inside each level. A param whose effect is concentrated in
  some levels is marked "acts when …" (PocketA: `mthr` acts when
  `meta = 1`; `C_meta` acts when `model = logreg`).
- **Interaction**: for a pair, the share of variance explained by the pair's
  cells beyond the two main effects.
- **Dead value**: a value whose 95% upper bound on the hit rate is below a
  fifth of the context's rate, with n ≥ 30 (PocketA: `min_child_weight = 40`
  under `xgb_hp`, 0 tradeable rows).
- **Luck line**: the expected best of n draws if every config were equally
  good and all spread were noise (the false strategy theorem, de Prado):
  mean + s·((1−γ)Φ⁻¹(1−1/n) + γΦ⁻¹(1−1/(n·e))). The record curve is drawn
  against it.
- **Pockets**: a conjunction of value sets. n, hit rate with Wilson interval,
  lift, recall (share of all hits inside), and split-half agreement (first
  half of arrivals against the second). Because every param is sampled
  independently and uniformly, a pocket's observed hit rate is an unbiased
  estimate of the hit rate of a new sweep that samples uniformly inside it.

## Views

1. **Board**: one block per param, sorted by effect strength on the target.
2. **Pocket**: compose a pocket by stacking value blocks; read its numbers;
   copy the predicate and the narrowed space for the next sweep.
3. **Pairs**: interaction strength for every pair; a pair opens as a
   value-by-value grid.
4. **Features**: inclusion effects of every set member.
5. **Trials**: the leaderboard and any row in full, with its replay command.
6. **Gates**: pass rates, never-passed gates and what bounds them, and what
   moves each gate.
7. **Run**: throughput, ETA, segments, crashes, warnings, invariants, the
   record curve against the luck line.

## A block's five degrees

1. **Colour**: the family (backtest, labels, model, features, sizing, logreg,
   hyperparameters).
2. **Icon**: the param's kind (category, number, switch, set member, nested).
3. **Attributes**: on the block's face: effect strength, its interval, q,
   and badges (fixed, alias, acts when, dead value, not independent, so far).
4. **Arguments**: inside the block: every value with n, mean, interval and
   lift, and how its estimate settled as rows arrived.
5. **Code**: the space file lines and sampler lines that define the param,
   and the expressions that reproduce every number shown.

## Live and replay

The server tails the results file and the log (locally, or over SSH with
`tail -F` so nothing is installed on the sweep host) and streams new rows.
A truncated results file starts a new segment. The replay edge hides every
row after it in every view.

## Non-goals

No model of why a config scores what it scores; no recommendation presented
as fact. Tessera describes what the sweep measured, with its uncertainty.
