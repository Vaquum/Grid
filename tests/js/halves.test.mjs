// The halves of a test window: an effect counts only when it shows in both,
// the rows' ranks on one half against the other, and how much of a lead on
// the first half the second keeps. A synthetic sweep with planted effects:
// one in both halves, one in the second only, one turned over between them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { board } from "../../web/js/engine.js";
import { halfTargets, agreement, twice, twiceDiff, showsIn, rankAgreement, firstHalfRanks, keptLead, persistence, firstHalfOnly, wholeWindow, choiceFound,
  needleReadsWhole }
  from "../../web/js/halves.js";
import { applyGates } from "../../web/js/gates.js";

// A deterministic noise source (an LCG), uniform on [-1, 1).
function noise(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 31 - 1; };
}

const N = 1200;
const dim = (id, k, code) => ({ id, label: id, levels: Array.from({ length: k }, (_, j) => ({ key: String(j), label: String(j), value: j })),
  codes: Int32Array.from({ length: N }, (_, i) => code(i)) });
// both: moves both halves alike; second: moves the second half only;
// over: moves the halves the opposite ways; none: nothing
const dims = [dim("both", 3, i => i % 3), dim("second", 2, i => Math.floor(i / 3) % 2), dim("over", 2, i => Math.floor(i / 6) % 2), dim("none", 2, i => Math.floor(i / 12) % 2)];
const [both, second, over] = dims;
const r1 = noise(1), r2 = noise(2);
const h1 = new Float64Array(N), h2 = new Float64Array(N);
for (let i = 0; i < N; i++) {
  h1[i] = both.codes[i] * 0.5 + (over.codes[i] ? 0.6 : -0.6) + r1();
  h2[i] = both.codes[i] * 0.5 + second.codes[i] * 0.6 + (over.codes[i] ? -0.6 : 0.6) + r2();
}
const values = h1.map((v, i) => (v + h2[i]) / 2);
const target = { id: "pnl", label: "Net PnL per bar", unit: "bps", kind: "cont", better: 1, digits: 2, values, halves: [h1, h2] };
const rows = Uint32Array.from({ length: N }, (_, i) => i);

test("a needle's halves are needles of their own", () => {
  const [a, b] = halfTargets(target);
  assert.deepEqual([a.id, a.label, b.id, b.label], ["pnl~1", "Net PnL per bar, first half", "pnl~2", "Net PnL per bar, second half"]);
  assert.equal(a.values, h1);
  assert.equal(b.halves, null);
  assert.equal(halfTargets({ ...target, halves: undefined }), null);
});

test("read on the first half only: a needle measured on each half reads its first, named so, with no second; gates read it so", () => {
  const auc = { id: "auc", label: "AUC", unit: "", kind: "cont", better: 1, digits: 3, values: new Float64Array(N).fill(0.6) };
  const schema = { n: N, targets: [target, auc], targetById: new Map([["pnl", target], ["auc", auc]]), gates: [],
    standingGates: [{ id: "pnl_up", target: "pnl", op: ">=", value: 0 }] };
  const read = firstHalfOnly(schema);
  const pnl = read.targetById.get("pnl");
  assert.deepEqual([pnl.id, pnl.label, pnl.values, pnl.halves, pnl.base], ["pnl", "Net PnL per bar, first half", h1, null, target]);
  assert.equal(read.targets[0], pnl);
  // nothing of the second half is left to show
  assert.equal(halfTargets(pnl), null);
  assert.ok(!read.targets.some(t => t.halves));
  // a needle not measured on each half reads the whole window, as it was
  assert.equal(read.targetById.get("auc"), auc);
  // the gates set on the needle, and the profile's own, read its first half
  const gated = applyGates(read, [{ id: "g1", target: "pnl", op: ">", value: 0 }, { id: "g2", target: "auc", op: ">=", value: 0.5 }]);
  const pass = (id) => [...gated.gates.find(g => g.id === id).pass];
  assert.deepEqual(pass("g1"), [...h1].map(v => (v > 0 ? 1 : 0)));
  assert.deepEqual(pass("pnl_up"), [...h1].map(v => (v >= 0 ? 1 : 0)));
  assert.notDeepEqual(pass("g1"), [...values].map(v => (v > 0 ? 1 : 0)));
  // which needles still read the whole window: one without halves, a gate
  // on it, and every gate together when one of them does
  const whole = (id) => wholeWindow(gated, gated.targetById.get(id));
  assert.deepEqual(["pnl", "auc", "gate:g1", "gate:g2", "gate:pnl_up", "gates:all", "gates:count"].map(whole),
    [false, true, false, true, false, true, true]);
  const halvedOnly = applyGates(read, [{ id: "g1", target: "pnl", op: ">", value: 0 }]);
  assert.equal(wholeWindow(halvedOnly, halvedOnly.targetById.get("gates:all")), false);
  // the whole window read as it is: nothing is said to read it
  assert.equal(wholeWindow(applyGates(schema, []), auc), false);
  // a run without halves is read as it is
  const flat = { ...schema, targets: [auc], targetById: new Map([["auc", auc]]) };
  assert.equal(firstHalfOnly(flat), flat);
});

test("how a pocket was found: on the first half only while every change to it was made with First half on", () => {
  const p = [{ dim: "a", keys: ["1"] }];
  const none = { pocket: [], gates: [], context: [], firstHalf: true, found: null };
  // nothing chosen: nothing to say
  assert.equal(choiceFound(none, none), null);
  // set with First half on, and changed with it on: found on the first half
  const first = { ...none, pocket: p, found: choiceFound(none, { ...none, pocket: p }) };
  assert.equal(first.found, "first");
  assert.equal(choiceFound(first, { ...first, gates: [{ id: "g1" }] }), "first");
  // First half turned off while it stands, or a change made with it off:
  // the whole window, and turning it on again does not undo that
  const off = { ...first, firstHalf: false, found: choiceFound(first, { ...first, firstHalf: false }) };
  assert.equal(off.found, "whole");
  assert.equal(choiceFound(off, { ...off, firstHalf: true }), "whole");
  assert.equal(choiceFound({ ...none, firstHalf: false }, { ...none, firstHalf: false, context: p }), "whole");
  // cleared, and set again with First half on: the first half again
  const cleared = { ...off, pocket: [], firstHalf: true, found: choiceFound(off, { ...off, pocket: [], firstHalf: true }) };
  assert.equal(cleared.found, null);
  assert.equal(choiceFound(cleared, { ...cleared, pocket: p }), "first");
  // a pocket from an address that kept no account: the whole window
  assert.equal(choiceFound({ ...none, pocket: p, found: null }, { ...none, pocket: p, found: null }), "whole");
  assert.equal(choiceFound(undefined, { ...none, pocket: p }), "first");
  // chosen with First half on but a needle in view that reads the whole
  // window anyway: the whole window
  assert.equal(choiceFound(none, { ...none, pocket: p }, true), "whole");
});

test("the needle a state shows reads the whole window with First half on when the run does not measure it on each half", () => {
  const auc = { id: "auc", label: "AUC", values: new Float64Array(N) };
  const schema = { targets: [target, auc], targetById: new Map([["pnl", target], ["auc", auc]]), defaultTarget: "pnl",
    standingGates: [{ id: "pnl_up", target: "pnl", op: ">=", value: 0 }] };
  const on = (patch) => needleReadsWhole(schema, { gates: [], ...patch });
  assert.deepEqual([on({ target: "pnl" }), on({ target: null }), on({ target: "auc" })], [false, false, true]);
  const gates = [{ id: "g1", target: "pnl" }, { id: "g2", target: "auc" }];
  assert.deepEqual([on({ target: "gate:g1", gates }), on({ target: "gate:g2", gates }), on({ target: "gate:pnl_up", gates }),
    on({ target: "gates:all", gates }), on({ target: "gates:all", gates: gates.slice(0, 1) })], [false, true, false, true, false]);
  // a run without halves: every needle reads the whole window, so a choice
  // made there with First half on is found on the whole window
  assert.equal(needleReadsWhole({ ...schema, targets: [auc] }, { target: "auc" }), true);
  const p = [{ dim: "a", keys: ["1"] }];
  assert.equal(choiceFound({ firstHalf: true }, { firstHalf: true, gates: p }, needleReadsWhole({ ...schema, targets: [auc] }, { target: "auc" })), "whole");
});

test("an effect counts only when it shows in both halves, its values ordered alike", () => {
  const whole = board({}, target, rows, dims);
  const halves = halfTargets(target).map(ht => board({}, ht, rows, dims));
  twice(whole, halves);
  const by = new Map(whole.effects.map(e => [e.dim, e]));
  assert.equal(by.get("both").detectable, true);
  assert.equal(showsIn(by.get("both")), "twice");
  assert.ok(by.get("both").agree > 0.9, `${by.get("both").agree}`);
  // over the whole window the second half's effect shows, halved
  assert.equal(by.get("second").whole, true);
  assert.equal(by.get("second").detectable, false);
  assert.equal(showsIn(by.get("second")), "second");
  // detectable in each half, but turned over: the whole window sees none
  assert.equal(showsIn(by.get("over")), "unlike");
  assert.ok(by.get("over").agree < -0.9, `${by.get("over").agree}`);
  assert.equal(showsIn(by.get("none")), null);
  assert.equal(whole.halves, halves);
});

test("agreement weighs each value's lifts by its rows, and needs two values with 30 rows", () => {
  const lv = (lifts, n = 50) => ({ levels: lifts.map(l => ({ lift: l, n, withheld: n < 30 })) });
  assert.ok(Math.abs(agreement(lv([1, -1]), lv([2, -2])) - 1) < 1e-12);
  assert.ok(Math.abs(agreement(lv([1, -1]), lv([-1, 1])) + 1) < 1e-12);
  assert.ok(Number.isNaN(agreement(lv([1, -1], 10), lv([1, -1], 10))));
  assert.ok(Number.isNaN(agreement(lv([1, 0, -1]), lv([0, 0, 0]))));
});

test("a difference counts when it is detectable over the window and in each half, of one sign", () => {
  const d = (delta, detectable) => ({ delta, detectable });
  const counts = twiceDiff(d(0.2, true), [d(0.3, true), d(0.1, true)], x => x.delta);
  assert.equal(counts.detectable, true);
  assert.equal(showsIn(counts), "twice");
  const flips = twiceDiff(d(0.2, true), [d(0.4, true), d(-0.1, true)], x => x.delta);
  assert.equal(showsIn(flips), "unlike");
  assert.equal(showsIn(twiceDiff(d(0.2, true), [d(0.3, true), d(0.1, false)], x => x.delta)), "first");
  assert.equal(showsIn(twiceDiff(d(0.2, false), [d(0.3, false), d(0.1, false)], x => x.delta)), null);
  assert.equal(showsIn(twiceDiff(d(0.2, true), [null, d(0.1, true)], x => x.delta)), "second");
});

test("the halves' rank agreement is Spearman's, ties at their mean rank, with Fisher's interval", () => {
  const t = (a, b) => ({ halves: [Float64Array.from(a), Float64Array.from(b)] });
  const six = Uint32Array.of(0, 1, 2, 3, 4, 5);
  const r = rankAgreement(t([1, 2, 3, 4, 5, 6], [1, 1, 2, 3, 3, 4]), six);
  // scipy.stats.spearmanr, and tanh(atanh(ρ) ∓ 1.96·√(1.06 / 3))
  assert.ok(Math.abs(r.rho - 0.9710083124552245) < 1e-12, `${r.rho}`);
  assert.ok(Math.abs(r.lo - 0.7373317100042661) < 1e-9 && Math.abs(r.hi - 0.9971420532311586) < 1e-9, `${r.lo} ${r.hi}`);
  assert.equal(r.n, 6);
  assert.ok(Math.abs(rankAgreement(t([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]), six).rho + 1) < 1e-12);
  // rows without both halves are left out; under four, no agreement
  const gaps = rankAgreement(t([1, 2, NaN, 4, 5, 6], [1, 2, 3, NaN, 5, 6]), six);
  assert.equal(gaps.n, 4);
  assert.ok(Number.isNaN(rankAgreement(t([1, 2, 3], [1, 2, 3]), Uint32Array.of(0, 1, 2)).rho));
});

test("each row's rank on the first half: competition ranks, the better way, none without it", () => {
  const t = { halves: [Float64Array.of(3, 5, 5, NaN, 1), Float64Array.of(0, 0, 0, 0, 0)] };
  const rank = firstHalfRanks(t, Uint32Array.of(0, 1, 2, 3, 4), 1, 5);
  assert.deepEqual([...rank].map(x => (Number.isNaN(x) ? null : x)), [3, 1, 1, null, 4]);
  // lower is better
  assert.deepEqual([...firstHalfRanks(t, Uint32Array.of(0, 1, 2, 4), -1, 5)].map(x => (Number.isNaN(x) ? null : x)), [2, 3, 3, null, 1]);
});

test("the lead kept: the best tenth's lead on the second half over its lead on the first", () => {
  const n = 300;
  const a = Float64Array.from({ length: n }, (_, i) => i);
  const b = a.map(v => 0.5 * v + 7);
  const t = { id: "x", label: "x", kind: "cont", better: 1, values: a, halves: [a, b] };
  const all = Uint32Array.from({ length: n }, (_, i) => i);
  const k = keptLead(t, all, 1);
  assert.equal(k.k, 30);
  assert.ok(Math.abs(k.kept - 0.5) < 1e-12, `${k.kept}`);
  // the second half turned over: the lead is lost and then some
  const flip = { ...t, halves: [a, a.map(v => -v)] };
  assert.ok(Math.abs(keptLead(flip, all, 1).kept + 1) < 1e-12);
  // lower is better: the best tenth is the lowest
  assert.ok(Math.abs(keptLead(t, all, -1).kept - 0.5) < 1e-12);
  assert.equal(keptLead(t, all.subarray(0, 59), 1), null);
  // by tenths on the first half, the best first
  const p = persistence(t, all, 1);
  assert.equal(p.points.length, 10);
  assert.deepEqual(p.points.map(x => x.n), new Array(10).fill(30));
  assert.ok(Math.abs(p.points[0].mean - (0.5 * 284.5 + 7)) < 1e-9, `${p.points[0].mean}`);
  assert.ok(p.points[0].mean > p.points[9].mean);
  assert.equal(persistence(t, all.subarray(0, 299), 1), null);
});
