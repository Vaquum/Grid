// Gates set here: a need on a needle (net PnL per bar above 0 bps, entries
// at least 30). Each becomes a gate like the runner's, with its pass as a
// needle of its own; once one is set, two more needles say whether a row
// passes every gate set here and how many it passes, so the board can say
// what moves them.

import { fmtT } from "./ui.js";
import { shownDigits } from "./schema.js";

export const OPS = {
  ">=": { sym: "≥", word: "at least", test: (v, x) => v >= x },
  ">": { sym: ">", word: "above", test: (v, x) => v > x },
  "<=": { sym: "≤", word: "at most", test: (v, x) => v <= x },
  "<": { sym: "<", word: "below", test: (v, x) => v < x },
};

// A need as written: its number with exactly the decimals it was given,
// in the needle's unit.
export function needText(t, x) {
  const decimals = Math.min(6, (String(Math.abs(x)).split(".")[1] || "").length);
  return fmtT({ kind: "cont", unit: t.unit || "" }, x, { digits: decimals });
}

export function gateLabel(t, def) {
  return `${t.label} ${OPS[def.op].sym} ${needText(t, def.value)}`;
}

// The needles a gate can be set on: measured values, not a rate or a gate.
export function gateable(t) {
  return t.kind !== "binary" && !t.gateSet;
}

// A field of a gate as it was set. The page's address can hold any JSON
// there (an object whose toString is not a function, say), so nothing is
// assumed of it: anything but a plain value is written as its JSON.
export function asSet(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  return v === undefined ? "nothing" : JSON.stringify(v);
}

// Why a gate's definition cannot be read against these targets, or null.
function gateProblem(def, targetById) {
  if (!def || typeof def !== "object" || Array.isArray(def)) return "it is not a gate";
  if (typeof def.id !== "string" || !def.id) return "it has no name";
  if (typeof def.op !== "string" || !Object.hasOwn(OPS, def.op)) return `no comparison ${asSet(def.op)}`;
  if (typeof def.value !== "number" || !Number.isFinite(def.value)) return "its need is not a number";
  const t = typeof def.target === "string" ? targetById.get(def.target) : null;
  if (!t) return `this run has no needle ${asSet(def.target)}`;
  if (!gateable(t)) return `${t.label} is ${t.kind === "binary" ? "a rate" : "a gate"}, not a value to set a need on`;
  return null;
}

// A need on a needle as a gate, and its pass as a needle `gate:<id>`.
function needGate(t, def, n, source) {
  const { test, word } = OPS[def.op];
  const sign = def.op[0] === ">" ? 1 : -1;
  const pass = new Float64Array(n), margin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = t.values[i];
    pass[i] = v === v ? (test(v, def.value) ? 1 : 0) : NaN;
    margin[i] = v === v ? sign * (v - def.value) : NaN;
  }
  const label = gateLabel(t, def);
  const need = `${word} ${needText(t, def.value)}`;
  return {
    gate: { id: def.id, label, need, unit: t.unit, needAt: def.value, pass, value: t.values, margin, set: source === "set", standing: source === "profile", def, target: t },
    target: { id: `gate:${def.id}`, label, unit: "share of rows passing", kind: "binary", better: 1, values: pass,
      gate: def.id, gateSet: true, source, definition: `${t.label} ${need}`, rev: JSON.stringify(def) },
  };
}

// The schema with the gates its profile stands by (`standingGates`: a
// Limen run's trades, where it recorded them), beside the runner's, and
// the gates set here: each a gate (the runner's first, then the
// profile's), a needle `gate:<id>`, and with any set here, `gates:all`
// and `gates:count`. A definition that cannot be read is kept in
// `gateProblems` with its reason.
export function applyGates(schema, defs) {
  const n = schema.n;
  const standing = [], gates = [], targets = [], gateProblems = [];
  for (const def of schema.standingGates || []) {
    const t = schema.targetById.get(def.target);
    if (!t) continue;
    const g = needGate(t, def, n, "profile");
    standing.push(g.gate);
    targets.push(g.target);
  }
  const runner = schema.gates.length > 0 || standing.length > 0;
  const taken = new Set(standing.map(g => g.id));
  for (const def of defs) {
    const why = gateProblem(def, schema.targetById) || (taken.has(def.id) ? `${asSet(def.id)} names a gate this run has` : null);
    if (why) { gateProblems.push({ def, why }); continue; }
    const g = needGate(schema.targetById.get(def.target), def, n, "set");
    gates.push(g.gate);
    targets.push(g.target);
  }
  if (gates.length) {
    const all = new Float64Array(n), count = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // a row fails every gate it fails; it passes them all only when each
      // has a value and passes
      let failed = false, unknown = false, k = 0;
      for (const g of gates) {
        const p = g.pass[i];
        if (p === 1) k++;
        else if (p === 0) failed = true;
        else unknown = true;
      }
      all[i] = failed ? 0 : unknown ? NaN : 1;
      count[i] = k;
    }
    const here = runner ? " set here" : "";
    const rev = JSON.stringify(gates.map(g => g.def));
    const list = gates.map(g => g.label).join("; ");
    targets.push({ id: "gates:all", label: `Passes every gate${here}`, unit: "share of rows", kind: "binary", better: 1, values: all,
      gate: "all", gateSet: true, source: "set", definition: `every one of: ${list}`, rev });
    targets.push({ id: "gates:count", label: runner ? "Gates set here, passed" : "Gates passed", unit: `of ${gates.length}`, kind: "ordinal",
      better: 1, values: count, digits: shownDigits(count, 0, "ordinal"), decimals: 0, gate: "count", gateSet: true, source: "set",
      definition: `how many of these a row passes: ${list}`, rev });
  }
  const allTargets = [...schema.targets, ...targets];
  return { ...schema, gates: [...schema.gates, ...standing, ...gates], targets: allTargets, targetById: new Map(allTargets.map(t => [t.id, t])),
    gatesSet: gates, gatesStanding: standing, gateProblems };
}

// The next free id for a gate set here.
export function nextGateId(defs, schema) {
  const taken = new Set([...defs.map(d => d && d.id), ...schema.gates.map(g => g.id)]);
  let k = 1;
  while (taken.has(`g${k}`)) k++;
  return `g${k}`;
}
