// Pairs: which two parameters change each other's effect, and how the
// sampler drew them together.
//
// The page: the strip (the pairs in figures); the interactions, strongest
// first, beside the chosen pair (the strongest until one is chosen) as the
// needle in every combination of their values, with each value's own
// margin; and below, the map of every pair: the interaction under the
// diagonal, the sampler's dependence above it.

import { h, tip, fmtT, fmtInt, fmtP, fmtDelta, inText } from "./ui.js";
import { pairEffect, cramersV, dimEffect, summarize, ALPHA } from "./engine.js";
import { bhQ } from "./stats.js";
import { moderatorParents, background } from "./model.js";
import { divergingFill } from "./charts.js";
import { strip, stripCell, about } from "./strip.js";

// The parameters paired: the ones a value can moderate (2 to 12 values),
// the strongest on the board first, at most this many.
const PAIR_DIMS = 26;

function pairDims(m) {
  const order = new Map(m.order.map((e, i) => [e.dim, i]));
  return moderatorParents(m.schema).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
}

// Every pair's interaction test, in slices; q over all pairs.
function* pairsJob(m) {
  const all = pairDims(m);
  const dims = all.slice(0, PAIR_DIMS);
  const base = summarize(m.target, m.rows);
  const res = [];
  for (let a = 0; a < dims.length; a++) {
    for (let b = 0; b < a; b++) {
      const pe = pairEffect(dims[a], dims[b], m.target, m.rows, base);
      const v = cramersV(dims[a], dims[b], m.allRows);
      res.push({ a: dims[a].id, b: dims[b].id, p: pe.p, omega2: pe.omega2, test: pe.test, V: v.V, pV: v.p });
    }
    yield;
  }
  const q = bhQ(res.map(r => r.p));
  res.forEach((r, k) => { r.q = q[k]; r.detectable = q[k] < ALPHA; r.linked = r.pV < 1e-6 && r.V > 0.03; });
  return { dims: dims.map(d => d.id), of: all.length, list: res, byKey: new Map(res.map(r => [`${r.a}|${r.b}`, r])), rows: m.rows.length };
}

export function renderPairs(view, m, A) {
  view.append(h("h1", { class: "sr", text: "Two parameters at once" }));
  const pairs = background(m, "pairs", pairsJob, A.rerender);
  view.append(pairsStrip(m, A, pairs));
  if (!pairs) {
    view.append(h("div", { class: "island pending", role: "status" }, h("span", { text: "Testing every pair…" })));
    return;
  }
  const ranked = pairs.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2);
  const chosen = chosenPair(m, pairs, ranked);
  // which pairs on the left (the ranked ones over the map of all), the
  // chosen pair on the right, in sight of either
  view.append(h("div", { class: "pr-grid" }, listIsland(m, A, pairs, ranked, chosen),
    chosen ? pairIsland(m, A, pairs, chosen) : noPair(pairs), mapIsland(m, A, pairs, chosen)));
}

// The pair the reader chose; else the strongest interaction; else the pair
// the sampler linked most, which matters as much: its effects mix.
function chosenPair(m, pairs, ranked) {
  const pr = m.state.pair;
  if (pr && m.schema.dimById.has(pr[0]) && m.schema.dimById.has(pr[1])) return { a: pr[0], b: pr[1], why: null };
  if (ranked.length) return { a: ranked[0].a, b: ranked[0].b, why: "the strongest" };
  const linked = pairs.list.filter(r => r.linked).sort((a, b) => b.V - a.V);
  return linked.length ? { a: linked[0].a, b: linked[0].b, why: "the most linked" } : null;
}

const pairOf = (pairs, a, b) => pairs.byKey.get(`${a}|${b}`) || pairs.byKey.get(`${b}|${a}`) || null;
const isChosen = (c, r) => !!c && ((c.a === r.a && c.b === r.b) || (c.a === r.b && c.b === r.a));

function shortName(d) {
  return d.kind === "scoped" ? `${d.name}@${d.scope.label.split(" = ")[1]}` : d.label;
}

function pairName(m, r) {
  return `${shortName(m.schema.dimById.get(r.a))} × ${shortName(m.schema.dimById.get(r.b))}`;
}

const omega = (r) => `${(Math.max(0, r.omega2) * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// The strip

function pairsStrip(m, A, pairs) {
  const t = m.target;
  const cells = [];
  if (!pairs) {
    cells.push(stripCell("Interacting pairs", "…", "testing every pair"));
    cells.push(stripCell("Rows", fmtInt(m.rows.length), null));
  } else {
    const total = pairs.list.length;
    const ranked = pairs.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2);
    const linked = pairs.list.filter(r => r.linked).sort((a, b) => b.V - a.V);
    const top = ranked[0] || null;
    const test = t.kind === "binary" ? "a logistic likelihood-ratio test" : "an F test";
    cells.push(stripCell("Interacting pairs", fmtInt(ranked.length), `of ${fmtInt(total)}`,
      () => h("div", null, h("b", { text: "Pairs that change each other's effect" }),
        h("div", { class: "k", text: `Their combinations explain ${inText(t.label)} beyond their two separate effects: ${test} per pair, corrected across all ${fmtInt(total)} pairs (Benjamini–Hochberg, q < 0.05).` }))));
    cells.push(stripCell("Strongest", top ? pairName(m, top) : "–", top ? `ω² ${omega(top)}` : "no pair interacts",
      () => h("div", null, h("b", { text: "The pair whose interaction explains the most" }), h("div", { class: "k", text: "ω²: the share of the needle's variance the interaction explains beyond the two separate effects." })),
      top ? () => A.set({ pair: [top.a, top.b] }) : null));
    cells.push(stripCell("Drawn together", fmtInt(linked.length), linked.length ? `${pairName(m, linked[0])}${linked.length > 1 ? ` and ${linked.length - 1} more` : ""}` : "independent, as drawn",
      () => h("div", null, h("b", { text: "Pairs the sampler did not draw independently" }),
        h("div", { class: "k", text: "Cramér's V of the pair over every row, with p < 10⁻⁶ and V over 0.03. An independent sampler gives V near zero; a linked pair's effects cannot be told apart." })),
      linked.length ? () => A.set({ pair: [linked[0].a, linked[0].b] }) : null));
    const capped = pairs.of > pairs.dims.length;
    cells.push(stripCell("Parameters", fmtInt(pairs.dims.length), capped ? `of ${fmtInt(pairs.of)} · the strongest` : "every one",
      () => h("div", null, h("b", { text: "Parameters paired" }),
        h("div", { class: "k", text: `Every parameter with 2 to 12 values${capped ? `, the ${PAIR_DIMS} strongest on the board: ${fmtInt(pairs.of - pairs.dims.length)} weaker ones are left out to keep the map readable and the tests quick` : ""}.` }))));
    cells.push(stripCell("Rows", fmtInt(pairs.rows), pairs.rows < m.rows.length ? `of ${fmtInt(m.rows.length)} · refreshing` : null,
      () => h("div", null, h("b", { text: "Rows the tests cover" }), h("div", { class: "k", text: "The tests run in the background on the rows in view; they refresh once the rows have grown by 5% or 30 seconds have passed." }))));
  }
  return strip("The pairs in figures", cells,
    { key: "pairs", label: "About the pairs", content: () => pairsAbout(m, pairs) },
    pairs ? { label: "Copy the pairs as notes", what: "Every interacting pair with its ω² and q, and any pair drawn together.", text: () => pairsNotes(m, pairs), done: "Pairs copied." } : null, A);
}

function pairsAbout(m, pairs) {
  const t = m.target;
  return about("Two parameters at once",
    `Two parameters interact when one changes the other's effect on ${inText(t.label)}: their combinations explain more than their two separate effects add up to (${t.kind === "binary" ? "a logistic likelihood-ratio test" : "an F test"} per pair, corrected across ${pairs ? `all ${fmtInt(pairs.list.length)} pairs` : "every pair"}).`,
    "A pair opens as the needle in every combination of their values, coloured against the base, with each value's own margin; a cell opens that combination on the board.",
    "The map below holds every pair: the interaction under the diagonal, and above it how the sampler drew the pair together (Cramér's V; near zero is what an independent sampler gives).");
}

function pairsNotes(m, pairs) {
  const ranked = pairs.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2);
  const linked = pairs.list.filter(r => r.linked);
  const lines = [`Pairs on ${m.ds.meta.label}: ${m.target.label}, ${fmtInt(pairs.rows)} rows, ${fmtInt(pairs.list.length)} pairs of ${fmtInt(pairs.dims.length)} parameters`];
  lines.push(ranked.length ? `Interacting (q < 0.05), strongest first:` : "No pair interacts detectably.");
  for (const r of ranked) lines.push(`- ${pairName(m, r)}: ω² ${omega(r)}, ${fmtP(r.q)}`);
  if (linked.length) {
    lines.push("Drawn together by the sampler:");
    for (const r of linked) lines.push(`- ${pairName(m, r)}: V ${r.V.toFixed(3)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The interactions, strongest first

function listIsland(m, A, pairs, ranked, chosen) {
  const linked = pairs.list.filter(r => r.linked).sort((a, b) => b.V - a.V);
  const strongest = ranked.length ? Math.max(1e-9, ranked[0].omega2) : 1;
  const isl = h("section", { class: "island pr-list", "aria-labelledby": "pr-list-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "pr-list-title", text: "Interactions" }),
      h("span", { class: "isl-count num", text: `${fmtInt(ranked.length)} of ${fmtInt(pairs.list.length)} pairs` })));
  if (!ranked.length) isl.append(h("p", { class: "isl-note", text: "No pair changes each other's effect detectably." }));
  else {
    const list = h("div", { class: "pr-rows", role: "list" });
    for (const r of ranked) list.append(pairRow(m, A, r, isChosen(chosen, r), Math.max(0, r.omega2) / strongest, `ω² ${omega(r)}`, fmtP(r.q)));
    isl.append(list);
    const quiet = pairs.list.length - ranked.length;
    if (quiet) isl.append(h("p", { class: "isl-note", text: `The other ${fmtInt(quiet)} pairs show no detectable interaction.` }));
  }
  if (linked.length) {
    const part = h("div", { class: "isl-part" }, h("h3", { class: "part-title" }, h("span", { text: "Drawn together" }),
      h("span", { class: "note", text: "the sampler linked them, so their effects mix" })));
    const list = h("div", { class: "pr-rows", role: "list" });
    const top = Math.max(1e-9, linked[0].V);
    for (const r of linked) list.append(pairRow(m, A, r, isChosen(chosen, r), r.V / top, `V ${r.V.toFixed(3)}`, null, "linked"));
    part.append(list);
    isl.append(part);
  }
  return isl;
}

function pairRow(m, A, r, on, share, figure, q, kind) {
  const row = h("button", { class: "pr-row" + (kind ? ` ${kind}` : ""), type: "button", role: "listitem", "aria-pressed": on ? "true" : "false",
    onclick: () => A.set({ pair: [r.a, r.b] }) },
    h("span", { class: "pr-name", text: pairName(m, r) }),
    h("span", { class: "pr-meter", "aria-hidden": "true" }, h("i", { style: { width: `${Math.max(4, share * 100)}%` } })),
    h("span", { class: "pr-fig num", text: figure }),
    q ? h("span", { class: "pr-q num", text: q }) : null);
  return row;
}

// ---------------------------------------------------------------------------
// One pair: the needle in every combination, with each value's margin

function noPair(pairs) {
  return h("section", { class: "island pr-pair empty-pair" }, h("p", { class: "isl-note", text: `No pair interacts detectably over these ${fmtInt(pairs.rows)} rows. Choose any cell of the map to open its pair.` }));
}

function pairIsland(m, A, pairs, chosen) {
  const t = m.target;
  let da = m.schema.dimById.get(chosen.a), db = m.schema.dimById.get(chosen.b);
  // the parameter with more values runs down the rows
  if (db.levels.length > da.levels.length) [da, db] = [db, da];
  const base = summarize(t, m.rows);
  const pe = pairEffect(da, db, t, m.rows, base);
  const r = pairOf(pairs, chosen.a, chosen.b);
  const ea = dimEffect(da, t, m.rows, base), eb = dimEffect(db, t, m.rows, base);
  // diverging scale: the largest shown distance from the base, margins included
  let span = 0;
  const reach = (c) => { if (!c.withheld && c.n && Number.isFinite(c.mean)) span = Math.max(span, Math.abs(c.mean - base.mean)); };
  pe.table.forEach(reach); ea.levels.forEach(reach); eb.levels.forEach(reach);

  const look = (conds) => A.set({ context: [...m.context.filter(x => !conds.some(c => c.dim === x.dim)), ...conds], view: "board" });
  const cell = (c, conds, where, cls = "") => {
    if (!c.n) return h("td", { class: `empty ${cls}` });
    if (c.withheld) {
      const td = h("td", { class: `withheld has-tip ${cls}` }, h("span", { class: "n", text: fmtInt(c.n) }));
      tip(td, `${where}: ${fmtInt(c.n)} rows, fewer than 30, so no number is shown`);
      return td;
    }
    const d = (c.mean - base.mean) * (t.better < 0 ? -1 : 1);
    const td = h("td", { class: `click has-tip ${cls}`, style: divergingFill(span ? d / span : 0), tabindex: "0",
      onclick: () => look(conds), onkeydown: (e) => { if (e.key === "Enter") look(conds); } },
      h("span", { class: "v", text: fmtT(t, c.mean, { unit: false, digits: t.kind === "binary" ? 0 : undefined }) }), h("span", { class: "n", text: fmtInt(c.n) }));
    tip(td, () => h("div", null, h("b", { text: fmtT(t, c.mean) }), h("span", { class: "k", text: `  [${fmtT(t, c.lo)}, ${fmtT(t, c.hi)}]` }),
      h("div", { class: "mono", text: where }),
      h("div", { class: "k", text: `${fmtInt(c.n)} rows · ${fmtDelta(t, c.mean - base.mean)} against the base${Number.isFinite(c.fitted) ? ` · the two effects alone: ${fmtT(t, c.fitted)}` : ""}` }),
      h("div", { class: "k", text: "Click to look inside it on the board." })));
    return td;
  };

  const tbl = h("table", { class: "heat pr-heat" });
  const head = h("tr", null, h("th", { class: "corner" }, h("span", { class: "mono", text: shortName(da) }), " ↓ ", h("span", { class: "mono", text: shortName(db) }), " →"));
  db.levels.forEach(l => head.append(h("th", { class: "col-h", text: l.label })));
  head.append(h("th", { class: "col-h margin-h", text: "every" }));
  tbl.append(h("thead", null, head));
  const tb = h("tbody");
  da.levels.forEach((la, a) => {
    const tr = h("tr", null, h("th", { class: "row-h", text: la.label }));
    db.levels.forEach((lb, b) => tr.append(cell(pe.table[a * db.levels.length + b], [{ dim: da.id, keys: [la.key] }, { dim: db.id, keys: [lb.key] }], `${shortName(da)} = ${la.label}, ${shortName(db)} = ${lb.label}`)));
    tr.append(cell(ea.levels[a], [{ dim: da.id, keys: [la.key] }], `${shortName(da)} = ${la.label}, any ${shortName(db)}`, "margin"));
    tb.append(tr);
  });
  const foot = h("tr", { class: "margin-row" }, h("th", { class: "row-h margin-h", text: "every" }));
  db.levels.forEach((lb, b) => foot.append(cell(eb.levels[b], [{ dim: db.id, keys: [lb.key] }], `${shortName(db)} = ${lb.label}, any ${shortName(da)}`, "margin")));
  const baseTd = h("td", { class: "margin base-cell has-tip", style: divergingFill(0) }, h("span", { class: "v", text: fmtT(t, base.mean, { unit: false, digits: t.kind === "binary" ? 0 : undefined }) }), h("span", { class: "n", text: fmtInt(base.n) }));
  tip(baseTd, `The base: ${fmtT(t, base.mean)} over the ${fmtInt(base.n)} rows in view`);
  foot.append(baseTd);
  tb.append(foot);
  tbl.append(tb);

  const testLine = Number.isFinite(pe.p) ? `${pe.test === "LR" ? "Likelihood-ratio" : "F"} test ${fmtP(pe.p, "p")}${r ? `, ${fmtP(r.q)} across the pairs` : ""}` : "Too few rows to test";
  const isl = h("section", { class: "island pr-pair", "aria-labelledby": "pr-pair-title" },
    h("header", { class: "isl-head pr-pair-head" },
      h("h2", { class: "isl-title mono", id: "pr-pair-title", text: `${shortName(da)} × ${shortName(db)}` }),
      h("span", { class: "isl-count" }, chosen.why ? `${chosen.why} · ` : "", r && r.detectable ? "they interact" : "no detectable interaction")),
    h("div", { class: "pr-figs" },
      h("span", null, h("span", { class: "k", text: "Interaction " }), h("b", { class: "num", text: Number.isFinite(pe.omega2) ? `ω² ${(Math.max(0, pe.omega2) * 100).toFixed(1)}%` : "–" })),
      h("span", { class: "muted", text: testLine }),
      r && r.linked ? h("span", { class: "tag crit", text: `drawn together, V ${r.V.toFixed(3)}` }) : null),
    h("p", { class: "isl-note pr-what", text: `${t.label} in every combination against the base ${fmtT(t, base.mean)}; "every" is a value over all of the other's.${pe.table.some(c => c.withheld) || [...ea.levels, ...eb.levels].some(l => l.withheld) ? " Hatched cells hold fewer than 30 rows." : ""}` }),
    h("div", { class: "table-wrap" }, tbl),
    h("div", { class: "legend" },
      h("span", null, h("i", { class: "box", style: { background: "var(--better)" } }), t.better < 0 ? "lower (better)" : "higher than the base"),
      h("span", null, h("i", { class: "box", style: { background: "var(--mid)", outline: "1px solid var(--line)" } }), "at the base"),
      h("span", null, h("i", { class: "box", style: { background: "var(--worse)" } }), t.better < 0 ? "higher (worse)" : "lower than the base")));
  return isl;
}

// ---------------------------------------------------------------------------
// The map of every pair

function mapIsland(m, A, pairs, chosen) {
  const dims = pairs.dims.map(id => m.schema.dimById.get(id));
  const maxW = Math.max(0.001, ...pairs.list.filter(r => r.detectable).map(r => r.omega2));
  const maxV = Math.max(0.05, ...pairs.list.map(r => (Number.isFinite(r.V) ? r.V : 0)));
  const tbl = h("table", { class: "pr-map" });
  const head = h("tr", null, h("th", { class: "corner" }));
  dims.forEach((d, j) => head.append(h("th", { class: "col-h", dataset: { j: String(j) } }, h("span", { text: shortName(d) }))));
  tbl.append(h("thead", null, head));
  const tb = h("tbody");
  dims.forEach((da, i) => {
    const tr = h("tr", null, h("th", { class: "row-h", dataset: { i: String(i) }, text: shortName(da) }));
    dims.forEach((db, j) => {
      if (i === j) { tr.append(h("td", { class: "diag", "aria-hidden": "true" })); return; }
      const r = i > j ? pairs.byKey.get(`${da.id}|${db.id}`) : pairs.byKey.get(`${db.id}|${da.id}`);
      if (!r) { tr.append(h("td", { class: "none" })); return; }
      let style = null, cls = "";
      if (i > j) {
        const t = r.detectable ? Math.max(0.15, Math.sqrt(Math.max(0, r.omega2) / maxW)) : 0;
        if (t) { style = { background: `color-mix(in oklab, var(--better) ${Math.round(t * 85)}%, var(--surface-2))` }; cls = " on"; }
      } else if (r.linked) {
        const t = Number.isFinite(r.V) ? Math.min(1, r.V / maxV) : 0;
        style = { background: `color-mix(in oklab, var(--cat-4) ${Math.round(20 + t * 70)}%, var(--surface-2))` }; cls = " on";
      }
      const td = h("td", { class: `cell has-tip${cls}${isChosen(chosen, r) ? " sel" : ""}`, style, tabindex: "0", dataset: { i: String(i), j: String(j) },
        "aria-label": pairName(m, r),
        onclick: () => A.set({ pair: [r.a, r.b] }), onkeydown: (e) => { if (e.key === "Enter") A.set({ pair: [r.a, r.b] }); } });
      tip(td, () => h("div", null, h("b", { class: "mono", text: pairName(m, r) }),
        h("div", { text: r.detectable ? `They change each other's effect: ω² ${omega(r)}, ${fmtP(r.q)}` : `No detectable interaction (${fmtP(r.q)})` }),
        h("div", { class: "k", text: `Drawn together: V ${Number.isFinite(r.V) ? r.V.toFixed(3) : "–"}${r.linked ? " (linked)" : " (independent)"}` })));
      tr.append(td);
    });
    tb.append(tr);
  });
  tbl.append(tb);
  // the row and column of the cell under the pointer light up
  tbl.addEventListener("pointerover", (e) => {
    const td = e.target.closest ? e.target.closest("td.cell") : null;
    for (const x of tbl.querySelectorAll(".hl")) x.classList.remove("hl");
    if (!td) return;
    tbl.querySelector(`th.row-h[data-i="${td.dataset.i}"]`).classList.add("hl");
    tbl.querySelector(`th.col-h[data-j="${td.dataset.j}"]`).classList.add("hl");
  });
  tbl.addEventListener("pointerleave", () => { for (const x of tbl.querySelectorAll(".hl")) x.classList.remove("hl"); });
  // the chosen pair's names stand out
  if (chosen) {
    const ia = pairs.dims.indexOf(chosen.a), ib = pairs.dims.indexOf(chosen.b);
    for (const k of [ia, ib]) if (k >= 0) {
      tbl.querySelector(`th.row-h[data-i="${k}"]`).classList.add("chosen");
      tbl.querySelector(`th.col-h[data-j="${k}"]`).classList.add("chosen");
    }
  }
  const capped = pairs.of > pairs.dims.length;
  return h("section", { class: "island pr-map-island", "aria-labelledby": "pr-map-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "pr-map-title", text: "Every pair" }),
      h("span", { class: "isl-count", text: capped ? `the ${fmtInt(pairs.dims.length)} strongest of ${fmtInt(pairs.of)} parameters` : `${fmtInt(pairs.dims.length)} parameters` }),
      h("div", { class: "legend pr-legend" },
        h("span", null, h("i", { class: "box", style: { background: "var(--better)" } }), "interact (below the diagonal)"),
        h("span", null, h("i", { class: "box", style: { background: "var(--cat-4)" } }), "drawn together (above)"),
        h("span", null, h("i", { class: "box", style: { background: "var(--surface-2)", outline: "1px solid var(--line-2)" } }), "nothing detectable"))),
    h("div", { class: "table-wrap", dataset: { scroll: "pairs-map" } }, tbl));
}
