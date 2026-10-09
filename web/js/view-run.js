// Run: the whole run on one page. The strip says what matters: the rows
// (of those planned, and their pace while live), the needle, the best row
// against luck, the clusters, and anything broken. Then the rows' clusters
// as toggles; each outcome's distribution, for every row, for the
// clusters chosen against every row, or for two clusters against each
// other; what sets the chosen rows apart (the parameters that put rows
// there); the best row against luck; and the run's health: its pace and
// segments, its problems and warnings, and the sampler.

import { h, icon, tip, fmtT, fmtInt, fmtPct, fmtP, fmtNum, fmtDuration, fmtAgo, inText, rangeText } from "./ui.js";
import { strip, stripCell, about } from "./strip.js";
import { lineChart, distChart, quantile } from "./charts.js";
import { invariantBreaks, recordCurve, uniformity, summarize, rowsIn, gTest, MIN_N } from "./engine.js";
import { buildSchema } from "./schema.js";
import { independence, moderatorParents, boardDims, background } from "./model.js";
import { clusterJob, clusterOutcomes, mannWhitney, composition, MIN_SILHOUETTE } from "./clusters.js";
import { bhQ } from "./stats.js";

// The log a run's runner writes.
export function runLog(m) {
  const id = m.ds.meta.logId;
  return id ? m.sweep.logs[id] || null : null;
}

// The log segment a run's rows came from: its own, or the latest.
export function segmentOf(m) {
  const log = runLog(m);
  if (!log || !log.segments.length) return null;
  const want = m.ds.meta.segment;
  if (want !== null && want !== undefined) return log.segments.find(s => s.index === want) || null;
  return log.segments[log.segments.length - 1];
}

// Rows per second now. The runner's own progress lines carry its elapsed
// seconds, so they are used whenever the run has a log; arrival times are
// the server's read times, which bunch up while it catches up with a file,
// so they are used only when there is no log.
export function runRate(m) {
  const ds = m.ds;
  const seg = segmentOf(m);
  if (seg && seg.progress.length >= 2) {
    const p = seg.progress.filter(x => x[2] !== null);
    if (p.length >= 2) {
      const a = p[Math.max(0, p.length - 11)], b = p[p.length - 1];
      if (b[2] > a[2]) return { rowsPerSec: (b[1] - a[1]) / (b[2] - a[2]), from: "log" };
    }
  }
  if (m.state.edge === null) {
    const t = ds.arrivals;
    let last = NaN, first = NaN, k = 0;
    for (let i = ds.n - 1; i >= 0; i--) {
      if (!Number.isFinite(t[i])) break;
      if (Number.isNaN(last)) last = t[i];
      if (last - t[i] > 300) break;
      first = t[i];
      k++;
    }
    if (k >= 10 && last - first >= 10) return { rowsPerSec: (k - 1) / (last - first), from: "arrivals" };
  }
  return null;
}

export function runHealth(m) {
  const ds = m.ds;
  const seg = segmentOf(m);
  // the rows planned: the log's start line, or the experiment's manifest
  const planned = m.schema.profile && m.schema.profile.planned;
  const total = seg && seg.total ? seg.total : planned || null;
  const rate = runRate(m);
  const parts = [`${fmtInt(m.edge)} rows`];
  if (total) parts.push(`${fmtPct(m.edge / total, m.edge / total < 0.1 ? 1 : 0)} of ${fmtInt(total)}`);
  const recorded = m.sweep.meta.mode !== "live";
  if (rate && ds.meta.live && m.state.edge === null) {
    parts.push(`${rate.rowsPerSec.toFixed(1)} rows/s${recorded ? " when recorded" : ""}`);
    if (total && total > ds.n && !recorded) parts.push(`${fmtDuration((total - ds.n) / rate.rowsPerSec)} to go`);
  }
  const problems = problemList(m);
  return { line: parts.join(" · "), issues: problems.filter(p => p.sev === "crit").length, problems, rate, total, seg };
}

// Everything broken, once: crashes, a traceback being written, broken
// invariants, lines that are not rows, and fields that changed late.
function problemList(m) {
  const ds = m.ds, log = runLog(m), out = [], c = m.cache;
  if (log) for (const cr of log.crashes) out.push({ sev: "crit", kind: "crash", c: cr });
  if (log && log.openTraceback) out.push({ sev: "crit", kind: "writing" });
  if (!c.invariants || c.invariants.key !== c.key) {
    c.invariants = { key: c.key, list: m.schema.invariants.map(inv => ({ inv, r: invariantBreaks(ds, inv, m.allRows, 12) })) };
  }
  for (const { inv, r } of c.invariants.list) out.push({ sev: r.count ? "crit" : "ok", kind: "invariant", inv, r });
  if (ds.meta.badCount) out.push({ sev: "crit", kind: "bad" });
  const late = (ds.meta.schemaEvents || []).filter(e => e.event === "kind" || e.row >= 1000);
  if (late.length) out.push({ sev: "warn", kind: "schema", late });
  return out;
}

export function renderRun(view, m, A) {
  view.append(h("h1", { class: "sr", text: "The run" }));
  const health = runHealth(m);
  const res = clustersOf(m, A);
  const sel = selectionOf(m, res);
  view.append(runStrip(m, A, health, res, sel));
  view.append(clusterIsland(m, A, res, sel));
  view.append(distIsland(m, res, sel));
  if (res && res.clusters.length) view.append(apartIsland(m, A, res, sel));
  view.append(h("div", { class: "rn-pair" }, recordIsland(m), paceIsland(m, health)));
  if (m.sweep.runs.length > 1) view.append(runsIsland(m, A));
  view.append(h("div", { class: "rn-pair" }, problemsIsland(m, A, health), samplerIsland(m)));
  const log = runLog(m);
  if (log && log.warnings.length) view.append(warningsIsland(log));
}

// ---------------------------------------------------------------------------
// The clusters and the choice of them

// The rows' clusters, found in the background; null while they are being
// found. A run with no rows has none.
function clustersOf(m, A) {
  if (!m.rows.length) return { clusters: [], reason: "few", scores: [], outcomes: clusterOutcomes(m.schema), left: 0, rows: 0 };
  const k = m.state.clusterK || null;
  return background(m, "clusters", mm => clusterJob(mm.schema, mm.rows, { n: mm.ds.n, k }), () => A.rerender(), `${m.cache.rkey}|k${k || "best"}`);
}

// What the cards show: every row; the chosen clusters (together) against
// every row; or, with Compare and two chosen, the first against the
// second.
function selectionOf(m, res) {
  const have = res ? res.clusters : [];
  const pick = (m.state.clusters || []).map(id => have.find(c => c.id === id)).filter(Boolean);
  const compare = !!m.state.compare;
  if (!pick.length) return { mode: "whole", pick, compare };
  if (compare && pick.length === 2) return { mode: "compare", pick, compare, a: pick[0], b: pick[1] };
  return { mode: "against", pick, compare, rows: unionRows(pick.map(c => c.rows)), label: pick.map(c => c.id).join(" + ") };
}

// The rows of several clusters (which share none), ascending.
function unionRows(lists) {
  if (lists.length === 1) return lists[0];
  const all = new Uint32Array(lists.reduce((a, l) => a + l.length, 0));
  let o = 0;
  for (const l of lists) { all.set(l, o); o += l.length; }
  return all.sort();
}

function toggleCluster(m, A, id) {
  const cur = m.state.clusters || [];
  const next = cur.includes(id) ? cur.filter(x => x !== id)
    : m.state.compare && cur.length >= 2 ? [cur[cur.length - 1], id] : [...cur, id];
  A.set({ clusters: next }, { replace: true });
}

function setCompare(m, A, on) {
  const cur = m.state.clusters || [];
  A.set({ compare: on, clusters: on && cur.length > 2 ? cur.slice(-2) : cur }, { replace: true });
}

// The colours of what the cards show: the chosen rows in blue against
// every row in grey; two clusters compared in the first two categorical
// colours.
function groupsOf(m, sel) {
  if (sel.mode === "compare") {
    return [{ key: "a", label: sel.a.id, rows: sel.a.rows, fill: "var(--cat-1-bar)", ink: "var(--cat-1)" },
      { key: "b", label: sel.b.id, rows: sel.b.rows, fill: "var(--cat-2-bar)", ink: "var(--cat-2)" }];
  }
  if (sel.mode === "against") {
    return [{ key: "sel", label: sel.label, rows: sel.rows, fill: "var(--data-bar)", ink: "var(--data)" },
      { key: "all", label: "All rows", rows: m.rows, fill: "var(--off-bar)", ink: "var(--off)" }];
  }
  return [{ key: "all", label: "All rows", rows: m.rows, fill: "var(--data-bar)", ink: "var(--data)" }];
}

function swatchOf(sel, id) {
  if (sel.mode === "compare") return sel.a.id === id ? "var(--cat-1)" : sel.b.id === id ? "var(--cat-2)" : null;
  return sel.pick.some(c => c.id === id) ? "var(--data)" : null;
}

function whyNone(res) {
  if (res.reason === "flat") return "The outcomes that say what a row did take one value each here: there is nothing to group by.";
  if (res.reason === "weak") {
    return `The rows do not fall into groups: the best grouping (${res.k} clusters) has a silhouette of ${res.silhouette.toFixed(2)}, under ${MIN_SILHOUETTE}, which is no structure, so none is drawn.`;
  }
  return `Too few rows to group: a grouping needs ${fmtInt(2 * MIN_N)} rows and every cluster ${MIN_N}${res.rows ? `; there are ${fmtInt(res.rows)}` : ""}.`;
}

// A cluster in a few words: the outcomes it stands out on, at its median.
function standText(res, c) {
  return c.standsOut.map(so => {
    const t = res.outcomes[so.outcome].t;
    return `${t.label} ${fmtT(t, c.medians[so.outcome])}`;
  }).join(" · ");
}

function clusterIsland(m, A, res, sel) {
  const isl = h("section", { class: "island rn-pick", "aria-label": "Clusters" });
  const head = h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "Clusters" }));
  isl.append(head);
  if (!res) {
    head.append(h("span", { class: "isl-count", text: "being found" }));
    isl.append(h("p", { class: "isl-note", text: "The rows are being grouped by what they did. Until then every card shows every row." }));
    return isl;
  }
  if (!res.clusters.length) {
    head.append(h("span", { class: "isl-count", text: "none" }));
    isl.append(h("p", { class: "isl-note", text: whyNone(res) }));
    return isl;
  }
  const count = h("span", { class: "isl-count num has-tip", text: `${res.k} · silhouette ${res.silhouette.toFixed(2)}, ${res.grade}` });
  tip(count, () => h("div", null, h("b", { text: "How clearly the rows group" }),
    h("div", { text: "The silhouette: how much nearer each row sits to its own cluster than to the next one, from −1 to 1. Over 0.7 is strong structure, 0.51 to 0.7 reasonable, 0.26 to 0.5 weak; under 0.26 no cluster is drawn." }),
    h("div", { class: "k", text: `Drawn on ${res.outcomes.map(o => o.t.label).join(", ")}.` })));
  head.append(count, kPicker(m, A, res), compareToggle(m, A, sel));
  const chips = h("div", { class: "rn-chips", role: "group", "aria-label": "Clusters to show" });
  for (const c of res.clusters) {
    const on = sel.pick.some(x => x.id === c.id);
    const sw = swatchOf(sel, c.id);
    const b = h("button", { class: "rn-chip", type: "button", "aria-pressed": on ? "true" : "false", dataset: { cluster: c.id, focus: `cluster-${c.id}` },
      onclick: () => toggleCluster(m, A, c.id) },
    h("span", { class: "rn-key", style: sw ? { background: sw, color: "var(--surface)", borderColor: sw } : null, text: c.id }),
    h("span", { class: "rn-chip-n num", text: fmtInt(c.n) }),
    h("span", { class: "rn-chip-share num", text: fmtPct(c.share, 0) }),
    h("span", { class: "rn-chip-what", text: standText(res, c) }));
    tip(b, () => h("div", null, h("b", { text: `Cluster ${c.id}: ${fmtInt(c.n)} rows, ${fmtPct(c.share, 1)}` }),
      h("div", null, res.outcomes.map((o, j) => h("div", { class: "k", text: `${o.t.label}: median ${fmtT(o.t, c.medians[j])}` }))),
      h("div", { class: "k", text: on ? "Choose it again to leave it out." : sel.compare ? "Choose it to compare; a third replaces the first." : "Choose it to set it against every row; choose more to set them together." })));
    chips.append(b);
  }
  isl.append(chips);
  const N = m.rows.length;
  const note = sel.mode === "whole"
    ? (sel.compare ? "Compare is on: choose two clusters to set against each other." : "Every card shows every row. Choose clusters to set them against every row, or turn on Compare and choose two.")
    : sel.mode === "compare" ? `${sel.a.id} (${fmtInt(sel.a.n)} rows) against ${sel.b.id} (${fmtInt(sel.b.n)} rows).`
      : `${sel.label}: ${fmtInt(sel.rows.length)} rows, ${fmtPct(sel.rows.length / N, 1)}, against all ${fmtInt(N)}.${sel.compare ? " Compare is on: choose a second cluster." : ""}`;
  isl.append(h("p", { class: "isl-note", text: note + (res.left ? ` ${fmtInt(res.left)} rows have too few outcomes to place and are in no cluster.` : "")
    + (res.rows < N ? ` The clusters cover the first ${fmtInt(res.rows)} rows; the newer ones join when they are found again.` : "") }));
  return isl;
}

// The number of clusters: the best by silhouette, or another with
// structure, each with its silhouette.
function kPicker(m, A, res) {
  const seg = h("div", { class: "seg rn-k", role: "group", "aria-label": "Number of clusters" });
  for (const s of res.scores) {
    const b = h("button", { type: "button", "aria-pressed": s.k === res.k ? "true" : "false", "aria-disabled": s.usable ? null : "true",
      dataset: { k: String(s.k), focus: `k-${s.k}` },
      onclick: () => { if (s.usable && s.k !== res.k) A.set({ clusterK: s.k === res.best ? null : s.k, clusters: [] }, { replace: true }); } }, String(s.k));
    tip(b, () => h("div", null, h("b", { text: `${s.k} clusters${s.k === res.best ? ", the best" : ""}` }),
      h("div", { class: "k", text: !s.valid ? "A cluster would hold fewer than 30 rows." : `Silhouette ${s.silhouette.toFixed(2)}${s.usable ? "" : ": no structure"}.` })));
    seg.append(b);
  }
  return seg;
}

function compareToggle(m, A, sel) {
  const b = h("button", { class: "btn small rn-compare", type: "button", "aria-pressed": sel.compare ? "true" : "false", dataset: { focus: "compare" },
    onclick: () => setCompare(m, A, !sel.compare) }, "Compare two");
  tip(b, () => h("div", null, h("b", { text: "Set two clusters against each other" }),
    h("div", { class: "k", text: "With it on, choose two clusters: each card shows the first against the second. A third choice replaces the first." })));
  return b;
}

// ---------------------------------------------------------------------------
// Distributions

// The outcomes that get a card: the needle, the ones the clusters are
// drawn on, and what a row cost to compute.
function cardOutcomes(m, res) {
  const out = [m.target];
  const drawn = res && res.outcomes ? res.outcomes.map(o => o.t) : clusterOutcomes(m.schema).map(o => o.t);
  for (const t of drawn) out.push(t);
  for (const t of m.schema.targets) if (t.cost) out.push(t);
  const seen = new Set();
  return out.filter(t => t && !seen.has(t.id) && seen.add(t.id) && hasValues(t, m.rows));
}

function hasValues(t, rows) {
  for (let j = 0; j < rows.length; j++) { const v = t.values[rows[j]]; if (v === v) return true; }
  return false;
}

function sortedVals(values, rows) {
  const v = [];
  for (let j = 0; j < rows.length; j++) { const x = values[rows[j]]; if (x === x) v.push(x); }
  return Float64Array.from(v).sort();
}

// The rows in `rows` not in `sub` (both ascending).
function minus(rows, sub) {
  const out = new Uint32Array(rows.length - sub.length);
  let j = 0, k = 0;
  for (let i = 0; i < rows.length; i++) {
    while (j < sub.length && sub[j] < rows[i]) j++;
    if (j < sub.length && sub[j] === rows[i]) continue;
    out[k++] = rows[i];
  }
  return out.subarray(0, k);
}

// The test of one outcome between what the card sets apart: the chosen
// rows against the rest, or the first cluster against the second.
function testOf(t, sel, m) {
  const [a, b] = sel.mode === "compare" ? [sel.a.rows, sel.b.rows] : [sel.rows, minus(m.rows, sel.rows)];
  if (t.kind === "binary") {
    const sa = summarize(t, a), sb = summarize(t, b);
    const g = gTest([sa.n, sb.n], [sa.hits, sb.hits]);
    return { p: g.p, binary: true, ra: sa.mean, rb: sb.mean };
  }
  return mannWhitney(t.values, a, b);
}

function distIsland(m, res, sel) {
  const outs = cardOutcomes(m, res);
  const drawn = new Set(res && res.clusters.length ? res.outcomes.map(o => o.t.id) : []);
  const groups = groupsOf(m, sel);
  const tests = outs.map(t => (sel.mode === "whole" || drawn.has(t.id) ? null : testOf(t, sel, m)));
  const q = bhQ(tests.map(x => (x ? x.p : NaN)));
  const isl = h("section", { class: "island rn-dists", "aria-label": "Distributions" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "Distributions" }),
      h("span", { class: "isl-count num", text: `${outs.length} outcome${outs.length === 1 ? "" : "s"}` }),
      h("div", { class: "legend rn-legend" }, groups.map(g => h("span", null, h("i", { class: "box", style: { background: g.ink } }),
        `${g.label} · ${fmtInt(g.rows.length)} rows`)))));
  if (!outs.length) { isl.append(h("p", { class: "isl-note", text: "No row in view has an outcome yet." })); return isl; }
  const grid = h("div", { class: "rn-grid" });
  outs.forEach((t, j) => grid.append(distCard(m, t, groups, drawn.has(t.id), sel, tests[j], q[j], res)));
  isl.append(grid);
  return isl;
}

const KIND_OF = { activity: "activity", risk: "risk", skill: "model skill" };

function distCard(m, t, groups, drawn, sel, test, q, res) {
  const vals = groups.map(g => sortedVals(t.values, g.rows));
  const ch = distChart(groups.map((g, i) => ({ label: g.label, fill: g.fill, ink: g.ink, vals: vals[i] })),
    { fmt: v => fmtT(t, v), label: `${t.label}: how the rows spread` });
  const isNeedle = t.id === m.target.id;
  const card = h("article", { class: "rn-card" + (isNeedle ? " needle" : ""), dataset: { outcome: t.id } });
  const tags = h("span", { class: "rn-tags" });
  if (isNeedle) tags.append(h("span", { class: "gt-tag", text: "the needle" }));
  if (t.cost) tags.append(h("span", { class: "gt-tag", text: "cost" }));
  else if (KIND_OF[t.group]) tags.append(h("span", { class: "gt-tag", text: KIND_OF[t.group] }));
  if (drawn) {
    const tg = h("span", { class: "gt-tag has-tip", text: "clusters drawn on it" });
    tip(tg, () => h("div", null, h("b", { text: "The clusters are drawn on this outcome" }),
      h("div", { class: "k", text: "So the clusters differ on it by construction; that difference is shown, never tested." })));
    tags.append(tg);
  }
  card.append(h("header", { class: "rn-head" }, h("h3", { class: "rn-name", text: t.label }),
    t.unit && !t.label.toLowerCase().includes(t.unit.toLowerCase()) ? h("span", { class: "rn-unit", text: t.unit }) : null, tags));
  card.append(h("div", { class: "rn-plot" }, ch.svg));
  // each group's figures
  const figs = h("div", { class: "rn-figs" });
  groups.forEach((g, i) => {
    const v = vals[i], miss = g.rows.length - v.length;
    const line = h("div", { class: "rn-fig" }, groups.length > 1 ? h("i", { class: "box", style: { background: g.ink } }) : null);
    if (!v.length) line.append(h("span", { class: "muted", text: `${g.label}: no row has a value` }));
    else if (t.kind === "binary") {
      const s = summarize(t, g.rows);
      line.append(h("span", null, groups.length > 1 ? h("b", { text: `${g.label} ` }) : null, `${fmtPct(s.mean, 1)} of rows`,
        h("span", { class: "muted", text: ` · 95% ${rangeText(t, s.lo, s.hi)}` })));
    } else {
      line.append(h("span", null, groups.length > 1 ? h("b", { text: `${g.label} ` }) : null, `median ${fmtT(t, quantile(v, 0.5))}`,
        h("span", { class: "muted", text: ` · middle half ${fmtT(t, quantile(v, 0.25), { unit: false })} to ${fmtT(t, quantile(v, 0.75))}` })));
      const heap = heapOf(v);
      if (heap) line.append(h("span", { class: "muted", text: ` · ${fmtPct(heap.share, 0)} at ${fmtT(t, heap.v)}` }));
    }
    if (miss) line.append(h("span", { class: "muted", text: ` · ${fmtInt(miss)} without one` }));
    figs.append(line);
  });
  if (ch.outside) figs.append(h("div", { class: "rn-fig muted", text: `${fmtInt(ch.outside)} values beyond the 1st to 99th percentile are not drawn.` }));
  card.append(figs);
  // what sets them apart on it
  if (sel.mode !== "whole") card.append(h("p", { class: "rn-diff" + (test && q < 0.05 ? " on" : "") }, diffText(t, groups, drawn, test, q, sel)));
  return card;
}

// A value that holds a tenth of the rows or more (most rounds at exactly 0).
function heapOf(v) {
  let best = null, i = 0;
  while (i < v.length) {
    let k = i;
    while (k + 1 < v.length && v[k + 1] === v[i]) k++;
    const c = k - i + 1;
    if (c / v.length >= 0.1 && (!best || c > best.c)) best = { v: v[i], c, share: c / v.length };
    i = k + 1;
  }
  return best;
}

function diffText(t, groups, drawn, test, q, sel) {
  if (drawn) return "Different by construction: the clusters are drawn on it, so no test.";
  if (!test || !Number.isFinite(q)) return "Too few values to compare.";
  const [a, b] = sel.mode === "compare" ? [sel.a.id, sel.b.id] : [sel.label, "the other rows"];
  if (q >= 0.05) return `No detectable difference between ${a} and ${b} (${fmtP(q)}).`;
  if (test.binary) return `${a}: ${fmtPct(test.ra, 1)} of rows, ${b}: ${fmtPct(test.rb, 1)} (${fmtP(q)}).`;
  const hi = test.shift >= 0.5;
  return `${hi ? a : b} sits higher: in ${fmtPct(hi ? test.shift : 1 - test.shift, 0)} of pairs of a row of each (${fmtP(q)}).`;
}

// ---------------------------------------------------------------------------
// What sets the chosen rows apart: the parameters, which the clusters were
// not drawn on, so they can be tested.

const apartCache = new WeakMap();
function apartOf(m, res, sel) {
  let byMode = apartCache.get(res);
  if (!byMode) { byMode = new Map(); apartCache.set(res, byMode); }
  const key = `${sel.mode}|${sel.pick.map(c => c.id).join(",")}|${m.rows.length}`;
  if (byMode.has(key)) return byMode.get(key);
  const dims = boardDims(m.schema).filter(d => d.levels.length >= 2);
  let out;
  if (sel.mode === "whole") {
    out = res.clusters.map(c => composition(dims, m.rows, i => res.labelOf[i] === c.index, m.rows));
  } else if (sel.mode === "compare") {
    const both = unionRows([sel.a.rows, sel.b.rows]);
    const inA = new Set(sel.a.rows);
    out = composition(dims, both, i => inA.has(i), sel.b.rows);
  } else {
    const inSel = new Set(sel.rows);
    out = composition(dims, m.rows, i => inSel.has(i), m.rows);
  }
  byMode.set(key, out);
  return out;
}

// The value of a parameter most over-represented in the group.
function overValue(x) {
  return x.levels.reduce((a, b) => (b.inGroup - b.inRef > a.inGroup - a.inRef ? b : a));
}

function apartIsland(m, A, res, sel) {
  const isl = h("section", { class: "island rn-apart", "aria-label": "What sets them apart" });
  const comp = apartOf(m, res, sel);
  if (sel.mode === "whole") {
    isl.append(h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "What makes each cluster" }),
      h("span", { class: "isl-count", text: "the parameters it holds more of than every row does" })));
    const list = h("div", { class: "rn-cls" });
    res.clusters.forEach((c, ci) => {
      const det = comp[ci].filter(x => x.q < 0.05).sort((a, b) => b.V - a.V);
      const b = h("button", { class: "rn-cl", type: "button", "aria-pressed": "false", dataset: { cluster: c.id }, onclick: () => toggleCluster(m, A, c.id) },
        h("div", { class: "rn-cl-head" }, h("span", { class: "rn-key", text: c.id }), h("b", { class: "num", text: `${fmtInt(c.n)} rows` }),
          h("span", { class: "muted num", text: fmtPct(c.share, 0) }), h("span", { class: "rn-chip-what", text: standText(res, c) })),
        det.length ? h("ul", { class: "rn-cl-params" }, det.slice(0, 3).map(x => {
          const v = overValue(x);
          return h("li", null, h("span", { class: "mono", text: x.dim.label }), " = ", h("b", { class: "mono", text: v.level.label }),
            h("span", { class: "muted num", text: ` ${fmtPct(v.inGroup, 0)} here, ${fmtPct(v.inRef, 0)} in every row` }));
        })) : h("p", { class: "muted", text: "No parameter sets it apart detectably." }));
      tip(b, () => h("div", null, h("b", { text: `Cluster ${c.id}` }), h("div", { class: "k", text: `${det.length} parameter${det.length === 1 ? "" : "s"} detectably more or less common in it (q < 0.05 across the parameters). Choose it to set it against every row.` })));
      list.append(b);
    });
    isl.append(list);
    return isl;
  }
  const [ga, gb] = sel.mode === "compare" ? [sel.a.id, sel.b.id] : [sel.label, "every row"];
  const det = comp.filter(x => x.q < 0.05).sort((a, b) => b.V - a.V);
  const rest = comp.filter(x => !(x.q < 0.05));
  isl.append(h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: sel.mode === "compare" ? `What sets ${ga} and ${gb} apart` : `What sets ${ga} apart` }),
    h("span", { class: "isl-count num", text: `${fmtInt(det.length)} of ${fmtInt(comp.length)} parameters` })));
  const groups = groupsOf(m, sel);
  if (!det.length) isl.append(h("p", { class: "isl-note", text: `No parameter is detectably more common in ${ga} than in ${gb} (q < 0.05 across the parameters).` }));
  const list = h("div", { class: "rn-params" });
  for (const x of det) list.append(paramRow(x, groups));
  isl.append(list);
  if (rest.length) {
    isl.append(h("details", { class: "rn-rest" }, h("summary", { class: "muted", text: `${fmtInt(rest.length)} parameter${rest.length === 1 ? "" : "s"} with no detectable difference` }),
      h("p", { class: "mono muted", text: rest.map(x => x.dim.label).join(", ") })));
  }
  return isl;
}

// One parameter: each value's share inside the group and inside what it is
// set against, as two bars.
function paramRow(x, groups) {
  const top = Math.max(...x.levels.map(l => Math.max(l.inGroup || 0, l.inRef || 0)), 1e-9);
  const row = h("div", { class: "rn-param" },
    h("div", { class: "rn-pname" }, h("span", { class: "mono", text: x.dim.label }),
      h("span", { class: "muted num", text: ` V ${x.V.toFixed(2)} · ${fmtP(x.q)}` })));
  const lv = h("div", { class: "rn-levels" });
  for (const l of x.levels) {
    if (!l.n) continue;
    const bars = h("div", { class: "rn-bars" },
      h("i", { style: { width: `${100 * (l.inGroup || 0) / top}%`, background: groups[0].fill } }),
      h("i", { style: { width: `${100 * (l.inRef || 0) / top}%`, background: groups[1] ? groups[1].fill : "var(--off-bar)" } }));
    const el = h("div", { class: "rn-level has-tip" }, h("span", { class: "mono rn-lv", text: l.level.label }), bars,
      h("span", { class: "num rn-lvn", text: `${fmtPct(l.inGroup, 0)} · ${fmtPct(l.inRef, 0)}` }));
    tip(el, () => h("div", null, h("b", { text: `${x.dim.label} = ${l.level.label}` }),
      h("div", { class: "k", text: `${groups[0].label}: ${fmtPct(l.inGroup, 1)} of its rows · ${groups[1] ? groups[1].label : "every row"}: ${fmtPct(l.inRef, 1)}` })));
    lv.append(el);
  }
  row.append(lv);
  return row;
}

// ---------------------------------------------------------------------------
// The strip

function runStrip(m, A, health, res, sel) {
  const t = m.target, N = m.rows.length;
  const cells = [];
  cells.push(stripCell("Rows", fmtInt(N), health.total ? `of ${fmtInt(health.total)} planned` : m.rows.length < m.ds.n ? `of ${fmtInt(m.ds.n)}` : null,
    () => h("div", null, h("b", { text: "Rows in view" }), h("div", { class: "k", text: health.total ? "The rows so far, against the rows the run plans to evaluate." : "Every row of the run so far." }))));
  if (health.rate && m.ds.meta.live && m.state.edge === null) {
    const togo = health.total && health.total > m.ds.n && m.sweep.meta.mode === "live" ? `${fmtDuration((health.total - m.ds.n) / health.rate.rowsPerSec)} to go` : null;
    cells.push(stripCell("Pace", `${health.rate.rowsPerSec.toFixed(2)} rows/s`, togo,
      () => h("div", null, h("b", { text: "Rows per second now" }), h("div", { class: "k", text: health.rate.from === "log" ? "From the runner's last progress lines." : "From the rows' arrivals in the last five minutes." }))));
  }
  if (N) {
    const s = summarize(t, m.rows);
    const v = sortedVals(t.values, m.rows);
    cells.push(stripCell(t.label, fmtT(t, s.mean), t.kind === "binary" ? `95% ${rangeText(t, s.lo, s.hi)}` : `median ${fmtT(t, quantile(v, 0.5))}`,
      () => h("div", null, h("b", { text: `${t.label}: the mean over the rows in view` }),
        h("div", { text: `95% ${rangeText(t, s.lo, s.hi)} over ${fmtInt(s.n)} rows${s.missing ? `; ${fmtInt(s.missing)} have no value` : ""}.` }),
        h("div", { class: "k", text: "Its whole distribution is the first card below." }))));
  }
  const rec = recordOf(m);
  if (rec) {
    const above = (rec.last.best - rec.last.luck) * (rec.t.better < 0 ? -1 : 1) > 0;
    cells.push(stripCell("Best", fmtT(rec.t, rec.last.best), `${above ? "above" : "inside"} the luck line, ${fmtT(rec.t, rec.last.luck)}`,
      () => h("div", null, h("b", { text: `The best ${inText(rec.t.label)} so far, against luck` }),
        h("div", { class: "k", text: "The luck line is what the best of as many rows would reach if every configuration were equally good and all spread were noise." }))));
  }
  cells.push(stripCell("Clusters", !res ? "…" : res.clusters.length ? String(res.k) : "none",
    !res ? "being found" : res.clusters.length ? `silhouette ${res.silhouette.toFixed(2)}, ${res.grade}` : res.reason === "weak" ? "the rows do not group" : "too few rows",
    () => h("div", null, h("b", { text: "The rows grouped by what they did" }), h("div", { class: "k", text: res && !res.clusters.length ? whyNone(res) : "Their toggles are under the strip; the cards follow what is chosen." }))));
  const broken = health.problems.filter(p => p.sev === "crit");
  cells.push(stripCell("Problems", fmtInt(broken.length), broken.length ? [...new Set(broken.map(p => p.kind))].join(", ") : "nothing broken",
    () => h("div", null, h("b", { text: "Crashes, broken invariants, bad lines" }), h("div", { class: "k", text: "Choose it to go to them." })),
    () => { const el = document.getElementById("rn-problems"); if (el) el.scrollIntoView({ block: "start" }); }));
  return strip("The run in figures", cells,
    { key: "run", label: "About the run", content: () => runAbout() },
    { label: "Copy the run as notes", what: "The rows, the needle, the best against luck, the clusters and what makes each, and any problem.", text: () => runNotes(m, health, res), done: "Run copied." }, A);
}

function runAbout() {
  return about("The run",
    "The whole run on one page. The strip gives the rows, the pace while it runs, the needle, the best row against luck, the clusters and anything broken.",
    "Clusters group the rows by what they did: their score, the activity it rests on, the risk that came with it and their model's skill, each read by its rank among the rows and the four kinds weighed alike. k-means tries 2 to 7 clusters and keeps the clearest (the best silhouette); any other with structure can be chosen. No cluster is drawn when the rows do not fall into groups (silhouette under 0.26) or a cluster would hold fewer than 30 rows.",
    "Each card is an outcome's distribution: every row by default; with clusters chosen, those rows (together) against every row; with Compare and two chosen, the first against the second. Bars are each group's share of its own rows; under them, each group's middle half, 5th to 95th percentile and median. The clusters differ on the outcomes they are drawn on by construction, so only the other outcomes are tested (Mann-Whitney, q across the cards).",
    "What makes each cluster tests the parameters, which the clusters are not drawn on: the G test of each parameter's values inside the cluster against every row, q across the parameters.");
}

function runNotes(m, health, res) {
  const t = m.target, lines = [];
  lines.push(`Run: ${m.ds.meta.label} (${m.sweep.meta.name || "sweep"})`);
  lines.push(`Rows: ${fmtInt(m.rows.length)}${health.total ? ` of ${fmtInt(health.total)} planned` : ""}`);
  if (m.rows.length) {
    const s = summarize(t, m.rows), v = sortedVals(t.values, m.rows);
    lines.push(`${t.label}: mean ${fmtT(t, s.mean)} (95% ${rangeText(t, s.lo, s.hi)})${t.kind === "binary" ? "" : `, median ${fmtT(t, quantile(v, 0.5))}, middle half ${fmtT(t, quantile(v, 0.25))} to ${fmtT(t, quantile(v, 0.75))}`}`);
  }
  const rec = recordOf(m);
  if (rec) lines.push(`Best ${inText(rec.t.label)}: ${fmtT(rec.t, rec.last.best)}; noise alone would give about ${fmtT(rec.t, rec.last.luck)}`);
  if (res && res.clusters.length) {
    lines.push(`Clusters: ${res.k} (silhouette ${res.silhouette.toFixed(2)}, ${res.grade}), drawn on ${res.outcomes.map(o => o.t.label).join(", ")}`);
    const comp = apartOf(m, res, { mode: "whole", pick: [] });
    res.clusters.forEach((c, ci) => {
      const det = comp[ci].filter(x => x.q < 0.05).sort((a, b) => b.V - a.V).slice(0, 3)
        .map(x => { const v = overValue(x); return `${x.dim.label} = ${v.level.label} ${fmtPct(v.inGroup, 0)} vs ${fmtPct(v.inRef, 0)}`; });
      lines.push(`  ${c.id}: ${fmtInt(c.n)} rows (${fmtPct(c.share, 0)}); ${standText(res, c)}${det.length ? `; ${det.join("; ")}` : ""}`);
    });
  } else if (res) lines.push(`Clusters: none. ${whyNone(res)}`);
  const broken = health.problems.filter(p => p.sev === "crit");
  lines.push(`Problems: ${broken.length ? broken.map(p => p.kind).join(", ") : "none"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The best against luck

// The objective's continuous measure (mean %/mo for plate sweeps) or the
// target, with its record curve.
function recordOf(m) {
  const t = m.target.kind === "binary" ? (m.schema.objective ? m.schema.targetById.get(m.schema.objective[m.schema.objective.length - 1][0]) : null) : m.target;
  if (!t || !m.allRows.length) return null;
  const c = m.cache;
  if (!c.runRecord || c.runRecord.key !== c.key || c.runRecord.t !== t) c.runRecord = { key: c.key, t, rc: recordCurve(t, m.allRows) };
  const pts = c.runRecord.rc.points;
  const last = pts[pts.length - 1];
  return last && Number.isFinite(last.luck) ? { t, pts, last } : null;
}

function recordIsland(m) {
  const isl = h("section", { class: "island", "aria-label": "Best so far against luck" });
  const rec = recordOf(m);
  isl.append(h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: rec ? `Best ${inText(rec.t.label)} so far, against luck` : "Best so far, against luck" })));
  if (!rec) { isl.append(h("p", { class: "isl-note", text: "Too few rows for a luck line." })); return isl; }
  isl.append(lineChart([
    { label: "best so far", color: "var(--ink)", points: rec.pts.map(p => [p.n, p.best]), step: true },
    { label: "expected best under noise", color: "var(--worse)", points: rec.pts.map(p => [p.n, p.luck]), dash: "5 4" },
    { label: "mean", color: "var(--muted)", points: rec.pts.map(p => [p.n, p.mean]), endDot: false },
  ], { height: 190, xLabel: "rows", fmtY: v => fmtT(rec.t, v), label: "record against the luck line" }));
  const above = (rec.last.best - rec.last.luck) * (rec.t.better < 0 ? -1 : 1) > 0;
  isl.append(h("p", { class: "isl-note" }, h("b", { text: above ? "Above the luck line" : "Inside the luck line" }),
    `: the best row reaches ${fmtT(rec.t, rec.last.best)}; noise alone would give about ${fmtT(rec.t, rec.last.luck)} at ${fmtInt(rec.last.n)} rows. The dashed line is that expectation; a record that only tracks it is harvesting noise.`));
  return isl;
}

// ---------------------------------------------------------------------------
// The run's health

function paceIsland(m, health) {
  const ds = m.ds, log = runLog(m);
  const isl = h("section", { class: "island", "aria-label": "Pace" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "Pace" }),
      h("span", { class: "isl-count", text: log ? `log ${(m.sweep.meta.logSources || {})[ds.meta.logId] || "embedded"}` : "no log for this run" })));
  const stats = h("div", { class: "stat-row" });
  const stat = (k, v, d, tp) => { const el = h("div", { class: "stat" + (tp ? " has-tip" : "") }, h("div", { class: "k", text: k }), h("div", { class: "v num", text: v }), d ? h("div", { class: "d", text: d }) : null); if (tp) tip(el, tp); stats.append(el); };
  if (health.rate) stat("Pace", `${health.rate.rowsPerSec.toFixed(2)} rows/s`, health.rate.from === "log" ? "from the last progress lines" : "from row arrivals, last 5 min");
  if (health.rate && health.total > ds.n) stat("Remaining", fmtDuration((health.total - ds.n) / health.rate.rowsPerSec), m.sweep.meta.mode === "live" ? "at this pace" : "at the pace when recorded");
  const sec = m.schema.targets.find(x => x.cost);
  if (sec && m.allRows.length) {
    const s = summarize(sec, m.allRows);
    stat("Compute per row", `${fmtNum(s.mean, 2)} s`, `mean ${inText(sec.label)}`, "The rows' own record of the work each configuration took.");
    if (health.rate) stat("Busy workers", fmtNum(health.rate.rowsPerSec * s.mean, 1), "pace × seconds per row",
      "Rows per second times seconds per row: about how many workers are kept busy. Far below the worker count means the pool is starved (waiting on I/O, stopped, or contended).");
  }
  if (Number.isFinite(ds.arrivals[ds.n - 1])) stat("Last row read", fmtAgo(Date.now() / 1000 - ds.arrivals[ds.n - 1]), "by this server");
  if (stats.childNodes.length) isl.append(stats);
  if (log && log.segments.length) {
    const longest = Math.max(0, ...log.segments.map(s => (s.progress.length ? s.progress[s.progress.length - 1][2] || 0 : 0)));
    const unit = longest > 3 * 3600 ? [3600, "h"] : longest > 600 ? [60, "min"] : [1, "s"];
    const series = log.segments.filter(s => s.progress.length > 1).map((s, i) => ({
      label: s.marker ? s.marker.label : "first run",
      color: ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)"][i % 4],
      points: s.progress.filter(p => p[2] !== null).map(p => [p[2] / unit[0], p[1]]),
    }));
    if (series.length) {
      isl.append(h("div", { class: "part-title", text: "Rows over time, each segment from its own start" }));
      isl.append(lineChart(series, { height: 160, xLabel: unit[1], fmtX: v => `${fmtNum(v, unit[1] === "h" ? 1 : 0)} ${unit[1]}`, fmtY: v => fmtInt(v), label: "rows over time by segment" }));
    }
    isl.append(h("div", { class: "part-title", text: "Segments in the log" }));
    const maxRows = Math.max(1, ...log.segments.map(s => (s.progress.length ? s.progress[s.progress.length - 1][1] : 0)));
    const tl = h("div", { class: "timeline" });
    for (const s of log.segments) {
      const rows = s.progress.length ? s.progress[s.progress.length - 1][1] : 0;
      const el = s.progress.length ? s.progress[s.progress.length - 1][2] : null;
      const mine = health.seg && health.seg.index === s.index;
      const fill = h("div", { class: "fill" + (s.status === "open" ? " live" : s.status === "crashed" ? " crashed" : ""), style: { width: `${Math.max(1, 100 * rows / maxRows)}%` } });
      tl.append(h("div", { class: "seg-row" },
        h("div", null, h("div", { style: { fontWeight: mine ? "650" : "400" }, text: s.marker ? s.marker.label : "first run" }),
          h("div", { class: "muted mono", text: s.marker ? s.marker.stamp : `log line ${s.line}` })),
        h("div", { class: "seg-bar has-tip" }, fill),
        h("div", { class: "num" }, h("div", null, `${fmtInt(rows)} rows`, el ? h("span", { class: "muted", text: ` · ${fmtDuration(el)}` }) : null),
          h("div", { class: "sev " + (s.status === "crashed" ? "crit" : s.status === "open" ? "ok" : "warn"), style: { display: "flex" }, text: s.status }))));
      tip(tl.lastChild.querySelector(".seg-bar"), `Segment ${s.index + 1}: from log line ${s.line}${s.endLine ? ` to ${s.endLine}` : ""}, ${fmtInt(rows)} of ${fmtInt(s.total)} rows${mine ? "; the rows on screen" : ""}`);
    }
    isl.append(tl);
  }
  if (!isl.querySelector(".stat-row, .timeline")) isl.append(h("p", { class: "isl-note", text: "No progress lines and no arrival times to read a pace from." }));
  return isl;
}

function problemsIsland(m, A, health) {
  const ds = m.ds, log = runLog(m);
  const isl = h("section", { class: "island", id: "rn-problems", "aria-label": "Problems" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "Problems" })));
  let any = false;
  for (const p of health.problems) {
    if (p.kind === "crash") {
      any = true;
      const c = p.c, seg = log.segments.find(s => s.index === c.segment);
      isl.append(h("div", { class: "issue" }, h("span", { class: "sev crit" }, icon("alert"), "crash"),
        h("div", { style: { minWidth: 0 } },
          h("div", null, h("b", { class: "mono", text: `${c.exception}` }), h("span", { text: `: ${c.message || ""}` })),
          c.where ? h("div", { class: "mono muted", text: `${c.where.path.split("/").slice(-2).join("/")}:${c.where.line} in ${c.where.func}` }) : null,
          c.where && c.where.code ? h("pre", { class: "code", text: c.where.code }) : null,
          h("details", null, h("summary", { class: "muted", text: `Full traceback (log line ${c.line}${seg ? `, ${seg.marker ? seg.marker.label : "first run"}, after ${fmtInt(c.row)} rows` : ""})` }),
            h("pre", { class: "code trace", text: c.text.join("\n") })))));
    } else if (p.kind === "writing") {
      any = true;
      isl.append(h("div", { class: "issue" }, h("span", { class: "sev crit" }, icon("alert"), "writing"), h("span", { text: "A traceback is being written to the log right now." })));
    } else if (p.kind === "invariant") {
      const ok = p.r.count === 0;
      if (!ok) any = true;
      isl.append(h("div", { class: "issue" }, h("span", { class: "sev " + (ok ? "ok" : "crit") }, icon(ok ? "check" : "alert"), ok ? "holds" : "broken"),
        h("div", { style: { minWidth: 0 } }, h("div", { text: p.inv.label }),
          h("div", { class: "muted num", text: ok ? `checked on ${fmtInt(p.r.checked)} rows` : `${fmtInt(p.r.count)} of ${fmtInt(p.r.checked)} rows break it` }),
          ok ? null : h("div", { class: "chips", style: { marginTop: "4px" } }, p.r.first.map(i => h("button", { class: "chip", style: { paddingRight: "8px" }, onclick: () => A.select({ kind: "row", i }), text: `row ${fmtInt(i)}` }))))));
    } else if (p.kind === "bad") {
      any = true;
      isl.append(h("div", { class: "issue" }, h("span", { class: "sev crit" }, icon("alert"), "bad lines"),
        h("div", { style: { minWidth: 0 } }, h("div", { text: `${fmtInt(ds.meta.badCount)} lines of the results file are not JSON objects; they are not rows.` }),
          ds.meta.bad.slice(0, 5).map(b => h("div", { class: "mono muted", text: `line ${b.line}: ${b.error} — ${b.text}` })))));
    } else if (p.kind === "schema") {
      isl.append(h("div", { class: "issue" }, h("span", { class: "sev warn" }, icon("alert"), "schema"),
        h("div", { style: { minWidth: 0 } }, h("div", { text: "Fields changed after the run was well under way:" }),
          p.late.slice(0, 8).map(e => h("div", { class: "mono muted", text: e.event === "kind" ? `${e.column}: kind ${e.from} → ${e.kind} at row ${fmtInt(e.row)}` : `${e.column}: first seen at row ${fmtInt(e.row)}` })))));
    }
  }
  if (!any) isl.append(h("p", { class: "note" }, h("span", { class: "sev ok" }, icon("check"), "Nothing broken."), " No crash, no broken invariant, no bad line."));
  return isl;
}

function warningsIsland(log) {
  const isl = h("section", { class: "island", "aria-label": "Warnings" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "Warnings" }), h("span", { class: "isl-count", text: "counted once per kind" })));
  const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null, h("th", { text: "warning" }), h("th", { text: "where" }), h("th", { class: "r", text: "times" }), h("th", { class: "r", text: "rows" }))));
  const tb = h("tbody");
  for (const w of log.warnings) {
    tb.append(h("tr", null, h("td", null, h("b", { text: w.category }), h("div", { class: "muted", text: w.message.length > 140 ? w.message.slice(0, 140) + "…" : w.message })),
      h("td", { class: "v", text: `${w.path.split("/").slice(-2).join("/")}:${w.line}` }),
      h("td", { class: "r num", text: fmtInt(w.count) }),
      h("td", { class: "r num", text: `${fmtInt(w.first.row)} – ${fmtInt(w.last.row)}` })));
  }
  tbl.append(tb);
  isl.append(h("div", { class: "table-wrap", dataset: { scroll: "warnings" } }, tbl));
  if (log.other && log.other.count) isl.append(h("p", { class: "isl-note", text: `${fmtInt(log.other.count)} log lines match no rule; the first: ${log.other.samples.slice(0, 3).map(x => x.text).join(" | ")}` }));
  return isl;
}

function samplerIsland(m) {
  const isl = h("section", { class: "island", "aria-label": "The sampler" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "The sampler" })));
  const params = moderatorParents(m.schema);
  const pairs = independence(m);
  const uneven = params.map(d => ({ d, u: uniformity(d, m.allRows) })).filter(x => x.u.p < 1e-6);
  const dep = pairs.filter(p => p.p < 1e-6 && p.V > 0.03).sort((a, b) => b.V - a.V);
  isl.append(h("p", { class: "isl-note", style: { marginTop: 0 }, text: `${params.length} sampled parameters checked for an even draw (χ² against uniform) and ${fmtInt(pairs.length)} pairs for independence (Cramér's V).` }));
  if (!uneven.length) isl.append(h("div", { class: "issue" }, h("span", { class: "sev ok" }, icon("check"), "even"), h("span", { text: "Every sampled parameter's values were drawn about equally often." })));
  for (const { d, u } of uneven) {
    isl.append(h("div", { class: "issue" }, h("span", { class: "sev warn" }, icon("alert"), "uneven"),
      h("div", { style: { minWidth: 0 } }, h("span", { class: "mono", text: d.label }),
        h("span", { class: "muted num", text: `  ${d.levels.map((l, j) => `${l.label} ${fmtPct(u.shares[j], 1)}`).join(" · ")}` }))));
  }
  if (!dep.length) isl.append(h("div", { class: "issue" }, h("span", { class: "sev ok" }, icon("check"), "independent"), h("span", { text: "No pair of sampled parameters is drawn together." })));
  for (const p of dep.slice(0, 8)) {
    isl.append(h("div", { class: "issue" }, h("span", { class: "sev warn" }, icon("alert"), "linked"),
      h("div", null, h("span", { class: "mono", text: `${p.a} × ${p.b}` }), h("span", { class: "muted num", text: `  V ${p.V.toFixed(3)} · ${fmtP(p.p, "p")}` }),
        h("div", { class: "muted", text: "Their marginal effects carry some of each other's; read one inside the other's levels." }))));
  }
  return isl;
}

// The runs side by side on the needle on screen: did narrowing move it?
function runsIsland(m, A) {
  const t = m.target;
  const cache = m.cache.runSchemas || (m.cache.runSchemas = new Map());
  const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null,
    h("th", { text: "run" }), h("th", { class: "r", text: "rows" }), h("th", { class: "r", text: t.label }),
    h("th", { class: "r", text: "95% interval" }), h("th", { class: "r", text: "best gates" }), h("th", { class: "r", text: "best %/mo" }))));
  const tb = h("tbody");
  for (const ds of m.sweep.runs) {
    let entry = cache.get(ds.id);
    if (!entry || entry.version !== ds.version) {
      const sc = ds === m.ds ? m.schema : buildSchema(ds);
      entry = { version: ds.version, schema: sc };
      cache.set(ds.id, entry);
    }
    const sc = entry.schema;
    const tt = sc.targetById.get(t.id);
    const rows = rowsIn(sc, [], ds.n);
    const s = tt ? summarize(tt, rows) : null;
    const best = (id, f) => {
      const x = sc.targetById.get(id);
      if (!x) return "–";
      let b = -Infinity;
      for (let j = 0; j < rows.length; j++) { const v = x.values[rows[j]]; if (v > b) b = v; }
      return Number.isFinite(b) ? f(x, b) : "–";
    };
    const mine = ds.id === m.ds.id;
    tb.append(h("tr", { class: "clickable" + (mine ? " sel" : ""),
      onclick: () => A.set({ run: ds.id, sel: null, context: [], pocket: [], edge: null, clusters: [], clusterK: null }) },
    h("td", null, h("b", { text: ds.meta.label }), ds.meta.live ? h("span", { class: "muted", text: " · being written" }) : null),
    h("td", { class: "r num", text: fmtInt(ds.n) }),
    h("td", { class: "r num", text: s ? fmtT(t, s.mean) : "no such target" }),
    h("td", { class: "r num", text: s ? `${fmtT(t, s.lo)} – ${fmtT(t, s.hi)}` : "–" }),
    h("td", { class: "r num", text: best("gates", (x, v) => String(v)) }),
    h("td", { class: "r num", text: best("mean_mo", (x, v) => fmtT(x, v)) })));
  }
  tbl.append(tb);
  return h("section", { class: "island", "aria-label": "The runs of this sweep" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "The runs of this sweep" }), h("span", { class: "isl-count", text: "on the same needle" })),
    h("div", { class: "table-wrap" }, tbl),
    h("p", { class: "isl-note", text: "Choose a run to open it. Runs drawn from different spaces are different questions: compare their intervals, not just their rates." }));
}
