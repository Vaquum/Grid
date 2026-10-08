// Gates: how often each gate passes, which never do and what bounds them,
// how far the rows are from each need, and which gates fail together.

import { h, icon, tip, fmtInt, fmtPct, fmtNum } from "./ui.js";
import { gateStats, coFailure, strongestCorrelate } from "./engine.js";
import { histogram } from "./charts.js";

export function renderGates(view, m, A) {
  const sc = m.schema;
  if (!sc.gates.length) {
    view.append(h("div", { class: "view-head" }, h("h1", { text: "What the gates allow" })), h("div", { class: "empty", text: "This sweep's rows carry no gates." }));
    return;
  }
  const stats = gateStats(sc, m.rows);
  const gTarget = sc.targetById.get("gates");
  let maxPassed = 0;
  if (gTarget) for (let j = 0; j < m.rows.length; j++) maxPassed = Math.max(maxPassed, gTarget.values[m.rows[j]] || 0);
  const never = stats.filter(s => s.never);
  view.append(h("div", { class: "view-head" }, h("div", null, h("h1", { text: "What the gates allow" }),
    h("div", { class: "sub", text: `${sc.gates.length} gates over ${fmtInt(m.rows.length)} rows. The most any row passes is ${maxPassed}.${never.length ? ` ${never.length === 1 ? "One gate has" : `${never.length} gates have`} never passed, so ${sc.gates.length - never.length} is the real ceiling.` : ""}` }))));

  // co-failure among the best rows
  const cf = coFailure(sc, m.rows, Math.max(0, maxPassed - 1));
  if (cf.total) {
    const card = h("div", { class: "card", style: { marginBottom: "14px" } }, h("h3", { text: `What stops the best rows (${maxPassed - 1} or more gates)` }),
      h("div", { class: "sub", text: `${fmtInt(cf.total)} rows. Each line is a set of gates they fail together.` }));
    for (const c of cf.combos.slice(0, 6)) {
      card.append(h("div", { class: "issue" }, h("span", { class: "num", style: { minWidth: "70px" }, text: fmtPct(c.share, 1) }),
        h("span", { class: "mono", text: c.failing.length ? c.failing.join(" + ") : "none (every gate passes)" }),
        h("span", { class: "muted num", text: `${fmtInt(c.count)} rows` })));
    }
    view.append(card);
  }

  const cards = h("div", { class: "cards" });
  for (const s of stats) {
    const g = sc.gates.find(x => x.id === s.id);
    const card = h("div", { class: "card" });
    card.append(h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
      h("h3", { text: s.label }), h("span", { class: "mono muted", text: s.id }),
      h("span", { class: "sev " + (s.never ? "crit" : s.always ? "ok" : "warn"), style: { marginLeft: "auto" } }, icon(s.never ? "alert" : "check"),
        s.never ? "never passed" : s.always ? "always passes" : `${fmtPct(s.rate, s.rate < 0.01 ? 2 : 1)} pass`)));
    card.append(h("div", { class: "sub", text: `Need: ${s.need}. ${fmtInt(s.passed)} of ${fmtInt(s.n)} rows pass [${fmtPct(s.lo, 2)}, ${fmtPct(s.hi, 2)}].` }));
    if (s.never) {
      const corr = strongestCorrelate(sc, g.value, m.rows, aliasesOf(sc, g.value, m.rows));
      const p = h("p", { class: "note" }, h("b", { text: "Never passed" }), ` in ${fmtInt(s.n)} rows: the true pass rate is under ${fmtPct(s.ruleOfThree, 3)} (95%, rule of three).`);
      if (Number.isFinite(s.quantiles.max)) p.append(` The best value seen is ${fmtNum(s.quantiles.max, 2)} ${g.unit || ""}.`);
      if (corr && Math.abs(corr.r) > 0.8) p.append(" ", h("b", { text: `It moves with ${corr.label.toLowerCase()} (r = ${corr.r.toFixed(3)})` }), ", so it is bounded by it: no parameter in this space can pass it while that stays where it is.");
      card.append(p);
    }
    if (s.values > 0 && (g.margin || Number.isFinite(s.quantiles.p50))) {
      const vals = [];
      for (let j = 0; j < m.rows.length; j++) { const v = g.value[m.rows[j]]; if (v === v) vals.push(v); }
      const need = g.needAt;
      card.append(histogram(vals, { need, needLabel: need !== undefined ? `need ${fmtNum(need, 2)}` : undefined, label: `${s.id} values`, height: 110 }));
      card.append(h("div", { class: "muted num", style: { fontSize: "11.5px" }, text: `median ${fmtNum(s.quantiles.p50, 2)} · 95th percentile ${fmtNum(s.quantiles.p95, 2)} · max ${fmtNum(s.quantiles.max, 2)} ${g.unit || ""}` }));
    }
    card.append(h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => A.set({ target: `gate:${s.id}`, view: "board" }) }, "What moves this gate")));
    cards.append(card);
  }
  view.append(cards);
}

// Targets that are the gate value itself (|r| > 0.999) are not an
// explanation of it.
function aliasesOf(sc, values, rows) {
  const out = [];
  for (const t of sc.targets) {
    if (t.kind === "binary") continue;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let j = 0; j < rows.length; j++) {
      const x = values[rows[j]], y = t.values[rows[j]];
      if (x !== x || y !== y) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    const vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
    if (n > 30 && vx > 0 && vy > 0 && Math.abs((sxy - sx * sy / n) / Math.sqrt(vx * vy)) > 0.999) out.push(t.id);
  }
  return out;
}
