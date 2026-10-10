// The halves of a test window: an effect counts only when it shows in both,
// the rows' ranks on one half against the other, and how much of a lead on
// the first half the second keeps. A synthetic sweep with planted effects:
// one in both halves, one in the second only, one turned over between them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { board } from "../../web/js/engine.js";
import { halfTargets, agreement, twice, twiceDiff, showsIn, rankAgreement, firstHalfRanks, keptLead, persistence } from "../../web/js/halves.js";

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
