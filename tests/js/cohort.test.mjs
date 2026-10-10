// The Cohort view's choosing: the pool (the rows in view in the pocket
// that pass every gate set, not Grid's standing ones), the pool ranked on
// the first half, the members of one result directory, and the members'
// mean.

import { test } from "node:test";
import assert from "node:assert/strict";
import { poolOf, poolGates, pocketOf, rankedOf, dirsOf, membersOf, meanOf, howChosen, chosenText } from "../../web/js/view-cohort.js";

const NaN_ = Number.NaN;
const set = { label: "Net PnL per bar ≥ 0", pass: Float64Array.from([1, 1, 0, 1, NaN_, 1]) };
const standing = { label: "Entries ≥ 30", pass: Float64Array.from([0, 0, 0, 0, 0, 0]) };
const shard = { id: "shard", column: "shard", label: "shard", codes: Int32Array.from([0, 1, 0, 1, 0, 1]),
  levels: [{ key: "s1", value: "s1", label: "s1" }, { key: "s2", value: "s2", label: "s2" }] };
const schema = { n: 6, gates: [set, standing], gatesStanding: [standing], dims: [shard], dimById: new Map([["shard", shard]]) };
const all = Uint32Array.from([0, 1, 2, 3, 4, 5]);

test("the pool is the rows in view, in the pocket, passing every gate set", () => {
  assert.deepEqual(poolGates(schema), [set]);
  // row 2 fails the gate, row 4 has no value for it; Grid's standing gate,
  // which every row fails, is not the pool's
  assert.deepEqual(poolOf(schema, all, [], 6), [0, 1, 3, 5]);
  // rows out of view, or past the replay edge, are not in it
  assert.deepEqual(poolOf(schema, Uint32Array.from([0, 1, 3]), [], 6), [0, 1, 3]);
  assert.deepEqual(poolOf(schema, all, [], 2), [0, 1]);
  // the pocket's conditions hold too
  assert.deepEqual(poolOf(schema, all, [{ dim: "shard", keys: ["s2"] }], 6), [1, 3, 5]);
  // one kept in the address that names a parameter this run does not have
  // is passed over, as the Pocket view and the context pass it over
  const kept = [{ dim: "gone", keys: ["x"] }, { dim: "shard", keys: ["s2"] }];
  assert.deepEqual(pocketOf(schema, kept), [{ dim: "shard", keys: ["s2"] }]);
  assert.deepEqual(poolOf(schema, all, kept, 6), [1, 3, 5]);
  assert.deepEqual(poolOf(schema, all, [{ dim: "gone", keys: ["x"] }], 6), [0, 1, 3, 5]);
});

test("ranked on the first half, the best first, rows without both halves left out", () => {
  const t = { better: 1, halves: [Float64Array.from([0.5, 0.9, 0.1, 0.7, 0.2, NaN_]), Float64Array.from([0.4, 0.1, 0.2, 0.3, 0.1, 0.5])] };
  assert.deepEqual(rankedOf(t, [0, 1, 3, 5]), [1, 3, 0]);
  // lower is better: the order turns over; ties keep their arrival order
  assert.deepEqual(rankedOf({ ...t, better: -1 }, [0, 1, 3]), [0, 3, 1]);
  const tied = { better: 1, halves: [Float64Array.from([1, 1, 1, 1, 1, 1]), Float64Array.from([0, 0, 0, 0, 0, 0])] };
  assert.deepEqual(rankedOf(tied, [5, 0, 3]), [0, 3, 5]);
  // without halves, the needle over the whole window
  assert.deepEqual(rankedOf({ better: 1, values: Float64Array.from([3, 1, 2, 0, 0, 0]) }, [0, 1, 2]), [0, 2, 1]);
});

test("the members: the best of one result directory, less those taken out, with those put in", () => {
  const dirOf = dirsOf(schema);
  assert.deepEqual([0, 1, 2].map(dirOf), ["s1", "s2", "s1"]);
  const ranked = [1, 3, 0, 5, 2];
  assert.deepEqual(membersOf(ranked, dirOf, "s2", 2, new Set(), new Set()), { mine: [1, 3, 5], members: [1, 3] });
  assert.deepEqual(membersOf(ranked, dirOf, "s2", 2, new Set([3]), new Set([5])).members, [1, 5]);
  assert.deepEqual(membersOf(ranked, dirOf, "s1", 5, new Set(), new Set()).members, [0, 2]);
  // a run of one directory: every ranked row
  assert.deepEqual(membersOf(ranked, null, null, 3, new Set(), new Set()).members, [1, 3, 0]);
  assert.equal(dirsOf({ dims: [] }), null);
});

test("the members' mean leaves out what a member did not have", () => {
  const m = meanOf([{ pnl: 1, trades: 2, tradeMean: 3, wins: 0.5 }, null, { pnl: 3, trades: 4, tradeMean: null, wins: 0.1 }]);
  assert.equal(m.pnl, 2);
  assert.equal(m.trades, 3);
  assert.equal(m.tradeMean, 3);
  assert.ok(Number.isNaN(m.tradeT));
  assert.equal(meanOf([null]), null);
});

test("a predictor keeps how its members were chosen, said as the page says it", () => {
  const m = { target: { label: "Net PnL per bar", halves: [new Float64Array(6), new Float64Array(6)] }, schema };
  const pocket = [{ dim: "gone", keys: ["x"] }, { dim: "shard", keys: ["s2"] }];
  const how = howChosen(m, pocket, [5, 1, 3], [5, 1, 3]);
  // not judged yet: no figures kept
  assert.deepEqual(how, { needle: "Net PnL per bar", on: "the first half", best: 5, byHand: { out: 0, in: 0 },
    pocket: ["shard = s2"], gates: ["Net PnL per bar ≥ 0"] });
  // by hand: the best 5 less the members, and the members past the best 5,
  // as the ranking stands (not every edit made since)
  const mine = [9, 8, 7, 6, 5, 4, 3];
  assert.deepEqual(howChosen(m, [], mine, [9, 7, 6, 5, 3]).byHand, { out: 1, in: 1 });
  assert.deepEqual(howChosen(m, [], mine, [9, 8, 7, 6, 5]).byHand, { out: 0, in: 0 });
  assert.deepEqual(howChosen(m, [], mine, [8]).byHand, { out: 4, in: 0 });
  assert.deepEqual(chosenText(how), ["The best 5 by Net PnL per bar on the first half; in the pocket shard = s2; passing Net PnL per bar ≥ 0."]);
  const judged = { ...how, pocket: [], gates: [], byHand: { out: 1, in: 2 },
    judged: { on: "the second half", bars: 696, fee: 5, slip: 2.5, cohort: { pnl: 0.12, trades: 34 },
      bestMember: { pnl: -0.07, trades: 76 }, membersMean: null, notes: [] } };
  assert.deepEqual(chosenText(judged), [
    "The best 5 by Net PnL per bar on the first half, 1 taken out and 2 put in by hand; no pocket; no gate.",
    "On the second half: the cohort 0.12 bps a bar, its best member alone −0.07 bps, its members on average –, at a fee of 5.0 and slippage of 2.5 bps."]);
  // a predictor made before Grid kept this says nothing of it
  assert.deepEqual(chosenText(null), []);
  assert.deepEqual(chosenText({ rows: [0, 1] }), []);
});
