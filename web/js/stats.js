// Numerical building blocks. Every function here is pure and checked
// against scipy reference values in tests/js/stats.test.mjs.

export const EULER_GAMMA = 0.5772156649015329;

// ln Γ(x), Lanczos approximation (g = 7, n = 9), |rel err| < 1e-14.
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

export function lnGamma(x) {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized incomplete beta I_x(a, b) by Lentz's continued fraction.
function betacf(x, a, b) {
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10000; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) return h;
  }
  throw new Error(`betacf did not converge (x=${x}, a=${a}, b=${b})`);
}

export function betaInc(x, a, b) {
  if (!(a > 0 && b > 0)) throw new Error(`betaInc needs a, b > 0 (a=${a}, b=${b})`);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const bt = Math.exp(lbt);
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(x, a, b) / a;
  return 1 - bt * betacf(1 - x, b, a) / b;
}

// Upper tail of the F distribution: P(F > f) with (d1, d2) degrees of freedom.
export function fSurvival(f, d1, d2) {
  if (!(f > 0)) return 1;
  if (!isFinite(f)) return 0;
  return betaInc(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

// Student t CDF.
export function tCdf(t, df) {
  const x = df / (df + t * t);
  const tail = 0.5 * betaInc(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

// Student t quantile, by bisection on tCdf (monotone), to 1e-12.
export function tInv(p, df) {
  if (!(p > 0 && p < 1)) throw new Error(`tInv needs 0 < p < 1, got ${p}`);
  if (p === 0.5) return 0;
  let lo = -1, hi = 1;
  while (tCdf(lo, df) > p) lo *= 2;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}

// Standard normal quantile, Wichura's AS241 (PPND16), |rel err| < 1e-15.
export function normInv(p) {
  if (!(p > 0 && p < 1)) throw new Error(`normInv needs 0 < p < 1, got ${p}`);
  const q = p - 0.5;
  let r, val;
  if (Math.abs(q) <= 0.425) {
    r = 0.180625 - q * q;
    val = q * (((((((r * 2509.0809287301226727 + 33430.575583588128105) * r + 67265.770927008700853) * r
      + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r
      + 133.14166789178437745) * r + 3.387132872796366608)
      / (((((((r * 5226.495278852545925 + 28729.085735721942674) * r + 39307.89580009271061) * r
      + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r
      + 42.313330701600911252) * r + 1);
    return val;
  }
  r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  if (r <= 5) {
    r -= 1.6;
    val = (((((((r * 7.7454501427834140764e-4 + 0.0227238449892691845833) * r + 0.24178072517745061177) * r
      + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r
      + 4.6303378461565452959) * r + 1.42343711074968357734)
      / (((((((r * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r
      + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r
      + 2.05319162663775882187) * r + 1);
  } else {
    r -= 5;
    val = (((((((r * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r
      + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r
      + 5.4637849111641143699) * r + 6.6579046435011037772)
      / (((((((r * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r
      + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r
      + 0.59983220655588793769) * r + 1);
  }
  return q < 0 ? -val : val;
}

// Standard normal CDF.
export function normCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2);
}

// Complementary error function: erfc(x) = Q(1/2, x²) for x >= 0.
export function erfc(x) {
  if (x < 0) return 2 - erfc(-x);
  return gammaQ(0.5, x * x);
}

// Regularized upper incomplete gamma Q(a, x).
export function gammaQ(a, x) {
  if (x < 0 || a <= 0) throw new Error(`gammaQ needs x >= 0, a > 0 (a=${a}, x=${x})`);
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaPSeries(a, x);
  return gammaQContinued(a, x);
}

function gammaPSeries(a, x) {
  let ap = a, sum = 1 / a, del = sum;
  for (let n = 0; n < 10000; n++) {
    ap += 1; del *= x / ap; sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-16) {
      return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
    }
  }
  throw new Error(`gamma series did not converge (a=${a}, x=${x})`);
}

function gammaQContinued(a, x) {
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  }
  throw new Error(`gamma continued fraction did not converge (a=${a}, x=${x})`);
}

// Upper tail of chi-square with k degrees of freedom.
export function chi2Survival(x, k) {
  if (!(x > 0)) return 1;
  return gammaQ(k / 2, x / 2);
}

// Wilson score interval for k successes in n trials at level 1 - alpha.
export function wilson(k, n, alpha = 0.05) {
  if (!(n > 0)) return [NaN, NaN];
  const z = normInv(1 - alpha / 2);
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

// The value at a share of the way up sorted values, as a value they hold:
// the lower of the two a share falls between (an even count's median is
// its lower middle). Every median and quartile Grid shows comes from here,
// so the same rows show the same median everywhere, printed as written.
export function rankAt(sorted, f) {
  const n = sorted.length;
  return n ? sorted[Math.floor(f * (n - 1))] : NaN;
}

// Benjamini–Hochberg q-values (same order as input; NaN stays NaN).
export function bhQ(pvals) {
  const idx = [];
  for (let i = 0; i < pvals.length; i++) if (Number.isFinite(pvals[i])) idx.push(i);
  idx.sort((a, b) => pvals[a] - pvals[b]);
  const m = idx.length;
  const q = new Array(pvals.length).fill(NaN);
  let prev = 1;
  for (let r = m - 1; r >= 0; r--) {
    const i = idx[r];
    prev = Math.min(prev, pvals[i] * m / (r + 1));
    q[i] = prev;
  }
  return q;
}

// Expected maximum of n independent standard normals, as used by the false
// strategy theorem (Bailey & López de Prado): (1−γ)Φ⁻¹(1−1/n) + γΦ⁻¹(1−1/(n·e)).
export function expectedMaxZ(n) {
  if (!(n >= 2)) return NaN;
  return (1 - EULER_GAMMA) * normInv(1 - 1 / n) + EULER_GAMMA * normInv(1 - 1 / (n * Math.E));
}

// Two-sided normal p-value for a z statistic.
export function zP(z) {
  return 2 * normCdf(-Math.abs(z));
}

// Mean and interval for a sample summarised by count, sum and sum of squares
// taken about `shift` (sums of y - shift), which keeps the variance exact
// when the mean is far from zero.
export function meanInterval(n, s, ss, shift, binary, alpha = 0.05) {
  if (!(n > 0)) return { mean: NaN, lo: NaN, hi: NaN, sd: NaN };
  if (binary) {
    // a rate is exactly hits / rows (shifted sums would leave 1e-17 dust)
    const k = Math.round(s + shift * n);
    const rate = k / n;
    const [lo, hi] = wilson(k, n, alpha);
    return { mean: rate, lo, hi, sd: Math.sqrt(rate * (1 - rate)) };
  }
  const mean = shift + s / n;
  if (n < 2) return { mean, lo: NaN, hi: NaN, sd: NaN };
  const varr = Math.max(0, (ss - s * s / n) / (n - 1));
  const sd = Math.sqrt(varr);
  const half = tInv(1 - alpha / 2, n - 1) * sd / Math.sqrt(n);
  return { mean, lo: mean - half, hi: mean + half, sd };
}
