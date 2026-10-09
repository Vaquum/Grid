// The Run view's cards: the outcomes they draw are read on the rows on
// screen, even while the clusters found in the background are of fewer
// rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOutcomes } from "../../web/js/view-run.js";

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
