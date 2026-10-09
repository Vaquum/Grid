// Clusters: the rows grouped by what they did. A row is read on the
// outcomes that say what it did (its score, the activity it rests on, the
// risk that came with it, its model's skill), each outcome by its rank
// among the rows, so a heavy tail or a heap of rows at 0 weighs like any
// other spread, and the four kinds weigh alike however many outcomes each
// has. k-means (k-means++ starts from a fixed seed, so the same rows give
// the same clusters) for k from 2 to 7; the k with the best silhouette is
// kept. No clusters are made when the rows do not fall into groups (a
// silhouette under 0.26, Kaufman and Rousseeuw's "no substantial
// structure") or a group would hold fewer than 30 rows.
//
// A missing outcome is never filled in: a row is measured on the outcomes
// it has (the distance scaled to the full weight), and a row with less
// than half the weight is left out of every cluster.
//
// The clusters are drawn from these outcomes, so their differences on them
// are made by the clustering and are never tested. What can be tested is
// what was not used to draw them: the parameters, and any other outcome.

import { MIN_N, gTest } from "./engine.js";
import { bhQ, normCdf } from "./stats.js";

export const K_MAX = 7;
export const MIN_SILHOUETTE = 0.26;
const SAMPLE_K = 2000;     // rows k is chosen on
const SAMPLE_SIL = 1000;   // rows the silhouette is read on
const SAMPLE_FIT = 20000;  // rows the final centres are fitted on
const RESTARTS = 4;
const MAX_ITER = 60;
const SEED = 0x5eed;
const KINDS = ["score", "activity", "risk", "skill", "outcome"];
export const CLUSTER_IDS = "ABCDEFG";

// The outcomes clusters are drawn from, each with its kind and weight.
// A profile says what its outcomes tell (score: the runner's objective;
// activity, risk, skill: the metric's group). Without one, every outcome
// that is not a pass flag, a fit diagnostic or a compute cost, alike.
export function clusterOutcomes(schema) {
  const usable = t => t && t.values && !t.diagnostic && !t.gate && !t.cost && t.kind !== "binary";
  const out = [];
  const objective = schema.objective ? schema.objective.map(([id]) => id) : [];
  for (const id of objective) { const t = schema.targetById.get(id); if (usable(t)) out.push({ t, kind: "score" }); }
  for (const kind of ["activity", "risk", "skill"]) {
    for (const t of schema.targets) if (t.group === kind && usable(t) && !objective.includes(t.id)) out.push({ t, kind });
  }
  if (!out.some(o => o.kind !== "score")) {
    out.length = 0;
    for (const t of schema.targets) if (usable(t)) out.push({ t, kind: "outcome" });
  }
  return out;
}

// Each value's rank among the rows that have one, as a share in (0, 1),
// ties at their mean rank; missing stays NaN. Null when the outcome takes
// fewer than two values in these rows.
export function rankScale(values, rows) {
  const n = rows.length, z = new Float64Array(n).fill(NaN);
  const idx = [];
  for (let j = 0; j < n; j++) { const v = values[rows[j]]; if (v === v) idx.push(j); }
  const m = idx.length;
  if (m < 2) return null;
  idx.sort((a, b) => values[rows[a]] - values[rows[b]]);
  let i = 0, distinct = 0;
  while (i < m) {
    const v = values[rows[idx[i]]];
    let k = i;
    while (k + 1 < m && values[rows[idx[k + 1]]] === v) k++;
    const r = ((i + k) / 2 + 0.5) / m;
    for (let q = i; q <= k; q++) z[idx[q]] = r;
    distinct++;
    i = k + 1;
  }
  return distinct < 2 ? null : z;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The points: one per usable row, its outcomes' ranks; the weights; and
// the rows left out for missing too much.
function points(outs, rows) {
  const cols = [], kinds = [];
  for (const o of outs) {
    const z = rankScale(o.t.values, rows);
    if (z) { cols.push(z); kinds.push(o); }
  }
  const d = cols.length;
  const per = new Map();
  for (const o of kinds) per.set(o.kind, (per.get(o.kind) || 0) + 1);
  const w = Float64Array.from(kinds, o => 1 / per.get(o.kind));
  let W = 0;
  for (let j = 0; j < d; j++) W += w[j];
  const keep = [];
  for (let r = 0; r < rows.length; r++) {
    let wo = 0;
    for (let j = 0; j < d; j++) if (cols[j][r] === cols[j][r]) wo += w[j];
    if (d && wo >= W / 2) keep.push(r);
  }
  const X = new Float64Array(keep.length * d);
  keep.forEach((r, p) => { for (let j = 0; j < d; j++) X[p * d + j] = cols[j][r]; });
  return { X, d, w, W, keep, used: kinds, left: rows.length - keep.length };
}

// Squared distance from point p to centre c, over the outcomes p has,
// scaled to the full weight.
function dist2(P, p, C, c) {
  const { X, d, w, W } = P;
  let s = 0, wo = 0;
  for (let j = 0; j < d; j++) {
    const x = X[p * d + j];
    if (x !== x) continue;
    const e = x - C[c * d + j];
    s += w[j] * e * e;
    wo += w[j];
  }
  return wo > 0 ? s * W / wo : Infinity;
}

// Distance between two points, over the outcomes both have.
function pairDist(P, a, b) {
  const { X, d, w, W } = P;
  let s = 0, wo = 0;
  for (let j = 0; j < d; j++) {
    const x = X[a * d + j], y = X[b * d + j];
    if (x !== x || y !== y) continue;
    const e = x - y;
    s += w[j] * e * e;
    wo += w[j];
  }
  return wo > 0 ? Math.sqrt(s * W / wo) : NaN;
}

function colMeans(P, set) {
  const { X, d } = P;
  const sum = new Float64Array(d), cnt = new Float64Array(d);
  for (const p of set) for (let j = 0; j < d; j++) { const x = X[p * d + j]; if (x === x) { sum[j] += x; cnt[j]++; } }
  return Float64Array.from(sum, (s, j) => (cnt[j] ? s / cnt[j] : 0.5));
}

// k-means++ starts: the first centre a random point, each next one a point
// drawn with probability proportional to its squared distance from the
// nearest centre so far. A centre's missing outcome takes the mean.
function seedCentres(P, set, k, rnd, means) {
  const { X, d } = P;
  const C = new Float64Array(k * d);
  const put = (c, p) => { for (let j = 0; j < d; j++) { const x = X[p * d + j]; C[c * d + j] = x === x ? x : means[j]; } };
  put(0, set[Math.floor(rnd() * set.length)]);
  const best = new Float64Array(set.length).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let q = 0; q < set.length; q++) {
      const e = dist2(P, set[q], C, c - 1);
      if (e < best[q]) best[q] = e;
      if (Number.isFinite(best[q])) total += best[q];
    }
    let r = rnd() * total, pick = set[set.length - 1];
    for (let q = 0; q < set.length; q++) {
      if (!Number.isFinite(best[q])) continue;
      r -= best[q];
      if (r <= 0) { pick = set[q]; break; }
    }
    put(c, pick);
  }
  return C;
}

// Lloyd's iterations from the given centres; a cluster left empty takes the
// point farthest from its centre.
function lloyd(P, set, C, k) {
  const { X, d } = P;
  const lab = new Int32Array(set.length).fill(-1);
  let inertia = 0;
  for (let it = 0; it < MAX_ITER; it++) {
    let changed = 0;
    inertia = 0;
    for (let q = 0; q < set.length; q++) {
      let bc = 0, be = Infinity;
      for (let c = 0; c < k; c++) { const e = dist2(P, set[q], C, c); if (e < be) { be = e; bc = c; } }
      if (lab[q] !== bc) { lab[q] = bc; changed++; }
      inertia += be;
    }
    if (!changed && it > 0) break;
    const sum = new Float64Array(k * d), cnt = new Float64Array(k * d), size = new Int32Array(k);
    for (let q = 0; q < set.length; q++) {
      const p = set[q], c = lab[q];
      size[c]++;
      for (let j = 0; j < d; j++) { const x = X[p * d + j]; if (x === x) { sum[c * d + j] += x; cnt[c * d + j]++; } }
    }
    for (let c = 0; c < k; c++) {
      if (!size[c]) {
        let far = 0, fe = -1;
        for (let q = 0; q < set.length; q++) { const e = dist2(P, set[q], C, lab[q]); if (e > fe) { fe = e; far = q; } }
        for (let j = 0; j < d; j++) { const x = X[set[far] * d + j]; if (x === x) C[c * d + j] = x; }
        lab[far] = c;
        continue;
      }
      for (let j = 0; j < d; j++) if (cnt[c * d + j]) C[c * d + j] = sum[c * d + j] / cnt[c * d + j];
    }
  }
  return { C, lab, inertia };
}

// The mean silhouette of the points in `sil` (positions into `set`): how
// much nearer each sits to its own cluster than to the next one, from -1
// to 1.
function silhouette(P, set, lab, sil, k) {
  let total = 0, n = 0;
  const sums = new Float64Array(k), cnts = new Int32Array(k);
  for (const a of sil) {
    sums.fill(0); cnts.fill(0);
    for (const b of sil) {
      if (a === b) continue;
      const e = pairDist(P, set[a], set[b]);
      if (e !== e) continue;
      sums[lab[b]] += e;
      cnts[lab[b]]++;
    }
    const own = lab[a];
    if (!cnts[own]) { n++; continue; }
    const ai = sums[own] / cnts[own];
    let bi = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && cnts[c]) bi = Math.min(bi, sums[c] / cnts[c]);
    if (!Number.isFinite(bi)) continue;
    const den = Math.max(ai, bi);
    total += den > 0 ? (bi - ai) / den : 0;
    n++;
  }
  return n ? total / n : NaN;
}

export function grade(s) {
  return s >= 0.71 ? "strong" : s >= 0.51 ? "reasonable" : s >= MIN_SILHOUETTE ? "weak" : "none";
}

// The clusters of `rows`, computed in steps (a generator, so a large run
// can be clustered without stopping the page). The result:
//   outcomes   the outcomes drawn on, with their kind
//   scores     each k tried: its silhouette, whether every group held 30
//              rows, and whether it may be chosen (that, and a silhouette
//              of 0.26 or more)
//   best       the k with the best silhouette; `opts.k` asks for another
//   k, silhouette, grade   the k shown
//   clusters   [{ id, n, share, rows, medians, standsOut }], largest first,
//              or empty with a `reason` ("few", "flat", "weak")
//   labelOf    the cluster index of each row (by row number), -1 for none
//   left       rows left out for missing more than half the weight
export function* clusterJob(schema, rows, opts = {}) {
  const outs = clusterOutcomes(schema);
  const P = points(outs, rows);
  const base = { outcomes: P.used, scores: [], k: 0, silhouette: NaN, grade: "none", clusters: [], left: P.left, rows: rows.length, reason: null };
  const N = P.keep.length;
  if (P.d < 2) return { ...base, reason: "flat" };
  if (N < 2 * MIN_N) return { ...base, reason: "few" };
  const rnd = mulberry32(opts.seed ?? SEED);
  // one shuffle of the points: the first of it is every sample
  const order = Array.from({ length: N }, (_, p) => p);
  for (let p = N - 1; p > 0; p--) { const q = Math.floor(rnd() * (p + 1)); [order[p], order[q]] = [order[q], order[p]]; }
  const setK = order.slice(0, Math.min(N, SAMPLE_K));
  const sil = Array.from({ length: Math.min(setK.length, SAMPLE_SIL) }, (_, a) => a);
  const means = colMeans(P, setK);
  const tried = [];
  for (let k = 2; k <= K_MAX; k++) {
    if (k * MIN_N > N) break;
    let run = null;
    for (let r = 0; r < RESTARTS; r++) {
      const one = lloyd(P, setK, seedCentres(P, setK, k, rnd, means), k);
      if (!run || one.inertia < run.inertia) run = one;
      yield;
    }
    const size = new Int32Array(k);
    for (const c of run.lab) size[c]++;
    const valid = size.every(c => c / setK.length * N >= MIN_N);
    const s = silhouette(P, setK, run.lab, sil, k);
    tried.push({ k, silhouette: s, valid, run });
    yield;
  }
  // a k may be chosen: any whose groups hold 30 rows and whose silhouette
  // shows some structure; otherwise the best
  const usable = x => x.valid && Number.isFinite(x.silhouette) && x.silhouette >= MIN_SILHOUETTE;
  const scores = tried.map(x => ({ k: x.k, silhouette: x.silhouette, valid: x.valid, usable: usable(x) }));
  const ok = tried.filter(x => x.valid && Number.isFinite(x.silhouette));
  const best = ok.length ? ok.reduce((a, b) => (b.silhouette > a.silhouette ? b : a)) : null;
  if (!best) return { ...base, scores, reason: "few" };
  if (best.silhouette < MIN_SILHOUETTE) return { ...base, scores, best: best.k, k: best.k, silhouette: best.silhouette, reason: "weak" };
  const asked = tried.find(x => x.k === opts.k && usable(x));
  const top = asked || best;
  // the centres refitted on up to 20,000 points, from the chosen solution
  const k = top.k;
  const setF = order.slice(0, Math.min(N, SAMPLE_FIT));
  const final = setF.length > setK.length ? lloyd(P, setF, Float64Array.from(top.run.C), k) : top.run;
  yield;
  // every point to its nearest centre
  const labP = new Int32Array(N);
  const size = new Int32Array(k);
  for (let p = 0; p < N; p++) {
    let bc = 0, be = Infinity;
    for (let c = 0; c < k; c++) { const e = dist2(P, p, final.C, c); if (e < be) { be = e; bc = c; } }
    labP[p] = bc;
    size[bc]++;
  }
  if (!size.every(c => c >= MIN_N)) return { ...base, scores, best: best.k, k, silhouette: top.silhouette, reason: "few" };
  // how much of each cluster has each outcome
  const seen = new Float64Array(k * P.d);
  for (let p = 0; p < N; p++) for (let j = 0; j < P.d; j++) if (P.X[p * P.d + j] === P.X[p * P.d + j]) seen[labP[p] * P.d + j]++;
  // largest first
  const rank = Array.from({ length: k }, (_, c) => c).sort((a, b) => size[b] - size[a] || a - b);
  const newOf = new Int32Array(k);
  rank.forEach((c, i) => { newOf[c] = i; });
  const labelOf = new Int16Array(opts.n ?? (rows.length ? rows[rows.length - 1] + 1 : 0)).fill(-1);
  const members = rank.map(() => []);
  for (let p = 0; p < N; p++) {
    const i = rows[P.keep[p]], c = newOf[labP[p]];
    labelOf[i] = c;
    members[c].push(i);
  }
  const clusters = members.map((list, c) => {
    const rs = Uint32Array.from(list).sort();
    const medians = P.used.map(o => median(o.t.values, rs));
    return { id: CLUSTER_IDS[c], index: c, n: rs.length, share: rs.length / rows.length, rows: rs, medians,
      standsOut: standsOut(P, final.C, rank[c], j => seen[rank[c] * P.d + j] / size[rank[c]]) };
  });
  return { ...base, scores, best: best.k, k, silhouette: top.silhouette, grade: grade(top.silhouette), clusters, labelOf };
}

// Run the job to its end.
export function clusterRows(schema, rows, opts) {
  const g = clusterJob(schema, rows, opts);
  let r;
  do { r = g.next(); } while (!r.done);
  return r.value;
}

function median(values, rows) {
  const v = [];
  for (let j = 0; j < rows.length; j++) { const x = values[rows[j]]; if (x === x) v.push(x); }
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// The outcomes a cluster stands out on: its centre's rank furthest from
// the middle of the rows (0.5), the two furthest, in the outcomes' order;
// only outcomes most of the cluster has (a cluster of rounds that never
// traded is not described by the losing bars of the few that did).
function standsOut(P, C, c, seenShare) {
  const { d } = P;
  const dev = [];
  for (let j = 0; j < d; j++) if (seenShare(j) >= 0.5) dev.push({ j, by: C[c * d + j] - 0.5 });
  return dev.sort((a, b) => Math.abs(b.by) - Math.abs(a.by) || a.j - b.j).slice(0, 2).sort((a, b) => a.j - b.j)
    .map(x => ({ outcome: x.j, high: x.by > 0 }));
}

// ---------------------------------------------------------------------------
// Comparing two groups of rows

// Mann-Whitney U on the values of two groups (missing skipped), with the
// tie correction and the normal approximation; p is two-sided. `shift` is
// the share of pairs where the first group's value is the larger, ties
// counting half (0.5: no shift).
export function mannWhitney(values, a, b) {
  const xs = [];
  for (let j = 0; j < a.length; j++) { const v = values[a[j]]; if (v === v) xs.push([v, 0]); }
  const na = xs.length;
  for (let j = 0; j < b.length; j++) { const v = values[b[j]]; if (v === v) xs.push([v, 1]); }
  const N = xs.length, nb = N - na;
  if (!na || !nb) return { p: NaN, shift: NaN, na, nb };
  xs.sort((x, y) => x[0] - y[0]);
  let ra = 0, ties = 0, i = 0;
  while (i < N) {
    let k = i;
    while (k + 1 < N && xs[k + 1][0] === xs[i][0]) k++;
    const r = (i + k) / 2 + 1, t = k - i + 1;
    for (let q = i; q <= k; q++) if (xs[q][1] === 0) ra += r;
    ties += t * t * t - t;
    i = k + 1;
  }
  const U = ra - na * (na + 1) / 2;
  const mu = na * nb / 2;
  const sd = Math.sqrt(na * nb / 12 * ((N + 1) - ties / (N * (N - 1))));
  const z = sd > 0 ? (Math.abs(U - mu) - 0.5) / sd : 0;
  return { p: sd > 0 ? Math.min(1, 2 * (1 - normCdf(Math.max(0, z)))) : 1, shift: U / (na * nb), na, nb };
}

// How each parameter's values are shared out between rows in the group
// and the rows they are set against. `inGroup(i)` says whether row i is in
// the group; `rows` is the group and the rows it is set against together.
// Each parameter gets the G test of independence between being in the
// group and the parameter's value, Cramér's V (from G), the shares of each
// value inside the group and inside `refRows`, and q across the
// parameters (Benjamini-Hochberg).
export function composition(dims, rows, inGroup, refRows) {
  const out = [];
  for (const d of dims) {
    const L = d.levels.length;
    const cnt = new Float64Array(L), hits = new Float64Array(L), ref = new Float64Array(L);
    let n = 0, k = 0;
    for (let j = 0; j < rows.length; j++) {
      const i = rows[j], l = d.codes[i];
      if (l < 0) continue;
      cnt[l]++; n++;
      if (inGroup(i)) { hits[l]++; k++; }
    }
    let nr = 0;
    for (let j = 0; j < refRows.length; j++) { const l = d.codes[refRows[j]]; if (l >= 0) { ref[l]++; nr++; } }
    const g = gTest(cnt, hits);
    out.push({ dim: d, n, inGroup: k, p: g.p, G: g.G, V: n && Number.isFinite(g.G) ? Math.min(1, Math.sqrt(g.G / n)) : NaN,
      levels: d.levels.map((lv, l) => ({ level: lv, inGroup: k ? hits[l] / k : NaN, inRef: nr ? ref[l] / nr : NaN, n: cnt[l], hits: hits[l] })) });
  }
  const q = bhQ(out.map(x => x.p));
  out.forEach((x, j) => { x.q = q[j]; });
  return out;
}

export { KINDS };
