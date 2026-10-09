// Run: the sweep as a process. Pace, segments, crashes, warnings, the
// record against luck, invariants and the sampler's health.

import { h, icon, tip, fmtT, fmtInt, fmtPct, fmtP, fmtNum, fmtDuration, fmtAgo, inText } from "./ui.js";
import { lineChart } from "./charts.js";
import { invariantBreaks, recordCurve, uniformity, summarize, rowsIn } from "./engine.js";
import { buildSchema } from "./schema.js";
import { independence, moderatorParents } from "./model.js";

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
  let issues = 0;
  const log = runLog(m);
  if (seg && seg.crash) issues++;
  if (log && log.openTraceback) issues++;
  if (ds.meta.badCount) issues++;
  for (const inv of m.schema.invariants) if (invariantBreaks(ds, inv, m.allRows, 1).count) issues++;
  return { line: parts.join(" · "), issues, rate, total, seg };
}

export function renderRun(view, m, A) {
  const ds = m.ds;
  const health = runHealth(m);
  const log = runLog(m);
  const logPath = log ? (m.sweep.meta.logSources || {})[ds.meta.logId] : null;
  view.append(h("div", { class: "view-head" }, h("div", null, h("h1", { text: "The run itself" }),
    h("div", { class: "sub", text: `${ds.meta.label}: ${ds.meta.source}${log ? ` · log ${logPath || "embedded"}` : " · no log for this run"}` }))));

  // pace
  const stats = h("div", { class: "stat-row" });
  const stat = (k, v, d, t) => { const el = h("div", { class: "stat" + (t ? " has-tip" : "") }, h("div", { class: "k", text: k }), h("div", { class: "v num", text: v }), d ? h("div", { class: "d", text: d }) : null); if (t) tip(el, t); stats.append(el); };
  stat("Rows", fmtInt(m.edge), health.total ? `of ${fmtInt(health.total)} planned` : null);
  if (health.rate) stat("Pace", `${health.rate.rowsPerSec.toFixed(2)} rows/s`, health.rate.from === "log" ? "from the last progress lines" : "from row arrivals, last 5 min");
  if (health.rate && health.total > ds.n) stat("Remaining", fmtDuration((health.total - ds.n) / health.rate.rowsPerSec), m.sweep.meta.mode === "live" ? "at this pace" : "at the pace when recorded");
  const sec = m.schema.targetById.get("sec");
  if (sec) {
    const s = summarize(sec, m.allRows);
    stat("Compute per row", `${s.mean.toFixed(2)} s`, "mean worker seconds", "The rows' own sec field: the work each configuration took.");
    if (health.rate) stat("Busy workers", fmtNum(health.rate.rowsPerSec * s.mean, 1), "pace × seconds per row",
      "Rows per second times seconds per row: about how many workers are kept busy. Far below the worker count means the pool is starved (waiting on I/O, stopped, or contended).");
  }
  if (Number.isFinite(ds.arrivals[ds.n - 1])) stat("Last row", fmtAgo(Date.now() / 1000 - ds.arrivals[ds.n - 1]));
  view.append(stats);

  // every run of the sweep on the same needle
  if (m.sweep.runs.length > 1) view.append(runsTable(m, A));

  // segments
  if (log && log.segments.length) {
    view.append(h("div", { class: "section-title", text: "Segments in the log" }));
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
    view.append(tl);
    // throughput
    const longest = Math.max(0, ...log.segments.map(s => (s.progress.length ? s.progress[s.progress.length - 1][2] || 0 : 0)));
    const unit = longest > 3 * 3600 ? [3600, "h"] : longest > 600 ? [60, "min"] : [1, "s"];
    const series = log.segments.filter(s => s.progress.length > 1).map((s, i) => ({
      label: s.marker ? s.marker.label : "first run",
      color: ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)"][i % 4],
      points: s.progress.filter(p => p[2] !== null).map(p => [p[2] / unit[0], p[1]]),
    }));
    if (series.length) {
      view.append(h("div", { class: "cards", style: { marginTop: "14px" } },
        h("div", { class: "card" }, h("h3", { text: "Rows over time" }), h("div", { class: "sub", text: "Each segment from its own start; a flattening line is a slowing pool." }),
          lineChart(series, { height: 200, xLabel: unit[1], fmtX: v => `${fmtNum(v, unit[1] === "h" ? 1 : 0)} ${unit[1]}`, fmtY: v => fmtInt(v), label: "rows over time by segment" })),
        recordCard(m)));
    }
  } else {
    view.append(h("div", { class: "cards" }, recordCard(m)));
  }

  // problems
  view.append(h("div", { class: "section-title", text: "Problems" }));
  const probs = h("div", { class: "card" });
  let any = false;
  if (log) for (const c of log.crashes) {
    any = true;
    const seg = log.segments.find(s => s.index === c.segment);
    probs.append(h("div", { class: "issue" }, h("span", { class: "sev crit" }, icon("alert"), "crash"),
      h("div", { style: { minWidth: 0 } },
        h("div", null, h("b", { class: "mono", text: `${c.exception}` }), h("span", { text: `: ${c.message || ""}` })),
        c.where ? h("div", { class: "mono muted", text: `${c.where.path.split("/").slice(-2).join("/")}:${c.where.line} in ${c.where.func}` }) : null,
        c.where && c.where.code ? h("pre", { class: "code", text: c.where.code }) : null,
        h("details", null, h("summary", { class: "muted", text: `Full traceback (log line ${c.line}${seg ? `, ${seg.marker ? seg.marker.label : "first run"}, after ${fmtInt(c.row)} rows` : ""})` }),
          h("pre", { class: "code trace", text: c.text.join("\n") })))));
  }
  if (log && log.openTraceback) {
    any = true;
    probs.append(h("div", { class: "issue" }, h("span", { class: "sev crit" }, icon("alert"), "writing"), h("span", { text: "A traceback is being written to the log right now." })));
  }
  for (const inv of m.schema.invariants) {
    const r = invariantBreaks(ds, inv, m.allRows, 12);
    const ok = r.count === 0;
    if (!ok) any = true;
    probs.append(h("div", { class: "issue" }, h("span", { class: "sev " + (ok ? "ok" : "crit") }, icon(ok ? "check" : "alert"), ok ? "holds" : "broken"),
      h("div", { style: { minWidth: 0 } }, h("div", { text: inv.label }),
        h("div", { class: "muted num", text: ok ? `checked on ${fmtInt(r.checked)} rows` : `${fmtInt(r.count)} of ${fmtInt(r.checked)} rows break it` }),
        ok ? null : h("div", { class: "chips", style: { marginTop: "4px" } }, r.first.map(i => h("button", { class: "chip", style: { paddingRight: "8px" }, onclick: () => A.select({ kind: "row", i }), text: `row ${fmtInt(i)}` }))))));
  }
  if (ds.meta.badCount) {
    any = true;
    probs.append(h("div", { class: "issue" }, h("span", { class: "sev crit" }, icon("alert"), "bad lines"),
      h("div", { style: { minWidth: 0 } }, h("div", { text: `${fmtInt(ds.meta.badCount)} lines of the results file are not JSON objects; they are not rows.` }),
        ds.meta.bad.slice(0, 5).map(b => h("div", { class: "mono muted", text: `line ${b.line}: ${b.error} — ${b.text}` })))));
  }
  const late = (ds.meta.schemaEvents || []).filter(e => e.event === "kind" || e.row >= 1000);
  if (late.length) {
    probs.append(h("div", { class: "issue" }, h("span", { class: "sev warn" }, icon("alert"), "schema"),
      h("div", { style: { minWidth: 0 } }, h("div", { text: "Fields changed after the run was well under way:" }),
        late.slice(0, 8).map(e => h("div", { class: "mono muted", text: e.event === "kind" ? `${e.column}: kind ${e.from} → ${e.kind} at row ${fmtInt(e.row)}` : `${e.column}: first seen at row ${fmtInt(e.row)}` })))));
  }
  if (!any) probs.prepend(h("p", { class: "note" }, h("span", { class: "sev ok" }, icon("check"), "Nothing broken."), " No crash, no broken invariant, no bad line."));
  view.append(probs);

  // warnings
  if (log && log.warnings.length) {
    view.append(h("div", { class: "section-title", text: "Warnings, counted once per kind" }));
    const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null, h("th", { text: "warning" }), h("th", { text: "where" }), h("th", { class: "r", text: "times" }), h("th", { class: "r", text: "rows" }))));
    const tb = h("tbody");
    for (const w of log.warnings) {
      tb.append(h("tr", null, h("td", null, h("b", { text: w.category }), h("div", { class: "muted", text: w.message.length > 140 ? w.message.slice(0, 140) + "…" : w.message })),
        h("td", { class: "v", text: `${w.path.split("/").slice(-2).join("/")}:${w.line}` }),
        h("td", { class: "r num", text: fmtInt(w.count) }),
        h("td", { class: "r num", text: `${fmtInt(w.first.row)} – ${fmtInt(w.last.row)}` })));
    }
    tbl.append(tb);
    view.append(h("div", { class: "card table-wrap" }, tbl));
    if (log.other && log.other.count) view.append(h("p", { class: "muted", text: `${fmtInt(log.other.count)} log lines match no rule; the first: ${log.other.samples.slice(0, 3).map(x => x.text).join(" | ")}` }));
  }

  // sampler
  view.append(h("div", { class: "section-title", text: "The sampler" }));
  const params = moderatorParents(m.schema);
  const uneven = params.map(d => ({ d, u: uniformity(d, m.allRows) })).filter(x => x.u.p < 1e-6);
  const dep = independence(m).filter(p => p.p < 1e-6 && p.V > 0.03).sort((a, b) => b.V - a.V);
  const card = h("div", { class: "card" });
  card.append(h("p", { class: "note", text: `${params.length} sampled parameters checked for an even draw (χ² against uniform) and ${fmtInt(independence(m).length)} pairs for independence (Cramér's V).` }));
  if (!uneven.length) card.append(h("div", { class: "issue" }, h("span", { class: "sev ok" }, icon("check"), "even"), h("span", { text: "Every sampled parameter's values were drawn about equally often." })));
  for (const { d, u } of uneven) {
    card.append(h("div", { class: "issue" }, h("span", { class: "sev warn" }, icon("alert"), "uneven"),
      h("div", { style: { minWidth: 0 } }, h("span", { class: "mono", text: d.label }),
        h("span", { class: "muted num", text: `  ${d.levels.map((l, j) => `${l.label} ${fmtPct(u.shares[j], 1)}`).join(" · ")}` }))));
  }
  if (!dep.length) card.append(h("div", { class: "issue" }, h("span", { class: "sev ok" }, icon("check"), "independent"), h("span", { text: "No pair of sampled parameters is drawn together." })));
  for (const p of dep.slice(0, 8)) {
    card.append(h("div", { class: "issue" }, h("span", { class: "sev warn" }, icon("alert"), "linked"),
      h("div", null, h("span", { class: "mono", text: `${p.a} × ${p.b}` }), h("span", { class: "muted num", text: `  V ${p.V.toFixed(3)} · ${fmtP(p.p, "p")}` }),
        h("div", { class: "muted", text: "Their marginal effects carry some of each other's; read one inside the other's levels." }))));
  }
  view.append(card);
}

// The best value so far against the luck line, for the objective's
// continuous measure (mean %/mo for plate sweeps) or the target.
function recordCard(m) {
  const t = m.target.kind === "binary" ? (m.schema.objective ? m.schema.targetById.get(m.schema.objective[m.schema.objective.length - 1][0]) : null) : m.target;
  if (!t) return h("div");
  const rc = recordCurve(t, m.allRows);
  const pts = rc.points;
  const card = h("div", { class: "card" }, h("h3", { text: `Best ${inText(t.label)} so far, against luck` }),
    h("div", { class: "sub", text: "The dashed line is what the best of n rows would reach if every configuration were equally good and all spread were noise. A record line that only tracks it is harvesting noise." }));
  card.append(lineChart([
    { label: "best so far", color: "var(--ink)", points: pts.map(p => [p.n, p.best]), step: true },
    { label: "expected best under noise", color: "var(--worse)", points: pts.map(p => [p.n, p.luck]), dash: "5 4" },
    { label: "mean", color: "var(--muted)", points: pts.map(p => [p.n, p.mean]), endDot: false },
  ], { height: 200, xLabel: "rows", fmtY: v => fmtT(t, v), label: "record against the luck line" }));
  const last = pts[pts.length - 1];
  if (last && Number.isFinite(last.luck)) {
    const above = (last.best - last.luck) * (t.better < 0 ? -1 : 1);
    card.append(h("p", { class: "note" }, h("b", { text: above > 0 ? "Above the luck line" : "Inside the luck line" }),
      `: the best row reaches ${fmtT(t, last.best)}; noise alone would give about ${fmtT(t, last.luck)} at ${fmtInt(last.n)} rows.`));
  }
  return card;
}

// The runs side by side on the needle on screen: did narrowing move it?
function runsTable(m, A) {
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
      onclick: () => A.set({ run: ds.id, sel: null, context: [], pocket: [], edge: null }) },
      h("td", null, h("b", { text: ds.meta.label }), ds.meta.live ? h("span", { class: "muted", text: " · being written" }) : null),
      h("td", { class: "r num", text: fmtInt(ds.n) }),
      h("td", { class: "r num", text: s ? fmtT(t, s.mean) : "no such target" }),
      h("td", { class: "r num", text: s ? `${fmtT(t, s.lo)} – ${fmtT(t, s.hi)}` : "–" }),
      h("td", { class: "r num", text: best("gates", (x, v) => String(v)) }),
      h("td", { class: "r num", text: best("mean_mo", (x, v) => fmtT(x, v)) })));
  }
  tbl.append(tb);
  return h("div", null, h("div", { class: "section-title", text: "The runs of this sweep, on the same needle" }),
    h("div", { class: "card table-wrap" }, tbl,
      h("p", { class: "muted", style: { margin: "8px 0 0" }, text: "Choose a run to open it. Runs drawn from different spaces are different questions: compare their intervals, not just their rates." })));
}
