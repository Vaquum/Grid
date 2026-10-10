// What every column is (its role), the dimensions a sweep can be cut by,
// and the targets it can be measured on.
//
// A dimension (dim) gives every row a level code, or -1 where it does not
// apply. Levels of a numeric param are its values (null is a level of its
// own: `tp = none` means no take-profit). A set column (feature subset)
// gives one in/out dim per member. A nested param (hpcfg.*) becomes one dim
// per value of the param it varies under (learning_rate under lgbm_hp and
// under xgb_hp are different knobs), and only where it varies.

import { matchProfile } from "./profiles.js";
import { spanText } from "./ui.js";
import { rowRounds } from "./pack.js";

const MAX_LEVELS = 32;      // more distinct values than this: binned
const BINS = 10;
const CAT_MAX = 64;         // strings with more levels are text, not params

// A parameter's value as the sweep wrote it, the way it would be typed into
// its config (kline_size = 3600, a hyphen for a minus): it names a value,
// it is not a measurement.
export function fmtValue(v) {
  if (v === null) return "none";
  if (v === undefined) return "n/a";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2).replace("e+", "e");
    return String(+v.toPrecision(6));
  }
  return String(v);
}

// Distinct non-absent values of a column over rows [0, n), capped.
function survey(col, n, cap) {
  const counts = new Map();
  let nulls = 0, absent = 0, many = false;
  for (let i = 0; i < n; i++) {
    const st = col.stateAt(i);
    if (st === 2) { absent++; continue; }
    if (st === 1) { nulls++; continue; }
    if (many) continue;
    const key = col.kind === "num" ? col.vals[i]
      : col.kind === "set" ? Array.from(col.bits.subarray(i * col.words, (i + 1) * col.words)).join(",")
      : col.codes[i];
    counts.set(key, (counts.get(key) || 0) + 1);
    if (counts.size > cap) many = true;
  }
  return { counts, nulls, absent, many, present: n - absent };
}

function levelOf(col, key) {
  if (col.kind === "num") return { key: String(key), label: fmtValue(key), value: key, sort: key };
  if (col.kind === "bool") return { key: key ? "true" : "false", label: key ? "true" : "false", value: !!key, sort: key };
  const text = col.levels[key];
  const value = col.kind === "json" ? JSON.parse(text) : text;
  return { key: text, label: col.kind === "json" ? text : fmtValue(value), value, sort: text };
}

// Build a categorical dim from a param column over rows [0, n).
function paramDim(col, n, base) {
  const sv = survey(col, n, MAX_LEVELS);
  if (col.kind === "num" && sv.many) return binnedDim(col, n, base, sv);
  const keys = [...sv.counts.keys()];
  const levels = keys.map(k => levelOf(col, k));
  const order = levels.map((_, i) => i).sort((a, b) =>
    col.kind === "num" || col.kind === "bool" ? levels[a].sort - levels[b].sort
      : String(levels[a].sort).localeCompare(String(levels[b].sort)));
  const sorted = order.map(i => levels[i]);
  const pos = new Map(order.map((i, j) => [keys[i], j]));
  let nullCode = -1;
  if (sv.nulls) { nullCode = 0; sorted.unshift({ key: "null", label: "none", value: null, sort: -Infinity }); for (const [k, v] of pos) pos.set(k, v + 1); }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const st = col.stateAt(i);
    if (st === 2) codes[i] = -1;
    else if (st === 1) codes[i] = nullCode;
    else codes[i] = pos.get(col.kind === "num" ? col.vals[i] : col.codes[i]);
  }
  return { ...base, levels: sorted, codes, ordered: col.kind === "num", present: sv.present };
}

// A numeric param with many distinct values: ten equal-count bins.
function binnedDim(col, n, base, sv) {
  const vals = [];
  for (let i = 0; i < n; i++) if (col.stateAt(i) === 0) vals.push(col.vals[i]);
  vals.sort((a, b) => a - b);
  const edges = [];
  for (let b = 1; b < BINS; b++) edges.push(vals[Math.floor(b * vals.length / BINS)]);
  const uniq = [...new Set(edges)];
  const levels = [];
  let lo = vals[0];
  for (let b = 0; b <= uniq.length; b++) {
    const hi = b < uniq.length ? uniq[b] : vals[vals.length - 1];
    levels.push({ key: `bin${b}`, label: spanText(fmtValue(lo), fmtValue(hi)), value: [lo, hi], sort: lo });
    lo = hi;
  }
  let off = 0;
  if (sv.nulls) { levels.unshift({ key: "null", label: "none", value: null, sort: -Infinity }); off = 1; }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const st = col.stateAt(i);
    if (st === 2) { codes[i] = -1; continue; }
    if (st === 1) { codes[i] = 0; continue; }
    const v = col.vals[i];
    let b = 0;
    while (b < uniq.length && v >= uniq[b]) b++;
    codes[i] = b + off;
  }
  return { ...base, levels, codes, ordered: true, binned: true, present: sv.present };
}

function buildMemberDims(col, n, family, sizeDim) {
  const dims = [];
  for (let m = 0; m < col.levels.length; m++) {
    const codes = new Int32Array(n);
    let inc = 0;
    for (let i = 0; i < n; i++) {
      const st = col.state[i];
      if (st !== 0) { codes[i] = -1; continue; }
      const h = col.has(i, m);
      codes[i] = h;
      inc += h;
    }
    dims.push({
      id: `${col.name}∋${col.levels[m]}`, name: col.levels[m], column: col.name, family,
      kind: "member", role: "param", label: col.levels[m],
      levels: [{ key: "out", label: "left out", value: false, sort: 0 },
               { key: "in", label: "included", value: true, sort: 1 }],
      codes, ordered: false, set: { column: col.name, member: m, sizeDim }, included: inc,
    });
  }
  return dims;
}

function sizeDimFromSet(col, n, family) {
  const codes = new Int32Array(n);
  const sizes = new Map();
  for (let i = 0; i < n; i++) {
    if (col.state[i] !== 0) { codes[i] = -1; continue; }
    let k = 0;
    for (let w = 0; w < col.words; w++) {
      let x = col.bits[i * col.words + w];
      while (x) { x &= x - 1; k++; }
    }
    codes[i] = k;
    sizes.set(k, true);
  }
  const keys = [...sizes.keys()].sort((a, b) => a - b);
  const pos = new Map(keys.map((k, j) => [k, j]));
  for (let i = 0; i < n; i++) if (codes[i] >= 0) codes[i] = pos.get(codes[i]);
  return {
    id: `|${col.name}|`, name: `|${col.name}|`, column: col.name, family, kind: "size", role: "param",
    label: `size of ${col.name}`, ordered: true, codes,
    levels: keys.map(k => ({ key: String(k), label: String(k), value: k, sort: k })),
  };
}

// Nested params scoped to the levels of `scope` under which they vary.
function scopedDims(col, n, scope, family) {
  const dims = [];
  const perLevel = new Map();
  for (let i = 0; i < n; i++) {
    const sc = scope.codes[i];
    if (sc < 0 || col.stateAt(i) === 2) continue;
    let m = perLevel.get(sc);
    if (!m) { m = new Set(); perLevel.set(sc, m); }
    if (m.size <= MAX_LEVELS) m.add(col.stateAt(i) === 1 ? "null" : col.kind === "num" ? col.vals[i] : col.codes[i]);
  }
  const short = col.name.split(".").slice(1).join(".");
  const fixedUnder = [];
  for (const [sc, set] of [...perLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const lvl = scope.levels[sc];
    if (set.size < 2) { fixedUnder.push(lvl.label); continue; }
    const codes = new Int32Array(n).fill(-1);
    const values = [...set].filter(v => v !== "null");
    const levels = values.map(k => levelOf(col, k));
    const order = levels.map((_, j) => j).sort((a, b) =>
      col.kind === "num" ? levels[a].sort - levels[b].sort : String(levels[a].sort).localeCompare(String(levels[b].sort)));
    const sorted = order.map(j => levels[j]);
    const pos = new Map(order.map((j, k) => [values[j], k]));
    let nullCode = -1;
    if (set.has("null")) { nullCode = 0; sorted.unshift({ key: "null", label: "none", value: null, sort: -Infinity }); for (const [k, v] of pos) pos.set(k, v + 1); }
    for (let i = 0; i < n; i++) {
      if (scope.codes[i] !== sc) continue;
      const st = col.stateAt(i);
      if (st === 2) continue;
      codes[i] = st === 1 ? nullCode : pos.get(col.kind === "num" ? col.vals[i] : col.codes[i]);
    }
    dims.push({
      id: `${col.name}@${lvl.key}`, name: short, column: col.name, family, kind: "scoped", role: "param",
      label: `${short} · ${lvl.label}`, levels: sorted, codes, ordered: col.kind === "num",
      scope: { dim: scope.id, level: sc, label: `${scope.label} = ${lvl.label}` },
    });
  }
  return { dims, fixedUnder };
}

// Is `a` the same knob as `b` where `a` applies (a one-to-one level map)?
function aliasOf(a, b, n) {
  const ab = new Map(), ba = new Map();
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const x = a.codes[i], y = b.codes[i];
    if (x < 0) continue;
    if (y < 0) return false;
    seen++;
    if (ab.has(x) && ab.get(x) !== y) return false;
    if (ba.has(y) && ba.get(y) !== x) return false;
    ab.set(x, y); ba.set(y, x);
  }
  return seen >= 30 && ab.size >= 2;
}

function inferRole(col, n) {
  const sv = survey(col, n, CAT_MAX);
  const distinct = sv.counts.size + (sv.nulls ? 1 : 0);
  if (!sv.many && distinct <= 1) return { role: "fixed", sv };
  if (col.kind === "set") return { role: "param", sv };
  if (col.kind === "str" || col.kind === "bool") return { role: sv.many ? "text" : "param", sv };
  if (col.kind === "json") return { role: sv.many || distinct > MAX_LEVELS ? "text" : "param", sv };
  // num
  if (!sv.many && distinct <= MAX_LEVELS) return { role: "param", sv };
  let integral = true, unique = new Set();
  for (let i = 0; i < n && integral; i++) {
    if (col.stateAt(i) !== 0) continue;
    const v = col.vals[i];
    if (!Number.isInteger(v)) integral = false;
    else unique.add(v);
  }
  if (integral && unique.size === sv.present && sv.present > 50) return { role: "id", sv };
  return { role: "metric", sv };
}

// The digits a target is shown with: the profile's, or more when its
// means are smaller than those can print: two significant digits at the
// larger of its mean's size and the 95% half-width of that mean over every
// row (Limen's net PnL per bar sits near -0.02 bps, which two decimals
// round to nothing). Not the rows' spread: most rounds of a sweep can
// score exactly 0 and a few far out, so the spread says little about the
// scale of the means. A rate is shown in percent whatever its digits.
export function shownDigits(values, digits, kind) {
  if (kind === "binary") return digits;
  let n = 0, s = 0;
  for (let i = 0; i < values.length; i++) { const v = values[i]; if (v === v) { n++; s += v; } }
  if (n < 2) return digits;
  const mean = s / n;
  let ss = 0;
  for (let i = 0; i < values.length; i++) { const v = values[i]; if (v === v) ss += (v - mean) * (v - mean); }
  const scale = Math.max(Math.abs(mean), 1.96 * Math.sqrt(ss / (n - 1) / n));
  if (!(scale > 0)) return digits;
  return Math.min(6, Math.max(digits, 1 - Math.floor(Math.log10(scale))));
}

// The decimals a target's values were written with: the fewest that print
// every value exactly, or null when six do not (a measured float). One
// row's value is shown no finer than this: Limen writes net PnL per bar to
// 0.1 bps, so a round's 0.7 is 0.7, not 0.700.
const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6];
export function recordedDecimals(values) {
  let most = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let d = most;
    for (; d < POW10.length; d++) {
      const x = v * POW10[d];
      if (Math.abs(x - Math.round(x)) <= 1e-9 * Math.max(1, Math.abs(x))) break;
    }
    if (d === POW10.length) return null;
    most = d;
  }
  return most;
}

export function buildSchema(ds, opts = {}) {
  const profile = opts.profile !== undefined ? opts.profile : matchProfile(ds.cols);
  const n = opts.n !== undefined ? opts.n : ds.n;
  const P = profile || { families: [], params: {}, nested: {}, effective: {}, alias: {}, setSize: {},
    ids: [], diagnostic: [], text: [], metrics: {}, derived: [], gates: [], gatesPrefix: null, objective: null };
  const families = [...P.families.map(f => ({ ...f })), { id: "inferred", label: "Inferred" }];
  const fields = [];
  const dims = [];
  const targets = [];
  const gates = [];
  const nestedOf = name => Object.keys(P.nested || {}).find(k => name.startsWith(k + "."));
  const isGate = name => P.gatesPrefix && name.startsWith(P.gatesPrefix);

  // pass 1: roles
  for (const name of ds.order) {
    const col = ds.cols.get(name);
    let role, family = null, inferred = false, note = null;
    if (isGate(name)) role = "gate";
    else if (P.params[name] !== undefined) { role = "param"; family = P.params[name]; }
    else if (nestedOf(name)) { role = "nested"; family = P.nested[nestedOf(name)].family; }
    else if (P.effective[name] !== undefined) { role = "effective"; family = P.effective[name]; }
    else if (P.alias[name] !== undefined) { role = "alias"; note = P.alias[name]; }
    else if (P.ids.includes(name)) role = "id";
    else if (P.text.includes(name)) role = "text";
    else if (P.diagnostic.includes(name)) role = "diagnostic";
    else if (P.metrics[name]) role = "metric";
    else {
      const got = inferRole(col, n);
      role = got.role; inferred = true;
      if (role === "param") family = "inferred";
    }
    if (role === "param" || role === "effective") {
      const sv = survey(col, n, 2);
      if (!sv.many && sv.counts.size + (sv.nulls ? 1 : 0) <= 1) {
        note = `one value in every row: ${sv.counts.size ? fmtValue(levelOf(col, [...sv.counts.keys()][0]).value) : "none"}`;
        role = "fixed";
      }
    }
    fields.push({ name, kind: col.kind, role, family, inferred, note });
  }
  const byName = new Map(fields.map(f => [f.name, f]));

  // pass 2: dims
  for (const f of fields) {
    const col = ds.cols.get(f.name);
    if (f.role === "param" || f.role === "effective" || f.role === "alias") {
      if (col.kind === "set") {
        const sizeName = P.setSize[f.name];
        const sizeId = sizeName && byName.get(sizeName) ? sizeName : `|${f.name}|`;
        if (!(sizeName && byName.get(sizeName))) dims.push(sizeDimFromSet(col, n, f.family));
        dims.push(...buildMemberDims(col, n, f.family, sizeId));
        continue;
      }
      if (col.kind === "json" && f.role !== "param") continue;
      const d = paramDim(col, n, {
        id: f.name, name: f.name, column: f.name, family: f.family || "inferred",
        kind: col.kind === "num" ? "num" : col.kind === "bool" ? "bool" : "cat",
        role: f.role, label: f.name, note: f.note, inferred: f.inferred,
      });
      dims.push(d);
    }
  }
  const dimById = new Map(dims.map(d => [d.id, d]));
  for (const f of fields) {
    if (f.role !== "nested") continue;
    const nest = P.nested[nestedOf(f.name)];
    const scope = dimById.get(nest.scopeBy);
    if (!scope) { f.note = `scoped by ${nest.scopeBy}, which is not in the data`; continue; }
    const { dims: sd, fixedUnder } = scopedDims(ds.cols.get(f.name), n, scope, f.family);
    f.note = fixedUnder.length ? `fixed under ${fixedUnder.join(", ")}` : null;
    for (const d of sd) {
      const twin = dims.find(o => o.role === "param" && o.kind !== "member" && o.kind !== "scoped" && aliasOf(d, o, n));
      if (twin) { d.role = "alias"; d.aliasOf = twin.id; d.note = `same knob as ${twin.id} where ${d.scope.label}`; }
      dims.push(d);
      dimById.set(d.id, d);
    }
    f.dims = sd.map(d => d.id);
  }

  // targets
  const numCol = name => {
    const c = ds.cols.get(name);
    if (!c) return null;
    if (c.kind === "num") return i => (c.state[i] === 0 ? c.vals[i] : NaN);
    if (c.kind === "bool") return i => (c.codes[i] >= 0 ? c.codes[i] : NaN);
    return null;
  };
  for (const d of P.derived || []) {
    const getters = d.needs.map(numCol);
    if (getters.some(g => !g)) continue;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const args = getters.map(g => g(i));
      values[i] = args.some(Number.isNaN) ? NaN : d.fn(...args);
    }
    targets.push({ id: d.id, label: d.label, unit: d.unit, kind: d.kind, better: d.better,
      definition: d.definition, note: d.note, values, digits: shownDigits(values, d.digits ?? 1, d.kind),
      decimals: recordedDecimals(values), group: d.group || null, source: "profile" });
  }
  for (const f of fields) {
    if (!(f.role === "metric" || f.role === "diagnostic")) continue;
    const get = numCol(f.name);
    if (!get) continue;
    const m = P.metrics[f.name] || { label: f.name, unit: "", better: 0, digits: 3 };
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = get(i);
    targets.push({ id: f.name, label: m.label, unit: m.unit, kind: m.kind || "cont", better: m.better,
      digits: shownDigits(values, m.digits, m.kind || "cont"), decimals: recordedDecimals(values),
      cost: !!m.cost, group: m.group || null, values,
      source: P.metrics[f.name] ? "profile" : "inferred",
      diagnostic: f.role === "diagnostic" });
  }

  // what each row's round says beside its row (a Limen round log), joined
  // to the rows by round
  const keyOf = (P.roundTargets || []).length && ds.outputs && ds.outputs.size ? rowRounds(ds) : null;
  for (const d of keyOf ? P.roundTargets : []) {
    const values = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const o = ds.outputs.get(keyOf(i));
      if (o && Number.isFinite(o[d.key])) values[i] = o[d.key];
    }
    targets.push({ id: d.id, label: d.label, unit: d.unit, kind: "cont", better: d.better, definition: d.definition,
      digits: shownDigits(values, d.digits, "cont"), decimals: recordedDecimals(values), group: null, values,
      source: "profile", diagnostic: true });
  }

  // what each row's round says its test window did (a Limen round log that
  // records the round's execution): needles of its own, and each half of
  // the window (`halves`, two arrays of values) for the needles that have
  // one; and with them, the gates a score resting on trades should pass
  const exOf = P.execution && ds.execution && ds.execution.size ? rowRounds(ds) : null;
  let standingGates = [];
  if (exOf) {
    const spanValues = (pick, key) => {
      const values = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        const s = ds.execution.get(exOf(i));
        const w = s ? pick(s) : null;
        const v = w ? (typeof key === "function" ? key(w) : w[key]) : null;
        if (Number.isFinite(v)) values[i] = v;
      }
      return values;
    };
    for (const d of P.execution.needles) {
      if (targets.some(t => t.id === d.id)) continue;
      const values = spanValues(s => s.whole, d.key);
      if (!values.some(Number.isFinite)) continue;
      targets.push({ id: d.id, label: d.label, unit: d.unit, kind: "cont", better: d.better, definition: d.definition,
        digits: shownDigits(values, d.digits, "cont"), decimals: recordedDecimals(values), group: d.group || null, values,
        source: "profile" });
    }
    for (const t of targets) {
      const key = Object.hasOwn(P.execution.halves, t.id) ? P.execution.halves[t.id] : null;
      if (!key) continue;
      const halves = [0, 1].map(k => spanValues(s => (s.halves ? s.halves[k] : null), key));
      if (halves.every(v => v.some(Number.isFinite))) t.halves = halves;
    }
    standingGates = P.execution.gates;
  }

  // gates
  for (const g of P.gates || []) {
    const pre = `${P.gatesPrefix}${g.id}.`;
    const passCol = ds.cols.get(pre + "pass");
    if (!passCol) continue;
    const pass = new Float64Array(n);
    for (let i = 0; i < n; i++) pass[i] = passCol.codes[i] >= 0 ? passCol.codes[i] : NaN;
    const value = new Float64Array(n).fill(NaN);
    const margin = g.margin ? new Float64Array(n).fill(NaN) : null;
    let detail = null;
    if (g.pair) {
      const a = ds.cols.get(pre + "v.0"), b = ds.cols.get(pre + "v.1");
      if (a && b) for (let i = 0; i < n; i++) {
        if (a.state[i] === 0 && b.state[i] === 0 && b.vals[i] !== 0) value[i] = a.vals[i] / b.vals[i];
      }
    } else {
      const vc = ds.cols.get(pre + "v");
      if (vc && vc.kind === "num") {
        for (let i = 0; i < n; i++) if (vc.state[i] === 0) value[i] = vc.vals[i];
      } else if (vc && (vc.kind === "str" || vc.kind === "json") && g.parse) {
        const parsed = vc.levels.map(t => g.parse(vc.kind === "json" ? JSON.parse(t) : t));
        detail = parsed;
        for (let i = 0; i < n; i++) {
          const c = vc.codes[i];
          if (c >= 0 && parsed[c]) value[i] = parsed[c].value;
        }
      }
    }
    if (margin) {
      const vc = ds.cols.get(pre + "v");
      for (let i = 0; i < n; i++) {
        if (Number.isNaN(value[i])) continue;
        if (detail && vc) { const p = detail[vc.codes[i]]; margin[i] = p ? g.margin(p) : NaN; }
        else margin[i] = g.margin(value[i]);
      }
    }
    gates.push({ ...g, pass, value, margin });
    targets.push({ id: `gate:${g.id}`, label: `${g.label}`, unit: "share of rows passing", kind: "binary",
      better: 1, values: pass, gate: g.id, source: "profile", definition: `gate ${g.id}: ${g.need}` });
  }

  // invariants that apply to this data
  const invariants = (P.invariants || []).filter(v => v.cols.every(c => ds.cols.has(c)));

  return {
    profile, n, fields, dims, dimById, targets, targetById: new Map(targets.map(t => [t.id, t])),
    gates, families, invariants, standingGates,
    // the runner's ranking, when every key of it is a measured target
    objective: P.objective && P.objective.every(([c]) => targets.some(t => t.id === c)) ? P.objective : null,
    objectiveLabel: P.objectiveLabel || null,
    defaultTarget: P.defaultTarget && targets.some(t => t.id === P.defaultTarget) ? P.defaultTarget
      : (targets[0] ? targets[0].id : null),
  };
}
