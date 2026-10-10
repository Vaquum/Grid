// Features on a Limen run: the manifest's groups, the pairs of drawn
// combinations that differ by one group, and the model that gives each
// dropped column its effect, on a design built the way Limen's is (groups
// switched on per round, a few columns dropped with one of three seeds,
// a column named after a parameter's value).

import { test } from "node:test";
import assert from "node:assert/strict";
import { limenDesign, groupsOf, groupContrasts, ablationMembers, ablationModel, MIN_DROPS } from "../../web/js/ablation.js";
import { Dataset, roundKey } from "../../web/js/pack.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dim = (id, values, codes) => ({ id, label: id, levels: values.map(v => ({ key: String(v), label: String(v), value: v })), codes: Int32Array.from(codes) });

// A Limen-like sweep: groups A (a1..a3) and B (b1, b2, r_{period}), four
// columns every round has, a parameter x that moves the needle, and an
// ablation dropping `count` columns chosen by one of three seeds (as with
// Limen, some columns are never chosen: a1, a3). The needle: x, the
// groups, and planted effects of dropping a2 and t2.
function sweep(n, seed, planted = { a2: -0.8, t2: 0.6 }) {
  const u = rng(seed);
  const z = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  const combos = ["all", "A", "B"], periods = [1, 5], seeds = [7, 42, 1337];
  const cols = { A: ["a1", "a2", "a3"], B: ["b1", "b2"] };
  const fg = [], per = [], xs = [], y = new Float64Array(n), rounds = new Map();
  for (let i = 0; i < n; i++) {
    const g = Math.floor(u() * 3), p = Math.floor(u() * 2), x = Math.floor(u() * 2), count = Math.floor(u() * 4), s = seeds[Math.floor(u() * 3)];
    const on = combos[g] === "all" ? ["A", "B"] : [combos[g]];
    const eligible = ["t1", "t2", "t3", "t4", ...on.flatMap(k => cols[k]), ...(on.includes("B") ? [`r_${periods[p]}`] : [])].sort();
    // the drop set is fixed by the eligible columns, the seed and the count
    const pick = rng(s * 7919 + eligible.length), pool = eligible.slice(), dropped = [];
    for (let k = 0; k < count; k++) dropped.push(pool.splice(Math.floor(pick() * pool.length), 1)[0]);
    let v = 0.5 * x + (combos[g] === "B" ? -0.3 : 0) + z();
    for (const c of dropped) v += planted[c] || 0;
    fg.push(g); per.push(p); xs.push(x); y[i] = v;
    rounds.set(i, dropped.sort());
  }
  const roundIndex = { kind: "num", state: new Uint8Array(n), vals: Float64Array.from({ length: n }, (_, i) => i) };
  const ds = { n, rounds, col: name => (name === "_round_index" ? roundIndex : null) };
  const dims = [dim("feature_groups", combos, fg), dim("period", periods, per), dim("x", [0, 1], xs)];
  const schema = { dimById: new Map(dims.map(d => [d.id, d])) };
  const design = { groups: [{ name: "A", funcs: ["fa"] }, { name: "B", funcs: ["fb", "r"] }], always: ["ft"], naming: ["period"], ablation: { countKey: "c", seedKey: "s" } };
  return { ds, schema, design, dims, target: { values: y, kind: "cont" }, rows: Uint32Array.from({ length: n }, (_, i) => i) };
}

test("the manifest gives the groups, what every round has, and the parameters features take", () => {
  const d = limenDesign({ manifest: { sfd: { manifest: {
    indicators: [{ func: "limen.indicators.roc.roc", params: { period: "{ret_period}", group: "momentum" } }],
    features: [{ func: "limen.features.price_lines.price_lines", params: { max_duration_hours: "{max_duration_hours}", group: "lines" } },
      { func: "limen.features.cyclical_time_features.cyclical_time_features" }],
    feature_ablation: { drop_count_key: "feature_drop_count", seed_key: "feature_drop_seed" } } } } });
  assert.deepEqual(d.groups, [{ name: "momentum", funcs: ["roc"] }, { name: "lines", funcs: ["price_lines"] }]);
  assert.deepEqual(d.always, ["cyclical_time_features"]);
  assert.deepEqual(d.naming, ["ret_period", "max_duration_hours"]);
  assert.deepEqual(d.ablation, { countKey: "feature_drop_count", seedKey: "feature_drop_seed" });
  assert.deepEqual(groupsOf(d, "all"), ["momentum", "lines"]);
  assert.deepEqual(groupsOf(d, "lines|momentum"), ["lines", "momentum"]);
});

test("drawn combinations that differ by one group say what adding it did", () => {
  // no drop moves the needle here: the combinations differ by their groups alone
  const s = sweep(3000, 3, {});
  const r = groupContrasts(s.design, s.dims[0], s.target, s.rows);
  // all = A + B: adding B to A, and adding A to B
  assert.deepEqual(r.contrasts.map(c => `${c.added} to ${c.from.label}`).sort(), ["A to B", "B to A"]);
  const bToA = r.contrasts.find(c => c.added === "B");
  // B alone was planted 0.3 lower; adding B to A changes little, adding A to B lifts it
  assert.ok(Math.abs(bToA.delta) < 0.25, `${bToA.delta}`);
  const aToB = r.contrasts.find(c => c.added === "A");
  assert.ok(aToB.delta > 0.1 && aToB.lo > 0, `${aToB.delta} [${aToB.lo}, ${aToB.hi}]`);
});

test("a column named after a parameter's value is one member, named by the parameter", () => {
  const s = sweep(1200, 5);
  const am = ablationMembers(s.ds, s.schema, s.design, s.rows);
  const names = am.members.map(m => m.name).sort();
  assert.ok(names.includes("r_{period}"), names.join(", "));
  assert.ok(!names.some(n => /^r_\d/.test(n)), names.join(", "));
  assert.deepEqual([...am.members.find(m => m.name === "r_{period}").raw].sort(), ["r_1", "r_5"]);
  // every row has a record; one without is unknown, not "dropped nothing"
  s.ds.rounds.delete(0);
  assert.equal(ablationMembers(s.ds, s.schema, s.design, s.rows).perRow[0], null);
});

test("a run read from several result directories joins each row to its own directory's round", () => {
  const s = sweep(600, 9);
  const plain = ablationMembers(s.ds, s.schema, s.design, s.rows);
  // the same rows from two directories, each counting its rounds from 0
  const shardOf = i => (i < 300 ? "s1" : "s2"), indexOf = i => (i < 300 ? i : i - 300);
  const pack = new Dataset({ id: "r0" });
  pack.addRounds([...s.ds.rounds].map(([i, dropped]) => [indexOf(i), dropped, shardOf(i)]));
  assert.deepEqual(pack.rounds.get(roundKey(0, "s2")), s.ds.rounds.get(300));
  const ri = { kind: "num", state: new Uint8Array(600), vals: Float64Array.from({ length: 600 }, (_, i) => indexOf(i)) };
  const sh = { value: i => shardOf(i) };
  const ds = { n: 600, rounds: pack.rounds, meta: { experiment: { shards: { s1: "/a", s2: "/b" } } },
    col: name => (name === "_round_index" ? ri : name === "shard" ? sh : null) };
  assert.deepEqual(ablationMembers(ds, s.schema, s.design, s.rows).perRow, plain.perRow);
});

test("the model finds planted effects of dropping a column, and keeping is the opposite sign", () => {
  const s = sweep(6000, 11);
  const am = ablationMembers(s.ds, s.schema, s.design, s.rows);
  const fit = ablationModel(s.target, s.rows, [s.dims[0], s.dims[1], s.dims[2]], am.members, am.perRow);
  const term = name => fit.terms.find(t => t.members.some(m => m.name === name));
  const a2 = term("a2"), t2 = term("t2");
  assert.equal(term("a1"), undefined, "a column never dropped has no term");
  // dropping a2 lowered the needle by 0.8: keeping it is +0.8
  assert.ok(a2.detectable && a2.lo < 0.8 && 0.8 < a2.hi, `a2 ${a2.keep} [${a2.lo}, ${a2.hi}] q ${a2.q}`);
  assert.ok(t2.detectable && t2.lo < -0.6 && -0.6 < t2.hi, `t2 ${t2.keep} [${t2.lo}, ${t2.hi}] q ${t2.q}`);
  const others = fit.terms.filter(t => t !== a2 && t !== t2 && !t.reason);
  assert.ok(others.filter(t => t.detectable).length <= 1, `columns with no planted effect called detectable: ${others.filter(t => t.detectable).map(t => t.members[0].name)}`);
});

// Least squares by brute force: the dense design, Gaussian elimination.
function ols(X, y) {
  const p = X[0].length, A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let r = 0; r < X.length; r++) for (let a = 0; a < p; a++) { A[a][p] += X[r][a] * y[r]; for (let b = 0; b < p; b++) A[a][b] += X[r][a] * X[r][b]; }
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((row, a) => row[p] / A[a][a]);
}

test("its terms are the least squares fit of the needle on the groups, the factors and the drops", () => {
  const s = sweep(800, 17);
  const am = ablationMembers(s.ds, s.schema, s.design, s.rows);
  const factors = [s.dims[0], s.dims[2]];
  const fit = ablationModel(s.target, s.rows, factors, am.members, am.perRow);
  const terms = fit.terms;
  const X = [], y = [];
  for (let i = 0; i < s.ds.n; i++) {
    const row = [1];
    for (const f of factors) for (let l = 1; l < f.levels.length; l++) row.push(f.codes[i] === l ? 1 : 0);
    for (const t of terms) row.push(t.mi.some(mi => am.perRow[i].includes(mi)) ? 1 : 0);
    X.push(row); y.push(s.target.values[i]);
  }
  const b = ols(X, y), t0 = 1 + factors.reduce((a, f) => a + f.levels.length - 1, 0);
  terms.forEach((t, k) => {
    if (t.reason) return;
    assert.ok(Math.abs(t.beta - b[t0 + k]) < 1e-8, `${t.members[0].name}: ${t.beta} vs ${b[t0 + k]}`);
  });
});

test("columns always dropped together are one term; a column dropped too rarely gets no number", () => {
  const n = 400, u = rng(9);
  const g = dim("feature_groups", ["all"], new Array(n).fill(0));
  const members = [{ name: "p" }, { name: "q" }, { name: "w" }, { name: "rare" }];
  const perRow = [], y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const list = [];
    if (i % 3 === 0) list.push(0, 1);          // p and q always together
    if (i % 4 === 1) list.push(2);
    if (i < MIN_DROPS - 1) list.push(3);       // rare: one drop short
    perRow.push(list);
    y[i] = (i % 3 === 0 ? -1 : 0) + u();
  }
  const fit = ablationModel({ values: y, kind: "cont" }, Uint32Array.from({ length: n }, (_, i) => i), [g], members, perRow);
  const pq = fit.terms.find(t => t.members.length === 2);
  assert.deepEqual(pq.members.map(m => m.name), ["p", "q"]);
  assert.ok(pq.keep > 0.8 && pq.detectable, `${pq.keep}`);
  assert.equal(fit.terms.find(t => t.members[0].name === "rare").reason, "few");
});
