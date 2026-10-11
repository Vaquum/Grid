// The Run view's cards: the outcomes they draw are read on the rows on
// screen, even while the clusters found in the background are of fewer
// rows. Limen's reports: the convergence counts and a selection's
// verdicts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOutcomes, convergenceOf, verdictsOf } from "../../web/js/view-run.js";

const target = (id, n, extra = {}) => ({ id, label: id, kind: "cont", values: Float64Array.from({ length: n }, (_, i) => i), ...extra });

test("the cards read the outcomes of the rows on screen, not those the clusters were found on", () => {
  // the clusters were found on 100 rows; 50 more have arrived since
  const then = [target("score", 100), target("entries", 100, { group: "activity" })];
  const now = [target("score", 150), target("entries", 150, { group: "activity" }), target("sec", 150, { cost: true })];
  const schema = { targets: now, targetById: new Map(now.map(t => [t.id, t])) };
  const m = { target: now[0], schema, rows: Uint32Array.from({ length: 150 }, (_, i) => i) };
  const outs = cardOutcomes(m, { outcomes: then.map(t => ({ t })) });
  assert.deepEqual(outs.map(t => t.id), ["score", "entries", "sec"]);
  for (const t of outs) {
    assert.equal(t, schema.targetById.get(t.id), `${t.id} is the outcome of the rows on screen`);
    assert.ok(m.rows.every(i => Number.isFinite(t.values[i])), `${t.id} has a value for every row on screen`);
  }
});

// Limen's reports, as Limen 5.24 wrote them for tests/fixtures/limen_walk_forward
const CONVERGENCE = { rounds: 4, observed_rounds: 4, unavailable_rounds: 0, convergence_warning_rounds: 2, convergence_warning_pct: 50,
  parameter_patterns: [
    { parameter: "C", value: "0.01", observed_rounds: 2, convergence_warning_rounds: 1, convergence_warning_pct: 50 },
    { parameter: "C", value: "1.0", observed_rounds: 2, convergence_warning_rounds: 1, convergence_warning_pct: 50 },
    { parameter: "solver", value: "'lbfgs'", observed_rounds: 4, convergence_warning_rounds: 2, convergence_warning_pct: 50 },
    { parameter: "max_iter", value: "2", observed_rounds: 2, convergence_warning_rounds: 2, convergence_warning_pct: 100 }] };

test("the convergence reports: counts summed across directories, the values Limen found with one directory, most first", () => {
  const one = convergenceOf([{ label: null, convergence: CONVERGENCE, acceptance: null }]);
  assert.deepEqual([one.rounds, one.observed, one.warned, one.share], [4, 4, 2, 0.5]);
  // a value every round had says nothing of which ones warned
  assert.deepEqual(one.patterns.map(p => `${p.parameter}=${p.value} ${p.warned}/${p.observed}`), ["max_iter=2 2/2", "C=0.01 1/2", "C=1.0 1/2"]);
  // of several directories, the counts add up, and each one's values are its own
  const two = convergenceOf([{ convergence: CONVERGENCE }, { convergence: { ...CONVERGENCE, observed_rounds: 6, convergence_warning_rounds: 0, unavailable_rounds: 1 } }, { convergence: null }]);
  assert.deepEqual([two.observed, two.warned, two.unavailable, two.share, two.patterns], [10, 2, 1, 0.2, null]);
  assert.equal(convergenceOf([{ convergence: null }, {}]), null);
});

test("a selection's verdicts: pass, fail, or unavailable with Limen's reason, for the thresholds declared", () => {
  assert.deepEqual(verdictsOf({ thresholds: { min_deflated_sharpe_probability: 0.95, max_pbo: 0.2 },
    verdicts: { min_deflated_sharpe_probability: true, max_pbo: null }, errors: { pbo: "PBO requires equal contiguous blocks with at least two bars each" } })
    .map(v => [v.label, v.op, v.threshold, v.verdict, v.why]), [
    ["Deflated Sharpe probability", "≥", 0.95, "pass", null],
    ["Probability of backtest overfitting", "≤", 0.2, "unavailable", "PBO requires equal contiguous blocks with at least two bars each"]]);
  assert.deepEqual(verdictsOf({ thresholds: { max_pbo: 0.2 }, verdicts: { max_pbo: false }, errors: {} }).map(v => v.verdict), ["fail"]);
  // none declared, no verdict
  assert.deepEqual(verdictsOf({ thresholds: {}, verdicts: {}, errors: {} }), []);
});
