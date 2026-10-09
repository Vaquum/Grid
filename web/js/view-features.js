// Features: what the sweep's choice of features did to the needle.
//
// A Limen run reads it from its manifest and its round log: the drawn
// combinations of feature groups, what adding one group did, and what each
// column its ablation dropped did (engine of ablation.js). A sweep that
// draws a random subset of a pool for every row (plate sweeps' feats)
// shows each member's inclusion effect, compared inside each subset size.

import { h, tip, fmtT, fmtInt, fmtPct, fmtP, fmtDelta, inText } from "./ui.js";
import { strip, stripCell, about } from "./strip.js";
import { memberEffects, dimEffect } from "./engine.js";
import { memberDims } from "./model.js";
import { lineChart, intervalBar } from "./charts.js";
import { limenDesign, groupContrasts, ablationMembers, ablationFactors, ablationModel, MIN_DROPS } from "./ablation.js";

export function renderFeatures(view, m, A) {
  view.append(h("h1", { class: "sr", text: "Features" }));
  const lf = limenFeatures(m);
  const sets = memberSets(m);
  if (!lf && !sets.length) {
    view.append(strip("The features in figures", [rowsCell(m)],
      { key: "features", label: "About features", content: () => featuresAbout(m, null, sets) }, null, A));
    view.append(h("section", { class: "island", "aria-labelledby": "ft-none" },
      h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "ft-none", text: "Features" })),
      h("p", { class: "isl-note", text: "This sweep draws no features to compare: no row holds a subset of a pool, and no manifest names feature groups or an ablation." })));
    return;
  }
  view.append(featuresStrip(m, A, lf, sets));
  if (lf && lf.groups) view.append(groupsIsland(m, lf));
  if (lf && lf.design.ablation) view.append(columnsIsland(m, A, lf));
  for (const s of sets) view.append(membersIsland(m, A, s));
  view.append(nextIsland(m, A, lf, sets));
}

// ---------------------------------------------------------------------------
// What is read, cached on the model's key.

function limenFeatures(m) {
  const exp = m.ds.meta.experiment;
  if (!exp || exp.kind !== "limen") return null;
  const c = m.cache;
  if (c.lf && c.lfKey === c.key) return c.lf;
  const design = limenDesign(exp);
  const groupsDim = m.schema.dimById.get("feature_groups");
  if (!design.ablation && !(design.groups.length && groupsDim)) return null;
  const out = { design, groups: null, columns: null };
  if (design.groups.length && groupsDim) out.groups = groupContrasts(design, groupsDim, m.target, m.rows);
  if (design.ablation) {
    if (!exp.roundLog) out.columns = { missing: true };
    else {
      const am = ablationMembers(m.ds, m.schema, design, m.rows);
      const movers = m.order.filter(e => e.detectable).map(e => m.schema.dimById.get(e.dim));
      const factors = ablationFactors(m.schema, design, movers);
      const fit = ablationModel(m.target, m.rows, factors, am.members, am.perRow);
      let recorded = 0, dropped = 0;
      for (let r = 0; r < m.rows.length; r++) { const l = am.perRow[m.rows[r]]; if (l) { recorded++; if (l.length) dropped++; } }
      out.columns = { members: am.members, fit, factors, recorded, dropped };
    }
  }
  c.lf = out;
  c.lfKey = c.key;
  return out;
}

function memberSets(m) {
  const members = memberDims(m.schema);
  const cols = [...new Set(members.map(d => d.set.column))];
  return cols.map(col => {
    const ms = members.filter(d => d.set.column === col);
    const size = m.schema.dimById.get(ms[0].set.sizeDim);
    const c = m.cache, key = `${c.key}|${col}`;
    if (c.membersKey !== key) { c.members = memberEffects(m.schema, ms, size, m.target, m.rows); c.membersKey = key; }
    return { col, members: ms, size, res: c.members };
  });
}

// ---------------------------------------------------------------------------
// The strip.

const betterSign = (t) => (t.better < 0 ? -1 : 1);
const termName = (x) => x.members.map(mm => mm.name).join(" + ");
const verdictOf = (t, delta, detectable) => (!detectable ? "quiet" : delta * betterSign(t) > 0 ? "helps" : "hurts");

function rowsCell(m) {
  return stripCell("Rows", fmtInt(m.rows.length), m.rows.length < m.ds.n ? `of ${fmtInt(m.ds.n)}` : null,
    () => h("div", null, h("b", { text: "Rows in view" }), h("div", { class: "k", text: m.context.length ? "Rows that hold every condition of the context." : m.edge < m.ds.n ? "Rows up to the replay edge." : "Every row of the run so far." })));
}

function featuresStrip(m, A, lf, sets) {
  const t = m.target, cells = [];
  if (lf && lf.groups) {
    const lv = lf.groups.levels.filter(l => l.n > 0);
    const best = lv.length ? lv.reduce((a, b) => (b.mean * betterSign(t) > a.mean * betterSign(t) ? b : a)) : null;
    // a best combination is only worth naming as best when they differ
    const fg = m.board.effects.find(e => e.dim === "feature_groups");
    cells.push(stripCell("Best groups", best ? fmtT(t, best.mean) : "–", best ? `${best.label}${fg && !fg.detectable ? " · they do not differ detectably" : ""}` : "no rows",
      () => h("div", null, h("b", { text: "The drawn combination of feature groups with the best needle" }), best ? h("div", { class: "k", text: `${fmtInt(best.n)} rows; 95% ${fmtT(t, best.lo)} to ${fmtT(t, best.hi)}.` }) : null)));
    const ct = lf.groups.contrasts, det = ct.filter(c => c.detectable);
    const top = det.length ? det.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a)) : null;
    cells.push(stripCell("Adding a group", ct.length ? `${fmtInt(det.length)} of ${fmtInt(ct.length)}` : "–",
      top ? `${top.added} to ${top.from.label}: ${fmtDelta(t, top.delta)}` : ct.length ? "none moves it detectably" : "no pair differs by one group",
      () => h("div", null, h("b", { text: "Single groups added to a drawn combination" }), h("div", { class: "k", text: "Pairs of drawn combinations that differ by one group, with a detectable difference after correcting across the pairs (q < 0.05)." }))));
  }
  if (lf && lf.columns && !lf.columns.missing) {
    const terms = lf.columns.fit.terms;
    const keep = terms.filter(x => verdictOf(t, x.keep, x.detectable) === "helps"), drop = terms.filter(x => verdictOf(t, x.keep, x.detectable) === "hurts");
    cells.push(stripCell("Columns dropped", fmtInt(lf.columns.members.length), `in ${fmtInt(lf.columns.dropped)} of ${fmtInt(lf.columns.recorded)} rounds`,
      () => h("div", null, h("b", { text: "Columns the ablation dropped" }), h("div", { class: "k", text: "Rounds the round log records, and how many dropped any column." }))));
    cells.push(stripCell("Worth keeping", fmtInt(keep.length), keep.length ? termName(keep[0]) : "none detectably",
      () => h("div", null, h("b", { text: "Columns whose drop detectably lowers the needle" }), h("div", { class: "k", text: "Keeping them helps (q < 0.05 across the columns)." }))));
    cells.push(stripCell("Better dropped", fmtInt(drop.length), drop.length ? termName(drop[0]) : "none detectably",
      () => h("div", null, h("b", { text: "Columns whose drop detectably raises the needle" }), h("div", { class: "k", text: "Leaving them out helps (q < 0.05 across the columns)." }))));
  }
  if (!lf) {
    for (const s of sets) {
      const rs = s.res.members;
      const helps = rs.filter(r => verdictOf(t, r.delta, r.detectable) === "helps"), hurts = rs.filter(r => verdictOf(t, r.delta, r.detectable) === "hurts");
      cells.push(stripCell("Members", fmtInt(rs.length), s.col, () => h("div", null, h("b", { text: `The pool ${s.col} draws from` }), h("div", { class: "k", text: "Each row includes a random subset of them." }))));
      cells.push(stripCell("Help", fmtInt(helps.length), helps.length ? helps.sort((a, b) => (b.delta - a.delta) * betterSign(t))[0].name : "none detectably",
        () => h("div", null, h("b", { text: "Members whose inclusion detectably helps" }), h("div", { class: "k", text: "q < 0.05 across the members." }))));
      cells.push(stripCell("Hurt", fmtInt(hurts.length), hurts.length ? hurts.sort((a, b) => (a.delta - b.delta) * betterSign(t))[0].name : "none detectably",
        () => h("div", null, h("b", { text: "Members whose inclusion detectably hurts" }), h("div", { class: "k", text: "q < 0.05 across the members." }))));
    }
  }
  cells.push(rowsCell(m));
  return strip("The features in figures", cells,
    { key: "features", label: "About features", content: () => featuresAbout(m, lf, sets) },
    { label: "Copy the features as notes", what: "What each group and each column did, and what to keep or leave out next.", text: () => nextText(m, lf, sets), done: "Features copied." }, A);
}

function featuresAbout(m, lf, sets) {
  const t = inText(m.target.label);
  const paras = [];
  if (lf) {
    paras.push("On a Limen run the features come from its manifest and its round log. The manifest puts each feature function in a group; each round switches groups on (feature_groups), and its ablation then drops a few of the round's columns (feature_drop_count of them, chosen with feature_drop_seed), which the round log names.");
    if (lf.groups) paras.push(`Feature groups: each drawn combination with its ${t}; where two differ by one group, their difference is what adding that group did, corrected across the pairs.`);
    if (lf.design.ablation) paras.push(`Columns: with few seeds, columns dropped together come in fixed sets, so one model over every round gives each column the share its varied company allows: ${t} as the round's feature groups, the parameters its features take and the ones that move the needle, plus a term for each column it dropped. Keeping a column is minus its term; columns never dropped apart are one term.`);
  }
  if (sets.length) paras.push(`Subsets: each row includes a random subset of a pool. For each member, the difference in ${t} between rows that included it and rows that left it out, compared inside each subset size and averaged (larger subsets include every member more often, so the size's own effect would leak into every member otherwise).`);
  if (!lf && !sets.length) paras.push("A sweep's features show here when its rows hold a subset of a pool, or when it is a Limen run whose manifest names feature groups or an ablation.");
  return about("Features", ...paras);
}

// ---------------------------------------------------------------------------
// Feature groups.

const verdictTag = (v) => h("span", { class: `ft-v ${v}`, text: v === "helps" ? "helps" : v === "hurts" ? "hurts" : "no detectable effect" });

function groupsIsland(m, lf) {
  const t = m.target, g = lf.groups, d = lf.design;
  const isl = h("section", { class: "island ft-island", "aria-labelledby": "ft-groups" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "ft-groups", text: "Feature groups" }),
      h("span", { class: "isl-count num", text: `${fmtInt(g.levels.length)} combinations drawn · ${fmtInt(d.groups.length)} groups` })));
  // the drawn combinations, their needle on one scale with the base
  let lo = m.base.mean, hi = m.base.mean;
  for (const l of g.levels) if (l.n >= 2) { lo = Math.min(lo, l.lo); hi = Math.max(hi, l.hi); }
  const pad = (hi - lo) * 0.06 || 1e-6;
  const funcs = (name) => (d.groups.find(x => x.name === name) || { funcs: [] }).funcs;
  const drawn = h("table", { class: "vals ft-table" }, h("thead", null, h("tr", null,
    h("th", { text: "combination" }), h("th", { text: "switches on" }), h("th", { class: "r", text: "rows" }), h("th", { class: "r", text: t.label }),
    h("th", { class: "iv", text: "95% interval (line: every row)" }))));
  const tb = h("tbody");
  for (const l of g.levels) {
    tb.append(h("tr", null, h("td", { class: "v", text: l.label }),
      h("td", { class: "ft-funcs", text: l.groups.map(x => `${x}: ${funcs(x).join(", ")}`).join(" · ") }),
      h("td", { class: "r num", text: fmtInt(l.n) }), h("td", { class: "r num", text: fmtT(t, l.mean) }),
      h("td", { class: "iv" }, intervalBar(l.mean, l.lo, l.hi, m.base.mean, [lo - pad, hi + pad]))));
  }
  drawn.append(tb);
  isl.append(h("div", { class: "isl-part" }, h("h3", { class: "part-title" }, h("span", { text: "Drawn" }),
    d.always.length ? h("span", { class: "note", text: `every round also has ${d.always.join(", ")}` }) : null),
  h("div", { class: "table-wrap" }, drawn)));
  // adding one group
  const part = h("div", { class: "isl-part" }, h("h3", { class: "part-title" }, h("span", { text: "Adding one group" }),
    h("span", { class: "note", text: "drawn combinations that differ by one group" })));
  if (!g.contrasts.length) part.append(h("p", { class: "isl-note", text: "No two drawn combinations differ by exactly one group, so no group's effect stands on its own; the combinations above are the comparison." }));
  else {
    let m0 = 0;
    for (const c of g.contrasts) m0 = Math.max(m0, Math.abs(c.lo), Math.abs(c.hi));
    const dom = [-m0 * 1.06 || -1e-6, m0 * 1.06 || 1e-6];
    const tbl = h("table", { class: "vals ft-table" }, h("thead", null, h("tr", null,
      h("th", { text: "adding" }), h("th", { class: "r", text: "difference" }), h("th", { class: "iv", text: "95% interval (line: no difference)" }), h("th", { class: "r", text: "corrected" }), h("th", { text: "" }))));
    const b = h("tbody");
    for (const c of g.contrasts) {
      b.append(h("tr", null, h("td", null, h("b", { text: c.added }), h("span", { class: "muted", text: ` to ${c.from.label}` })),
        h("td", { class: "r num", text: fmtDelta(t, c.delta) }), h("td", { class: "iv" }, intervalBar(c.delta, c.lo, c.hi, 0, dom)),
        h("td", { class: "r num", text: fmtP(c.q) }), h("td", null, verdictTag(verdictOf(t, c.delta, c.detectable)))));
    }
    tbl.append(b);
    part.append(h("div", { class: "table-wrap" }, tbl));
  }
  isl.append(part);
  return isl;
}

// ---------------------------------------------------------------------------
// The columns the ablation dropped.

function columnsIsland(m, A, lf) {
  const t = m.target, cl = lf.columns;
  const head = h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "ft-cols", text: "Columns the ablation dropped" }));
  const isl = h("section", { class: "island ft-island", "aria-labelledby": "ft-cols" }, head);
  if (cl.missing) {
    isl.append(h("p", { class: "isl-note", text: "This run's directory has no round_data.jsonl, Limen's round log, so the columns each round dropped are not known." }));
    return isl;
  }
  head.append(h("span", { class: "isl-count num", text: `${fmtInt(cl.members.length)} columns · ${fmtInt(cl.dropped)} of ${fmtInt(cl.recorded)} rounds dropped some` }),
    sortPicker(m, A));
  if (!cl.fit.terms.length) {
    isl.append(h("p", { class: "isl-note", text: cl.recorded ? "No round in view dropped a column." : "The round log has no record yet for the rounds in view." }));
    return isl;
  }
  const est = cl.fit.terms.filter(x => !x.reason);
  let m0 = 0;
  for (const x of est) m0 = Math.max(m0, Math.abs(x.lo), Math.abs(x.hi));
  const dom = [-m0 * 1.06 || -1e-6, m0 * 1.06 || 1e-6];
  const byName = m.state.featSort === "name";
  const order = [...cl.fit.terms].sort((a, b) => (byName ? termName(a).localeCompare(termName(b))
    : (!a.reason - !b.reason) * -1 || ((b.keep - a.keep) * betterSign(t)) || termName(a).localeCompare(termName(b))));
  const tbl = h("table", { class: "vals ft-table" }, h("thead", null, h("tr", null,
    h("th", { text: "column" }), h("th", { class: "r", text: "rounds dropped" }), h("th", { class: "r", text: "keeping it" }),
    h("th", { class: "iv", text: "95% interval (line: no difference)" }), h("th", { class: "r", text: "corrected" }), h("th", { text: "" }))));
  const tb = h("tbody");
  for (const x of order) {
    const name = termName(x);
    const tr = h("tr", null, h("td", { class: "v", text: name }), h("td", { class: "r num", text: fmtInt(x.drops) }));
    if (x.reason) {
      tr.append(h("td", { class: "r num muted", text: "–" }), h("td", { class: "iv" }), h("td", { class: "r num muted", text: "–" }),
        h("td", null, h("span", { class: "ft-v quiet", text: x.reason === "few" ? `fewer than ${MIN_DROPS} drops` : "cannot be told apart" })));
    } else {
      tr.append(h("td", { class: "r num", text: fmtDelta(t, x.keep) }), h("td", { class: "iv" }, intervalBar(x.keep, x.lo, x.hi, 0, dom)),
        h("td", { class: "r num", text: fmtP(x.q) }), h("td", null, verdictTag(verdictOf(t, x.keep, x.detectable))));
      tip(tr.children[3], () => h("div", null, h("b", { text: `Keeping ${name}` }),
        h("div", { text: `${fmtDelta(t, x.keep)}, 95% ${fmtDelta(t, x.lo)} to ${fmtDelta(t, x.hi)}` }),
        h("div", { class: "k", text: `dropped in ${fmtInt(x.drops)} rounds${x.members.length > 1 ? "; these columns were always dropped together, so they are one term" : ""}` })));
    }
    if (x.members.some(mm => mm.raw.size > 1 || [...mm.raw][0] !== mm.name)) {
      tip(tr.children[0], () => h("div", null, h("b", { text: name }), h("div", { class: "k", text: `the column named after its parameter's value: ${x.members.flatMap(mm => [...mm.raw]).sort().join(", ")}` })));
    }
    tb.append(tr);
  }
  tbl.append(tb);
  isl.append(h("div", { class: "table-wrap" }, tbl));
  const held = cl.factors.map(f => f.label).join(", ");
  isl.append(h("p", { class: "isl-note", text: `One model over ${fmtInt(cl.fit.rows)} rounds: ${inText(t.label)} as the round's ${held || "nothing else"}, and a term for each column it dropped; least squares, with errors robust to unequal spread (HC3). A column is kept out of the reckoning below ${MIN_DROPS} drops.` }));
  return isl;
}

function sortPicker(m, A) {
  const seg = h("div", { class: "seg ft-sort", role: "group", "aria-label": "Order" });
  for (const [k, label] of [["effect", "by effect"], ["name", "by name"]]) {
    seg.append(h("button", { type: "button", "aria-pressed": (m.state.featSort === "name") === (k === "name") ? "true" : "false",
      onclick: () => A.set({ featSort: k }, { replace: true }) }, label));
  }
  return seg;
}

// ---------------------------------------------------------------------------
// A pool's members (plate sweeps).

function membersIsland(m, A, s) {
  const t = m.target, rs = s.res.members;
  const sorted = [...rs].sort((a, b) => (m.state.featSort === "name" ? a.name.localeCompare(b.name) : (b.delta - a.delta) * betterSign(t)));
  const isl = h("section", { class: "island ft-island", "aria-label": `Including each of ${s.col}` },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title" }, "Including each of ", h("span", { class: "mono", text: s.col })),
      h("span", { class: "isl-count num", text: `${fmtInt(rs.length)} members` }), sortPicker(m, A)));
  let lo = 0, hi = 0;
  for (const r of rs) if (Number.isFinite(r.lo)) { lo = Math.min(lo, r.lo); hi = Math.max(hi, r.hi); }
  const pad = (hi - lo) * 0.05 || 1e-3;
  const tbl = h("table", { class: "vals ft-table" }, h("thead", null, h("tr", null,
    h("th", { text: "member" }), h("th", { class: "r", text: "included in" }), h("th", { class: "r", text: "difference" }),
    h("th", { class: "iv", text: "95% interval (line: no difference)" }), h("th", { class: "r", text: "corrected" }), h("th", { text: "" }))));
  const tb = h("tbody");
  for (const r of sorted) {
    const tr = h("tr", { class: "clickable", tabindex: "0", onclick: () => A.select({ kind: "dim", id: r.id }),
      onkeydown: (e) => { if (e.key === "Enter") A.select({ kind: "dim", id: r.id }); } },
      h("td", { class: "v", text: r.name }), h("td", { class: "r num", text: fmtPct(r.share, 0) }),
      h("td", { class: "r num", text: fmtDelta(t, r.delta, { digits: t.kind === "binary" ? 1 : 3 }) }),
      h("td", { class: "iv" }, intervalBar(r.delta, r.lo, r.hi, 0, [lo - pad, hi + pad])),
      h("td", { class: "r num", text: fmtP(r.q) }), h("td", null, verdictTag(verdictOf(t, r.delta, r.detectable))));
    tip(tr.children[3], `${fmtDelta(t, r.lo)} to ${fmtDelta(t, r.hi)} · included ${fmtInt(r.nIn)} rows (${fmtT(t, r.inMean)}), left out ${fmtInt(r.nOut)} (${fmtT(t, r.outMean)})`);
    tb.append(tr);
  }
  tbl.append(tb);
  isl.append(h("div", { class: "table-wrap" }, tbl));
  if (s.size) {
    const e = dimEffect(s.size, t, m.rows, m.base);
    const ok = e.levels.filter(l => l.n >= 30);
    isl.append(h("div", { class: "isl-part" }, h("h3", { class: "part-title" }, h("span", { text: `${t.label} by the number of members` }),
      h("span", { class: "note", text: `${fmtP(e.p, "p")} for any difference across sizes; thin lines bound the 95% interval` })),
    lineChart([{ label: t.label, color: "var(--ink)", points: ok.map(l => [l.value, l.mean]) },
      { label: "95% interval", color: "var(--muted)", points: ok.map(l => [l.value, l.lo]), width: 1, endDot: false },
      { label: "", color: "var(--muted)", points: ok.map(l => [l.value, l.hi]), width: 1, endDot: false }],
    { height: 170, xLabel: "members", fmtX: v => String(v), fmtY: v => fmtT(t, v), label: "needle by subset size" })));
  }
  return isl;
}

// ---------------------------------------------------------------------------
// For the next sweep.

function nextText(m, lf, sets) {
  const t = m.target;
  const lines = [`# ${m.sweep.meta.name} · ${m.ds.meta.label}: features against ${inText(t.label)} (${fmtInt(m.rows.length)} rows)`];
  if (lf && lf.groups) {
    for (const l of lf.groups.levels) lines.push(`# ${l.label}: ${fmtT(t, l.mean)} over ${fmtInt(l.n)} rows`);
    for (const c of lf.groups.contrasts) lines.push(`# adding ${c.added} to ${c.from.label}: ${fmtDelta(t, c.delta)} (${fmtP(c.q)})`);
  }
  if (lf && lf.columns && !lf.columns.missing) {
    const terms = lf.columns.fit.terms;
    lines.push(`keep_columns: [${terms.filter(x => verdictOf(t, x.keep, x.detectable) === "helps").map(termName).join(", ")}]`);
    lines.push(`drop_columns: [${terms.filter(x => verdictOf(t, x.keep, x.detectable) === "hurts").map(termName).join(", ")}]`);
  }
  for (const s of sets) {
    const rs = s.res.members;
    lines.push(`# ${s.col}: inclusion effects`);
    lines.push(`always_include: [${rs.filter(r => verdictOf(t, r.delta, r.detectable) === "helps").map(r => r.name).join(", ")}]`);
    lines.push(`drop_from_pool: [${rs.filter(r => verdictOf(t, r.delta, r.detectable) === "hurts").map(r => r.name).join(", ")}]`);
  }
  return lines.join("\n");
}

function nextIsland(m, A, lf, sets) {
  const text = nextText(m, lf, sets);
  return h("section", { class: "island ft-island", "aria-labelledby": "ft-next" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "ft-next", text: lf ? "For the next manifest" : "For the next pool" }),
      h("span", { class: "isl-count", text: "what the evidence so far supports" })),
    h("pre", { class: "code", text }));
}
