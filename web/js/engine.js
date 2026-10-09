// The analyses behind every view. Pure functions over a schema (schema.js)
// and a list of row indices (the rows in the current context, up to the
// replay edge). Formulas are written out in docs/statistics.md.

import { bhQ, chi2Survival, expectedMaxZ, fSurvival, meanInterval, normCdf, wilson, zP } from "./stats.js";

export const MIN_N = 30;          // fewer rows: a value is withheld
export const ALPHA = 0.05;

// ---------------------------------------------------------------------------
// Rows

// Rows [0, edge) that satisfy every condition of a context. A condition is
// {dim, keys}: the row's level of `dim` is one of `keys` (level keys).
export function rowsIn(schema, conditions, edge) {
  const n = Math.min(edge === undefined ? schema.n : edge, schema.n);
  const tests = conditions.map(c => {
    const d = schema.dimById.get(c.dim);
    if (!d) throw new Error(`context names ${c.dim}, which this sweep does not have`);
    const ok = new Uint8Array(d.levels.length);
    d.levels.forEach((l, j) => { if (c.keys.includes(l.key)) ok[j] = 1; });
    return { codes: d.codes, ok };
  });
  const out = new Uint32Array(n);
  let m = 0;
  outer: for (let i = 0; i < n; i++) {
    for (const t of tests) {
      const c = t.codes[i];
      if (c < 0 || !t.ok[c]) continue outer;
    }
    out[m++] = i;
  }
  return out.subarray(0, m);
}

// Mean of a target over rows (NaN skipped), with its interval.
export function summarize(target, rows) {
  const y = target.values;
  let n = 0, s = 0;
  for (let j = 0; j < rows.length; j++) { const v = y[rows[j]]; if (v === v) { n++; s += v; } }
  const shift = n ? s / n : 0;
  let s1 = 0, ss = 0;
  for (let j = 0; j < rows.length; j++) {
    const v = y[rows[j]];
    if (v === v) { const d = v - shift; s1 += d; ss += d * d; }
  }
  const mi = meanInterval(n, s1, ss, shift, target.kind === "binary");
  return { n, missing: rows.length - n, ...mi, hits: target.kind === "binary" ? Math.round(s) : null, shift };
}

// ---------------------------------------------------------------------------
// One-way effects

// Accumulate count, shifted sum and sum of squares per level.
function accumulate(dim, y, rows, shift) {
  const k = dim.levels.length;
  const cnt = new Float64Array(k), sum = new Float64Array(k), sq = new Float64Array(k);
  const codes = dim.codes;
  let na = 0;
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j];
    const c = codes[i];
    const v = y[i];
    if (c < 0 || v !== v) { if (c < 0) na++; continue; }
    const d = v - shift;
    cnt[c]++; sum[c] += d; sq[c] += d * d;
  }
  return { cnt, sum, sq, na };
}

// One-way ANOVA from per-group sufficient statistics.
export function anova(cnt, sum, sq) {
  let N = 0, S = 0, SS = 0, k = 0, SSB0 = 0;
  for (let j = 0; j < cnt.length; j++) {
    if (cnt[j] <= 0) continue;
    N += cnt[j]; S += sum[j]; SS += sq[j]; k++;
    SSB0 += sum[j] * sum[j] / cnt[j];
  }
  if (k < 2 || N <= k) return { N, k, F: NaN, p: NaN, omega2: NaN, eta2: NaN, df1: k - 1, df2: N - k, SST: NaN, SSB: NaN, SSW: NaN };
  const SST = Math.max(0, SS - S * S / N);
  const SSB = Math.max(0, SSB0 - S * S / N);
  const SSW = Math.max(0, SST - SSB);
  const df1 = k - 1, df2 = N - k;
  const MSW = SSW / df2;
  let F, p;
  if (SST === 0) { F = NaN; p = 1; }
  else if (MSW === 0) { F = Infinity; p = 0; }
  else { F = (SSB / df1) / MSW; p = fSurvival(F, df1, df2); }
  const omega2 = SST > 0 ? (SSB - df1 * MSW) / (SST + MSW) : 0;
  return { N, k, F, p, omega2, eta2: SST > 0 ? SSB / SST : 0, df1, df2, SST, SSB, SSW, MSW };
}

// How a dim moves a target: every level's mean with its interval, and the
// strength of the whole dim.
export function dimEffect(dim, target, rows, base) {
  const binary = target.kind === "binary";
  const shift = base.shift;
  const acc = accumulate(dim, target.values, rows, shift);
  const g = binary ? gTest(acc.cnt, acc.cnt.map((n, j) => Math.round(acc.sum[j] + shift * n))) : null;
  const levels = dim.levels.map((l, j) => {
    const n = acc.cnt[j];
    const mi = meanInterval(n, acc.sum[j], acc.sq[j], shift, binary);
    return { key: l.key, label: l.label, value: l.value, n, mean: mi.mean, lo: mi.lo, hi: mi.hi, sd: mi.sd,
      lift: mi.mean - base.mean, withheld: n < MIN_N, hits: binary ? Math.round(acc.sum[j] + shift * n) : null };
  });
  const a = anova(acc.cnt, acc.sum, acc.sq);
  const shown = levels.filter(l => !l.withheld && l.n > 0);
  let best = null, worst = null;
  for (const l of shown) {
    const score = l.mean * (target.better || 1);
    if (!best || score > best.mean * (target.better || 1)) best = l;
    if (!worst || score < worst.mean * (target.better || 1)) worst = l;
  }
  return {
    dim: dim.id, levels, na: acc.na, N: a.N, k: a.k, F: a.F, omega2: a.omega2, eta2: a.eta2,
    df1: a.df1, df2: a.df2,
    // binary targets: likelihood-ratio (G) test of equal rates; otherwise ANOVA F
    test: binary ? "G" : "F", G: g ? g.G : NaN, p: binary ? g.p : a.p,
    spread: shown.length >= 2 ? Math.abs(best.mean - worst.mean) : NaN,
    best, worst, dead: deadLevels(levels, base, binary),
  };
}

const xlogy = (x, y) => (x === 0 ? 0 : x * Math.log(y));

// Likelihood-ratio (G) test that k groups share one rate.
export function gTest(cnt, hits) {
  let N = 0, K = 0, groups = 0;
  for (let j = 0; j < cnt.length; j++) if (cnt[j] > 0) { N += cnt[j]; K += hits[j]; groups++; }
  if (groups < 2 || N === 0) return { G: NaN, df: groups - 1, p: NaN };
  const p0 = K / N;
  let G = 0;
  for (let j = 0; j < cnt.length; j++) {
    const n = cnt[j], k = hits[j];
    if (!n) continue;
    const pj = k / n;
    G += xlogy(k, pj / p0) + xlogy(n - k, (1 - pj) / (1 - p0));
  }
  G *= 2;
  if (K === 0 || K === N) return { G: 0, df: groups - 1, p: 1 };
  return { G, df: groups - 1, p: chi2Survival(G, groups - 1) };
}

// Additive logistic model on a cell table, fitted by iteratively
// reweighted least squares, against the saturated model (each cell its own
// rate): the likelihood-ratio test of the interaction for a binary target.
export function logisticInteraction(ka, kb, cnt, hits) {
  const cells = [];
  for (let a = 0; a < ka; a++) for (let b = 0; b < kb; b++) {
    const n = cnt[a * kb + b];
    if (n > 0) cells.push({ a, b, n, k: hits[a * kb + b] });
  }
  const as = [...new Set(cells.map(c => c.a))], bs = [...new Set(cells.map(c => c.b))];
  const ai = new Map(as.map((a, j) => [a, j])), bi = new Map(bs.map((b, j) => [b, j]));
  // design: intercept, a dummies (drop first), b dummies (drop first)
  const P = 1 + (as.length - 1) + (bs.length - 1);
  const X = cells.map(c => {
    const x = new Float64Array(P); x[0] = 1;
    const ja = ai.get(c.a), jb = bi.get(c.b);
    if (ja > 0) x[ja] = 1;
    if (jb > 0) x[as.length - 1 + jb] = 1;
    return x;
  });
  let beta = new Float64Array(P);
  const N = cells.reduce((s, c) => s + c.n, 0), K = cells.reduce((s, c) => s + c.k, 0);
  beta[0] = Math.log((K + 0.5) / (N - K + 0.5));
  const dev = (bt) => {
    let d = 0;
    cells.forEach((c, i) => {
      let eta = 0; for (let j = 0; j < P; j++) eta += X[i][j] * bt[j];
      const p = 1 / (1 + Math.exp(-eta));
      const ph = c.k / c.n;
      d += xlogy(c.k, ph / p) + xlogy(c.n - c.k, (1 - ph) / (1 - p));
    });
    return 2 * d;
  };
  let D = dev(beta);
  for (let it = 0; it < 100; it++) {
    const H = Array.from({ length: P }, () => new Float64Array(P));
    const g = new Float64Array(P);
    cells.forEach((c, i) => {
      let eta = 0; for (let j = 0; j < P; j++) eta += X[i][j] * beta[j];
      const p = 1 / (1 + Math.exp(-eta));
      const w = c.n * p * (1 - p) + 1e-12;
      const r = c.k - c.n * p;
      for (let j = 0; j < P; j++) {
        g[j] += X[i][j] * r;
        for (let l = 0; l < P; l++) H[j][l] += X[i][j] * w * X[i][l];
      }
    });
    for (let j = 0; j < P; j++) H[j][j] += 1e-10;
    const step = solve(H, g);
    let t = 1, next, Dn;
    for (let h = 0; h < 30; h++) {
      next = beta.map((v, j) => v + t * step[j]);
      Dn = dev(next);
      if (Dn <= D + 1e-12) break;
      t /= 2;
    }
    const done = Math.abs(D - Dn) < 1e-10 * Math.max(1, D);
    beta = next; D = Dn;
    if (done) break;
  }
  const df = cells.length - P;
  if (df <= 0) return { D: NaN, df, p: NaN };
  return { D, df, p: chi2Survival(D, df) };
}

// Solve H x = g (small symmetric positive definite system), Gaussian
// elimination with partial pivoting.
function solve(H, g) {
  const n = g.length;
  const A = H.map((row, i) => [...row, g[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-300) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-300 ? 0 : row[n] / row[i]));
}

// Levels whose 95% upper bound on the hit rate is under a fifth of the
// context's rate (binary targets, n >= MIN_N).
function deadLevels(levels, base, binary) {
  if (!binary || !(base.mean > 0)) return [];
  return levels.filter(l => l.n >= MIN_N && l.hi < base.mean / 5).map(l => l.key);
}

// Effects of many dims on one target, with Benjamini-Hochberg q-values.
export function board(schema, target, rows, dims) {
  const base = summarize(target, rows);
  const effects = dims.map(d => dimEffect(d, target, rows, base));
  const q = bhQ(effects.map(e => e.p));
  effects.forEach((e, i) => { e.q = q[i]; e.detectable = q[i] < ALPHA; });
  return { base, effects, tests: effects.filter(e => Number.isFinite(e.p)).length };
}

// Board order: detectable dims by strength (omega squared, inside their
// scope for scoped dims), then the rest by strength.
export function boardOrder(effects) {
  const w = e => (Number.isFinite(e.omega2) ? e.omega2 : -1);
  return [...effects].sort((a, b) => (b.detectable - a.detectable) || (w(b) - w(a)));
}

// ---------------------------------------------------------------------------
// Two dims at once

// Cell table of a pair, the additive fit by backfitting, and the share of
// variance the pair explains beyond its two main effects.
export function pairEffect(da, db, target, rows, base) {
  const ka = da.levels.length, kb = db.levels.length;
  const cnt = new Float64Array(ka * kb), sum = new Float64Array(ka * kb), sq = new Float64Array(ka * kb);
  const y = target.values, shift = base.shift, A = da.codes, B = db.codes;
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j], a = A[i], b = B[i], v = y[i];
    if (a < 0 || b < 0 || v !== v) continue;
    const c = a * kb + b, d = v - shift;
    cnt[c]++; sum[c] += d; sq[c] += d * d;
  }
  const res = pairFromCells(ka, kb, cnt, sum, sq, target, base);
  if (target.kind === "binary") {
    const hits = new Float64Array(ka * kb);
    for (let c = 0; c < ka * kb; c++) hits[c] = Math.round(sum[c] + shift * cnt[c]);
    const lr = logisticInteraction(ka, kb, cnt, hits);
    res.test = "LR"; res.D = lr.D; res.p = lr.p; res.dfLR = lr.df;
  } else {
    res.test = "F";
  }
  return res;
}

export function pairFromCells(ka, kb, cnt, sum, sq, target, base) {
  let N = 0, S = 0, SS = 0, cells = 0, SSW = 0;
  const m = new Float64Array(ka * kb);
  for (let c = 0; c < ka * kb; c++) {
    if (cnt[c] <= 0) continue;
    N += cnt[c]; S += sum[c]; SS += sq[c]; cells++;
    m[c] = sum[c] / cnt[c];
    SSW += Math.max(0, sq[c] - sum[c] * sum[c] / cnt[c]);
  }
  const mu = N ? S / N : 0;
  const alpha = new Float64Array(ka), beta = new Float64Array(kb);
  const na = new Float64Array(ka), nb = new Float64Array(kb);
  for (let a = 0; a < ka; a++) for (let b = 0; b < kb; b++) { na[a] += cnt[a * kb + b]; nb[b] += cnt[a * kb + b]; }
  let prev = Infinity, SSI = 0;
  for (let it = 0; it < 200; it++) {
    for (let a = 0; a < ka; a++) {
      if (!na[a]) continue;
      let s = 0;
      for (let b = 0; b < kb; b++) { const c = a * kb + b; if (cnt[c]) s += cnt[c] * (m[c] - mu - beta[b]); }
      alpha[a] = s / na[a];
    }
    for (let b = 0; b < kb; b++) {
      if (!nb[b]) continue;
      let s = 0;
      for (let a = 0; a < ka; a++) { const c = a * kb + b; if (cnt[c]) s += cnt[c] * (m[c] - mu - alpha[a]); }
      beta[b] = s / nb[b];
    }
    SSI = 0;
    for (let c = 0; c < ka * kb; c++) {
      if (!cnt[c]) continue;
      const r = m[c] - mu - alpha[Math.floor(c / kb)] - beta[c % kb];
      SSI += cnt[c] * r * r;
    }
    if (Math.abs(prev - SSI) <= 1e-13 * Math.max(1, SSI)) break;
    prev = SSI;
  }
  const rowsA = na.filter(x => x > 0).length, colsB = nb.filter(x => x > 0).length;
  const dfI = cells - (rowsA + colsB - 1);
  const dfW = N - cells;
  const SST = Math.max(0, SS - S * S / N);
  const MSW = dfW > 0 ? SSW / dfW : NaN;
  let F = NaN, p = NaN, omega2 = NaN;
  if (dfI > 0 && dfW > 0 && MSW > 0) {
    F = (SSI / dfI) / MSW;
    p = fSurvival(F, dfI, dfW);
    omega2 = SST > 0 ? (SSI - dfI * MSW) / (SST + MSW) : 0;
  } else if (dfI > 0 && dfW > 0 && MSW === 0) {
    F = SSI > 0 ? Infinity : NaN; p = SSI > 0 ? 0 : 1; omega2 = SST > 0 ? SSI / SST : 0;
  }
  const binary = target.kind === "binary";
  const table = [];
  for (let a = 0; a < ka; a++) for (let b = 0; b < kb; b++) {
    const c = a * kb + b;
    const mi = meanInterval(cnt[c], sum[c], sq[c], base.shift, binary);
    table.push({ a, b, n: cnt[c], mean: mi.mean, lo: mi.lo, hi: mi.hi, withheld: cnt[c] < MIN_N,
      fitted: cnt[c] ? base.shift + mu + alpha[a] + beta[b] : NaN });
  }
  return { ka, kb, table, N, F, p, omega2, dfI, dfW, SSI, SST, cells };
}

// Cramér's V between two dims (sampler independence), with its chi-square p.
export function cramersV(da, db, rows) {
  const ka = da.levels.length, kb = db.levels.length;
  const cnt = new Float64Array(ka * kb);
  const A = da.codes, B = db.codes;
  let N = 0;
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j], a = A[i], b = B[i];
    if (a < 0 || b < 0) continue;
    cnt[a * kb + b]++; N++;
  }
  const ra = new Float64Array(ka), cb = new Float64Array(kb);
  for (let a = 0; a < ka; a++) for (let b = 0; b < kb; b++) { ra[a] += cnt[a * kb + b]; cb[b] += cnt[a * kb + b]; }
  const ua = [...ra].filter(x => x > 0).length, ub = [...cb].filter(x => x > 0).length;
  if (N === 0 || ua < 2 || ub < 2) return { N, V: NaN, chi2: NaN, p: NaN, df: 0 };
  let chi2 = 0;
  for (let a = 0; a < ka; a++) for (let b = 0; b < kb; b++) {
    if (!ra[a] || !cb[b]) continue;
    const e = ra[a] * cb[b] / N, o = cnt[a * kb + b];
    chi2 += (o - e) * (o - e) / e;
  }
  const df = (ua - 1) * (ub - 1);
  return { N, V: Math.sqrt(chi2 / (N * (Math.min(ua, ub) - 1))), chi2, df, p: chi2Survival(chi2, df) };
}

// The effect of a dim inside each level of one parent, with q-values over
// all (parent, level) tests made for this dim.
export function actsWhere(schema, dim, target, rows, parents) {
  const base = summarize(target, rows);
  const tests = [];
  for (const P of parents) {
    if (P.id === dim.id || P.id === (dim.scope && dim.scope.dim)) continue;
    const k = dim.levels.length;
    const groups = P.levels.map(() => ({ cnt: new Float64Array(k), sum: new Float64Array(k), sq: new Float64Array(k) }));
    const y = target.values, A = P.codes, B = dim.codes, shift = base.shift;
    for (let j = 0; j < rows.length; j++) {
      const i = rows[j], a = A[i], b = B[i], v = y[i];
      if (a < 0 || b < 0 || v !== v) continue;
      const g = groups[a], d = v - shift;
      g.cnt[b]++; g.sum[b] += d; g.sq[b] += d * d;
    }
    const binary = target.kind === "binary";
    groups.forEach((g, a) => {
      const n = g.cnt.reduce((x, z) => x + z, 0);
      if (n < 2 * MIN_N) return;
      const an = anova(g.cnt, g.sum, g.sq);
      const gt = binary ? gTest(g.cnt, g.cnt.map((c, j) => Math.round(g.sum[j] + shift * c))) : null;
      tests.push({ parent: P.id, parentLabel: P.label, level: P.levels[a].key, levelLabel: P.levels[a].label,
        n, omega2: an.omega2, p: binary ? gt.p : an.p,
        // pieces for a pooled test over several levels
        SSB: an.SSB, SSW: an.SSW, df1: an.df1, df2: an.df2, G: gt ? gt.G : NaN, dfG: gt ? gt.df : NaN, binary });
    });
  }
  const q = bhQ(tests.map(t => t.p));
  tests.forEach((t, i) => { t.q = q[i]; t.detectable = q[i] < ALPHA; });
  return tests;
}

// Which params change a dim's effect: the dim-by-parent interaction test for
// every parent, with q-values over the parents. Scoped dims are not
// parents (they only exist inside one level of their own scope).
export function moderators(schema, dim, target, rows, parents) {
  const base = summarize(target, rows);
  const res = [];
  for (const P of parents) {
    if (P.id === dim.id || P.kind === "scoped" || P.kind === "member") continue;
    if (dim.scope && dim.scope.dim === P.id) continue;
    const pe = pairEffect(P, dim, target, rows, base);
    if (!Number.isFinite(pe.p)) continue;
    res.push({ parent: P.id, label: P.label, p: pe.p, F: pe.F, omega2: pe.omega2, dfI: pe.dfI });
  }
  const q = bhQ(res.map(r => r.p));
  res.forEach((r, i) => { r.q = q[i]; r.detectable = q[i] < ALPHA; });
  res.sort((a, b) => a.p - b.p);
  return res;
}

// The interaction tests of one dim with every parent (raw p-values).
export function moderatorTests(schema, dim, target, rows, parents, base) {
  const out = [];
  for (const P of parents) {
    if (P.id === dim.id || P.kind === "scoped" || P.kind === "member") continue;
    if (dim.scope && dim.scope.dim === P.id) continue;
    const pe = pairEffect(P, dim, target, rows, base);
    if (!Number.isFinite(pe.p)) continue;
    out.push({ dim: dim.id, parent: P.id, label: P.label, p: pe.p, F: pe.F, omega2: pe.omega2 });
  }
  return out;
}

// One Benjamini-Hochberg correction over every (dim, parent) test of the
// board, so the number of claims stays honest; then where each dim acts.
export function moderatorSummaries(schema, tests, dims, target, rows) {
  const q = bhQ(tests.map(t => t.p));
  tests.forEach((t, i) => { t.q = q[i]; t.detectable = q[i] < ALPHA; });
  const byDim = new Map();
  for (const t of tests) {
    if (!byDim.has(t.dim)) byDim.set(t.dim, []);
    byDim.get(t.dim).push(t);
  }
  const out = new Map();
  for (const d of dims) {
    const mods = (byDim.get(d.id) || []).sort((a, b) => a.p - b.p);
    const top = mods.find(m => m.detectable);
    if (!top) { out.set(d.id, { mods, acts: null }); continue; }
    const where = actsWhere(schema, d, target, rows, [schema.dimById.get(top.parent)]);
    out.set(d.id, { mods, acts: actsSummary(mods, where) });
  }
  return { tests: tests.length, byDim: out };
}

export function moderatorScan(schema, dims, target, rows, parents) {
  const base = summarize(target, rows);
  const tests = [];
  for (const d of dims) tests.push(...moderatorTests(schema, d, target, rows, parents, base));
  return moderatorSummaries(schema, tests, dims, target, rows);
}

// Where a dim acts: its strongest detectable moderator, and the levels of
// that moderator inside which the dim's own effect is detectable. Null
// when no parent changes the dim's effect.
export function actsSummary(mods, tests) {
  const top = mods.find(m => m.detectable);
  if (!top) return null;
  const ts = tests.filter(t => t.parent === top.parent);
  const on = ts.filter(t => t.detectable), off = ts.filter(t => !t.detectable);
  const pooled = pooledTest(off);
  // "only": the dim acts inside some levels and a pooled test over all the
  // other levels finds nothing (p > 0.05); "modulated": it acts across the
  // levels, more in some; "unresolved": the interaction is there but no
  // level has the rows to show the dim's own effect.
  let kind;
  if (!on.length) kind = "unresolved";
  else if (off.length && pooled.p > ALPHA) kind = "only";
  else kind = "modulated";
  const strongest = on.length ? on.reduce((x, y) => (y.omega2 > x.omega2 ? y : x)) : null;
  return { parent: top.parent, label: top.label, p: top.p, q: top.q, kind, on, off, offPooled: pooled, strongest };
}

// The dim's effect pooled over several levels of a parent, inside each
// level (a stratified test): summed between- and within-level sums of
// squares (F), or summed G statistics for a binary target.
export function pooledTest(levelTests) {
  if (!levelTests.length) return { p: NaN, n: 0 };
  const n = levelTests.reduce((s, t) => s + t.n, 0);
  if (levelTests[0].binary) {
    const G = levelTests.reduce((s, t) => s + (Number.isFinite(t.G) ? t.G : 0), 0);
    const df = levelTests.reduce((s, t) => s + (Number.isFinite(t.dfG) ? t.dfG : 0), 0);
    return { test: "G", G, df, p: df > 0 ? chi2Survival(G, df) : NaN, n };
  }
  let SSB = 0, SSW = 0, d1 = 0, d2 = 0;
  for (const t of levelTests) {
    if (!Number.isFinite(t.SSB)) continue;
    SSB += t.SSB; SSW += t.SSW; d1 += t.df1; d2 += t.df2;
  }
  if (!(d1 > 0 && d2 > 0 && SSW > 0)) return { test: "F", p: NaN, n };
  const F = (SSB / d1) / (SSW / d2);
  return { test: "F", F, df1: d1, df2: d2, p: fSurvival(F, d1, d2), n };
}

// ---------------------------------------------------------------------------
// Set members (feature inclusion)

// Inclusion effect of every member, stratified by subset size: the
// difference of means inside each size, averaged with the size's row count
// as its weight. Inclusion is randomised, but larger subsets include every
// member more often, so an unstratified difference would carry the effect
// of subset size into every member.
export function memberEffects(schema, members, sizeDim, target, rows) {
  const ks = sizeDim.levels.length, M = members.length;
  const y = target.values;
  const base = summarize(target, rows);
  const shift = base.shift;
  // [member][size][in/out] -> cnt, sum, sq
  const cnt = new Float64Array(M * ks * 2), sum = new Float64Array(M * ks * 2), sq = new Float64Array(M * ks * 2);
  const S = sizeDim.codes;
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j], s = S[i], v = y[i];
    if (s < 0 || v !== v) continue;
    const d = v - shift, d2 = d * d;
    for (let m = 0; m < M; m++) {
      const c = members[m].codes[i];
      if (c < 0) continue;
      const idx = (m * ks + s) * 2 + c;
      cnt[idx]++; sum[idx] += d; sq[idx] += d2;
    }
  }
  const binary = target.kind === "binary";
  const res = members.map((mem, m) => {
    let W = 0, D = 0, V = 0, nIn = 0, nOut = 0, sIn = 0, sOut = 0;
    for (let s = 0; s < ks; s++) {
      const o = (m * ks + s) * 2, i1 = o + 1;
      const n0 = cnt[o], n1 = cnt[i1];
      nIn += n1; nOut += n0; sIn += sum[i1]; sOut += sum[o];
      if (n0 < 2 || n1 < 2) continue;
      const m0 = sum[o] / n0, m1 = sum[i1] / n1;
      const v0 = Math.max(0, (sq[o] - sum[o] * sum[o] / n0) / (n0 - 1));
      const v1 = Math.max(0, (sq[i1] - sum[i1] * sum[i1] / n1) / (n1 - 1));
      const w = n0 + n1;
      W += w; D += w * (m1 - m0); V += w * w * (v1 / n1 + v0 / n0);
    }
    const delta = W ? D / W : NaN;
    const se = W ? Math.sqrt(V) / W : NaN;
    const z = se > 0 ? delta / se : NaN;
    return { id: mem.id, name: mem.name, nIn, nOut, inMean: nIn ? shift + sIn / nIn : NaN, outMean: nOut ? shift + sOut / nOut : NaN,
      delta, se, lo: delta - 1.959963984540054 * se, hi: delta + 1.959963984540054 * se, z, p: Number.isFinite(z) ? zP(z) : NaN,
      share: nIn / (nIn + nOut), binary };
  });
  const q = bhQ(res.map(r => r.p));
  res.forEach((r, i) => { r.q = q[i]; r.detectable = q[i] < ALPHA; });
  return { base, members: res };
}

// ---------------------------------------------------------------------------
// Pockets

// A pocket is a list of conditions (AND); a condition holds level keys (OR).
export function pocketStats(schema, conditions, target, contextRows, edge) {
  const inPocket = rowsIn(schema, conditions, edge);
  const base = summarize(target, contextRows);
  // pocket rows restricted to the context
  const ctxMark = new Uint8Array(schema.n);
  for (let j = 0; j < contextRows.length; j++) ctxMark[contextRows[j]] = 1;
  const rows = [];
  for (let j = 0; j < inPocket.length; j++) if (ctxMark[inPocket[j]]) rows.push(inPocket[j]);
  const pr = Uint32Array.from(rows);
  const s = summarize(target, pr);
  // split-half: first and second half of the context's arrivals
  const mid = contextRows.length ? contextRows[Math.floor(contextRows.length / 2)] : 0;
  const h1 = pr.filter(i => i < mid), h2 = pr.filter(i => i >= mid);
  const s1 = summarize(target, h1), s2 = summarize(target, h2);
  let halvesP = NaN;
  if (s1.n >= MIN_N && s2.n >= MIN_N) {
    const se = Math.sqrt((s1.sd * s1.sd) / s1.n + (s2.sd * s2.sd) / s2.n);
    halvesP = se > 0 ? zP((s1.mean - s2.mean) / se) : 1;
  }
  const binary = target.kind === "binary";
  return {
    rows: pr, n: s.n, share: contextRows.length ? pr.length / contextRows.length : NaN,
    mean: s.mean, lo: s.lo, hi: s.hi, hits: s.hits,
    base, lift: binary && base.mean > 0 ? s.mean / base.mean : s.mean - base.mean,
    recall: binary && base.hits ? s.hits / base.hits : NaN,
    halves: [s1, s2], halvesP,
  };
}

// ---------------------------------------------------------------------------
// Interactions of any order

// What k parameters do together beyond everything their smaller subsets
// explain: the needle's cell means over their full grid against the best
// fit that holds every (k-1)-way term among them (and so every lower one),
// fitted by weighted backfitting. A set is tested only when every cell of
// its grid has at least `minCell` rows, so the degrees of freedom are the
// grid's own, Π(levels − 1); otherwise it comes back `sparse`. For a rate,
// p is the likelihood-ratio test of the logistic model with every
// (k-1)-way term (iterative proportional fitting); ω² is read off the same
// decomposition as for a number. `table` adds each cell's mean and
// interval.
export function comboEffect(dims, target, rows, base, minCell, table = false) {
  const k = dims.length;
  const L = dims.map(d => d.levels.length);
  const strides = new Array(k);
  let C = 1;
  for (let t = k - 1; t >= 0; t--) { strides[t] = C; C *= L[t]; }
  const cnt = new Float64Array(C), sum = new Float64Array(C), sq = new Float64Array(C);
  const y = target.values, shift = base.shift, codes = dims.map(d => d.codes);
  outer: for (let j = 0; j < rows.length; j++) {
    const i = rows[j], v = y[i];
    if (v !== v) continue;
    let c = 0;
    for (let t = 0; t < k; t++) { const x = codes[t][i]; if (x < 0) continue outer; c += x * strides[t]; }
    const d = v - shift;
    cnt[c]++; sum[c] += d; sq[c] += d * d;
  }
  let minN = Infinity;
  for (let c = 0; c < C; c++) if (cnt[c] < minN) minN = cnt[c];
  const res = { k, cells: C, minN, sparse: !(minN >= minCell), N: 0, F: NaN, p: NaN, omega2: NaN, df: NaN, dfW: NaN };
  if (table) res.table = cellTable(dims, L, strides, cnt, sum, sq, shift, target.kind === "binary");
  if (res.sparse) return res;

  // each (k-1)-subset is the grid without one parameter: a cell's place in it
  const margins = [];
  for (let drop = 0; drop < k; drop++) {
    const size = C / L[drop], map = new Int32Array(C);
    for (let c = 0; c < C; c++) {
      let m = 0, mult = 1;
      for (let t = k - 1; t >= 0; t--) {
        if (t === drop) continue;
        m += (Math.floor(c / strides[t]) % L[t]) * mult;
        mult *= L[t];
      }
      map[c] = m;
    }
    margins.push({ size, map, g: new Float64Array(size) });
  }
  let N = 0, S = 0, SS = 0, SSW = 0;
  const mean = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    N += cnt[c]; S += sum[c]; SS += sq[c];
    mean[c] = sum[c] / cnt[c];
    SSW += Math.max(0, sq[c] - sum[c] * sum[c] / cnt[c]);
  }
  const mu = S / N;
  const fit = new Float64Array(C).fill(mu);
  let prev = Infinity, SSI = 0;
  for (let it = 0; it < 300; it++) {
    for (const mg of margins) {
      const acc = new Float64Array(mg.size), w = new Float64Array(mg.size);
      for (let c = 0; c < C; c++) {
        const m = mg.map[c];
        acc[m] += cnt[c] * (mean[c] - (fit[c] - mg.g[m]));
        w[m] += cnt[c];
      }
      for (let c = 0; c < C; c++) {
        const m = mg.map[c];
        fit[c] += acc[m] / w[m] - mg.g[m];
      }
      for (let m = 0; m < mg.size; m++) mg.g[m] = acc[m] / w[m];
    }
    SSI = 0;
    for (let c = 0; c < C; c++) { const r = mean[c] - fit[c]; SSI += cnt[c] * r * r; }
    if (Math.abs(prev - SSI) <= 1e-12 * Math.max(1e-300, SS)) break;
    prev = SSI;
  }
  const df = L.reduce((a, l) => a * (l - 1), 1);
  const dfW = N - C;
  const SST = Math.max(0, SS - S * S / N);
  const MSW = dfW > 0 ? SSW / dfW : NaN;
  res.N = N; res.df = df; res.dfW = dfW; res.SSI = SSI; res.SST = SST;
  if (df > 0 && dfW > 0 && MSW > 0) {
    res.F = (SSI / df) / MSW;
    res.p = fSurvival(res.F, df, dfW);
    res.omega2 = SST > 0 ? (SSI - df * MSW) / (SST + MSW) : 0;
  } else if (df > 0 && dfW > 0 && MSW === 0) {
    res.F = SSI > 0 ? Infinity : NaN; res.p = SSI > 0 ? 0 : 1; res.omega2 = SST > 0 ? SSI / SST : 0;
  }
  if (target.kind === "binary") {
    const hits = new Float64Array(C);
    for (let c = 0; c < C; c++) hits[c] = Math.round(sum[c] + shift * cnt[c]);
    const lr = logisticOrderTest(C, cnt, hits, margins);
    res.G = lr.G; res.p = chi2Survival(lr.G, df);
  }
  return res;
}

// The logistic model with every (k-1)-way term, against the saturated one:
// iterative proportional fitting of the hits and misses table to its cell
// totals and to each (k-1)-subset's hits and misses; G² of the fit.
function logisticOrderTest(C, cnt, hits, margins) {
  const N = cnt.reduce((a, b) => a + b, 0), H = hits.reduce((a, b) => a + b, 0);
  const eh = new Float64Array(C), em = new Float64Array(C);
  for (let c = 0; c < C; c++) { eh[c] = cnt[c] * H / N; em[c] = cnt[c] - eh[c]; }
  const obs = margins.map(mg => {
    const oh = new Float64Array(mg.size), om = new Float64Array(mg.size);
    for (let c = 0; c < C; c++) { oh[mg.map[c]] += hits[c]; om[mg.map[c]] += cnt[c] - hits[c]; }
    return { oh, om };
  });
  for (let it = 0; it < 500; it++) {
    let moved = 0;
    margins.forEach((mg, t) => {
      const fh = new Float64Array(mg.size), fm = new Float64Array(mg.size);
      for (let c = 0; c < C; c++) { fh[mg.map[c]] += eh[c]; fm[mg.map[c]] += em[c]; }
      for (let c = 0; c < C; c++) {
        const m = mg.map[c];
        eh[c] = fh[m] > 0 ? eh[c] * obs[t].oh[m] / fh[m] : 0;
        em[c] = fm[m] > 0 ? em[c] * obs[t].om[m] / fm[m] : 0;
      }
      for (let c = 0; c < C; c++) {
        const tot = eh[c] + em[c];
        if (!(tot > 0)) continue;
        const nh = eh[c] * cnt[c] / tot;
        moved = Math.max(moved, Math.abs(nh - eh[c]));
        eh[c] = nh; em[c] = cnt[c] - nh;
      }
    });
    if (moved < 1e-9 * Math.max(1, N)) break;
  }
  let G = 0;
  for (let c = 0; c < C; c++) {
    const h = hits[c], m = cnt[c] - hits[c];
    if (h > 0) G += h * Math.log(h / eh[c]);
    if (m > 0) G += m * Math.log(m / em[c]);
  }
  return { G: Math.max(0, 2 * G) };
}

// Every cell of a grid with its parameters' values, rows, mean and interval.
function cellTable(dims, L, strides, cnt, sum, sq, shift, binary) {
  const out = [];
  for (let c = 0; c < cnt.length; c++) {
    const at = L.map((l, t) => Math.floor(c / strides[t]) % l);
    const mi = meanInterval(cnt[c], sum[c], sq[c], shift, binary);
    out.push({ at, keys: at.map((x, t) => dims[t].levels[x].key), n: cnt[c], mean: mi.mean, lo: mi.lo, hi: mi.hi, withheld: cnt[c] < MIN_N });
  }
  return out;
}

// Does each block of a pocket earn its place? A block's rows to judge are
// the ones it takes away: those that hold every other block (inside the
// context) but not this one. The pocket's rows against them, a two-sample z
// test, corrected across the pocket's blocks (Benjamini–Hochberg). Also
// what the pocket would be without the block.
export function blockTests(schema, conditions, target, contextRows, edge, pocketRows) {
  const inside = summarize(target, pocketRows);
  const inPocket = new Uint8Array(schema.n), inContext = new Uint8Array(schema.n);
  for (let j = 0; j < pocketRows.length; j++) inPocket[pocketRows[j]] = 1;
  for (let j = 0; j < contextRows.length; j++) inContext[contextRows[j]] = 1;
  const out = conditions.map((c, k) => {
    const rest = conditions.filter((_, j) => j !== k);
    const held = rest.length ? rowsIn(schema, rest, edge) : contextRows;
    const kept = [], away = [];
    for (let j = 0; j < held.length; j++) {
      const i = held[j];
      if (!inContext[i]) continue;
      kept.push(i);
      if (!inPocket[i]) away.push(i);
    }
    const without = summarize(target, Uint32Array.from(kept));
    const removed = summarize(target, Uint32Array.from(away));
    let p = NaN;
    if (inside.n >= MIN_N && removed.n >= MIN_N) {
      const se = Math.sqrt(inside.sd * inside.sd / inside.n + removed.sd * removed.sd / removed.n);
      p = se > 0 ? zP((inside.mean - removed.mean) / se) : inside.mean === removed.mean ? 1 : 0;
    }
    return { without, removed, p };
  });
  const q = bhQ(out.map(r => r.p));
  out.forEach((r, k) => { r.q = q[k]; });
  return out;
}

// Candidate next conditions: every level of every dim not in the pocket,
// ranked by the lower end of its interval (better direction).
export function suggestions(schema, dims, target, pocketRows, base, limit = 12) {
  const binary = target.kind === "binary";
  const better = target.better || 1;
  const out = [];
  for (const d of dims) {
    const acc = accumulate(d, target.values, pocketRows, base.shift);
    d.levels.forEach((l, j) => {
      const n = acc.cnt[j];
      if (n < MIN_N || n === pocketRows.length) return;
      const mi = meanInterval(n, acc.sum[j], acc.sq[j], base.shift, binary);
      out.push({ dim: d.id, dimLabel: d.label, key: l.key, label: l.label, n, mean: mi.mean, lo: mi.lo, hi: mi.hi,
        hits: binary ? Math.round(acc.sum[j] + base.shift * n) : null,
        bound: better >= 0 ? mi.lo : -mi.hi });
    });
  }
  out.sort((a, b) => b.bound - a.bound);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Ranking, records and luck

// Rows ranked by a lexicographic objective [[column getter, dir], ...].
export function topRows(rows, keys, k) {
  const score = (i) => keys.map(([get, dir]) => { const v = get(i); return v === v ? v * dir : -Infinity; });
  const cmp = (a, b) => { for (let t = 0; t < a.s.length; t++) if (a.s[t] !== b.s[t]) return b.s[t] - a.s[t]; return a.i - b.i; };
  const heap = [];
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j];
    const e = { i, s: score(i) };
    if (heap.length < k) { heap.push(e); if (heap.length === k) heap.sort(cmp); continue; }
    if (cmp(e, heap[k - 1]) < 0) {
      // insert keeping order (k is small)
      let p = k - 1;
      while (p > 0 && cmp(e, heap[p - 1]) < 0) { heap[p] = heap[p - 1]; p--; }
      heap[p] = e;
    }
  }
  if (heap.length < k) heap.sort(cmp);
  return heap.map(e => e.i);
}

// Best value so far in arrival order, sampled at most `points` times, with
// the luck line: the best of n draws expected if every config were equally
// good and the spread were all noise, mean + sd * E[max of n normals].
export function recordCurve(target, rows, points = 400) {
  const y = target.values;
  const dir = target.better < 0 ? -1 : 1;
  let best = -Infinity, n = 0, mean = 0, m2 = 0;
  const step = Math.max(1, Math.floor(rows.length / points));
  const out = [];
  let lastRecordRow = -1;
  const records = [];
  for (let j = 0; j < rows.length; j++) {
    const v = y[rows[j]];
    if (v !== v) continue;
    n++;
    const d = v - mean; mean += d / n; m2 += d * (v - mean);
    if (v * dir > best) { best = v * dir; lastRecordRow = rows[j]; records.push({ n, row: rows[j], value: v }); }
    if (j % step === 0 || j === rows.length - 1) {
      const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : NaN;
      out.push({ n, row: rows[j], best: best * dir, luck: n >= 2 ? mean + dir * sd * expectedMaxZ(n) : NaN, mean });
    }
  }
  return { points: out, records, lastRecordRow };
}

// ---------------------------------------------------------------------------
// Gates

export function gateStats(schema, rows) {
  const out = [];
  for (const g of schema.gates) {
    let n = 0, k = 0;
    const vals = [];
    for (let j = 0; j < rows.length; j++) {
      const i = rows[j], p = g.pass[i];
      if (p !== p) continue;
      n++; k += p;
      const v = g.value[i];
      if (v === v) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const q = (f) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(f * vals.length))] : NaN;
    const [lo, hi] = wilson(k, n);
    out.push({ id: g.id, label: g.label, need: g.need, unit: g.unit, n, passed: k, rate: n ? k / n : NaN, lo, hi,
      never: n > 0 && k === 0, always: n > 0 && k === n,
      // with no pass in n rows, the 95% upper bound on the pass rate (rule of three)
      ruleOfThree: n > 0 && k === 0 ? 3 / n : NaN,
      quantiles: { p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), max: vals[vals.length - 1] },
      values: vals.length });
  }
  return out;
}

// Which gates fail together, among rows at or above `minGates` passes.
export function coFailure(schema, rows, minPassed) {
  const G = schema.gates;
  const counts = new Map();
  let total = 0;
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j];
    let passed = 0, mask = 0, known = true;
    for (let g = 0; g < G.length; g++) {
      const p = G[g].pass[i];
      if (p !== p) { known = false; break; }
      if (p) passed++; else mask |= 1 << g;
    }
    if (!known || passed < minPassed) continue;
    total++;
    counts.set(mask, (counts.get(mask) || 0) + 1);
  }
  const combos = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([mask, c]) => ({
    failing: G.filter((_, g) => mask & (1 << g)).map(x => x.id), count: c, share: c / total }));
  return { total, combos };
}

// The numeric target most correlated with a gate's value (what bounds it).
export function strongestCorrelate(schema, values, rows, exclude = []) {
  let best = null;
  for (const t of schema.targets) {
    if (t.kind === "binary" || exclude.includes(t.id)) continue;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let j = 0; j < rows.length; j++) {
      const i = rows[j], x = values[i], y = t.values[i];
      if (x !== x || y !== y) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    if (n < MIN_N) continue;
    const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
    if (!(vx > 0 && vy > 0)) continue;
    const r = cov / Math.sqrt(vx * vy);
    if (!best || Math.abs(r) > Math.abs(best.r)) best = { target: t.id, label: t.label, r, n };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Sampler health

// Share of each level against a uniform draw (chi-square goodness of fit).
export function uniformity(dim, rows) {
  const k = dim.levels.length;
  const cnt = new Float64Array(k);
  let N = 0;
  for (let j = 0; j < rows.length; j++) { const c = dim.codes[rows[j]]; if (c >= 0) { cnt[c]++; N++; } }
  if (k < 2 || N === 0) return { N, chi2: NaN, p: NaN, shares: [...cnt].map(c => (N ? c / N : NaN)) };
  const e = N / k;
  let chi2 = 0;
  for (let j = 0; j < k; j++) chi2 += (cnt[j] - e) * (cnt[j] - e) / e;
  return { N, chi2, df: k - 1, p: chi2Survival(chi2, k - 1), shares: [...cnt].map(c => c / N), counts: [...cnt] };
}

// Rows that break a profile invariant.
export function invariantBreaks(ds, inv, rows, keep = 20) {
  const cols = inv.cols.map(c => ds.col(c));
  let count = 0;
  const first = [];
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j];
    const args = cols.map(c => { const v = c.value(i); return v === undefined ? null : v; });
    if (inv.bad(...args)) { count++; if (first.length < keep) first.push(i); }
  }
  return { id: inv.id, label: inv.label, count, first, checked: rows.length };
}

// Probability that a normal z is below x (re-exported for views).
export const phi = normCdf;
