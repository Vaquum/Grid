# Statistics

Every number Tessera shows, defined. Code: `web/js/stats.js` (numerics)
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

## Gates

Each gate's pass rate with its Wilson interval. A gate that never passed
in n rows has a true rate under 3/n (95%, the rule of three). The outcome
most correlated with a gate's value (excluding outcomes that are the value
itself, |r| > 0.999) is reported when |r| > 0.8: the gate is bounded by
it. Co-failure counts the sets of gates failed together by the rows with
at least the best row's gates minus one.
