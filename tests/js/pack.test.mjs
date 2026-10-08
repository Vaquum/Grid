import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodePack, rowObject, Dataset } from "../../web/js/pack.js";

const G = JSON.parse(readFileSync(new URL("../golden/pack.json", import.meta.url)));

// Python writes non-finite numbers as strings in the golden rows.
function portable(v) {
  if (typeof v === "number" && !Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
  if (Array.isArray(v)) return v.map(portable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, portable(x)]));
  return v;
}

test("every row decodes to exactly what Python rebuilds", () => {
  const { runs } = decodePack(structuredClone(G.pack));
  const ds = runs[0];
  assert.equal(ds.n, G.rows.length);
  G.rows.forEach((want, i) => assert.deepEqual(portable(rowObject(ds, i)), want, `row ${i}`));
  assert.ok(Object.is(ds.col("v").value(0), -0), "-0 keeps its sign");
});

test("null and absent stay apart", () => {
  const { runs } = decodePack(structuredClone(G.pack));
  const ds = runs[0];
  assert.equal(ds.col("tp").value(0), null);
  assert.equal(ds.col("hp.depth").value(0), undefined);
  assert.equal(ds.col("feats").value(2), null);
  assert.deepEqual(ds.col("feats").value(1), []);
});

test("a set wider than 32 members spans two words", () => {
  const { runs } = decodePack(structuredClone(G.pack));
  const f = runs[0].col("feats");
  assert.equal(f.words, 2);
  assert.equal(f.members(3).length, 41);
});

test("deltas append, extend dictionaries and add columns", () => {
  const ds = new Dataset({ id: "r0" });
  ds.append(0, 2, [{ name: "m", kind: "str", levelBase: 0, levels: ["a", "b"], data: [0, 1] }], [null, null]);
  ds.append(2, 3, [{ name: "m", kind: "str", levelBase: 2, levels: ["c"], data: [2] },
                   { name: "x", kind: "num", data: [1.5] }], [1700000000.5]);
  assert.deepEqual([0, 1, 2].map(i => ds.col("m").value(i)), ["a", "b", "c"]);
  assert.deepEqual([0, 1, 2].map(i => ds.col("x").value(i)), [undefined, undefined, 1.5]);
  assert.equal(ds.arrivals[2], 1700000000.5);
  assert.ok(Number.isNaN(ds.arrivals[0]));
  assert.throws(() => ds.append(5, 6, [], null), /do not follow/);
  assert.throws(() => ds.append(3, 4, [{ name: "m", kind: "str", levelBase: 1, levels: [], data: [0] }], null), /out of step/);
});
