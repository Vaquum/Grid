// The inspector: a parameter (what it is, its attributes, where it acts,
// its values and how their estimates settled), a value, or one row in full.

import { h, icon, tip, clear, fmtT, fmtP, fmtInt, fmtNum, fmtPct, fmtDelta, fmtRowValue, fmtStamp, copyText, inText, rangeText } from "./ui.js";
import { miniBar, lineChart, needleDomain } from "./charts.js";
import { dimEffect, uniformity } from "./engine.js";
import { rowObject } from "./pack.js";
import { ensureModerators, independence, bestRows, objectiveKeys, effectOf, setName, TOGETHER, together, togetherWhy } from "./model.js";
import { actsPhrase, strengthText, scopeText } from "./view-board.js";

const KIND_TEXT = { cat: "Category", num: "Number", bool: "Switch", member: "Set member", scoped: "Nested number", size: "Subset size" };

export function renderInspector(el, m, A) {
  clear(el);
  const sel = m.state.sel;
  if (!sel) return;
  const box = h("div", { class: "insp-in" });
  el.append(box);
  if (sel.kind === "dim" || sel.kind === "level") {
    const d = m.schema.dimById.get(sel.kind === "dim" ? sel.id : sel.dim);
    if (!d) { box.append(closeRow(A), h("p", { class: "muted", text: "This parameter is not in the current run." })); return; }
    dimDetail(box, m, A, d, sel.kind === "level" ? sel.key : null);
  } else if (sel.kind === "row") {
    rowDetail(box, m, A, sel.i);
  }
}

function closeRow(A, title) {
  return h("div", { class: "insp-head" }, title || null,
    h("button", { class: "icon-btn close", "aria-label": "Close the inspector", dataset: { focus: "insp-close" }, onclick: () => A.select(null) }, icon("close")));
}

function part(title, ...kids) {
  return h("section", { class: "part" }, h("h3", { text: title }), ...kids);
}

// ---------------------------------------------------------------------------

function dimDetail(box, m, A, d, levelKey) {
  const { target, base, rows } = m;
  const found = effectOf(m, d.id);
  const e = found ? found.effect : dimEffect(d, target, rows, base);
  const family = found ? `${found.tests} ${found.family}` : "no family: not corrected";
  box.append(closeRow(A, h("div", null,
    h("div", { class: "eyebrow" }, `${KIND_TEXT[d.kind] || d.kind} · ${d.levels.length} values`,
      d.scope ? ` · ${scopeText(m, d)}` : "",
      d.role !== "param" ? ` · ${d.role}` : ""),
    h("h2", { class: "mono", text: d.label }))));
  // verdict
  box.append(verdict(m, d, e));

  // attributes
  const mods = ensureModerators(m, A.rerender);
  const md = mods && mods.byDim.get(d.id);
  const facts = h("dl", { class: "facts" });
  const fact = (k, v, t) => { const dt = h("dt", { text: k }); const dd = h("dd", null, v); if (t) tip(dd, t); facts.append(dt, dd); };
  fact("Strength", `ω² ${strengthText(e)}`, "Bias-corrected share of the needle's variance this parameter explains on its own.");
  fact("Test", e.test === "G" ? `G = ${fmtNum(e.G, 1)}, ${e.k - 1} df, ${fmtP(e.p, "p")}` : `F(${e.df1}, ${e.df2}) = ${fmtNum(e.F, 2)}, ${fmtP(e.p, "p")}`,
    e.test === "G" ? "Likelihood-ratio test that every value has the same rate." : "One-way analysis of variance.");
  fact("After correction", `${fmtP(e.q)} (Benjamini–Hochberg over ${family})`);
  fact("Rows", `${fmtInt(e.N)} with a value${e.na ? ` · ${fmtInt(e.na)} where it does not apply` : ""}`);
  const uni = uniformity(d, m.allRows);
  if (Number.isFinite(uni.p)) {
    const tilt = uni.p < 1e-6;
    fact("Sampler", `${tilt ? "uneven" : "even"} draw (χ² ${fmtP(uni.p, "p")})`,
      tilt ? "The values were not drawn equally often. That can be by design (pf_frac is drawn for 2% of rows) or a sampler problem; the shares are in the table below." : "Each value was drawn about equally often, as a uniform sampler does.");
  }
  // the pair the board tags, when it is drawn together with any: the
  // strongest of those drawn together; else the closest of all
  const mine = independence(m).filter(p => p.a === d.id || p.b === d.id).sort((a, b) => b.V - a.V);
  const indep = mine.find(p => together(p.p, p.V)) || mine[0];
  if (indep) {
    const o = m.schema.dimById.get(indep.a === d.id ? indep.b : indep.a);
    const bad = together(indep.p, indep.V);
    fact("Independence", bad
      ? h("span", { class: "sev warn" }, icon("alert"), `${TOGETHER} with `, h("span", { class: "mono", text: o.label }), ` (V ${fmtNum(indep.V, 3)})`)
      : h("span", null, "drawn independently; the closest is ", h("span", { class: "mono", text: o.label }), ` (V ${fmtNum(indep.V, 3)})`),
      bad ? `${togetherWhy(indep.V)} Use the context to look inside one of its values.` : "Cramér's V against every other sampled parameter; the largest is shown. Near zero means drawn independently, which is what lets a marginal difference read as an effect.");
  }
  box.append(part("Attributes", facts));
  // moderators
  if (mods) {
    const list = h("div");
    if (md && md.mods.length) {
      const top = md.mods.slice(0, 4);
      for (const mo of top) {
        list.append(h("div", { class: "issue" },
          h("span", { class: "sev " + (mo.detectable ? "on" : "off"), text: mo.detectable ? "changes it" : "no change" }),
          h("span", null, h("span", { class: "mono", text: mo.label }), h("span", { class: "muted", text: `  ${fmtP(mo.q)}` }))));
      }
      if (md.acts) list.prepend(h("p", { class: "note" }, h("b", { text: (s => s.charAt(0).toUpperCase() + s.slice(1))(actsPhrase(m, md.acts)) }), `. The ${setName(m, [md.acts.parent, d.id])} interaction is detectable (${fmtP(md.acts.q)}, corrected across the board's ${fmtInt(mods.tests)} tests).`));
      else list.prepend(h("p", { class: "note", text: "No other parameter changes its effect detectably." }));
    } else list.append(h("p", { class: "muted", text: "No moderator tests for this parameter." }));
    box.append(part("Where it acts", list));
  } else {
    box.append(part("Where it acts", h("p", { class: "muted", text: "Checking every other parameter…" })));
  }

  // its values
  const domain = needleDomain([e], base.mean);
  const tbl = h("table", { class: "vals" },
    h("thead", null, h("tr", null, h("th", { text: "Value" }), h("th", { class: "r", text: "Rows" }), h("th", { class: "r", text: target.label }),
      tip(h("th", { class: "r has-tip", text: "Difference" }), `Each value's ${inText(target.label)} against the base, ${fmtT(target, base.mean)} over the rows in view.`),
      h("th", { style: { width: "34%" }, text: "95% interval" }))));
  const tb = h("tbody");
  const shareOf = new Map(d.levels.map((l, j) => [l.key, uni.shares ? uni.shares[j] : NaN]));
  for (const l of e.levels) {
    if (!(l.n > 0)) continue;
    const tr = h("tr", { class: "clickable" + (l.withheld ? " withheld" : "") + (levelKey === l.key ? " sel" : ""), tabindex: "0",
      dataset: { focus: `level:${l.key}` },
      "aria-selected": levelKey === l.key ? "true" : "false",
      onclick: () => A.select({ kind: "level", dim: d.id, key: l.key }),
      onkeydown: (ev) => { if (ev.key === "Enter") A.select({ kind: "level", dim: d.id, key: l.key }); } },
      h("td", { class: "v", text: l.label }),
      h("td", { class: "r num has-tip", text: fmtInt(l.n) }),
      h("td", { class: "r num", text: l.withheld ? "–" : fmtT(target, l.mean) }),
      h("td", { class: "r num", text: l.withheld ? "–" : fmtDelta(target, l.lift) }),
      h("td", null, miniBar(l, domain, base.mean)));
    tip(tr.children[1], `${fmtPct(shareOf.get(l.key), 1)} of the rows where ${d.label} applies drew this value`);
    tip(tr.children[4], l.withheld ? "Fewer than 30 rows: no interval." : `95% ${rangeText(target, l.lo, l.hi)}`);
    tb.append(tr);
  }
  tbl.append(tb);
  const deg4 = part("Values", h("div", { class: "table-wrap" }, tbl));
  if (levelKey) {
    const l = d.levels.find(x => x.key === levelKey);
    deg4.append(h("div", { class: "actions" },
      h("span", { class: "muted", text: `${d.label} = ${l ? l.label : levelKey}` }),
      h("button", { class: "btn", onclick: () => A.addContext(d.id, levelKey) }, "Look inside it ", h("kbd", { text: "C" })),
      h("button", { class: "btn", onclick: () => A.addPocket(d.id, levelKey) }, "Add to pocket ", h("kbd", { text: "P" }))));
  } else {
    deg4.append(h("p", { class: "muted", style: { marginTop: "6px" }, text: "Choose a value to look inside it or to stack it into a pocket." }));
  }
  box.append(deg4);
  box.append(part("How the estimates settled", settling(m, d, e)));
}

function verdict(m, d, e) {
  const t = m.target;
  const p = h("p", { class: "verdict" });
  if (!e.detectable) {
    const shown = e.levels.filter(l => !l.withheld && l.n > 0);
    const spread = shown.length > 1 ? Math.max(...shown.map(l => l.mean)) - Math.min(...shown.map(l => l.mean)) : NaN;
    p.append(h("b", { text: "No detectable effect" }), ` on ${inText(t.label)} (${fmtP(e.q)}). `,
      Number.isFinite(spread) ? `Its values differ by at most ${fmtDelta(t, spread).replace(/^\+/, "")}, which the noise explains.` : "");
    return p;
  }
  const b = e.best, w = e.worst;
  p.append("Moves ", inText(t.label), " from ", h("b", { text: fmtT(t, w.mean) }), " (", h("span", { class: "mono", text: w.label }), ") to ",
    h("b", { text: fmtT(t, b.mean) }), " (", h("span", { class: "mono", text: b.label }), "). ",
    `It explains ${strengthText(e)} of the variance on its own, ${fmtP(e.q)}.`);
  if (e.dead.length) p.append(" ", h("b", { text: `Dead value${e.dead.length > 1 ? "s" : ""}: ${e.dead.map(k => (e.levels.find(l => l.key === k) || {}).label).join(", ")}.` }));
  return p;
}

// Each value's estimate as rows arrived (60 checkpoints), so a reader can
// see whether the picture has settled or is still moving.
function settling(m, d, e) {
  const rows = m.rows, y = m.target.values, codes = d.codes;
  const k = d.levels.length;
  const cnt = new Float64Array(k), sum = new Float64Array(k);
  const shown = e.levels.map((l, j) => j).filter(j => !e.levels[j].withheld && e.levels[j].n > 0)
    .sort((a, b) => e.levels[b].mean - e.levels[a].mean);
  const pick = shown.length > 4 ? [shown[0], shown[1], shown[shown.length - 2], shown[shown.length - 1]] : shown;
  // each value its own series colour, highest first: which value a line is,
  // not whether it is better (the legend names them)
  const series = pick.map((j, i) => ({ label: d.levels[j].label, color: `var(--cat-${i + 1})`, points: [] }));
  const steps = 60, every = Math.max(1, Math.floor(rows.length / steps));
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j], c = codes[i], v = y[i];
    if (c >= 0 && v === v) { cnt[c]++; sum[c] += v; }
    if ((j + 1) % every === 0 || j === rows.length - 1) {
      pick.forEach((lv, s) => { if (cnt[lv] >= 30) series[s].points.push([j + 1, sum[lv] / cnt[lv]]); });
    }
  }
  if (!series.some(sr => sr.points.length > 1)) return h("p", { class: "muted", text: "Not enough rows per value yet." });
  const fig = lineChart(series, { height: 150, width: 360, xLabel: "rows", target: m.target, label: `${d.label}: estimates as rows arrived` });
  return h("div", null, h("p", { class: "muted", style: { margin: "0 0 4px" }, text: pick.length < shown.length ? "The two highest and two lowest values; each line starts once a value has 30 rows." : "Each line starts once a value has 30 rows." }), fig);
}

function toastCopy(ok) {
  const el = document.querySelector(".toasts");
  if (!el) return;
  const t = h("div", { class: "toast", text: ok ? "Copied." : "Copying was refused; the text is selected, copy it by hand." });
  el.append(t);
  setTimeout(() => t.remove(), 3000);
}

// ---------------------------------------------------------------------------

// Where a row ranks among the rows in view, as the Trials view ranks them.
function rankLine(m, i) {
  const best = bestRows(m);
  if (!best) return "row";
  const at = best.list.find(x => x.i === i);
  if (at) return `#${at.rank}${at.tie > 1 ? "=" : ""} by ${m.schema.objectiveLabel}`;
  const c = best.cut;
  if (c && objectiveKeys(m).every(({ t }) => t.values[i] === t.values[c.row]) && m.rows.includes(i)) return `one of ${fmtInt(c.n)} rows tied at #${c.rank} by ${m.schema.objectiveLabel}`;
  return "row";
}

function rowDetail(box, m, A, i) {
  const ds = m.ds, sc = m.schema;
  if (!(i >= 0 && i < ds.n)) { box.append(closeRow(A), h("p", { class: "muted", text: `Row ${i} is not in this run.` })); return; }
  const obj = rowObject(ds, i);
  box.append(closeRow(A, h("div", null, h("div", { class: "eyebrow", text: rankLine(m, i) }), h("h2", { text: `Row ${fmtInt(i)}` }))));
  if (Number.isFinite(ds.arrivals[i])) box.append(h("p", { class: "muted", text: `Arrived ${fmtStamp(ds.arrivals[i])}` }));
  // gates
  if (sc.gates.length) {
    const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null, h("th", { text: "Gate" }), h("th", { text: "Value" }), h("th", { text: "Need" }), h("th", { text: "" }))));
    const tb = h("tbody");
    for (const g of sc.gates) {
      const pass = g.pass[i];
      // a gate set here reads its needle; the runner's, the value it wrote
      const raw = g.set ? null : obj.gates_detail && obj.gates_detail[g.id] ? obj.gates_detail[g.id].v : null;
      const value = g.set ? fmtRowValue(g.target, g.value[i]) : raw === null ? "–" : Array.isArray(raw) ? raw.join(" / ") : String(raw);
      tb.append(h("tr", null, h("td", { class: g.set ? null : "v", text: g.set ? inText(g.target.label) : g.id }), h("td", { class: "v", text: value }),
        h("td", { class: "muted", text: g.need }),
        h("td", null, pass === pass ? h("span", { class: "sev " + (pass ? "ok" : "crit") }, icon(pass ? "check" : "close"), pass ? "pass" : "fail")
          : h("span", { class: "sev off", text: "no value" }))));
    }
    tbl.append(tb);
    box.append(part("Gates", h("div", { class: "table-wrap" }, tbl)));
  }
  // outcomes
  const outs = h("dl", { class: "facts" });
  for (const t of sc.targets.filter(x => !x.gate)) {
    const v = t.values[i];
    if (!Number.isFinite(v)) continue;
    outs.append(h("dt", { text: t.label }), h("dd", { class: "num", text: fmtRowValue(t, v) }));
  }
  box.append(part("Outcomes", outs));
  // its parameters
  const params = h("dl", { class: "facts" });
  for (const d of sc.dims.filter(x => (x.role === "param" || x.role === "effective") && x.kind !== "member")) {
    const c = d.codes[i];
    if (c < 0) continue;
    const dt = h("dt", { class: "mono", text: d.label });
    const dd = h("dd", { class: "mono" }, h("button", { class: "btn small", onclick: () => A.select({ kind: "level", dim: d.id, key: d.levels[c].key }), text: d.levels[c].label }));
    params.append(dt, dd);
  }
  const sets = sc.dims.filter(x => x.kind === "member" && x.codes[i] === 1).map(x => x.name);
  if (sets.length) params.append(h("dt", { text: "features" }), h("dd", { class: "mono", text: sets.join(", ") }));
  box.append(part("Parameters", params));
  // code: replay and raw row
  const prof = sc.profile;
  const out = [];
  if (prof && prof.replay) {
    const cmd = prof.replay.python(obj);
    const pre = h("pre", { class: "code", text: cmd });
    out.push(h("div", { class: "code-head" }, h("span", { text: "Replay it exactly (in research/, with its .venv)" }),
      h("button", { class: "btn small", onclick: async () => toastCopy(await copyText(cmd, pre)) }, icon("copy"), "Copy")), pre);
  }
  const raw = JSON.stringify(obj, null, 1);
  const pre2 = h("pre", { class: "code", text: raw, style: { maxHeight: "320px" } });
  out.push(h("div", { class: "code-head" }, h("span", { text: "The row, rebuilt from its columns" }),
    h("button", { class: "btn small", onclick: async () => toastCopy(await copyText(raw, pre2)) }, icon("copy"), "Copy")), pre2);
  box.append(part("Replay", ...out));
}

