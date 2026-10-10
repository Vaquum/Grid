# Statistics

Every number Grid shows, defined. Code: `web/js/stats.js` (numerics)
and `web/js/engine.js` (analyses). Tests: `tests/js/stats.test.mjs`
(against scipy) and `tests/js/engine.test.mjs` (against scipy, an OLS fit,
`chi2_contingency` and pandas on a synthetic sweep with planted effects).

## Rows and the base

The rows in view are those up to the replay edge that hold every condition
of the context. The base is the needle over them: for a 0/1 needle the
rate k/n with its Wilson interval; otherwise the mean with
mean ± t(0.975, n−1)·s/√n. Sums are taken about the mean so the variance
stays exact for values far from zero. Rows with no value for the needle
are left out and counted.

## A parameter's effect

For each value j: n_j, the needle's mean and interval, and the lift
(mean_j − base). A value with n_j < 30 is withheld: drawn hollow, with no
number.

Strength is ω² = (SSB − (k−1)·MSW) / (SST + MSW), the bias-corrected share
of the needle's variance the parameter explains on its own (inside its
scope for a nested parameter). The test is the one-way ANOVA F with
(k−1, N−k) degrees of freedom, or, for a 0/1 needle, the likelihood-ratio
G-test that every value has the same rate, with k−1 degrees of freedom.

The p-values of all parameters on the board are corrected together with
Benjamini–Hochberg; q < 0.05 is detectable. A parameter with no detectable
effect is not called inert: its values' intervals bound how much it could
move the needle.

A dead value has n ≥ 30 and a 95% interval whose top is under a fifth of
the base rate.

## Where a parameter acts

For a parameter D and each other sampled parameter P (2 to 12 values, not
nested, not a set member), the D × P interaction is tested: the share of
variance the cells explain beyond the additive fit μ + α_P + β_D (fitted by
backfitting on the cell means, weighted by the cell counts), with the F
test on (cells − levels_P − levels_D + 1, N − cells) degrees of freedom;
for a 0/1 needle, the likelihood-ratio test of an additive logistic model
(fitted by iteratively reweighted least squares) against the cells' own
rates. All interaction tests of the board are corrected together.

For the strongest detectable moderator P, D's own effect is tested inside
each value of P (with ≥ 60 rows), and those tests are corrected together.
D acts only when P is in a set of values if its effect is detectable there
and a pooled test over the other values (the summed sums of squares, or
the summed G statistics, inside each value) finds nothing (p > 0.05).
Otherwise D's effect is modulated by P: present throughout, stronger in
some values.

## Sampler health

Cramér's V of every pair of sampled parameters, with its χ² test; a pair is
linked when p < 10⁻⁶ and V > 0.03. A parameter's draw is uneven when the χ²
test against equal shares gives p < 10⁻⁶ (by design for some: PocketA
draws `pf_frac` for 2% of rows).

Why it matters: because the sampler draws each parameter independently
and uniformly, the difference between a parameter's values is an unbiased
estimate of its effect averaged over the rest of the space. Where two
parameters are linked, each one's marginal difference carries some of the
other's; read it inside the other's values.

## Set members

For each member m of a sampled subset, inside each subset size s: the
difference between the needle's mean on rows that included m and rows
that left it out, with variance v_in/n_in + v_out/n_out. The effect is the
average over sizes weighted by each size's row count, with its standard
error from the same weights; the p-value is two-sided normal, corrected
across the members. Stratifying by size keeps the size's own effect out of
every member (larger subsets include every member more often).

## Pockets

A pocket is a conjunction of conditions (a condition holds values of one
parameter as alternatives). Its rate and interval are those of the rows it
holds. Lift is rate over base; recall is the share of all hits inside it.
The halves test splits the context's rows at their median arrival and
compares the pocket's rate in each (two-sample z test). Suggestions rank
every value of every parameter not in the pocket by the conservative end
of its interval inside the pocket.

Because every parameter is drawn independently and uniformly, a pocket's
observed rate estimates what a new sweep drawn uniformly inside it would
hit.

## Records and luck

The record curve is the best needle value so far in arrival order. The
luck line is mean + sd·((1−γ)·Φ⁻¹(1−1/n) + γ·Φ⁻¹(1−1/(n·e))), with γ the
Euler–Mascheroni constant: the expected best of n draws if every
configuration were equally good and all of the spread were noise (the
false strategy theorem of Bailey and López de Prado). It uses the spread
of all rows, which includes real differences between configurations, so
a record inside the line is no evidence of an edge, and a record above it
is evidence only when the trials are independent.

## A round's execution

A Limen round recorded with `uel.record_execution` gives each test bar's
position, gross and net return (times its notional rate), and from Limen
5.20 the market's return on it; the server reads them as each round's line
arrives (`grid/limen.py` `execution_summary`) and keeps, for the whole test
window and each half of it, read as a window of its own:

- net return, cost and deployed notional per bar, and the share of
  winning bars, as Limen's ledger has them (on a real round they
  reproduce its results.csv figures);
- the trades: runs of bars in the market, each one's net return
  compounded over its bars (Limen's per-trade summary); their count, their
  mean, and from 30 trades the per-trade t, the mean over its standard
  error s/√k. Under 30 trades no t is read: its spread is too wide, and
  trades stopped at one level have all but one return (on a 10,000-round
  run, |t| reached 10¹⁴ under 10 trades and 19 from 30). Trades of one
  return have none either;
- timing per bar: over the bars with a market return, the mean gross
  return less the mean deployed notional times the market's mean return
  (Limen's reading example), so that riding the market is not read as
  choosing its bars; and the market's own return, compounded.

## Halves

The halves are Limen's ordinal ones: the first ⌊n/2⌋ bars of the test
window and the rest (an odd middle bar in the second). They are two
stretches of the market that do not overlap, so what holds on both is not
the luck of one.

- **An effect counts only when it shows in both halves**: detectable over
  the whole window (q < 0.05, as above), and in each half (the same test on
  that half's values, corrected across the board on that half), its values
  ordered alike: the correlation of the two halves' lifts over the values
  with 30 rows in both, each value weighted by the rows of the fewer, is
  above 0. A difference (a feature group added, a column kept) counts when
  it is detectable over the whole window and in each half, of one sign in
  all three.
- **Reliability**: Spearman's ρ of the rows' needle on the first half
  against the second (ties at their mean rank), with a 95% interval from
  Fisher's z and the standard error √(1.06 / (n − 3)) of Fieller,
  Hartley and Pearson.
- **Lead kept**: the rows ranked by the needle on the first half; the best
  tenth (at least 30 rows, over 60 rows with both halves) against every
  row on each half; their lead on the second half over their lead on the
  first. 1: the order holds; 0: the second half returns them to the mean,
  the lead was luck. The chart gives each tenth's mean second half with
  its interval.

## Gates

Each gate's pass rate with its Wilson interval. Grid sets two on a run
that recorded its trades: entries at least 30 and per-trade t at least 2.
A gate that never passed
in n rows has a true rate under 3/n (95%, the rule of three). The outcome
most correlated with a gate's value (excluding outcomes that are the value
itself, |r| > 0.999) is reported when |r| > 0.8: the gate is bounded by
it. Co-failure counts the sets of gates failed together by the rows with
at least the best row's gates minus one.
