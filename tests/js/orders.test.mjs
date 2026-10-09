// Interactions of any order: with two parameters the test is the pair
// test; a planted three-way effect is found; pairs alone are not mistaken
// for one; a grid with a thin cell is not tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../../web/js/engine.js";

// A seeded uniform generator (mulberry32) and a normal draw.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (u) => () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());

// A sweep of n rows over parameters with the given numbers of values, drawn
// uniformly, and a needle made from their codes.
function sweep(n, levels, needle, seed, kind = "cont") {
  const u = rng(seed), z = normal(u);
  const dims = levels.map((l, t) => ({ id: `p${t}`, levels: Array.from({ length: l }, (_, j) => ({ key: String(j), label: String(j) })), codes: new Int32Array(n) }));
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = dims.map(d => { const c = Math.floor(u() * d.levels.length); d.codes[i] = c; return c; });
    values[i] = needle(x, z, u);
  }
  const rows = Uint32Array.from({ length: n }, (_, i) => i);
  const target = { values, kind };
  return { dims, rows, target, base: E.summarize(target, rows) };
}

test("with two parameters it is the pair test", () => {
  const s = sweep(3000, [3, 4], (x, z) => 0.2 * x[0] - 0.1 * x[1] + 0.25 * (x[0] === 2 && x[1] === 1) + z(), 11);
  const two = E.comboEffect(s.dims, s.target, s.rows, s.base, 5);
  const pair = E.pairEffect(s.dims[0], s.dims[1], s.target, s.rows, s.base);
  assert.equal(two.df, pair.dfI);
  assert.ok(Math.abs(two.SSI - pair.SSI) <= 1e-9 * pair.SSI, `${two.SSI} vs ${pair.SSI}`);
  assert.ok(Math.abs(two.p - pair.p) <= 1e-9 + 1e-6 * pair.p, `${two.p} vs ${pair.p}`);
  assert.ok(Math.abs(two.omega2 - pair.omega2) <= 1e-12);
});

test("for a rate, two parameters give the pair's likelihood-ratio test", () => {
  const s = sweep(4000, [2, 3], (x, z, u) => (u() < 0.2 + 0.1 * x[0] + 0.15 * (x[0] === 1 && x[1] === 2) ? 1 : 0), 23, "binary");
  const two = E.comboEffect(s.dims, s.target, s.rows, s.base, 5);
  const pair = E.pairEffect(s.dims[0], s.dims[1], s.target, s.rows, s.base);
  assert.ok(Math.abs(two.G - pair.D) <= 1e-6 * Math.max(1, pair.D), `G ${two.G} vs D ${pair.D}`);
  assert.ok(Math.abs(two.p - pair.p) <= 1e-6, `${two.p} vs ${pair.p}`);
});

test("a planted three-way effect is found, and pairs are not taken for one", () => {
  // the needle moves only when all three hold their value
  const three = sweep(6000, [2, 3, 2], (x, z) => 0.6 * (x[0] === 1 && x[1] === 2 && x[2] === 1) + z(), 5);
  const r3 = E.comboEffect(three.dims, three.target, three.rows, three.base, 5);
  assert.equal(r3.df, 1 * 2 * 1);
  assert.ok(r3.p < 1e-3 && r3.omega2 > 0, `p ${r3.p} for a planted three-way effect`);
  // every pair interacts, nothing is left for the three together: over 50
  // sweeps, p falls under 0.05 about as often as chance says, never far
  const nulls = (mk) => Array.from({ length: 50 }, (_, s) => { const w = mk(100 + s); return E.comboEffect(w.dims, w.target, w.rows, w.base, 5).p; });
  const cont = nulls((seed) => sweep(3000, [2, 3, 2], (x, z) => 0.5 * (x[0] === 1 && x[1] === 2) + 0.5 * (x[1] === 0 && x[2] === 1) + 0.5 * (x[0] === 0 && x[2] === 0) + z(), seed));
  assert.ok(cont.filter(p => p < 0.05).length <= 8 && Math.min(...cont) > 1e-4, `p values for a needle with no three-way term: ${cont.map(p => p.toFixed(3))}`);
  // a rate whose logit holds only a pair and a main effect: the logistic
  // model with every pair is exactly right, so nothing is left
  const logit = (v) => 1 / (1 + Math.exp(-v));
  const rate = nulls((seed) => sweep(4000, [2, 2, 3], (x, z, u) => (u() < logit(-1.5 + 1.0 * (x[0] === 1 && x[1] === 1) + 0.6 * (x[2] === 2)) ? 1 : 0), seed, "binary"));
  assert.ok(rate.filter(p => p < 0.05).length <= 8 && Math.min(...rate) > 1e-4, `p values for a rate with no three-way term: ${rate.map(p => p.toFixed(3))}`);
});

test("a grid with a cell under the minimum is not tested", () => {
  const s = sweep(200, [4, 4, 4], (x, z) => z(), 3);
  const r = E.comboEffect(s.dims, s.target, s.rows, s.base, 5);
  assert.equal(r.sparse, true);
  assert.ok(r.minN < 5);
  assert.ok(Number.isNaN(r.p));
  // with its table, every cell is still described
  const t = E.comboEffect(s.dims, s.target, s.rows, s.base, 5, true);
  assert.equal(t.table.length, 64);
  assert.equal(t.table.reduce((a, c) => a + c.n, 0), 200);
});
