// The Trials view's arithmetic: ranks with ties, a tie that runs past the
// list told as one group, the rows like a row (the row itself left out),
// and a row's value at the precision it was written with.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../../web/js/engine.js";
import { recordedDecimals } from "../../web/js/schema.js";
import { fmtRowValue } from "../../web/js/ui.js";

const rowsOf = (n) => Uint32Array.from({ length: n }, (_, i) => i);
const higher = (v) => [[i => v[i], 1]];
const dim = (id, codes, L) => ({ id, levels: Array.from({ length: L }, (_, j) => ({ key: String(j), label: String(j) })), codes: Int32Array.from(codes) });

test("rows that tie share the rank of the first of them, in the order they arrived", () => {
  const v = [5, 3, 3, 3, 1, 1, 0, 0, 0, 0];
  const r = E.rankRows(rowsOf(v.length), higher(v), 6);
  assert.deepEqual(r.list.map(x => [x.i, x.rank, x.tie]), [[0, 1, 1], [1, 2, 3], [2, 2, 3], [3, 2, 3], [4, 5, 2], [5, 5, 2]]);
  assert.equal(r.cut, null, "the list ends where a tie ends");
  assert.equal(r.n, 10);
});

test("a tie that runs past the list is told as one group, not listed", () => {
  const v = [5, 3, 3, 3, 1, 1, 0, 0, 0, 0];
  const r = E.rankRows(rowsOf(v.length), higher(v), 7);
  assert.deepEqual(r.list.map(x => x.i), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([r.cut.rank, r.cut.n, v[r.cut.row]], [7, 4, 0]);
  // every row one tie: nothing is listed
  const flat = E.rankRows(rowsOf(5), higher([2, 2, 2, 2, 2]), 3);
  assert.deepEqual(flat.list, []);
  assert.deepEqual([flat.cut.rank, flat.cut.n], [1, 5]);
  // fewer rows than the list: every row, ties and all
  const few = E.rankRows(rowsOf(4), higher([1, 0, 0, 0]), 100);
  assert.deepEqual(few.list.map(x => x.rank), [1, 2, 2, 2]);
  assert.equal(few.cut, null);
});

test("rows without a value are not ranked, and a key can rank lower first", () => {
  const v = [1, NaN, 3, 2];
  const r = E.rankRows(rowsOf(4), [[i => v[i], -1]], 10);
  assert.deepEqual(r.list.map(x => x.i), [0, 3, 2]);
  assert.equal(r.missing, 1);
});

test("with several keys, the next one breaks the first one's ties", () => {
  const gates = [9, 9, 8, 9], perMonth = [1.5, 2.5, 9, 2.5];
  const r = E.rankRows(rowsOf(4), [[i => gates[i], 1], [i => perMonth[i], 1]], 10);
  assert.deepEqual(r.list.map(x => [x.i, x.rank, x.tie]), [[1, 1, 2], [3, 1, 2], [0, 3, 1], [2, 4, 1]]);
});

test("the rows like a row share its values of the strongest movers that leave enough rows", () => {
  // a alternates, b steps every two rows; the needle is 10a + b, and one
  // row is lucky
  const n = 200;
  const a = dim("a", Array.from({ length: n }, (_, i) => i % 2), 2);
  const b = dim("b", Array.from({ length: n }, (_, i) => Math.floor(i / 2) % 4), 4);
  const y = Float64Array.from({ length: n }, (_, i) => 10 * a.codes[i] + b.codes[i]);
  y[7] = 100;
  const t = { values: y, kind: "cont" };
  // row 7 holds a = 1 and b = 3, as 24 other rows do; it is left out
  const [both] = E.rowsLikeIt([a, b], t, rowsOf(n), [7], 20);
  assert.deepEqual([both.j, both.dims, both.n, both.mean], [2, ["a", "b"], 24, 13]);
  // 24 is under 30: only the stronger mover is matched
  const [one] = E.rowsLikeIt([a, b], t, rowsOf(n), [7], 30);
  assert.deepEqual([one.j, one.n], [1, 99]);
  assert.ok(Math.abs(one.mean - (1150 - 13) / 99) < 1e-12, `${one.mean}`);
  // nothing moves the needle: every other row
  const [none] = E.rowsLikeIt([], t, rowsOf(n), [7], 30);
  assert.deepEqual([none.j, none.n], [0, 199]);
  assert.ok(Math.abs(none.mean - (1300 + 87 - 100) / 199) < 1e-12, `${none.mean}`);
  assert.ok(none.lo < none.mean && none.mean < none.hi);
});

test("for a rate, the rows like it give their share of hits", () => {
  const n = 120;
  const a = dim("a", Array.from({ length: n }, (_, i) => i % 3), 3);
  // hits where a = 2 and the row is a multiple of four: rows 8, 20, …, 116
  const y = Float64Array.from({ length: n }, (_, i) => (a.codes[i] === 2 && i % 4 === 0 ? 1 : 0));
  const [r] = E.rowsLikeIt([a], { values: y, kind: "binary" }, rowsOf(n), [8], 30);
  assert.equal(r.n, 39);
  assert.ok(Math.abs(r.mean - 9 / 39) < 1e-12, `${r.mean}`);
  assert.ok(r.lo < r.mean && r.mean < r.hi);
});

test("a parameter that does not apply is a value like any other", () => {
  const n = 90;
  const s = dim("s", Array.from({ length: n }, (_, i) => (i < 60 ? -1 : i % 2)), 2);
  const y = Float64Array.from({ length: n }, (_, i) => (i < 60 ? 1 : 5));
  const [r] = E.rowsLikeIt([s], { values: y, kind: "cont" }, rowsOf(n), [0], 30);
  assert.deepEqual([r.j, r.n, r.mean], [1, 59, 1]);
});

test("a target's values are shown no finer than they were written", () => {
  assert.equal(recordedDecimals(Float64Array.from([0.7, -0.1, 0, 12.3, NaN])), 1);
  assert.equal(recordedDecimals(Float64Array.from([1, 2, 300])), 0);
  assert.equal(recordedDecimals(Float64Array.from([0.647, 0.5])), 3);
  assert.equal(recordedDecimals(Float64Array.from([0.5, 0.1234567])), null);
  const pnl = { kind: "cont", unit: "bps", digits: 3, decimals: 1 };
  assert.equal(fmtRowValue(pnl, 0.7), "0.7 bps");
  assert.equal(fmtRowValue(pnl, 0.7, { unit: false }), "0.7");
  assert.equal(fmtRowValue({ kind: "cont", unit: "", digits: 3, decimals: null }, 0.6473829), "0.647");
  assert.equal(fmtRowValue({ kind: "binary", unit: "share of rows", digits: 1 }, 1), "yes");
  assert.equal(fmtRowValue({ kind: "binary", unit: "share of rows", digits: 1 }, 0), "no");
  assert.equal(fmtRowValue(pnl, NaN), "–");
});
