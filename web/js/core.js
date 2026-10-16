// Shared state and analysis model for the page and headless clients.

import { buildSchema } from "./schema.js";
import { limenProfile } from "./profiles.js";
import { rowsIn, summarize, board, boardOrder } from "./engine.js";
import { boardDims } from "./model.js";
import { applyGates } from "./gates.js";
import { halfTargets, twice, firstHalfOnly } from "./halves.js";

export const DEFAULT_STATE = {
  run: null, view: "board", target: null, context: [], pocket: [], pocketB: null,
  sel: null, edge: null, show: { flat: true }, pair: null, order: 2, featSort: "effect",
  trialSort: null, trialCols: ["movers", "halves"], gates: [], clusters: [], compare: false, clusterK: null, firstHalf: false, found: null,
};

export function encodeState(st) {
  const o = { v: st.view, r: st.run, t: st.target, c: st.context, p: st.pocket, pb: st.pocketB, s: st.sel, e: st.edge, pr: st.pair, po: st.order, sh: st.show, fs: st.featSort, tc: st.trialCols, ts: st.trialSort, g: st.gates,
    cl: st.clusters, cm: st.compare, ck: st.clusterK, fh: st.firstHalf ? 1 : undefined, fo: st.found || undefined };
  const json = JSON.stringify(o);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return "s1." + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeState(hash) {
  const m = /^#?s1\.([A-Za-z0-9_-]+)$/.exec(hash || "");
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const o = JSON.parse(new TextDecoder().decode(bytes));
    return { ...DEFAULT_STATE, view: o.v, run: o.r, target: o.t, context: o.c || [], pocket: o.p || [], pocketB: Array.isArray(o.pb) ? o.pb : null, sel: o.s || null,
      edge: o.e ?? null, pair: o.pr || null, order: o.po || 2, show: o.sh || DEFAULT_STATE.show, featSort: o.fs || "effect",
      trialSort: o.ts && typeof o.ts.key === "string" && [1, -1].includes(o.ts.dir) ? { key: o.ts.key, dir: o.ts.dir } : null,
      trialCols: Array.isArray(o.tc) ? o.tc : DEFAULT_STATE.trialCols, gates: Array.isArray(o.g) ? o.g : [],
      clusters: Array.isArray(o.cl) ? o.cl : [], compare: !!o.cm, clusterK: Number.isInteger(o.ck) ? o.ck : null, firstHalf: o.fh === 1,
      found: o.fo === "first" || o.fo === "whole" ? o.fo : null };
  } catch (err) {
    console.warn("ignoring an address that is not a Grid view", err);
    return null;
  }
}

export const NO_NEEDLE = { id: "none", label: "Needle", kind: "cont", unit: "", better: 0, digits: 2, values: new Float64Array(0) };

export function createModel(sweep, st, c = {}, { effects = true } = {}) {
  const ds = sweep.runs.find(r => r.id === st.run) || sweep.runs[0];
  if (!ds) throw new Error("no run is loaded");
  if (c.ds !== ds || c.version !== ds.version) {
    c.ds = ds; c.version = ds.version;
    // a Limen run says what its columns are; other runs are matched to a
    // known profile or inferred
    const exp = ds.meta.experiment;
    c.schema = buildSchema(ds, exp && exp.kind === "limen" ? { profile: limenProfile(exp) } : {});
    c.key = null; c.indep = null;  // background results (mods, pairs) refresh on their own
    c.gatedKey = null;
  }
  // read on the first half of the test window only, when set
  const half = st.firstHalf ? "first" : "";
  if (c.halfKey !== half || c.halfOf !== c.schema) {
    c.read = half ? firstHalfOnly(c.schema) : c.schema;
    c.halfKey = half; c.halfOf = c.schema; c.gatedKey = null;
  }
  // the gates set here, on the schema as read: gates, and needles of their own
  const gatesKey = JSON.stringify(st.gates);
  if (c.gatedKey !== gatesKey) { c.gated = applyGates(c.read, st.gates); c.gatedKey = gatesKey; }
  const schema = c.gated;
  let targetId = st.target && schema.targetById.has(st.target) ? st.target : schema.defaultTarget;
  // a run with no row yet (one that has just started over) has no needle
  // to measure: a stand-in with no values, so every view can say so
  const target = schema.targetById.get(targetId) || NO_NEEDLE;
  const edge = st.edge === null ? ds.n : Math.min(st.edge, ds.n);
  const ctx = (st.context || []).filter(cnd => schema.dimById.has(cnd.dim));
  // a gate's needle changes with its need: its revision is part of the question
  const rev = target.rev || "";
  const key = `${ds.id}|${ds.version}|${targetId}|${rev}|${edge}|${JSON.stringify(ctx)}|${half}`;
  // the same question, whatever rows have arrived since
  c.akey = `${ds.id}|${ds.meta.generation}|${targetId}|${rev}|${st.edge === null ? "latest" : edge}|${JSON.stringify(ctx)}|${half}`;
  // the same rows, whatever the needle (the clusters do not read it, but
  // read their outcomes on the half read)
  c.rkey = `${ds.id}|${ds.meta.generation}|${st.edge === null ? "latest" : edge}|${JSON.stringify(ctx)}|${half}`;
  if (c.key !== key) {
    c.key = key;
    c.rows = rowsIn(schema, ctx, edge);
    c.allRows = rowsIn(schema, [], edge);
    c.base = summarize(target, c.rows);
    c.board = null; c.order = [];
    c.record = null;
  }
  if (effects && !c.board) {
    const dims = boardDims(schema);
    c.board = board(schema, target, c.rows, dims);
    // a needle measured on each half of the test window (a Limen run that
    // recorded its execution): an effect counts only when it shows in both
    const halves = halfTargets(target);
    if (halves) twice(c.board, halves.map(ht => board(schema, ht, c.rows, dims)));
    c.order = boardOrder(c.board.effects);
  }
  return { sweep, ds, schema, target, edge, rows: c.rows, allRows: c.allRows, base: c.base,
    board: c.board, order: c.order, state: st, context: ctx, cache: c };
}
