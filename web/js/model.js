// What views compute from the model, cached on the model's key.

import { moderatorTests, moderatorSummaries, summarize, cramersV, recordCurve, topRows, board } from "./engine.js";

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

// Moderators for the board, computed in slices so the page stays
// responsive; `done` is called once they are in.
export function ensureModerators(m, done) {
  const c = m.cache;
  if (c.modsKey === c.key && c.mods) return c.mods;
  if (c.modsPending === c.key) return null;
  const key = c.key;
  c.modsPending = key;
  const dims = boardDims(m.schema).concat(memberDims(m.schema));
  const parents = moderatorParents(m.schema);
  const base = summarize(m.target, m.rows);
  const tests = [];
  let i = 0;
  const step = () => {
    if (c.key !== key) { if (c.modsPending === key) c.modsPending = null; return; }
    const t0 = performance.now();
    while (i < dims.length && performance.now() - t0 < 12) {
      tests.push(...moderatorTests(m.schema, dims[i], m.target, m.rows, parents, base));
      i++;
    }
    if (i < dims.length) { setTimeout(step, 0); return; }
    c.mods = moderatorSummaries(m.schema, tests, dims, m.target, m.rows);
    c.modsKey = key;
    c.modsPending = null;
    done();
  };
  setTimeout(step, 0);
  return null;
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
