// Pairs: which two parameters change each other's effect, and how the
// sampler drew them together; a pair opens as a value-by-value grid.

import { h, tip, fmtT, fmtInt, fmtP, fmtDelta, famColor } from "./ui.js";
import { pairEffect, cramersV, summarize, ALPHA } from "./engine.js";
import { bhQ } from "./stats.js";
import { moderatorParents, background } from "./model.js";
import { divergingFill } from "./charts.js";

function pairDims(m) {
  const order = new Map(m.order.map((e, i) => [e.dim, i]));
  return moderatorParents(m.schema).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999)).slice(0, 26);
}

// Every pair's interaction test, in slices; q over all pairs.
function* pairsJob(m) {
  const dims = pairDims(m);
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
  res.forEach((r, k) => { r.q = q[k]; r.detectable = q[k] < ALPHA; });
  return { dims: dims.map(d => d.id), list: res, byKey: new Map(res.map(r => [`${r.a}|${r.b}`, r])), rows: m.rows.length };
}

export function renderPairs(view, m, A) {
  view.append(h("div", { class: "view-head" }, h("div", null, h("h1", { text: "Two parameters at once" }),
    h("div", { class: "sub", text: `Below the diagonal: how much a pair changes each other's effect on ${m.target.label.toLowerCase()} (the interaction beyond their separate effects; ${m.target.kind === "binary" ? "logistic likelihood-ratio test" : "F test"}, corrected across all pairs). Above it: how the sampler drew the pair together (Cramér's V; near zero is what an independent sampler gives). Choose a cell to open the pair.` }))));
  const pairs = background(m, "pairs", pairsJob, A.rerender);
  if (!pairs) { view.append(h("p", { class: "muted", text: "Testing every pair…" })); return; }
  const dims = pairs.dims.map(id => m.schema.dimById.get(id));
  const maxW = Math.max(0.001, ...pairs.list.filter(r => r.detectable).map(r => r.omega2));
  const maxV = Math.max(0.05, ...pairs.list.map(r => (Number.isFinite(r.V) ? r.V : 0)));
  const tbl = h("table", { class: "heat", style: { borderSpacing: "2px" } });
  const head = h("tr", null, h("th", { class: "corner" }));
  dims.forEach((d, j) => head.append(h("th", { style: { writingMode: "vertical-rl", transform: "rotate(180deg)", height: "120px", textAlign: "left", fontSize: "10.5px" }, text: shortName(d) })));
  tbl.append(h("thead", null, head));
  const tb = h("tbody");
  dims.forEach((da, i) => {
    const tr = h("tr", null, h("th", { style: { textAlign: "right", fontSize: "10.5px" } },
      h("i", { style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "2px", background: famColor(da.family), marginRight: "5px" } }), shortName(da)));
    dims.forEach((db, j) => {
      if (i === j) { tr.append(h("td", { style: { background: "var(--surface-3)", minWidth: "22px", height: "22px" } })); return; }
      const r = i > j ? pairs.byKey.get(`${da.id}|${db.id}`) : pairs.byKey.get(`${db.id}|${da.id}`);
      if (!r) { tr.append(h("td", { class: "empty", style: { minWidth: "22px", height: "22px" } })); return; }
      let style;
      if (i > j) {
        const t = r.detectable ? Math.max(0.15, Math.sqrt(Math.max(0, r.omega2) / maxW)) : 0;
        style = { background: t ? `color-mix(in oklab, var(--better) ${Math.round(t * 85)}%, var(--surface-2))` : "var(--surface-2)" };
      } else {
        const t = Number.isFinite(r.V) ? Math.min(1, r.V / maxV) : 0;
        const linked = r.pV < 1e-6 && r.V > 0.03;
        style = { background: linked ? `color-mix(in oklab, var(--f-labels) ${Math.round(20 + t * 70)}%, var(--surface-2))` : "var(--surface-2)" };
      }
      const td = h("td", { class: "click has-tip", style: { ...style, minWidth: "22px", height: "22px" }, tabindex: "0",
        onclick: () => A.set({ pair: [r.a, r.b] }), onkeydown: (e) => { if (e.key === "Enter") A.set({ pair: [r.a, r.b] }); } });
      tip(td, () => h("div", null, h("b", { class: "mono", text: `${shortName(m.schema.dimById.get(r.a))} × ${shortName(m.schema.dimById.get(r.b))}` }),
        h("div", { text: r.detectable ? `They change each other's effect: ω² ${(Math.max(0, r.omega2) * 100).toFixed(2)}%, ${fmtP(r.q)}` : `No detectable interaction (${fmtP(r.q)})` }),
        h("div", { class: "k", text: `Drawn together: V ${Number.isFinite(r.V) ? r.V.toFixed(3) : "–"}${r.pV < 1e-6 && r.V > 0.03 ? " (linked)" : " (independent)"}` })));
      tr.append(td);
    });
    tb.append(tr);
  });
  tbl.append(tb);
  const grid = h("div", { style: { display: "flex", gap: "26px", flexWrap: "wrap", alignItems: "flex-start" } });
  grid.append(h("div", { class: "table-wrap" }, tbl,
    h("div", { class: "legend", style: { marginTop: "8px" } },
      h("span", null, h("i", { class: "box", style: { background: "var(--better)" } }), "interaction (darker is stronger)"),
      h("span", null, h("i", { class: "box", style: { background: "var(--f-labels)" } }), "drawn together"),
      h("span", null, h("i", { class: "box", style: { background: "var(--surface-2)", outline: "1px solid var(--line)" } }), "nothing detectable"))));
  const top = pairs.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2).slice(0, 10);
  const list = h("div", { style: { minWidth: "260px", flex: "1 1 260px" } }, h("div", { class: "section-title", style: { marginTop: 0 }, text: "Strongest interactions" }));
  if (!top.length) list.append(h("p", { class: "muted", text: "No pair changes each other's effect detectably." }));
  for (const r of top) {
    list.append(h("button", { class: "chip", style: { display: "flex", width: "100%", marginBottom: "5px", paddingRight: "8px" }, onclick: () => A.set({ pair: [r.a, r.b] }) },
      h("span", { class: "mono", text: `${shortName(m.schema.dimById.get(r.a))} × ${shortName(m.schema.dimById.get(r.b))}` }),
      h("span", { class: "muted num", style: { marginLeft: "auto" }, text: `ω² ${(r.omega2 * 100).toFixed(2)}%` })));
  }
  grid.append(list);
  view.append(grid);
  const pr = m.state.pair;
  if (pr && m.schema.dimById.has(pr[0]) && m.schema.dimById.has(pr[1])) view.append(pairDetail(m, A, m.schema.dimById.get(pr[0]), m.schema.dimById.get(pr[1])));
}

function shortName(d) {
  return d.kind === "scoped" ? `${d.name}@${d.scope.label.split(" = ")[1]}` : d.label;
}

export function pairDetail(m, A, da, db) {
  const t = m.target;
  const base = summarize(t, m.rows);
  const pe = pairEffect(da, db, t, m.rows, base);
  const wrap = h("div", { class: "card", style: { marginTop: "18px" } });
  wrap.append(h("h3", { class: "mono", text: `${shortName(da)} × ${shortName(db)}` }),
    h("div", { class: "sub", text: `${t.label} in each combination, against the base ${fmtT(t, base.mean)}. ${Number.isFinite(pe.p) ? `Interaction ${pe.test === "LR" ? "likelihood-ratio" : "F"} test: ${fmtP(pe.p, "p")}${Number.isFinite(pe.omega2) ? `, ω² ${(Math.max(0, pe.omega2) * 100).toFixed(2)}%` : ""}.` : ""} Hatched cells have fewer than 30 rows.` }));
  // diverging scale: the largest shown distance from the base
  let span = 0;
  for (const c of pe.table) if (!c.withheld && Number.isFinite(c.mean)) span = Math.max(span, Math.abs(c.mean - base.mean));
  const tbl = h("table", { class: "heat" });
  const head = h("tr", null, h("th", { class: "corner", text: `${shortName(da)} ↓  ${shortName(db)} →` }));
  db.levels.forEach(l => head.append(h("th", { text: l.label })));
  tbl.append(h("thead", null, head));
  const tb = h("tbody");
  da.levels.forEach((la, a) => {
    const tr = h("tr", null, h("th", { style: { textAlign: "right" }, text: la.label }));
    db.levels.forEach((lb, b) => {
      const c = pe.table[a * db.levels.length + b];
      if (!c.n) { tr.append(h("td", { class: "empty" })); return; }
      if (c.withheld) {
        const td = h("td", { class: "withheld has-tip" }, h("span", { class: "n", text: fmtInt(c.n) }));
        tip(td, `${fmtInt(c.n)} rows: fewer than 30, so no number is shown`);
        tr.append(td);
        return;
      }
      const d = (c.mean - base.mean) * (t.better < 0 ? -1 : 1);
      const td = h("td", { class: "click has-tip", style: divergingFill(span ? d / span : 0), tabindex: "0",
        onclick: () => A.set({ context: [...m.context.filter(x => x.dim !== da.id && x.dim !== db.id), { dim: da.id, keys: [la.key] }, { dim: db.id, keys: [lb.key] }], view: "board" }) },
        fmtT(t, c.mean, { unit: false, digits: t.kind === "binary" ? 0 : undefined }), h("span", { class: "n", text: fmtInt(c.n) }));
      tip(td, () => h("div", null, h("b", { text: fmtT(t, c.mean) }), h("span", { class: "k", text: `  [${fmtT(t, c.lo)}, ${fmtT(t, c.hi)}]` }),
        h("div", { class: "mono", text: `${shortName(da)} = ${la.label}, ${shortName(db)} = ${lb.label}` }),
        h("div", { class: "k", text: `${fmtInt(c.n)} rows · ${fmtDelta(t, c.mean - base.mean)} against the base · additive fit ${fmtT(t, c.fitted)}` }),
        h("div", { class: "k", text: "Click to look inside this cell on the board." })));
      tr.append(td);
    });
    tb.append(tr);
  });
  tbl.append(tb);
  wrap.append(h("div", { class: "table-wrap" }, tbl),
    h("div", { class: "legend" }, h("span", null, h("i", { class: "box", style: { background: "var(--better)" } }), t.better < 0 ? "lower (better)" : "higher than the base"),
      h("span", null, h("i", { class: "box", style: { background: "var(--mid)", outline: "1px solid var(--line)" } }), "at the base"),
      h("span", null, h("i", { class: "box", style: { background: "var(--worse)" } }), t.better < 0 ? "higher (worse)" : "lower than the base")));
  return wrap;
}
