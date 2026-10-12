// Headless queries use the same model and view calculations as the page.
import { decodePack, rowObject } from "./pack.js";
import { DEFAULT_STATE, createModel, encodeState } from "./core.js";
import { MIN_N, pocketStats, blockTests, suggestions, comboEffect, moderatorScan, gateStats, strongestCorrelate, uniformity } from "./engine.js";
import { boardDims, memberDims, moderatorParents, bestRows, independence, records } from "./model.js";
import { pairsJob, comboPlan, comboJob } from "./view-pairs.js";
import { limenFeatures, memberSets } from "./view-features.js";
import { readTogether } from "./view-gates.js";
import { runHealth, runLog, selectionOf, shownGroups, cardOutcomes, sortedVals, testOf, apartOf, reliabilityOf, marketHalves } from "./view-run.js";
import { clusterRows } from "./clusters.js";
import { rankAt, bhQ } from "./stats.js";
import { heldBack } from "./outputs.js";
import { needleReadsWhole, choiceFound } from "./halves.js";
import { narrowManifest, mergeConditions } from "./manifest.js";
import { gateReads, poolOf, rankedOf, membersOf, touchedBy } from "./view-cohort.js";

export const ANALYSES = ["schema", "board", "pocket", "pairs", "features", "trials", "gates", "run", "cohort", "manifest"];
const QUERY_STATE_KEYS = new Set(["run", "view", "target", "context", "pocket", "pocketB", "edge", "gates", "firstHalf", "found", "clusters", "compare", "clusterK", "pair", "order"]);

function queryFail(message) { throw new Error(message); }
function drainQuery(job) { let step; do { step = job.next(); } while (!step.done); return step.value; }
function queryInteger(value, fallback, lo, hi, name) {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < lo || v > hi) queryFail(`${name} is an integer from ${lo} to ${hi}`);
  return v;
}

export function describeTarget(t) {
  return Object.fromEntries(["id", "label", "kind", "unit", "better", "digits", "decimals", "definition", "inferred", "diagnostic", "cost", "group"].filter(k => t[k] !== undefined).map(k => [k, t[k]]));
}

export function rowReference(m, i) {
  const row = rowObject(m.ds, i);
  return { run: m.ds.id, generation: m.ds.meta.generation, instance: m.sweep.meta.agentInstance, i, roundId: row.id ?? null, shard: row.shard ?? null };
}

// Typed arrays and model internals never become implicit million-row outputs.
export function portableQuery(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, portableQuery(v)]));
  if (value instanceof Set) return [...value].map(portableQuery);
  if (ArrayBuffer.isView(value)) return Array.from(value, portableQuery);
  if (Array.isArray(value)) return value.map(portableQuery);
  const skip = new Set(["codes", "pass", "labelOf", "perRow"]);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (skip.has(k) || typeof v === "function") continue;
    if (["values", "value"].includes(k) && ArrayBuffer.isView(v)) continue;
    if (["target", "t"].includes(k) && v && v.values) { out[k] = describeTarget(v); continue; }
    if (k === "rows" && (Array.isArray(v) || ArrayBuffer.isView(v))) { out.rowCount = v.length; continue; }
    out[k] = portableQuery(v);
  }
  // Match the page's floor: retain support, withhold unsupported estimates.
  if (typeof out.n === "number" && out.n < MIN_N) {
    out.withheld = true;
    for (const k of ["mean", "lo", "hi", "lift", "delta", "keep"]) if (k in out) out[k] = null;
  }
  return out;
}

function checkConditions(conditions, schema, name) {
  if (!Array.isArray(conditions)) queryFail(`${name} is a list of conditions`);
  const seen = new Set();
  for (const c of conditions) {
    if (!c || typeof c.dim !== "string" || !Array.isArray(c.keys) || !c.keys.length) queryFail(`${name} conditions name a dim and nonempty keys`);
    const d = schema.dimById.get(c.dim);
    if (!d || seen.has(c.dim)) queryFail(`unknown or repeated dimension ${c.dim}`);
    seen.add(c.dim);
    for (const key of c.keys) if (!d.levels.some(l => l.key === key)) queryFail(`unknown level ${JSON.stringify(key)} of ${c.dim}`);
  }
}

function queryManifest(m) {
  const exp = m.ds.meta.experiment;
  if (!exp || !exp.manifestText) return { available: false, reason: "run has no recorded manifest" };
  const params = exp.manifest?.sfd?.params || {};
  const narrow = mergeConditions(m.context, m.state.pocket).map(c => {
    const d = m.schema.dimById.get(c.dim);
    return { param: d.column || d.id, values: c.keys.map(k => d.levels.find(l => l.key === k)?.value) };
  });
  const r = narrowManifest(exp.manifestText, params, narrow);
  return { available: true, text: r.lines.join("\n"), changed: r.changed, problems: r.problems, before: r.before, after: r.after };
}

export function analyzePack(pack, args = {}) {
  if (!ANALYSES.includes(args.analysis)) queryFail(`analysis is one of ${ANALYSES.join(", ")}`);
  const sweep = decodePack(pack);
  const given = args.state ?? {};
  if (!given || Array.isArray(given) || typeof given !== "object") queryFail("state is an object");
  for (const k of Object.keys(given)) if (!QUERY_STATE_KEYS.has(k)) queryFail(`unknown state field ${k}`);
  const state = { ...DEFAULT_STATE, ...given };
  const ds = state.run ? sweep.runs.find(r => r.id === state.run) : sweep.runs[0];
  if (!ds) queryFail("unknown run or no run is loaded");
  state.run = ds.id;
  if (args.generation !== undefined && args.generation !== ds.meta.generation) queryFail("stale run generation; query the run again");
  state.edge = queryInteger(state.edge, ds.n, 0, ds.n, "edge");
  for (const k of ["firstHalf", "compare"]) if (typeof state[k] !== "boolean") queryFail(`${k} is boolean`);
  if (!Array.isArray(state.gates)) queryFail("gates is a list");
  state.order = queryInteger(state.order, 2, 2, 6, "order");
  if (state.clusterK !== null) state.clusterK = queryInteger(state.clusterK, null, 2, 7, "clusterK");
  if (!Array.isArray(state.clusters) || state.clusters.some(x => typeof x !== "string")) queryFail("clusters is a list of IDs");
  const m = createModel(sweep, state);
  for (const k of ["context", "pocket"]) checkConditions(state[k], m.schema, k);
  if (state.pocketB !== null) checkConditions(state.pocketB, m.schema, "pocketB");
  if (state.target && !m.schema.targetById.has(state.target)) queryFail(`unknown target ${state.target}`);
  if (m.schema.gateProblems?.length) queryFail(m.schema.gateProblems.map(x => x.why).join("; "));
  state.target = m.target.id;
  state.view = ANALYSES.includes(args.analysis) && !["schema", "manifest"].includes(args.analysis) ? args.analysis : "pocket";
  state.found = choiceFound(given.found ? given : null, state, needleReadsWhole(m.cache.schema, state));
  const limit = queryInteger(args.limit, 100, 1, 1000, "limit");
  const offset = queryInteger(args.offset, 0, 0, ds.n, "offset");
  let result;
  switch (args.analysis) {
    case "schema":
      result = { profile: m.schema.profile?.id ?? null, fields: m.schema.fields,
        dimensions: m.schema.dims.map(d => ({ id: d.id, label: d.label, role: d.role, kind: d.kind, levels: d.levels })),
        targets: m.schema.targets.map(describeTarget), objective: m.schema.objective, gates: m.schema.gates.map(g => ({ id: g.id, label: g.label, need: g.need, definition: g.def })) };
      break;
    case "board":
      result = { ...m.board, effects: m.order, moderators: moderatorScan(m.schema, boardDims(m.schema).concat(memberDims(m.schema)), m.target, m.rows, moderatorParents(m.schema)) };
      break;
    case "pocket": {
      const p = pocketStats(m.schema, state.pocket, m.target, m.rows, m.edge);
      result = { ...p, blocks: blockTests(m.schema, state.pocket, m.target, m.rows, m.edge, p.rows), suggestions: suggestions(m.schema, boardDims(m.schema), m.target, p.rows, p.base),
        comparison: state.pocketB === null ? null : pocketStats(m.schema, state.pocketB, m.target, m.rows, m.edge), manifest: queryManifest(m) };
      break;
    }
    case "pairs": {
      const pairs = drainQuery(pairsJob(m));
      const plan = state.order > 2 ? comboPlan(m, state.order, pairs) : null;
      const sets = plan ? drainQuery(comboJob(m, plan)) : null;
      let detail = null;
      if (state.pair !== null) {
        if (!Array.isArray(state.pair) || state.pair.length !== state.order || new Set(state.pair).size !== state.order || state.pair.some(id => !m.schema.dimById.has(id))) queryFail("pair names distinct known dimensions of the chosen order");
        detail = comboEffect(state.pair.map(id => m.schema.dimById.get(id)), m.target, m.rows, m.base, 5, true);
      }
      result = { pairs, plan, sets, detail };
      break;
    }
    case "features": result = { limen: limenFeatures(m), sets: memberSets(m) }; break;
    case "trials": {
      const ranked = bestRows(m);
      result = ranked ? { ...ranked, list: ranked.list.slice(offset, offset + limit).map(x => ({ ...x, reference: rowReference(m, x.i), parameters: Object.fromEntries(m.schema.fields.filter(f => ["param", "set", "nested", "fixed", "effective"].includes(f.role)).map(f => [f.name, ds.col(f.name)?.value(x.i)])), outcomes: m.schema.targets.map(t => ({ target: describeTarget(t), value: t.values[x.i] })) })), limit: 100, offset } : { available: false, reason: "run has no declared objective" };
      break;
    }
    case "gates":
      result = { gates: gateStats(m.schema, m.rows).map(g => ({ ...g, correlate: strongestCorrelate(m.schema, m.schema.gates.find(x => x.id === g.id).value, m.rows) })), together: readTogether(m) };
      break;
    case "run": {
      const clusters = clusterRows(m.schema, m.rows, { n: ds.n, k: state.clusterK });
      if (state.clusters.some(id => !clusters.clusters.some(c => c.id === id))) queryFail("unknown cluster; query clusters on this snapshot first");
      const sel = selectionOf(m, clusters), groups = shownGroups(m, sel);
      const outs = cardOutcomes(m, clusters), drawn = new Set(clusters.clusters.length ? clusters.outcomes.map(o => o.t.id) : []);
      const tests = outs.map(t => sel.mode === "whole" || drawn.has(t.id) ? null : testOf(t, sel, m));
      const q = bhQ(tests.map(x => x?.p ?? NaN));
      result = { health: runHealth(m), log: runLog(m), clusters, selection: sel.mode,
        composition: clusters.clusters.length ? apartOf(m, clusters, sel) : null,
        distributions: outs.map((t, j) => ({ target: describeTarget(t), drawn: drawn.has(t.id), test: tests[j], q: q[j], groups: groups.map(g => {
          const v = sortedVals(t.values, g.rows);
          return { label: g.label, n: v.length, missing: g.rows.length - v.length, quantiles: [0.05, 0.25, 0.5, 0.75, 0.95].map(f => rankAt(v, f)) };
        }) })), records: records(m), reliability: reliabilityOf(m, m.target), marketHalves: state.firstHalf ? null : marketHalves(m), heldBack: heldBack(ds, m.rows),
        sampler: { independence: independence(m), uniformity: moderatorParents(m.schema).map(d => ({ dim: d.id, ...uniformity(d, m.allRows) })) } };
      break;
    }
    case "cohort": {
      const t = m.target.base || m.target, reads = gateReads(m.schema);
      const pool = poolOf(m.schema, m.rows, state.pocket, m.edge, reads);
      const ranked = rankedOf(t, pool), count = queryInteger(args.members, 5, 1, 100, "members");
      const chosen = membersOf(ranked, count, new Set(), new Set());
      result = { pool: pool.length, ranked: ranked.length, members: chosen.map(i => rowReference(m, i)), warning: touchedBy(t, reads), firstHalfSelection: !!t.halves, gates: reads.map(r => ({ id: r.gate.id, label: r.label, firstHalf: r.firstHalf })), state };
      break;
    }
    case "manifest": result = queryManifest(m); break;
  }
  return portableQuery({ apiVersion: 1, snapshot: { run: ds.id, generation: ds.meta.generation, datasetVersion: ds.version, edge: m.edge, rows: m.rows.length },
    state: Object.fromEntries([...QUERY_STATE_KEYS].map(k => [k, state[k]])), viewLink: `/#${encodeState(state)}`, target: describeTarget(m.target), summary: m.base,
    warnings: needleReadsWhole(m.cache.schema, state) ? ["This target reads the whole window despite firstHalf."] : [], result });
}
