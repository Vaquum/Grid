// Trials: the best rows by the runner's own objective, each one a click
// from its full record and its replay command.

import { h, tip, fmtT, fmtInt, inText } from "./ui.js";
import { objectiveTop, records } from "./model.js";

export function renderTrials(view, m, A) {
  const sc = m.schema;
  if (!sc.objective) {
    view.append(h("div", { class: "view-head" }, h("h1", { text: "The best rows" })),
      h("div", { class: "empty", text: "No objective is known for this sweep; pick a target and use the Pocket view to find its best rows." }));
    return;
  }
  const top = objectiveTop(m, m.rows, 100);
  const objT = sc.objective.map(([c]) => sc.targetById.get(c));
  const rc = records(m);
  view.append(h("div", { class: "view-head" }, h("div", null, h("h1", { text: "The best rows" }),
    h("div", { class: "sub", text: `Ranked by ${sc.objectiveLabel}, as the runner ranks them, over ${fmtInt(m.rows.length)} rows${m.context.length ? " in the context" : ""}. The best of many noisy rows is also the luckiest: compare the top against the luck line in the Run view before trusting it.` }))));
  const cols = [
    ["gates", "gates", t => String(t)],
    ["mean_mo", "%/mo", null], ["total", "total", null], ["maxDD", "max DD", null], ["auc", "AUC", null], ["sec", "s", null],
  ].filter(([c]) => sc.targetById.has(c));
  const paramCols = ["model", "tp", "sl", "label_q", "label_mode", "nfeats", "meta", "mthr"].filter(c => sc.dimById.has(c));
  const tbl = h("table", { class: "vals" });
  tbl.append(h("thead", null, h("tr", null, h("th", { class: "r", text: "#" }), h("th", { class: "r", text: "row" }), sc.gates.length ? h("th", { text: "gates passed" }) : null,
    cols.map(([, label]) => h("th", { class: "r", text: label })), paramCols.map(c => h("th", { text: c })))));
  const tb = h("tbody");
  top.forEach((i, k) => {
    const sel = m.state.sel && m.state.sel.kind === "row" && m.state.sel.i === i;
    const tr = h("tr", { class: "clickable", tabindex: "0", "aria-selected": sel ? "true" : "false",
      onclick: () => A.select({ kind: "row", i }), onkeydown: (e) => { if (e.key === "Enter") A.select({ kind: "row", i }); } },
      h("td", { class: "r num", text: String(k + 1) }), h("td", { class: "r num muted", text: fmtInt(i) }));
    if (sel) tr.classList.add("sel");
    if (sc.gates.length) {
      const pills = h("span", { class: "pills has-tip" });
      for (const g of sc.gates) pills.append(h("span", { class: "pill" + (g.pass[i] === 1 ? " pass" : "") }));
      tip(pills, () => h("div", null, sc.gates.map(g => h("div", null, h("b", { text: g.pass[i] === 1 ? "pass " : "fail " }), h("span", { class: "mono", text: g.id }), h("span", { class: "k", text: `  ${g.need}` })))));
      tr.append(h("td", null, pills));
    }
    for (const [c] of cols) {
      const t = sc.targetById.get(c);
      tr.append(h("td", { class: "r num", text: c === "gates" ? String(t.values[i]) : fmtT(t, t.values[i], { unit: false }) }));
    }
    for (const c of paramCols) {
      const d = sc.dimById.get(c);
      const code = d.codes[i];
      tr.append(h("td", { class: "v", text: code >= 0 ? d.levels[code].label : "–" }));
    }
    tb.append(tr);
  });
  tbl.append(tb);
  view.append(h("div", { class: "card table-wrap" }, tbl));
  if (rc.records.length) {
    const last = rc.records[rc.records.length - 1];
    view.append(h("p", { class: "muted", text: `${rc.records.length} times a new best ${m.target.kind === "binary" ? inText(objT[objT.length - 1].label) : inText(m.target.label)} arrived; the last at row ${fmtInt(last.row)}.` }));
  }
}
