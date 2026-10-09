# Grid design

Grid monitors a running parameter sweep and explains how each parameter
moves the outcome. It reads what the sweep already writes (a results JSONL
with one row per evaluated configuration, and the runner's stdout log) and
needs nothing from the runner itself.

The reference sweep is PocketA on s0 (`research/pocket_a.py`,
`pocketA_space.yaml`, `pocketA_sweep.log`, `data/pocketA/results.jsonl`):
random search over about 30 dimensions plus a 36-feature subset, every row
scored by the nine monthly plate gates. The grand sweep (552k rows) sets the
scale target: one million rows must stay interactive.

## Sources of the design

- **blockable** (eka-foundation): an interaction is a block that reveals
  itself in degrees of depth, and blocks arranged side by side or on top of
  each other compute something (the Pocket stacks value blocks).
- **Market State Cube Explorer**: every number says what it measures, its
  basis, its support and its clipping; a value below its sample floor is
  withheld, never drawn; missing is never zero; the address holds the view;
  every control has a key and a label; a reference pane explains each
  surface with Purpose, Read and Use; replay hides everything after an edge.
  Its look too: restrained neutrals, colour kept for data and states, one
  type scale, hairlines, small radii. Grid's palette is Kanagawa (Wave in the
  dark, Lotus in the light), so the two read as different instruments.
- **Designed experiments**: a random search is one, so the board reads like
  a main-effects plot: the response at each level of each factor, every
  panel on one scale, against the grand mean.

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
mean %/mo descending (Limen: net PnL per bar descending).

A profile also says what each metric tells about a row's score: the
activity it rests on (signal days; Limen's entries, the entries per bar
times the test window's bars, and its deployed notional), the risk that
came with it (drawdowns, losses), its model's skill (AUC, log-loss,
precision, recall), or the compute it took (seconds per row).

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
- **Pockets**: a conjunction of value sets. n, the needle with its interval
  (Wilson for a rate), lift, recall (share of all hits inside), and
  split-half agreement (first half of arrivals against the second). Because
  every param is sampled independently and uniformly, a pocket's observed
  needle is an unbiased estimate of a new sweep's that samples uniformly
  inside it. A block earns its place when the pocket's rows differ from
  the rows it takes away (those holding every other block but not this
  one): a two-sample z test, Benjamini–Hochberg across the blocks.
- **Interactions of any order**: k parameters act together when their
  cell means over the full k-way grid explain the needle beyond the best
  fit holding every (k−1)-way term among them (weighted backfitting; for a
  rate, the logistic model with those terms by iterative proportional
  fitting and a likelihood-ratio test). A set is tested only when every
  cell holds 5 rows, so its degrees of freedom are Π(levels − 1); with two
  parameters it is exactly the pair test. Sizes 3 to 6 combine only the
  strongest parameters (by main effect or strongest pair: effect
  heredity), at most 2,000 sets or 4·10⁸ rows read a size, corrected with
  Benjamini–Hochberg across the sets tested at that size.
- **Features on a Limen run**: groups compared where two drawn
  combinations differ by one group (a difference of means, BH across the
  pairs). Columns: Limen drops `feature_drop_count` columns chosen with
  `random.Random(feature_drop_seed)`; with few seeds, columns dropped
  together come in fixed sets, so one least-squares model over every
  round with a record (fixed effects for the feature groups, the
  parameters the features take and the parameters that move the needle;
  one term per dropped column) gives each column the effect its varied
  company allows, with HC3 errors (calibrated on null sweeps: 4.5–5.5% of
  terms under p = 0.05, down to 10 drops) and BH across the columns.
  Columns never dropped apart are one term; under 10 drops, no number.
- **Clusters**: rows grouped by what they did. A row is read on the
  outcomes that say so: the runner's objective, and a profile's activity,
  risk and skill metrics (without a profile, every outcome that is not a
  pass flag, a fit diagnostic or a compute cost). Each outcome is replaced
  by its rank among the rows in view (ties at their mean rank), so a heavy
  tail or a heap at 0 weighs like any spread, and each kind weighs alike
  however many outcomes it has. k-means with k-means++ starts from a
  fixed seed (the same rows give the same clusters), four starts a k, for
  k from 2 to 7, on up to 2,000 rows (the centres then refitted on up to
  20,000, and every row placed at its nearest). The k with the best mean
  silhouette (on up to 1,000 rows) is shown; any other whose clusters
  each hold 30 rows and whose silhouette is 0.26 or more can be chosen.
  None is drawn under 0.26 (Kaufman and Rousseeuw: no substantial
  structure; 0.26 to 0.5 weak, 0.51 to 0.7 reasonable, over 0.7 strong).
  A missing outcome is never filled in: distances use the outcomes a row
  has, scaled to the full weight, and a row with under half the weight is
  in no cluster. Clusters are named by size (A the largest) and by the two
  outcomes their centre sits furthest from the middle on, among those
  most of the cluster has, at the cluster's median.
- **Distributions**: each group's share of its own rows per bin (side by
  side), over the 1st to 99th percentile of the rows drawn; a dozen whole
  values or fewer get a bar each. Under the axis, each group's middle half,
  5th to 95th percentile and median. A bin over four times the next is
  broken at twice it, with its share. Medians and quartiles in the text are
  values the rows have, printed as written. The clusters differ on the
  outcomes they are drawn on by construction, so those are never tested;
  any other outcome is, the chosen rows against the rest or one cluster
  against the other (Mann-Whitney U with the tie correction, normal
  approximation; for a 0/1 outcome the G test), q across the cards.
- **What makes a cluster**: each parameter's values inside it against the
  rows it is set against, the G test of independence between being in it
  and the parameter's value, Cramér's V from G, q across the parameters;
  a parameter's most over-represented value is named.
- **Rows like a row**: the other rows that share its values of the
  parameters that move the needle, strongest first, as many of them as
  leave at least 30 rows (the row itself is left out): their mean, with
  its interval, is what those values earn without the row's own luck.
- **Ranks**: rows that tie on the objective share a rank (competition
  ranking, 4=) and keep their arrival order; a tie that runs past the
  list is not listed but told as one group, since inside it the order
  means nothing.
- **Recorded precision**: one row's value is printed no finer than the
  decimals its target was written with (Limen writes net PnL per bar to
  0.1 bps: a round's 0.7, not 0.700); means keep the shown digits.
- **Shown digits**: a target is printed with its profile's digits, or more
  when its means are smaller than those can print: two significant digits
  at the larger of the mean's size and its 95% half-width over every row
  (Limen's net PnL per bar sits near −0.02 bps). Not the rows' spread: most
  rounds can score exactly 0 and a few far out.

## Views

The Board, the Pocket, Pairs, Trials, Gates and the Run open with a strip
of their figures and their blurb behind an (i) (a click opens it, and so
do five seconds resting on the (i)); Features follows in its own pass.
A tooltip shows after half a second, and the next one at once. Every view ends with
the experiment's manifest, folded: the copy `limen run` kept, shown as
written, narrowed to what the view looks at (the pocket, or the context)
by rewriting only the narrowed parameters' lists, in their own spelling,
with what each was. What cannot be narrowed is said in the page and in the
text. A sweep without a manifest has no such section.

1. **Board**: a strip that sums the board up, then one card per param,
   sorted by effect strength on the target.
2. **Pocket**: a strip of the pocket's figures; the stack, read bottom up
   as a path from the rows in view, each block saying whether it earns its
   place; and the blocks to add, ranked and every one, under one search.
3. **Pairs**: a strip of the chosen size's figures; the interactions of 2
   to 6 parameters ranked (or, when none is detectable, the closest) over
   the map of every pair (interaction under the diagonal, the sampler's
   dependence above), and beside them the chosen set: a pair as a
   value-by-value grid with each value's margin, three as that grid for
   each value of the third, more as their best and worst combinations.
4. **Features**: on a Limen run, from its manifest and round log, the
   drawn combinations of feature groups and what adding one group did,
   and the effect of keeping each column its ablation dropped; on a sweep
   that draws subsets of a pool, every member's inclusion effect.
5. **Trials**: a strip that sets the best row against the luck line and
   the rows like it; the best rows ranked with their ties, and icons that
   add column sets (the parameters that move the needle, the other
   parameters, the rows like each row, and the activity, risk, model
   skill and run time behind each score); any row in full in the
   inspector, with its replay command.
6. **Gates**: a gate factory. Its first card sets a gate on any measured
   needle (a comparison and a need, the needle's rows against it as it is
   typed); each gate, set here or the runner's, gets a card with its pass
   rate, its needle's rows against the need, what bounds it when it never
   passed, and what moves it. A strip reads them together, and the foot
   lists what the rows passing the most fail together. Gates set here live
   in the address; each is a needle, and with any set, so are Passes every
   gate and Gates passed (a row fails every gate it fails and passes them
   all only when each is decided).
7. **Run**: the whole run on one page. A strip of the rows (of those
   planned, and their pace while live), the needle, the best row against
   the luck line, the clusters and anything broken; the rows' clusters as
   toggles; a card per outcome's distribution (the needle, the outcomes
   the clusters are drawn on, compute cost), for every row by default,
   for the chosen clusters together against every row, or with Compare
   for one cluster against another; what makes each cluster (the
   parameters it holds more of than every row does, or with a choice,
   every parameter's values inside it against every row or the other
   cluster); then the best against luck, pace and segments, problems,
   the sampler and warnings.

## A card

Nothing on a card depends on knowing the experiment beyond its results:
no colour per family and no icon per kind, which a hand-written profile or
an agent would have to supply for every new sweep.

1. **Name and scope**: the param, how many values it has, and for a nested
   param the value it varies under with that value's share of the rows.
2. **Strength and evidence**: ω² with a bar against the strongest param on
   the board, and q after correcting across the board.
3. **The plot**: the needle (y) at each value (x). A number's values sit at
   their own place, small to large, on a log axis when they are spaced by
   factors, as dots with their 95% interval joined in order; `none` stands
   apart. A category's values are bars from zero with the interval on top.
   Every card shares the y scale, which always holds zero, and the
   reference (the base, or a nested param's own scope) is the dashed line.
   The best and worst value of a param that moves the needle carry their
   number. Blue marks a param that moves the needle, grey one that does
   not; a value under 30 rows is hollow. The shown values set the scale,
   so a hollow value past it sits on the edge it passes: a triangle
   pointing past it, or a bar whose far end is dotted.
4. **Tags**: where it acts, dead values, not independent, withheld values,
   an inferred role.

The inspector opens a card in depth: its kind and scope, a sentence on
what it does, its attributes and tests, where it acts, every value with its
interval, and how each estimate settled as rows arrived.

## Live and replay

The server tails the results file and the log (locally, or over SSH with
`tail -F` so nothing is installed on the sweep host) and streams new rows.
A truncated results file starts a new segment. The replay edge hides every
row after it in every view.

A page is watched all day, among others, so it says what the run is doing:
the status pill reads the run's own state (Live; Quiet after ten minutes
without a row; Crashed when its latest log segment ends in a crash;
Finished at the log's closing summary; Archived, Earlier run, Recorded,
Replay, Reconnecting), the tab's title names the sweep and the view, or
the trouble in the view's place, and its icon carries a dot for a run
live, quiet or down. Times are the reader's: a clock time, or in full with
the reader's zone. When the run on screen starts over, the page stays on
the rows it had, kept as an archived run, and offers the run from its
first new row. Toasts say their kind at their edge, and the Run view keeps
what they said while the page is open. The board holds its cards' places
while rows arrive and re-sorts when asked; a new question (the run, the
needle, the context, the edge) sorts afresh.

## Non-goals

No model of why a config scores what it scores; no recommendation presented
as fact. Grid describes what the sweep measured, with its uncertainty.
