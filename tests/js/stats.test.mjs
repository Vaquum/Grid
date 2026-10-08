import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/stats.js";

const G = JSON.parse(readFileSync(new URL("../golden/stats.json", import.meta.url)));

// |actual - expected| within rel * |expected| (or within `abs`, for values
// whose exact answer is zero).
function close(actual, expected, rel, what, abs = 0) {
  const tol = Math.max(rel * Math.abs(expected), abs);
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, scipy ${expected} (rel tol ${rel})`);
}

test("lnGamma matches scipy", () => {
  for (const [x, v] of G.lnGamma) close(S.lnGamma(x), v, 1e-13, `lnGamma(${x})`, 1e-14);
});

test("regularized incomplete beta matches scipy", () => {
  for (const [x, a, b, v] of G.betaInc) close(S.betaInc(x, a, b), v, 1e-10, `I(${x};${a},${b})`);
});

test("F upper tail matches scipy", () => {
  for (const [f, d1, d2, v] of G.fSurvival) close(S.fSurvival(f, d1, d2), v, 1e-9, `F(${f};${d1},${d2})`);
});

test("t CDF and quantile match scipy", () => {
  for (const [t, df, v] of G.tCdf) close(S.tCdf(t, df), v, 1e-10, `tCdf(${t};${df})`);
  for (const [p, df, v] of G.tInv) close(S.tInv(p, df), v, 1e-9, `tInv(${p};${df})`);
});

test("normal quantile and CDF match scipy", () => {
  for (const [p, v] of G.normInv) close(S.normInv(p), v, 1e-12, `normInv(${p})`);
  for (const [x, v] of G.normCdf) close(S.normCdf(x), v, 1e-11, `normCdf(${x})`);
});

test("chi-square upper tail matches scipy", () => {
  for (const [x, k, v] of G.chi2Survival) close(S.chi2Survival(x, k), v, 1e-9, `chi2(${x};${k})`);
});

test("Wilson interval matches its definition", () => {
  for (const [k, n, lo, hi] of G.wilson) {
    const [a, b] = S.wilson(k, n);
    close(a + 1, lo + 1, 1e-12, `wilson lo ${k}/${n}`);
    close(b, hi, 1e-12, `wilson hi ${k}/${n}`);
  }
});

test("Benjamini-Hochberg q-values", () => {
  const [p, q] = G.bh;
  const got = S.bhQ(p);
  got.forEach((v, i) => close(v, q[i], 1e-14, `q[${i}]`));
  assert.ok(Number.isNaN(S.bhQ([NaN, 0.1])[0]));
});

test("expected maximum of n normals", () => {
  for (const [n, v] of G.expectedMaxZ) close(S.expectedMaxZ(n), v, 1e-12, `E[max] n=${n}`);
});

test("meanInterval is exact for shifted sums", () => {
  const ys = [1000.5, 1000.25, 999.75, 1001, 1000];
  const shift = 1000;
  let s = 0, ss = 0;
  for (const y of ys) { s += y - shift; ss += (y - shift) ** 2; }
  const m = S.meanInterval(ys.length, s, ss, shift, false);
  close(m.mean, 1000.3, 1e-15, "mean");
  const sd = Math.sqrt(ys.reduce((a, y) => a + (y - 1000.3) ** 2, 0) / 4);
  close(m.sd, sd, 1e-12, "sd");
  const b = S.meanInterval(10, 3, 3, 0, true);
  close(b.mean, 0.3, 1e-15, "binary mean");
  assert.deepEqual([b.lo, b.hi], S.wilson(3, 10));
});
