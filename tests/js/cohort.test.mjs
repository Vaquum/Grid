// The Cohort view's choosing: the pool (the rows in view in the pocket
// that pass every gate set, not Grid's standing ones, each read on the
// first half where it can be), the pool ranked on the first half, the
// members from any of the run's result directories, the members' mean,
// and what a predictor keeps of how its members were chosen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { poolOf, poolGates, gateReads, touchedBy, pocketOf, rankedOf, dirsOf, dirCount, membersOf, meanOf, howChosen, chosenText }
  from "../../web/js/view-cohort.js";

const NaN_ = Number.NaN;
// a gate without halves to read (the runner's own): its passes over the
// whole window
const set = { label: "Entries ≥ 10", pass: Float64Array.from([1, 1, 0, 1, NaN_, 1]) };
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

test("a gate on a needle measured on each half is read on its first half, any other over the whole window", () => {
  const net = { label: "Net PnL per bar", halves: [Float64Array.from([1, -1, 2, -2, NaN_, 3]), Float64Array.from([-5, 5, -5, 5, 5, -5])] };
  // over the whole window every row fails it: the second half's losses
  const g = { label: "Net PnL per bar ≥ 0", def: { op: ">=", value: 0 }, target: net, pass: new Float64Array(6) };
  const halved = { ...schema, gates: [g, standing] };
  const reads = gateReads(halved);
  assert.deepEqual(reads.map(r => r.firstHalf), [true]);
  assert.deepEqual([...reads[0].pass], [1, 0, 1, 0, NaN_, 1]);
  assert.deepEqual(poolOf(halved, all, [], 6), [0, 2, 5]);
  // the second half chose nothing; with a gate over the whole window, or a
  // needle without halves, it helped choose, and the view says why
  assert.equal(touchedBy(net, reads), null);
  const mixed = gateReads({ ...schema, gates: [g, set, standing] });
  assert.deepEqual(mixed.map(r => r.firstHalf), [true, false]);
  assert.equal(touchedBy(net, mixed), "the gate Entries ≥ 10 is read over the whole window");
  assert.equal(touchedBy(net, gateReads({ ...schema, gates: [set, { ...set, label: "Wins ≥ 0.5" }, standing] })),
    "the gates Entries ≥ 10; Wins ≥ 0.5 are read over the whole window");
  assert.equal(touchedBy({ label: "AUC" }, reads), "AUC is not measured on each half");
  // with First half on, a gate's needle is its first half: the pool reads
  // the gate from the needle measured on both, by its own name
  const firstHalf = { ...net, label: "Net PnL per bar, first half", values: net.halves[0], halves: null, base: net };
  const read = gateReads({ ...schema, gates: [{ ...g, label: "Net PnL per bar, first half ≥ 0", target: firstHalf }, standing] });
  assert.deepEqual([read[0].firstHalf, read[0].label, [...read[0].pass]], [true, "Net PnL per bar ≥ 0", [1, 0, 1, 0, NaN_, 1]]);
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

const shardColumn = (labels, codes, state = () => 0) => ({ kind: "str", levels: labels, codes: Int32Array.from(codes), stateAt: state });

test("the members: the best of the ranked rows from any result directory, less those taken out, with those put in", () => {
  const dirOf = dirsOf({ cols: new Map([["shard", shardColumn(["s1", "s2"], [0, 1, 0, 1, 0, 1])]]) });
  assert.deepEqual([0, 1, 2].map(dirOf), ["s1", "s2", "s1"]);
  const ranked = [1, 3, 0, 5, 2];
  // the best of every directory's rows, in their ranked order
  assert.deepEqual(membersOf(ranked, 3, new Set(), new Set()), [1, 3, 0]);
  assert.deepEqual(membersOf(ranked, 3, new Set([3]), new Set([2])), [1, 0, 2]);
  assert.equal(dirCount(dirOf, [1, 3]), 1);
  assert.equal(dirCount(dirOf, [1, 3, 0]), 2);
  // a run of one directory has none to count
  assert.equal(dirCount(null, [1, 3, 0]), 0);
  assert.equal(dirsOf({ cols: new Map() }), null);
  // each row's directory as the run wrote it: forty directories stay forty
  // (the shard parameter's levels fold those past the first few dozen)
  const forty = Array.from({ length: 40 }, (_, k) => `d${k}`);
  const many = dirsOf({ cols: new Map([["shard", shardColumn(forty, forty.map((_, k) => k))]]) });
  assert.deepEqual(forty.map((_, k) => many(k)), forty);
  // a row without one has none
  const absent = dirsOf({ cols: new Map([["shard", shardColumn(["s1"], [0, 0], i => (i === 1 ? 2 : 0))]]) });
  assert.deepEqual([0, 1].map(absent), ["s1", null]);
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
  const net = { label: "Net PnL per bar", halves: [new Float64Array(6), new Float64Array(6)] };
  const m = { target: net, schema, state: { firstHalf: false, found: "whole", pocket: [{ dim: "shard", keys: ["s2"] }] } };
  const pocket = [{ dim: "gone", keys: ["x"] }, { dim: "shard", keys: ["s2"] }];
  const g = { label: "Net PnL per bar ≥ 0", def: { op: ">=", value: 0 }, target: net, pass: new Float64Array(6) };
  const how = howChosen(m, pocket, gateReads({ ...schema, gates: [g, standing] }), [5, 1, 3], [5, 1, 3]);
  // not judged yet: no figures kept
  assert.deepEqual(how, { needle: "Net PnL per bar", on: "the first half", best: 5, byHand: { out: 0, in: 0 },
    pocket: ["shard = s2"], gates: ["Net PnL per bar ≥ 0 (on the first half)"], analysis: "the whole window", untouched: true });
  assert.deepEqual(chosenText(how), ["The best 5 by Net PnL per bar on the first half; in the pocket shard = s2; passing Net PnL per bar ≥ 0 (on the first half).",
    "Its pocket, gates or context were found with the other views reading the whole window, the second half too."]);
  // a pocket found with First half on: nothing to say of the other views;
  // and the needle in view, its first half, is read from the one measured
  // on both
  const blind = howChosen({ target: { ...net, label: "Net PnL per bar, first half", halves: null, base: net }, schema,
    state: { firstHalf: true, found: "first", pocket: [{ dim: "shard", keys: ["s2"] }] } }, pocket, gateReads({ ...schema, gates: [g, standing] }), [5, 1, 3], [5, 1, 3]);
  assert.deepEqual([blind.needle, blind.on, blind.analysis], ["Net PnL per bar", "the first half", "the first half"]);
  assert.equal(chosenText(blind).length, 1);
  // First half on now does not make a pocket found with the whole window
  // one found without it
  const late = howChosen({ target: net, schema, state: { firstHalf: true, found: "whole", pocket: [{ dim: "shard", keys: ["s2"] }] } },
    pocket, gateReads({ ...schema, gates: [g, standing] }), [5, 1, 3], [5, 1, 3]);
  assert.equal(late.analysis, "the whole window");
  // nothing chosen: nothing to say
  assert.equal(howChosen({ target: net, schema, state: { firstHalf: false, found: null } }, [], [], [5], [5]).analysis, null);
  // a cohort narrowed by the context alone, found reading the whole window,
  // keeps the context and says so
  const ctx = howChosen({ target: net, schema, state: { firstHalf: false, found: "whole", context: [{ dim: "shard", keys: ["s1"] }] } }, [], [], [5], [5]);
  assert.deepEqual([ctx.context, ctx.analysis], [["shard = s1"], "the whole window"]);
  assert.deepEqual(chosenText(ctx), ["The best 5 by Net PnL per bar on the first half; no pocket; no gate; of the rows in the context shard = s1.",
    "Its pocket, gates or context were found with the other views reading the whole window, the second half too."]);
  // a gate read over the whole window: kept, and said
  const whole = howChosen(m, [], gateReads(schema), [5, 1, 3], [5, 1, 3]);
  assert.deepEqual([whole.gates, whole.untouched], [["Entries ≥ 10 (over the whole window)"], false]);
  assert.deepEqual(chosenText(whole), ["The best 5 by Net PnL per bar on the first half; no pocket; passing Entries ≥ 10 (over the whole window).",
    "The second half helped choose them, so it does not judge them untouched."]);
  // by hand: the best 5 less the members, and the members past the best 5,
  // as the ranking stands (not every edit made since)
  const mine = [9, 8, 7, 6, 5, 4, 3];
  assert.deepEqual(howChosen(m, [], [], mine, [9, 7, 6, 5, 3]).byHand, { out: 1, in: 1 });
  assert.deepEqual(howChosen(m, [], [], mine, [9, 8, 7, 6, 5]).byHand, { out: 0, in: 0 });
  assert.deepEqual(howChosen(m, [], [], mine, [8]).byHand, { out: 4, in: 0 });
  const judged = { ...how, pocket: [], gates: [], analysis: null, byHand: { out: 1, in: 2 },
    judged: { on: "the second half", bars: 696, fee: 5, slip: 2.5, cohort: { pnl: 0.12, trades: 34 },
      bestMember: { pnl: -0.07, trades: 76 }, membersMean: null, notes: [] } };
  assert.deepEqual(chosenText(judged), [
    "The best 5 by Net PnL per bar on the first half, 1 taken out and 2 put in by hand; no pocket; no gate.",
    "On the second half: the cohort 0.12 bps a bar, its best member alone −0.07 bps, its members on average –, at a fee of 5.0 and slippage of 2.5 bps."]);
  // a predictor made before Grid kept this says nothing of it
  assert.deepEqual(chosenText(null), []);
  assert.deepEqual(chosenText({ rows: [0, 1] }), []);
});
