// Clusters: rows grouped by what they did, read on their outcomes' ranks,
// with no group made where the rows do not fall into groups; and the tests
// that set one group of rows against another.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterOutcomes, clusterRows, rankScale, mannWhitney, composition, grade } from "../../web/js/clusters.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A schema with the four kinds of outcome a profile names (score, activity,
// risk, skill), a pass flag and a compute cost, over rows whose outcomes
// come from `kindOf(i)`: each kind of row its own centre, plus noise.
function sweep(n, seed, centres, kindOf, noise = 0.35) {
  const u = rng(seed);
  const z = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  const names = ["score", "entries", "drawdown", "auc"];
  const cols = names.map(() => new Float64Array(n));
  const kinds = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = kindOf(i, u);
    kinds[i] = k;
    names.forEach((_, j) => { cols[j][i] = centres[k][j] + noise * z(); });
  }
  const t = (id, j, group, extra = {}) => ({ id, label: id, kind: "cont", values: cols[j], group, ...extra });
  const targets = [t("score", 0, null), t("entries", 1, "activity"), t("drawdown", 2, "risk"), t("auc", 3, "skill"),
    { id: "pass", label: "pass", kind: "binary", values: Float64Array.from(cols[0], v => (v > 0 ? 1 : 0)), gate: "g1" },
    { id: "sec", label: "sec", kind: "cont", values: Float64Array.from({ length: n }, () => u()), cost: true }];
  const schema = { targets, targetById: new Map(targets.map(x => [x.id, x])), objective: [["score", -1]] };
  return { schema, rows: Uint32Array.from({ length: n }, (_, i) => i), kinds };
}

const THREE = [[0, 0, 0, 0], [3, 3, -3, 1], [-3, 2, 3, -2]];

test("the outcomes are the score and the profile's activity, risk and skill, never a pass flag or a cost", () => {
  const { schema } = sweep(10, 1, THREE, () => 0);
  const outs = clusterOutcomes(schema);
  assert.deepEqual(outs.map(o => `${o.t.id}:${o.kind}`), ["score:score", "entries:activity", "drawdown:risk", "auc:skill"]);
  // without groups, every outcome alike (still no pass flag, no cost)
  for (const t of schema.targets) delete t.group;
  assert.deepEqual(clusterOutcomes(schema).map(o => `${o.t.id}:${o.kind}`), ["score:outcome", "entries:outcome", "drawdown:outcome", "auc:outcome"]);
});

test("ranks are shares in (0, 1) with ties at their mean rank, and missing stays missing", () => {
  const v = Float64Array.from([5, 0, 0, NaN, 9, 0]);
  const z = rankScale(v, Uint32Array.from([0, 1, 2, 3, 4, 5]));
  // five values: the three zeros share ranks 1-3 (mean 2), then 5, then 9
  assert.deepEqual([...z].map(x => (Number.isNaN(x) ? "NaN" : x.toFixed(2))), ["0.70", "0.30", "0.30", "NaN", "0.90", "0.30"]);
  assert.equal(rankScale(Float64Array.from([1, 1, 1]), Uint32Array.from([0, 1, 2])), null);
});

test("three planted kinds of row come back as three clusters, largest first, the same every time", () => {
  const { schema, rows, kinds } = sweep(900, 7, THREE, (i, u) => (u() < 0.5 ? 0 : u() < 0.6 ? 1 : 2));
  const r = clusterRows(schema, rows, { n: rows.length });
  assert.equal(r.k, 3, JSON.stringify(r.scores));
  assert.ok(r.silhouette >= 0.51, `${r.silhouette}`);
  assert.equal(r.grade, grade(r.silhouette));
  assert.ok(r.clusters[0].n >= r.clusters[1].n && r.clusters[1].n >= r.clusters[2].n);
  assert.deepEqual(r.clusters.map(c => c.id), ["A", "B", "C"]);
  // each cluster is one planted kind (at least 97% of it)
  for (const c of r.clusters) {
    const count = [0, 0, 0];
    for (const i of c.rows) count[kinds[i]]++;
    assert.ok(Math.max(...count) / c.n >= 0.97, `${c.id}: ${count}`);
  }
  // every row has its cluster
  assert.equal(r.clusters.reduce((a, c) => a + c.n, 0), rows.length);
  for (const c of r.clusters) for (const i of c.rows) assert.equal(r.labelOf[i], c.index);
  // the same rows give the same clusters
  const again = clusterRows(schema, rows, { n: rows.length });
  assert.deepEqual(again.clusters.map(c => [...c.rows].join()), r.clusters.map(c => [...c.rows].join()));
  // a cluster names the outcomes it stands out on
  const big = r.clusters.find(c => c.rows.every(i => kinds[i] === 0) || c.n > 400);
  assert.equal(big.standsOut.length, 2);
});

test("rows that do not fall into groups get no clusters", () => {
  const { schema, rows } = sweep(800, 3, [[0, 0, 0, 0]], () => 0, 1);
  const r = clusterRows(schema, rows, { n: rows.length });
  assert.equal(r.clusters.length, 0);
  assert.equal(r.reason, "weak");
  assert.ok(r.silhouette < 0.26, `${r.silhouette}`);
});

test("too few rows, or a group under 30 rows, makes no cluster of it", () => {
  const few = sweep(50, 4, THREE, i => i % 3);
  assert.equal(clusterRows(few.schema, few.rows).reason, "few");
  // 20 rows of a far kind among 600: no cluster of 20
  const { schema, rows } = sweep(620, 5, THREE, i => (i < 20 ? 1 : 0), 0.2);
  const r = clusterRows(schema, rows, { n: rows.length });
  for (const c of r.clusters) assert.ok(c.n >= 30, `${c.id} has ${c.n}`);
});

test("a missing outcome is never filled in: the row is placed by the outcomes it has", () => {
  const { schema, rows, kinds } = sweep(900, 9, THREE, (i, u) => Math.floor(u() * 3));
  // the risk outcome is missing for every row of kind 2 (as a round with no
  // losing bar has no mean losing bar); one row misses all but one outcome
  const dd = schema.targetById.get("drawdown").values;
  for (let i = 0; i < 900; i++) if (kinds[i] === 2) dd[i] = NaN;
  for (const t of ["entries", "drawdown", "auc"]) schema.targetById.get(t).values[0] = NaN;
  const r = clusterRows(schema, rows, { n: rows.length });
  assert.equal(r.k, 3, JSON.stringify(r.scores));
  assert.equal(r.left, 1);
  assert.equal(r.labelOf[0], -1);
  for (const c of r.clusters) {
    const count = [0, 0, 0];
    for (const i of c.rows) count[kinds[i]]++;
    assert.ok(Math.max(...count) / c.n >= 0.97, `${c.id}: ${count}`);
  }
});

test("Mann-Whitney finds a shift, not a same distribution, and says which way", () => {
  const u = rng(11);
  const v = Float64Array.from({ length: 400 }, (_, i) => u() + (i < 200 ? 0.25 : 0));
  const a = Uint32Array.from({ length: 200 }, (_, i) => i), b = Uint32Array.from({ length: 200 }, (_, i) => 200 + i);
  const r = mannWhitney(v, a, b);
  assert.ok(r.p < 1e-6 && r.shift > 0.6, JSON.stringify(r));
  const same = Float64Array.from({ length: 400 }, () => u());
  assert.ok(mannWhitney(same, a, b).p > 0.05);
  // ties: two groups of only zeros and ones
  const tied = Float64Array.from({ length: 400 }, (_, i) => (i < 200 ? (i % 4 === 0 ? 1 : 0) : (i % 2 ? 1 : 0)));
  const t = mannWhitney(tied, a, b);
  assert.ok(t.p < 1e-4 && t.shift < 0.5, JSON.stringify(t));
});

test("composition finds the parameter that sends rows into a group, and not the one that does not", () => {
  const u = rng(13);
  const n = 1200;
  const lv = k => Array.from({ length: k }, (_, j) => ({ key: String(j), label: String(j) }));
  const cal = { id: "cal", label: "cal", levels: lv(2), codes: Int32Array.from({ length: n }, () => (u() < 0.5 ? 1 : 0)) };
  const inert = { id: "inert", label: "inert", levels: lv(3), codes: Int32Array.from({ length: n }, () => Math.floor(u() * 3)) };
  const inGroup = Uint8Array.from({ length: n }, (_, i) => (u() < (cal.codes[i] ? 0.7 : 0.3) ? 1 : 0));
  const rows = Uint32Array.from({ length: n }, (_, i) => i);
  const res = composition([cal, inert], rows, i => inGroup[i] === 1, rows);
  const [c, z] = res;
  assert.ok(c.q < 1e-6 && c.V > 0.3, JSON.stringify({ q: c.q, V: c.V }));
  assert.ok(z.q > 0.05, `${z.q}`);
  // the shares: cal = 1 is over-represented in the group
  assert.ok(c.levels[1].inGroup > 0.6 && Math.abs(c.levels[1].inRef - 0.5) < 0.05);
});
