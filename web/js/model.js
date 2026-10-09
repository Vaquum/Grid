// What views compute from the model, cached on the model's key.

import { moderatorTests, moderatorSummaries, summarize, cramersV, recordCurve, topRows, board, rankRows, rowsLikeIt } from "./engine.js";
import { fmtNum } from "./ui.js";

export function boardDims(schema) {
  return schema.dims.filter(d => d.role === "param" && d.kind !== "member");
}

export function memberDims(schema) {
  return schema.dims.filter(d => d.kind === "member");
}

// Parents that may moderate a dim: sampled params with few levels.
export function moderatorParents(schema) {
  return schema.dims.filter(d => d.role === "param" && d.kind !== "member" && d.kind !== "scoped" && d.levels.length >= 2 && d.levels.length <= 12);
}

// Background analyses (moderators, pairs) are computed in slices on a
// snapshot of the rows, so the page stays responsive. A finished result
// stays on screen while new rows arrive (it says how many rows it covers)
// and is refreshed once the rows have grown by 5% or 30 seconds have
// passed; a new target, context or edge starts over at once. `akey` is the
// question the result answers (by default the model's, which includes the
// target; an analysis that does not read the target passes its own).
export function background(m, name, compute, done, akey = m.cache.akey) {
  const c = m.cache;
  const slot = c[name] || (c[name] = { result: null, akey: null, rows: 0, at: 0, running: null });
  const fresh = slot.result && slot.akey === akey;
  const grown = m.rows.length > slot.rows * 1.05 || Date.now() - slot.at > 30000;
  if (slot.running && slot.running.akey !== akey) slot.running.cancelled = true;
  if (slot.running && !slot.running.cancelled) return fresh ? slot.result : null;
  if (fresh && (m.rows.length === slot.rows || !grown)) return slot.result;
  const job = { akey, cancelled: false };
  slot.running = job;
  const steps = compute(m);
  const step = () => {
    if (job.cancelled) return;
    const t0 = performance.now();
    let out;
    while (performance.now() - t0 < 12) { out = steps.next(); if (out.done) break; }
    if (!out.done) { setTimeout(step, 0); return; }
    slot.result = out.value;
    slot.akey = job.akey;
    slot.rows = m.rows.length;
    slot.at = Date.now();
    slot.running = null;
    done();
  };
  setTimeout(step, 0);
  return fresh ? slot.result : null;
}

function* moderatorJob(m) {
  const dims = boardDims(m.schema).concat(memberDims(m.schema));
  const parents = moderatorParents(m.schema);
  const base = summarize(m.target, m.rows);
  const tests = [];
  for (const d of dims) {
    tests.push(...moderatorTests(m.schema, d, m.target, m.rows, parents, base));
    yield;
  }
  const res = moderatorSummaries(m.schema, tests, dims, m.target, m.rows);
  res.rows = m.rows.length;
  return res;
}

export function ensureModerators(m, done) {
  return background(m, "mods", moderatorJob, done);
}

// Two or more parameters named in one order wherever they show together:
// the board's, the strongest first (`ids` of dims; names joined by ×).
export function setName(m, ids) {
  const at = new Map(m.order.map((e, i) => [e.dim, i]));
  return ids.slice().sort((a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity) || String(a).localeCompare(String(b)))
    .map(id => (m.schema.dimById.get(id) || { label: id }).label).join(" × ");
}

// Two parameters the sampler did not draw independently: said one way
// wherever it shows (the board's tag, the inspector, Pairs, the Run's
// sampler), as "drawn together", in the warning colour.
export const TOGETHER = "drawn together";
export function together(p, V) {
  return p < 1e-6 && V > 0.03;
}
export function togetherWhy(V) {
  return `The sampler drew them together (Cramér's V ${fmtNum(V, 3)}), so each one's effect carries some of the other's: read one inside the other's values.`;
}

// Sampler independence: Cramér's V of every pair of sampled params.
export function independence(m) {
  const c = m.cache;
  if (c.indep && c.indepKey === c.key) return c.indep;
  const dims = moderatorParents(m.schema);
  const pairs = [];
  for (let a = 0; a < dims.length; a++) for (let b = a + 1; b < dims.length; b++) {
    const v = cramersV(dims[a], dims[b], m.allRows);
    if (Number.isFinite(v.V)) pairs.push({ a: dims[a].id, b: dims[b].id, ...v });
  }
  c.indep = pairs;
  c.indepKey = c.key;
  return pairs;
}

export function objectiveTop(m, rows, k) {
  if (!m.schema.objective) return [];
  const keys = m.schema.objective.map(([col, dir]) => {
    const t = m.schema.targetById.get(col);
    const v = t ? t.values : null;
    return [i => (v ? v[i] : NaN), -dir];
  });
  return topRows(rows, keys, k);
}

// The runner's objective as ranking keys: each key's target and whether
// higher is better.
export function objectiveKeys(m) {
  const sc = m.schema;
  if (!sc.objective) return null;
  return sc.objective.map(([col, dir]) => ({ t: sc.targetById.get(col), better: -dir }));
}

// The best rows in view by the objective, ranked with their ties (engine
// rankRows), and for each, the rows like it on the needle: the other rows
// sharing its values of the parameters that move the needle.
export const BEST_LIMIT = 100;
export function bestRows(m) {
  const c = m.cache;
  if (c.best && c.bestKey === c.key) return c.best;
  const keys = objectiveKeys(m);
  if (!keys) return null;
  const ranked = rankRows(m.rows, keys.map(({ t, better }) => [i => t.values[i], better]), BEST_LIMIT);
  const movers = m.order.filter(e => e.detectable).map(e => m.schema.dimById.get(e.dim));
  const like = rowsLikeIt(movers, m.target, m.rows, ranked.list.map(x => x.i));
  ranked.list.forEach((x, k) => { x.like = like[k]; });
  ranked.movers = movers;
  c.best = ranked;
  c.bestKey = c.key;
  return ranked;
}

export function records(m) {
  const c = m.cache;
  if (c.record && c.recordKey === c.key) return c.record;
  c.record = recordCurve(m.target, m.allRows);
  c.recordKey = c.key;
  return c.record;
}


// Set members on one board of their own: their q-values are corrected
// across the members (the Features view's family of tests).
export function memberBoard(m) {
  const c = m.cache;
  if (c.memberBoard && c.memberBoardKey === c.key) return c.memberBoard;
  c.memberBoard = board(m.schema, m.target, m.rows, memberDims(m.schema));
  c.memberBoardKey = c.key;
  return c.memberBoard;
}

// A dim's effect with its corrected q, from the board it belongs to.
export function effectOf(m, dimId) {
  const e = m.board.effects.find(x => x.dim === dimId);
  if (e) return { effect: e, tests: m.board.tests, family: "parameters" };
  const mb = memberBoard(m);
  const me = mb.effects.find(x => x.dim === dimId);
  if (me) return { effect: me, tests: mb.tests, family: "members of its set" };
  return null;
}
