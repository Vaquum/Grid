// The two halves of a Limen round's test window, from its recorded
// execution: Limen's ordinal halves, the first n / 2 bars and the rest,
// each read as a window of its own (grid/limen.py execution_summary). A
// needle that has them is measured twice on every row, on stretches of
// the market that do not overlap, so what shows in both is not the luck
// of one stretch: an effect counts only when it shows in both, the rows'
// ranks on one half against the other say how much of a score repeats,
// and the rows that lead the first half show how much of a lead the
// second keeps.

import { summarize, MIN_N } from "./engine.js";
import { normInv } from "./stats.js";

export const HALF_NAMES = ["first half", "second half"];

// A needle's halves as needles of their own, or null when it has none.
export function halfTargets(t) {
  if (!t || !t.halves) return null;
  return t.halves.map((values, k) => ({ ...t, id: `${t.id}~${k + 1}`, label: `${t.label}, ${HALF_NAMES[k]}`, values, halves: null, half: k + 1 }));
}

// Whether a parameter's values are ordered alike on both halves: the
// correlation of their lifts (each half's value means less that half's
// base), weighted by the rows of the fewer, over the values with 30 rows
// in both. Near 1, the same values lead; below 0, the order turns over;
// NaN when fewer than two values can be read.
export function agreement(a, b) {
  let k = 0, s = 0, sa = 0, sb = 0;
  for (let j = 0; j < a.levels.length; j++) {
    const x = a.levels[j], y = b.levels[j];
    if (!y || x.withheld || y.withheld || !Number.isFinite(x.lift) || !Number.isFinite(y.lift)) continue;
    const w = Math.min(x.n, y.n);
    k++; s += w * x.lift * y.lift; sa += w * x.lift * x.lift; sb += w * y.lift * y.lift;
  }
  return k >= 2 && sa > 0 && sb > 0 ? s / Math.sqrt(sa * sb) : NaN;
}

// An effect counts only when it shows in both halves: detectable over the
// whole window and in each half (q < 0.05, corrected across the board on
// that half), its values ordered alike in both (agreement above 0). Each
// effect keeps whether it was detectable over the whole window (`whole`),
// its effect on each half (`halves`) and their agreement (`agree`);
// `detectable` becomes whether it counts.
export function twice(whole, halves) {
  const byDim = halves.map(b => new Map(b.effects.map(e => [e.dim, e])));
  for (const e of whole.effects) {
    const hs = byDim.map(m => m.get(e.dim) || null);
    e.halves = hs;
    e.agree = hs[0] && hs[1] ? agreement(hs[0], hs[1]) : NaN;
    e.whole = e.detectable;
    e.detectable = e.whole && hs.every(x => x && x.detectable) && e.agree > 0;
  }
  whole.halves = halves;
  return whole;
}

// The same for a difference (a feature group added, a column kept): it
// counts only when detectable over the whole window and in each half, the
// three of one sign. `value` reads the difference from an item.
export function twiceDiff(item, halves, value) {
  const v = value(item);
  item.halves = halves;
  item.whole = item.detectable;
  item.agree = halves.every(x => x && Number.isFinite(value(x))) ? (halves.every(x => Math.sign(value(x)) === Math.sign(v)) ? 1 : -1) : NaN;
  item.detectable = item.whole && halves.every(x => x && x.detectable) && item.agree > 0;
  return item;
}

// Where an effect that has halves shows: "twice" when it counts; else
// "unlike" (detectable in each half, its values ordered unlike), "first"
// or "second" (in that half only), "whole" (over the whole window only),
// or null (nowhere).
export function showsIn(e) {
  if (!e.halves) return null;
  if (e.detectable) return "twice";
  const [a, b] = e.halves.map(x => !!(x && x.detectable));
  if (a && b) return "unlike";
  if (a) return "first";
  if (b) return "second";
  return e.whole ? "whole" : null;
}

// The words for where it shows, said one way on its card and in the
// inspector.
export const SHOWS_TEXT = {
  twice: "shows in both halves",
  unlike: "the halves disagree",
  first: "first half only",
  second: "second half only",
  whole: "neither half alone",
};

// Each value's rank among `values` (1 the lowest; ties at their mean rank).
function ranksOf(values) {
  const order = Array.from(values.keys()).sort((a, b) => values[a] - values[b]);
  const r = new Float64Array(values.length);
  for (let p = 0; p < order.length;) {
    let q = p;
    while (q + 1 < order.length && values[order[q + 1]] === values[order[p]]) q++;
    for (let k = p; k <= q; k++) r[order[k]] = (p + q) / 2 + 1;
    p = q + 1;
  }
  return r;
}

// How alike the rows rank on the two halves: Spearman's correlation over
// the rows with a value on both, with its 95% interval (Fisher's z, the
// standard error of Fieller, Hartley and Pearson, √(1.06 / (n − 3))).
// 1, the same order; 0, none: the share of a row's standing that repeats
// on a stretch of the market it did not see.
export function rankAgreement(t, rows) {
  const [a, b] = t.halves;
  const x = [], y = [];
  for (let j = 0; j < rows.length; j++) { const i = rows[j], u = a[i], v = b[i]; if (u === u && v === v) { x.push(u); y.push(v); } }
  const n = x.length;
  if (n < 4) return { rho: NaN, lo: NaN, hi: NaN, n };
  const rx = ranksOf(x), ry = ranksOf(y);
  const mean = (n + 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { const p = rx[k] - mean, q = ry[k] - mean; sxy += p * q; sxx += p * p; syy += q * q; }
  if (!(sxx > 0 && syy > 0)) return { rho: NaN, lo: NaN, hi: NaN, n };
  const rho = sxy / Math.sqrt(sxx * syy);
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, rho)));
  const half = normInv(0.975) * Math.sqrt(1.06 / (n - 3));
  return { rho, lo: Math.tanh(z - half), hi: Math.tanh(z + half), n };
}

// The rows with a value on both halves, the best on the first half first
// (ties in the order they arrived).
function byFirstHalf(t, rows, better) {
  const [a, b] = t.halves;
  const out = [];
  for (let j = 0; j < rows.length; j++) { const i = rows[j]; if (a[i] === a[i] && b[i] === b[i]) out.push(i); }
  const dir = better < 0 ? -1 : 1;
  return out.sort((p, q) => (a[q] - a[p]) * dir || p - q);
}

// Each row's rank on the first half among the rows in view (competition
// ranks: rows that tie share the first one's), NaN where it has none.
export function firstHalfRanks(t, rows, better, n) {
  const a = t.halves[0];
  const order = byFirstHalf(t, rows, better);
  const rank = new Float64Array(n).fill(NaN);
  for (let p = 0; p < order.length; p++) {
    const i = order[p];
    rank[i] = p > 0 && a[order[p - 1]] === a[i] ? rank[order[p - 1]] : p + 1;
  }
  return rank;
}

// How much of a lead on the first half the second half keeps: the best
// tenth of the rows on the first half (at least 30), against every row,
// on each half. `kept` is their second-half lead over their first-half
// lead: 1 when a lead holds whole, 0 when the second half returns every
// row to the mean (a lead that was luck), below 0 when it turns over.
// null under 60 rows.
export function keptLead(t, rows, better) {
  const order = byFirstHalf(t, rows, better);
  const N = order.length;
  if (N < 2 * MIN_N) return null;
  const top = order.slice(0, Math.max(MIN_N, Math.ceil(N / 10)));
  const [h1, h2] = halfTargets(t);
  const all1 = summarize(h1, order), all2 = summarize(h2, order);
  const top1 = summarize(h1, top), top2 = summarize(h2, top);
  const lead = top1.mean - all1.mean;
  return { n: N, k: top.length, top1, top2, all1, all2, lead, kept: lead !== 0 ? (top2.mean - all2.mean) / lead : NaN };
}

// The second half by the rank on the first, for a chart: the rows in
// tenths by the first half (the best tenth first), each tenth's mean
// second half with its 95% interval; and every row's.
export function persistence(t, rows, better, bins = 10) {
  const order = byFirstHalf(t, rows, better);
  const N = order.length;
  if (N < bins * MIN_N) return null;
  const h2 = halfTargets(t)[1];
  const points = [];
  for (let b = 0; b < bins; b++) {
    const part = order.slice(Math.floor(b * N / bins), Math.floor((b + 1) * N / bins));
    points.push({ bin: b + 1, ...summarize(h2, part) });
  }
  return { points, all: summarize(h2, order), n: N };
}
