// Features: what including each member of a sampled subset does to the
// target, stratified by subset size.

import { h, tip, fmtT, fmtInt, fmtPct, fmtP, fmtDelta, copyText, icon, inText } from "./ui.js";
import { memberEffects, dimEffect } from "./engine.js";
import { memberDims } from "./model.js";
import { lineChart, intervalBar } from "./charts.js";

export function renderFeatures(view, m, A) {
  const t = m.target;
  const members = memberDims(m.schema);
  if (!members.length) {
    view.append(h("div", { class: "view-head" }, h("h1", { text: "Feature inclusion" })), h("div", { class: "empty", text: "This sweep samples no subsets." }));
    return;
  }
  const sets = [...new Set(members.map(d => d.set.column))];
  for (const col of sets) renderSet(view, m, A, col, members.filter(d => d.set.column === col));
}

function renderSet(view, m, A, col, members) {
  const t = m.target;
  const size = m.schema.dimById.get(members[0].set.sizeDim);
  const c = m.cache;
  const key = `${c.key}|${col}`;
  if (c.membersKey !== key) { c.members = memberEffects(m.schema, members, size, t, m.rows); c.membersKey = key; }
  const res = c.members;
  const sorted = [...res.members].sort((a, b) => (m.state.featSort === "name" ? a.name.localeCompare(b.name) : (b.delta - a.delta) * (t.better < 0 ? -1 : 1)));
  view.append(h("div", { class: "view-head" },
    h("div", null, h("h1", null, "Including each of ", h("span", { class: "mono", text: col })),
      h("div", { class: "sub", text: `${members.length} members, drawn in random subsets. For each, the difference in ${inText(t.label)} between rows that included it and rows that left it out, compared inside each subset size and averaged (subset size is drawn too, and larger subsets include every member more often). Inclusion is randomised, so each difference reads as that member's average effect over the rest of the space.` })),
    h("div", { class: "tools" }, h("div", { class: "seg" },
      h("button", { "aria-pressed": m.state.featSort !== "name" ? "true" : "false", onclick: () => A.set({ featSort: "effect" }, { replace: true }), text: "by effect" }),
      h("button", { "aria-pressed": m.state.featSort === "name" ? "true" : "false", onclick: () => A.set({ featSort: "name" }, { replace: true }), text: "by name" })))));
  let lo = 0, hi = 0;
  for (const r of res.members) if (Number.isFinite(r.lo)) { lo = Math.min(lo, r.lo); hi = Math.max(hi, r.hi); }
  const pad = (hi - lo) * 0.05 || 1e-3;
  lo -= pad; hi += pad;
  const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null,
    h("th", { text: "member" }), h("th", { class: "r", text: "included in" }), h("th", { class: "r", text: "difference" }),
    h("th", { style: { width: "34%" }, text: "95% interval (vertical line: no difference)" }), h("th", { class: "r", text: "corrected" }), h("th", { text: "" }))));
  const tb = h("tbody");
  for (const r of sorted) {
    const helps = r.detectable && r.delta * (t.better < 0 ? -1 : 1) > 0;
    const hurts = r.detectable && !helps;
    const tr = h("tr", { class: "clickable", tabindex: "0", onclick: () => A.select({ kind: "dim", id: r.id }),
      onkeydown: (e) => { if (e.key === "Enter") A.select({ kind: "dim", id: r.id }); } },
      h("td", { class: "v", text: r.name }),
      h("td", { class: "r num", text: fmtPct(r.share, 0) }),
      h("td", { class: "r num", text: fmtDelta(t, r.delta, { digits: t.kind === "binary" ? 1 : 3 }) }),
      h("td", null, forestBar(r, lo, hi, t.better < 0 ? -1 : 1)),
      h("td", { class: "r num", text: fmtP(r.q) }),
      h("td", null, helps ? h("span", { class: "badge good", text: "helps" }) : hurts ? h("span", { class: "badge crit", text: "hurts" }) : h("span", { class: "muted", text: "no detectable effect" })));
    tip(tr.children[3], `${fmtDelta(t, r.lo)} to ${fmtDelta(t, r.hi)} · included ${fmtInt(r.nIn)} rows (${fmtT(t, r.inMean)}), left out ${fmtInt(r.nOut)} (${fmtT(t, r.outMean)})`);
    tb.append(tr);
  }
  tbl.append(tb);
  view.append(h("div", { class: "card table-wrap" }, tbl));

  // keep / drop advice as a list the next sweep can use
  const helps = sorted.filter(r => r.detectable && r.delta * (t.better < 0 ? -1 : 1) > 0).map(r => r.name);
  const hurts = sorted.filter(r => r.detectable && r.delta * (t.better < 0 ? -1 : 1) < 0).map(r => r.name);
  const text = `# ${col}: inclusion effects on ${inText(t.label)} (${m.ds.meta.label}, ${fmtInt(m.rows.length)} rows)\nalways_include: [${helps.join(", ")}]\ndrop_from_pool: [${hurts.join(", ")}]`;
  const pre = h("pre", { class: "code", text });
  view.append(h("div", { class: "section-title", text: "For the next pool" }),
    h("p", { class: "note", text: `${helps.length} members help and ${hurts.length} hurt detectably (q < 0.05 across the ${members.length} members). The rest are indistinguishable from leaving them out.` }),
    h("div", { class: "code-head" }, h("span", { text: "As YAML" }), h("button", { class: "btn small", onclick: async () => { await copyText(text, pre); } }, icon("copy"), "Copy")), pre);

  // subset size
  if (size) {
    const e = dimEffect(size, t, m.rows, m.base);
    const pts = e.levels.filter(l => l.n >= 30).map(l => [l.value, l.mean]);
    const los = e.levels.filter(l => l.n >= 30).map(l => [l.value, l.lo]);
    const his = e.levels.filter(l => l.n >= 30).map(l => [l.value, l.hi]);
    view.append(h("div", { class: "section-title", text: "Subset size" }),
      h("div", { class: "card" }, h("h3", { text: `${t.label} by the number of members` }),
        h("div", { class: "sub", text: `${fmtP(e.p, "p")} for any difference across sizes. Thin lines bound the 95% interval.` }),
        lineChart([{ label: t.label, color: "var(--ink)", points: pts }, { label: "95% interval", color: "var(--muted)", points: los, width: 1, endDot: false },
          { label: "", color: "var(--muted)", points: his, width: 1, endDot: false }],
        { height: 170, xLabel: "members", fmtX: v => String(v), fmtY: v => fmtT(t, v), label: "target by subset size" })));
  }
}

function forestBar(r, lo, hi, better) {
  const tone = r.detectable ? (r.delta * better > 0 ? "best" : "worst") : null;
  return intervalBar(r.delta, r.lo, r.hi, 0, [lo, hi], { tone });
}
