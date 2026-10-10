// Features on a Limen run, read from its manifest and its round log.
//
// The manifest names each feature and indicator function with its group.
// A round's feature_groups switches groups on (pipe-joined names, or
// "all"); its ablation then drops feature_drop_count of the round's
// columns, chosen with random.Random(feature_drop_seed) from them sorted,
// and the round log (round_data.jsonl) names the columns it dropped.
//
// Two readings follow. Groups: drawn combinations that differ by one
// group say what adding that group did. Columns: with few seeds, columns
// dropped together come in fixed sets, so each column's effect comes from
// one additive model over every round with a record: the needle as the
// round's feature groups, the parameters that name columns, and one term
// per column it dropped. A column's term is the share of the effect that
// its varied company allows; columns never dropped apart are one term.

import { summarize, ALPHA } from "./engine.js";
import { bhQ, zP } from "./stats.js";
import { roundKey } from "./pack.js";

const Z95 = 1.959963984540054;
// Fewer rows than this dropped a column: its term would rest on a handful
// of rounds fitted almost exactly, so no number is claimed for it.
export const MIN_DROPS = 10;

const fname = (func) => String(func).split(".").pop();

// What the manifest says about features: its groups and the functions in
// each, the functions every round has, the parameters its feature and
// indicator entries take from the round, and the ablation's keys.
export function limenDesign(experiment) {
  const sm = (((experiment || {}).manifest || {}).sfd || {}).manifest || {};
  const entries = [...(sm.indicators || []), ...(sm.features || [])];
  const groups = new Map(), always = [], naming = new Set();
  for (const e of entries) {
    const params = e.params || {};
    const name = fname(e.func);
    if (typeof params.group === "string") {
      if (!groups.has(params.group)) groups.set(params.group, []);
      groups.get(params.group).push(name);
    } else always.push(name);
    for (const v of Object.values(params)) {
      const m = typeof v === "string" ? /^\{(\w+)\}$/.exec(v) : null;
      if (m) naming.add(m[1]);
    }
  }
  const fa = sm.feature_ablation || null;
  return {
    groups: [...groups].map(([name, funcs]) => ({ name, funcs })), always, naming: [...naming],
    ablation: fa ? { countKey: fa.drop_count_key || "feature_drop_count", seedKey: fa.seed_key || "feature_drop_seed" } : null,
  };
}

// The groups a value of feature_groups switches on.
export function groupsOf(design, value) {
  return value === "all" || value === null || value === undefined ? design.groups.map(g => g.name) : String(value).split("|");
}

// Drawn combinations that differ by one group: what adding it did, as a
// difference of means with its 95% interval, corrected across the pairs.
export function groupContrasts(design, dim, target, rows) {
  const levels = dim.levels.map((l, j) => {
    const sub = [];
    for (let r = 0; r < rows.length; r++) if (dim.codes[rows[r]] === j) sub.push(rows[r]);
    return { key: l.key, label: l.label, groups: groupsOf(design, l.value), rows: sub, ...summarize(target, sub) };
  });
  const contrasts = [];
  for (const a of levels) for (const b of levels) {
    const added = b.groups.filter(g => !a.groups.includes(g));
    if (added.length !== 1 || b.groups.length !== a.groups.length + 1 || !a.groups.every(g => b.groups.includes(g))) continue;
    const va = a.sd * a.sd / a.n, vb = b.sd * b.sd / b.n;
    const delta = b.mean - a.mean, se = Math.sqrt(va + vb);
    const p = a.n >= 2 && b.n >= 2 && se > 0 ? zP(delta / se) : NaN;
    contrasts.push({ added: added[0], from: a, to: b, delta, lo: delta - Z95 * se, hi: delta + Z95 * se, p });
  }
  const q = bhQ(contrasts.map(c => c.p));
  contrasts.forEach((c, k) => { c.q = q[k]; c.detectable = q[k] < ALPHA; });
  return { levels, contrasts };
}

// The columns the ablation dropped, one member each across the rounds. A
// column named after the value a naming parameter took in every round
// that dropped it (roc_24 where ret_period was 24) is named by that
// parameter instead (roc_{ret_period}), so it is one member whatever the
// value. `perRow[i]` lists the members row i dropped, or is null when the
// round log has no record of row i's round.
export function ablationMembers(ds, schema, design, rows) {
  const ri = ds.col("_round_index");
  if (!ri || ri.kind !== "num") throw new Error("a Limen run needs its _round_index column to read its round log");
  const n = ds.n;
  // a run read from several result directories: a round is its index in
  // its directory (shard)
  const shard = ds.meta.experiment && ds.meta.experiment.shards ? ds.col("shard") : null;
  const roundOf = (i) => (ri.state[i] === 0 ? roundKey(ri.vals[i], shard ? shard.value(i) : null) : NaN);
  const valueOf = (p, i) => { const d = schema.dimById.get(p); return d && d.codes[i] >= 0 ? String(d.levels[d.codes[i]].value) : null; };
  // the naming parameters each raw column name matches in every round that dropped it
  const seen = new Map();
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r], rec = ds.rounds.get(roundOf(i));
    if (!rec) continue;
    for (const name of rec) {
      const tokens = name.split("_");
      const fits = design.naming.filter(p => { const v = valueOf(p, i); return v !== null && tokens.includes(v); });
      const was = seen.get(name);
      seen.set(name, was ? was.filter(p => fits.includes(p)) : fits);
    }
  }
  const canonical = new Map();
  for (const [name, fits] of seen) {
    if (fits.length !== 1) { canonical.set(name, name); continue; }
    const p = fits[0];
    // the token that is the parameter's value: the same position in every round
    canonical.set(name, { param: p, name });
  }
  const memberIndex = new Map(), members = [];
  const perRow = new Array(n).fill(null);
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r], rec = ds.rounds.get(roundOf(i));
    if (!rec) continue;
    const list = [];
    for (const name of rec) {
      const c = canonical.get(name);
      let key = name;
      if (c && typeof c === "object") {
        const v = valueOf(c.param, i);
        key = name.split("_").map(t => (t === v ? `{${c.param}}` : t)).join("_");
      }
      if (!memberIndex.has(key)) { memberIndex.set(key, members.length); members.push({ name: key, raw: new Set(), drops: 0 }); }
      const m = members[memberIndex.get(key)];
      m.raw.add(name);
      if (!list.includes(memberIndex.get(key))) { list.push(memberIndex.get(key)); m.drops++; }
    }
    perRow[i] = list;
  }
  return { members, perRow };
}

// The dims the model holds fixed: the feature groups, the parameters the
// manifest's features take (a column can be named by one), and the
// parameters that move the needle (independent of the drops, they only
// narrow the intervals); never the ablation's own count and seed, which
// decide the drops.
export function ablationFactors(schema, design, movers) {
  const skip = new Set(design.ablation ? [design.ablation.countKey, design.ablation.seedKey] : []);
  const ids = ["feature_groups", ...design.naming, ...movers.map(d => d.id)];
  const out = [];
  for (const id of ids) {
    const d = schema.dimById.get(id);
    if (!d || skip.has(id) || out.includes(d) || d.levels.length < 2) continue;
    out.push(d);
  }
  return out;
}

// Cholesky of a p×p matrix (row-major) for the columns `keep`; null when
// a pivot is not clearly positive.
function cholesky(A, p, keep) {
  const k = keep.length, L = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b <= a; b++) {
      let s = A[keep[a] * p + keep[b]];
      for (let c = 0; c < b; c++) s -= L[a * k + c] * L[b * k + c];
      if (a === b) {
        if (!(s > 1e-9 * Math.max(1, A[keep[a] * p + keep[a]]))) return { fail: a };
        L[a * k + a] = Math.sqrt(s);
      } else L[a * k + b] = s / L[b * k + b];
    }
  }
  return { L };
}

function cholSolve(L, k, rhs) {
  const y = new Float64Array(k);
  for (let a = 0; a < k; a++) { let s = rhs[a]; for (let c = 0; c < a; c++) s -= L[a * k + c] * y[c]; y[a] = s / L[a * k + a]; }
  for (let a = k - 1; a >= 0; a--) { let s = y[a]; for (let c = a + 1; c < k; c++) s -= L[c * k + a] * y[c]; y[a] = s / L[a * k + a]; }
  return y;
}

// The additive model: least squares over the rows with a needle value and
// a round record, with fixed effects for `factors` (dims: the feature
// groups and the naming parameters) and a term per member (dropped = 1).
// Members dropped in exactly the same rows are one term; a member under
// MIN_DROPS drops, or one the design cannot tell from the rest, gets no
// number. Errors are robust to unequal spread and leverage (HC3).
export function ablationModel(target, rows, factors, members, perRow) {
  const y = target.values;
  const use = [];
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    if (perRow[i] === null || y[i] !== y[i] || factors.some(f => f.codes[i] < 0)) continue;
    use.push(i);
  }
  // members dropped in the same rows are one term
  const sig = new Map(), terms = [];
  const rowsOf = members.map(() => []);
  for (let u = 0; u < use.length; u++) for (const mi of perRow[use[u]]) rowsOf[mi].push(u);
  members.forEach((m, mi) => {
    if (!rowsOf[mi].length) return;
    const key = rowsOf[mi].join(",");
    if (sig.has(key)) { terms[sig.get(key)].members.push(m); return; }
    sig.set(key, terms.length);
    terms.push({ members: [m], drops: rowsOf[mi].length, mi: [mi] });
  });
  for (const t of terms) t.mi = t.members.map(m => members.indexOf(m));
  const termOf = new Int32Array(members.length).fill(-1);
  terms.forEach((t, k) => { for (const mi of t.mi) termOf[mi] = k; });
  // columns: intercept, each factor's levels but its first, then each term
  const offs = [];
  let p = 1;
  for (const f of factors) { offs.push(p); p += f.levels.length - 1; }
  const t0 = p;
  p += terms.length;
  const colsOf = (i) => {
    const s = [0];
    factors.forEach((f, k) => { const c = f.codes[i]; if (c > 0) s.push(offs[k] + c - 1); });
    const seenTerms = new Set();
    for (const mi of perRow[i]) { const t = termOf[mi]; if (t >= 0 && !seenTerms.has(t)) { seenTerms.add(t); s.push(t0 + t); } }
    return s;
  };
  const XtX = new Float64Array(p * p), Xty = new Float64Array(p);
  let shift = 0;
  for (const i of use) shift += y[i];
  shift = use.length ? shift / use.length : 0;
  const S = use.map(colsOf);
  use.forEach((i, u) => {
    const s = S[u], v = y[i] - shift;
    for (const a of s) { Xty[a] += v; for (const b of s) XtX[a * p + b] += 1; }
  });
  // terms with too few drops are left out of the fit's report but kept in it
  let keep = [...Array(p).keys()];
  const aliased = new Set();
  let ch;
  for (;;) {
    ch = cholesky(XtX, p, keep);
    if (ch.L) break;
    aliased.add(keep[ch.fail]);
    keep = keep.filter((_, a) => a !== ch.fail);
  }
  const k = keep.length;
  const b = cholSolve(ch.L, k, keep.map(a => Xty[a]));
  // the inverse, column by column
  const inv = new Float64Array(k * k);
  for (let c = 0; c < k; c++) {
    const e = new Float64Array(k); e[c] = 1;
    const col = cholSolve(ch.L, k, e);
    for (let a = 0; a < k; a++) inv[a * k + c] = col[a];
  }
  const pos = new Int32Array(p).fill(-1);
  keep.forEach((a, j) => { pos[a] = j; });
  // HC3: each row's squared residual over (1 - its leverage)^2
  const meat = new Float64Array(k * k);
  let fitted = 0;
  use.forEach((i, u) => {
    const s = S[u].map(a => pos[a]).filter(j => j >= 0);
    let yhat = 0, h = 0;
    for (const a of s) { yhat += b[a]; for (const c of s) h += inv[a * k + c]; }
    const e = (y[i] - shift) - yhat;
    if (h >= 1 - 1e-9) return;
    fitted++;
    const w = e * e / ((1 - h) * (1 - h));
    for (const a of s) for (const c of s) meat[a * k + c] += w;
  });
  const cov = (a) => {
    // (inv meat inv)[a][a]
    let v = 0;
    for (let x = 0; x < k; x++) { if (!inv[a * k + x]) continue; for (let z = 0; z < k; z++) v += inv[a * k + x] * meat[x * k + z] * inv[z * k + a]; }
    return v;
  };
  const out = terms.map((t, ti) => {
    const col = t0 + ti, j = pos[col];
    const few = t.drops < MIN_DROPS;
    if (aliased.has(col) || few) return { ...t, beta: NaN, se: NaN, keep: NaN, lo: NaN, hi: NaN, p: NaN, reason: few ? "few" : "aliased" };
    const beta = b[j], se = Math.sqrt(Math.max(0, cov(j)));
    // the effect of keeping the column is minus the effect of dropping it
    return { ...t, beta, se, keep: -beta, lo: -beta - Z95 * se, hi: -beta + Z95 * se, p: se > 0 ? zP(beta / se) : NaN, reason: null };
  });
  const q = bhQ(out.map(t => t.p));
  out.forEach((t, k2) => { t.q = q[k2]; t.detectable = q[k2] < ALPHA; });
  return { terms: out, rows: use.length, fitted, params: p };
}
