// Trials: the best rows, ranked as the runner ranks them, each a click from
// its full record and its replay. The strip sets the best row against what
// noise alone and the rows like it give; toggles over the table add columns:
// the parameters that move the needle and the rest, the rows like each
// row, and the activity, risk, model skill and run time behind each score
// where the sweep records them.

import { h, tip, keyTip, icon, fmtT, fmtInt, fmtP, fmtRowValue, inText, rangeText, runName } from "./ui.js";
import { strip, stripCell, about } from "./strip.js";
import { summarize, MIN_N } from "./engine.js";
import { expectedMaxZ } from "./stats.js";
import { bestRows, objectiveKeys, BEST_LIMIT } from "./model.js";
import { strengthText } from "./view-board.js";

// The column sets, in the order of their toggles: a row's parameters, the
// checks on its score, and what it cost.
const PRESETS = [
  { id: "movers", icon: "needle", name: "Movers", part: 0 },
  { id: "rest", icon: "sliders", name: "Other parameters", part: 0 },
  { id: "like", icon: "like", name: "Rows like it", part: 1 },
  { id: "activity", icon: "activity", name: "Activity", part: 1 },
  { id: "risk", icon: "risk", name: "Risk", part: 1 },
  { id: "skill", icon: "skill", name: "Model skill", part: 1 },
  { id: "time", icon: "clock", name: "Run time", part: 2 },
];

export function renderTrials(view, m, A) {
  view.append(h("h1", { class: "sr", text: "The best rows" }));
  const keys = objectiveKeys(m);
  if (!keys) { renderUnranked(view, m, A); return; }
  const ranked = bestRows(m);
  const cols = columnSets(m, ranked);
  const on = new Set(m.state.trialCols);
  const shown = PRESETS.filter(p => on.has(p.id) && cols[p.id] && cols[p.id].length);
  const base = baseColumns(m, keys);
  view.append(trialsStrip(m, A, ranked, keys, base, cols, shown));
  view.append(bestIsland(m, A, ranked, keys, base, cols, shown));
}

// ---------------------------------------------------------------------------
// The strip: the best row against luck and against the rows like it.

function luckOf(t, better, rows) {
  if (t.kind === "binary") return null;
  const s = summarize(t, rows);
  if (s.n < 2 || !Number.isFinite(s.sd)) return null;
  const line = s.mean + better * s.sd * expectedMaxZ(s.n);
  let clear = 0;
  for (let j = 0; j < rows.length; j++) { const v = t.values[rows[j]]; if (v === v && (v - line) * better > 0) clear++; }
  return { line, clear, n: s.n };
}

// Rows in view that arrived after row i.
function arrivedAfter(rows, i) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid] <= i) lo = mid + 1; else hi = mid; }
  return rows.length - lo;
}

function trialsStrip(m, A, ranked, keys, base, cols, shown) {
  const { t: lt, better } = keys[keys.length - 1];
  const top = ranked.list.length && ranked.list[0].rank === 1 ? ranked.list[0] : null;
  const luck = luckOf(lt, better, m.rows);
  const sel = m.state.sel;
  const cells = [];
  const firstKeys = top ? keys.slice(0, -1).map(k => `${inText(k.t.label)} ${fmtRowValue(k.t, k.t.values[top.i])}`) : [];
  cells.push(stripCell("Best row", top ? fmtRowValue(lt, lt.values[top.i]) : "–",
    top ? [`row ${fmtInt(top.i)}`, ...firstKeys, top.tie > 1 ? `tied with ${fmtInt(top.tie - 1)}` : null].filter(Boolean).join(" · ")
      : ranked.cut ? `${fmtInt(ranked.cut.n)} rows tie for it` : "no row has a value",
    () => h("div", null, h("b", { text: `The first row by ${m.schema.objectiveLabel}` }),
      h("div", { class: "k", text: "The best of many noisy rows is also the luckiest: read it against the luck line and the rows like it. Choose it to open its record." })),
    top ? () => A.select(sel && sel.kind === "row" && sel.i === top.i ? null : { kind: "row", i: top.i }) : null));
  const like = top ? top.like : null;
  cells.push(stripCell("Like the best", like ? fmtT(m.target, like.mean) : "–",
    like ? `${m.target === lt ? "" : `${inText(m.target.label)} · `}${fmtInt(like.n)} rows` : "no best row",
    like ? () => likeTip(m, ranked, top) : null));
  cells.push(stripCell("Luck line", luck ? fmtT(lt, luck.line) : "–", luck ? `best of ${fmtInt(luck.n)} by noise` : "not for a rate",
    () => h("div", null, h("b", { text: "What noise alone would reach" }),
      h("div", { text: `The best ${inText(lt.label)} of ${luck ? fmtInt(luck.n) : "these"} rows if every configuration were equally good and all their spread were noise: the mean plus the spread times the expected largest of as many normal draws.` }),
      h("div", { class: "k", text: "A needle with heavy tails (most rows at 0, a few far out) reaches past this line more often than normal noise does." }))));
  cells.push(stripCell("Clear of luck", luck ? fmtInt(luck.clear) : "–", luck ? (luck.clear ? `of ${fmtInt(luck.n)} rows` : "the best is inside it") : null,
    () => h("div", null, h("b", { text: "Rows above the luck line" }),
      h("div", { class: "k", text: `Rows whose ${inText(lt.label)} beats what noise alone would reach in as many rows: hard to get by luck, though not proof. Their activity and the rows like them say more.` }))));
  const since = top ? arrivedAfter(m.rows, top.i) : null;
  cells.push(stripCell("Since the best", top ? fmtInt(since) : "–", top ? `rows since row ${fmtInt(top.i)}` : null,
    () => h("div", null, h("b", { text: "Rows that arrived after the best one" }),
      h("div", { class: "k", text: "A search that still improves finds a better row now and then; a long stretch without one says the space is drawn out, or that the best was luck." }))));
  cells.push(stripCell("Rows", fmtInt(m.rows.length), m.rows.length < m.ds.n ? `of ${fmtInt(m.ds.n)}` : null,
    () => h("div", null, h("b", { text: "Rows in view" }),
      h("div", { class: "k", text: `${m.context.length ? "Rows that hold every condition of the context." : m.edge < m.ds.n ? "Rows up to the replay edge." : "Every row of the run so far."}${ranked.missing ? ` ${fmtInt(ranked.missing)} have no value for ${m.schema.objectiveLabel} and are not ranked.` : ""}` }))));
  return strip("The best rows in figures", cells,
    { key: "trials", label: "About the best rows", content: () => trialsAbout(m) },
    { label: "Copy the best rows as notes", what: "The rows in the table, with the columns on screen, and the luck line.",
      text: () => trialsNotes(m, ranked, base, cols, shown, luck, lt), done: "Best rows copied." }, A);
}

function trialsAbout(m) {
  return about("The best rows",
    `Ranked by ${m.schema.objectiveLabel}, as the runner ranks them, over the rows in view. Rows that tie share a rank (4=) and keep the order they arrived in; a tie too large for the list of ${BEST_LIMIT} is told in one line instead, since inside it the order means nothing.`,
    "The best of many noisy rows is also the luckiest. The strip sets the best row against the luck line, what noise alone would reach in as many rows, and against the rows like it: the other rows that share its values where the needle moves, which is what those values earn without its luck.",
    "The toggles above the table add columns: the parameters that move the needle and the other parameters; the rows like each row; and, where the sweep records them, the activity, risk and model skill behind each score and the time it took. Choose a row to open its full record and its replay.");
}

// No objective: nothing to rank by.
function renderUnranked(view, m, A) {
  view.append(strip("The best rows in figures", [stripCell("Rows", fmtInt(m.rows.length), m.rows.length < m.ds.n ? `of ${fmtInt(m.ds.n)}` : null)],
    { key: "trials", label: "About the best rows", content: () => about("The best rows",
      "A runner's profile says how it ranks its rows: Limen by net PnL per bar, plate sweeps by gates and then mean %/mo. This sweep matches no profile with an objective, so no row is ranked.") }, null, A));
  view.append(h("section", { class: "island", "aria-labelledby": "tr-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "tr-title", text: "The best rows" })),
    h("p", { class: "isl-note", text: "No objective is known for this sweep. Choose a needle and compose a pocket to find where it is best." })));
}

// ---------------------------------------------------------------------------
// Columns: each has a label (and unit), a tip for its head, and its cell;
// `text` is the cell as notes, `note` its label there when the table's
// group names it, and `cellTip` a cell's tip (where `tipIf` holds).

const listText = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function targetTip(t) {
  return h("div", null, h("b", { text: t.label }), t.definition ? h("div", { text: t.definition }) : null,
    h("div", { class: "k", text: `${t.unit || "value"}; ${t.better > 0 ? "higher is better" : t.better < 0 ? "lower is better" : "no better direction"}${t.decimals !== null && t.decimals !== undefined && t.decimals < (t.digits ?? 2) ? `; written to ${t.decimals} decimal${t.decimals === 1 ? "" : "s"}` : ""}` }));
}

function targetCol(t) {
  const text = x => fmtRowValue(t, t.values[x.i], { unit: false });
  return { key: t.id, label: t.label, unit: t.kind === "binary" ? "" : t.unit, num: true, head: () => targetTip(t), text, cell: text };
}

function paramCol(m, d, e) {
  const text = x => { const c = d.codes[x.i]; return c >= 0 ? d.levels[c].label : "–"; };
  const t = m.target;
  return { key: d.id, label: d.label, unit: "", num: false, mono: true, text, cell: text,
    head: () => h("div", null, h("b", { text: d.label }),
      e && e.detectable ? h("div", { class: "k", text: `Moves ${inText(t.label)}: ω² ${strengthText(e)}, ${fmtP(e.q)}${e.best ? `; best at ${e.best.label}, ${fmtT(t, e.best.mean)}` : ""}.` })
        : e ? h("div", { class: "k", text: `No detectable effect on ${inText(t.label)} (${fmtP(e.q)}).` }) : null) };
}

function rankText(x) {
  return `${x.rank}${x.tie > 1 ? "=" : ""}`;
}

function baseColumns(m, keys) {
  const sc = m.schema;
  const cols = [
    { key: "#", label: "#", unit: "", num: true, cls: "rk", text: rankText,
      cell: x => h("span", null, String(x.rank), h("span", { class: "eq" + (x.tie > 1 ? "" : " no"), text: "=" })),
      tipIf: x => x.tie > 1,
      cellTip: x => h("div", null, h("b", { text: `Tied with ${fmtInt(x.tie - 1)} other row${x.tie > 2 ? "s" : ""}` }),
        h("div", { class: "k", text: `They share rank ${x.rank} and keep the order they arrived in.` })) },
    { key: "row", label: "Row", unit: "", num: true, cls: "ri", text: x => fmtInt(x.i), cell: x => fmtInt(x.i) },
  ];
  if (sc.gates.length) {
    cols.push({ key: "pills", label: "Gates", unit: "", num: false, notes: false, text: () => "",
      cell: x => {
        const pills = h("span", { class: "pills" });
        for (const g of sc.gates) pills.append(h("span", { class: "pill" + (g.pass[x.i] === 1 ? " pass" : "") }));
        return pills;
      },
      cellTip: x => h("div", null, sc.gates.map(g => h("div", null, h("b", { text: g.pass[x.i] === 1 ? "pass " : g.pass[x.i] === 0 ? "fail " : "no value " }),
        g.set ? h("span", { text: g.label }) : [h("span", { class: "mono", text: g.id }), h("span", { class: "k", text: `  ${g.need}` })]))) });
  }
  for (const { t } of keys) cols.push(targetCol(t));
  if (!keys.some(k => k.t === m.target)) cols.push(targetCol(m.target));
  return cols;
}

// Every column set this sweep can show: null when it records nothing for
// it; empty when it has nothing to show now (nothing moves the needle).
function columnSets(m, ranked) {
  const sc = m.schema;
  const order = Object.keys((sc.profile && sc.profile.metrics) || {});
  const recorded = (list) => (list.length ? list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(targetCol) : null);
  const effectOf = new Map(m.board.effects.map(e => [e.dim, e]));
  const t = m.target;
  return {
    movers: ranked.movers.map(d => paramCol(m, d, effectOf.get(d.id))),
    rest: m.order.filter(e => !e.detectable).map(e => paramCol(m, sc.dimById.get(e.dim), e)),
    like: ranked.movers.length ? [
      { key: "like", label: t.label, note: `${t.label} like it`, unit: t.kind === "binary" ? "" : t.unit, num: true,
        head: () => h("div", null, h("b", { text: `${t.label} of the rows like it` }), h("div", { class: "k", text: "The other rows that share the row's values where the needle moves." })),
        text: x => fmtT(t, x.like.mean, { unit: false }), cell: x => fmtT(t, x.like.mean, { unit: false }), cellTip: x => likeTip(m, ranked, x) },
      { key: "like-n", label: "Rows", note: "Rows like it", unit: "", num: true,
        head: () => h("div", null, h("b", { text: "Rows like it" }), h("div", { class: "k", text: `At least ${MIN_N}: matched on the strongest movers that leave as many.` })),
        text: x => fmtInt(x.like.n), cell: x => fmtInt(x.like.n), cellTip: x => likeTip(m, ranked, x) },
    ] : [],
    activity: recorded(sc.targets.filter(x => x.group === "activity")),
    risk: recorded(sc.targets.filter(x => x.group === "risk")),
    skill: recorded(sc.targets.filter(x => x.group === "skill")),
    time: recorded(sc.targets.filter(x => x.cost)),
  };
}

// What a column set's toggle says: its name, and what it adds here.
function presetWhat(id, m, cols) {
  const t = inText(m.target.label);
  const names = listText(cols.map(c => inText(c.label)));
  switch (id) {
    case "movers": return cols.length ? `Each row's values of the ${cols.length} parameters that move ${t}, strongest first.` : `Nothing moves ${t} detectably yet.`;
    case "rest": return cols.length ? `Each row's values of the ${cols.length} parameters with no detectable effect on ${t}: the rest of its configuration.` : `Every parameter moves ${t}.`;
    case "like": return cols.length ? `${m.target.label} over the other rows that share a row's values where the needle moves: what those values earn without the row's own luck.` : `Nothing moves ${t} yet, so every row is like every other.`;
    case "activity": return `How much trading a row's score rests on: ${names}. A score from a handful of trades is mostly luck.`;
    case "risk": return `The downside that came with a row's score: ${names}.`;
    case "skill": return `Whether the model behind a row's score predicts anything: ${names}.`;
    case "time": return `The compute each row took: ${names}.`;
    default: throw new Error(`no column set ${id}`);
  }
}

function likeTip(m, ranked, x) {
  const L = x.like, t = m.target, sc = m.schema;
  const vals = L.dims.map(id => { const d = sc.dimById.get(id); const c = d.codes[x.i]; return `${d.label} = ${c >= 0 ? d.levels[c].label : "does not apply"}`; });
  const k = ranked.movers.length;
  return h("div", null, h("b", { text: `Rows like row ${fmtInt(x.i)}` }),
    h("div", { text: L.j ? `The other ${fmtInt(L.n)} rows with ${listText(vals)}.` : k ? `No value of a mover leaves ${MIN_N} other rows, so every other row in view (${fmtInt(L.n)}).` : `Nothing moves ${inText(t.label)}, so every other row in view (${fmtInt(L.n)}).` }),
    h("div", { class: "k", text: `${t.label} ${fmtT(t, L.mean)}, 95% ${rangeText(t, L.lo, L.hi)}${L.j && L.j < k ? `; matched on the ${L.j} strongest of the ${k} movers, as many as leave ${MIN_N} rows` : ""}.` }));
}

// ---------------------------------------------------------------------------
// The island: its head with the column toggles, the table, the tie left out.

// The column sets as toggles that say what they are: an icon and a name,
// in a group for each part (a row's parameters, the checks on its score,
// what it cost).
function colTools(m, A, cols) {
  const bar = h("div", { class: "tr-tools", role: "toolbar", "aria-label": "Columns", dataset: { key: "x" } });
  const on = m.state.trialCols;
  let part = null, group = null;
  for (const p of PRESETS) {
    const c = cols[p.id];
    if (!c) continue;
    if (p.part !== part) { group = h("div", { class: "seg" }); bar.append(group); }
    part = p.part;
    const empty = !c.length;
    const b = h("button", { type: "button",
      "aria-pressed": on.includes(p.id) && !empty ? "true" : "false", "aria-disabled": empty ? "true" : null,
      dataset: { cols: p.id, focus: `cols-${p.id}` },
      onclick: () => {
        if (empty) return;
        A.set({ trialCols: on.includes(p.id) ? on.filter(x => x !== p.id) : [...on, p.id] }, { replace: true });
      } }, icon(p.icon), h("span", { text: p.name }));
    tip(b, keyTip(p.name, "X", `${presetWhat(p.id, m, c)} X reaches these toggles, ← → move between them.`));
    group.append(b);
  }
  return bar;
}

// A head's unit, unless its label already says it ("Signal days").
const unitOf = (c) => (c.unit && !c.label.toLowerCase().split(/\s+/).includes(c.unit.toLowerCase()) ? c.unit : "");

function headCell(c, cls) {
  const th = h("th", { class: [c.num ? "r" : "", c.cls || "", cls || ""].join(" ").trim() || null, scope: "col" },
    h("span", { class: "lbl" + (c.mono ? " mono" : "") }, c.label, unitOf(c) ? [" ", h("span", { class: "u", text: `(${unitOf(c)})` })] : null));
  if (c.head) tip(th, c.head);
  return th;
}

function bestIsland(m, A, ranked, keys, base, cols, shown) {
  const sc = m.schema;
  const tbl = h("table", { class: "vals trials" });
  const thead = h("thead");
  if (shown.length) {
    thead.append(h("tr", { class: "grp-row" },
      h("th", { class: "grp blank stk", colspan: "2" }),
      base.length > 2 ? h("th", { class: "grp blank", colspan: String(base.length - 2) }) : null,
      shown.map(p => h("th", { class: "grp g-start", colspan: String(cols[p.id].length), scope: "colgroup", text: p.name })),
      h("th", { class: "grp blank fill" })));
  }
  thead.append(h("tr", null, base.map(c => headCell(c)), shown.flatMap(p => cols[p.id].map((c, k) => headCell(c, k === 0 ? "g-start" : ""))),
    h("th", { class: "fill", "aria-hidden": "true" })));
  tbl.append(thead);
  const tb = h("tbody");
  const sel = m.state.sel;
  for (const x of ranked.list) {
    const on = !!sel && sel.kind === "row" && sel.i === x.i;
    const pick = () => A.select(on ? null : { kind: "row", i: x.i });
    const tr = h("tr", { class: "clickable" + (on ? " sel" : ""), tabindex: "0", "aria-selected": on ? "true" : "false",
      dataset: { focus: `trial-${x.i}` }, onclick: pick, onkeydown: (e) => { if (e.key === "Enter") pick(); } });
    const cell = (c, cls) => {
      const td = h("td", { class: [c.num ? "r num" : "v", c.cls || "", cls || ""].join(" ") }, c.cell(x));
      if (c.cellTip && (!c.tipIf || c.tipIf(x))) tip(td, () => c.cellTip(x));
      return td;
    };
    tr.append(...base.map(c => cell(c)), ...shown.flatMap(p => cols[p.id].map((c, k) => cell(c, k === 0 ? "g-start" : ""))),
      h("td", { class: "fill", "aria-hidden": "true" }));
    tb.append(tr);
  }
  tbl.append(tb);
  const { t: lt } = keys[keys.length - 1];
  const isl = h("section", { class: "island tr-island", "aria-labelledby": "tr-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "tr-title", text: "The best rows" }),
      h("span", { class: "isl-count num", text: `${fmtInt(ranked.list.length)} of ${fmtInt(ranked.n)} · by ${sc.objectiveLabel}` }),
      colTools(m, A, cols)));
  if (ranked.list.length) isl.append(h("div", { class: "table-wrap tr-wrap", dataset: { scroll: "trials" } }, tbl));
  if (ranked.cut) {
    const c = ranked.cut;
    isl.append(h("p", { class: "isl-note", text: `${ranked.list.length ? `From rank ${c.rank}, ` : ""}${fmtInt(c.n)} rows tie at ${keys.map(k => fmtRowValue(k.t, k.t.values[c.row])).join(" · ")}: too many to list, and inside a tie the order means nothing.` }));
  } else if (!ranked.n) {
    isl.append(h("p", { class: "isl-note", text: `No row in view has a value for ${inText(lt.label)}.` }));
  }
  return isl;
}

// ---------------------------------------------------------------------------
// Notes: the table as Markdown, and the luck line.

function trialsNotes(m, ranked, base, cols, shown, luck, lt) {
  const all = [...base.filter(c => c.notes !== false), ...shown.flatMap(p => cols[p.id])];
  const ctx = m.context.map(c => {
    const d = m.schema.dimById.get(c.dim);
    return `${d.label} = ${c.keys.map(k => (d.levels.find(l => l.key === k) || { label: k }).label).join("/")}`;
  });
  const lines = [`${m.sweep.meta.name} · ${runName(m.ds.meta)} · the best ${fmtInt(ranked.list.length)} of ${fmtInt(ranked.n)} rows by ${m.schema.objectiveLabel}${ctx.length ? ` inside ${ctx.join(", ")}` : ""}${m.state.edge !== null && m.state.edge < m.ds.n ? ` (up to row ${fmtInt(m.edge)})` : ""}`, ""];
  lines.push(`| ${all.map(c => `${c.note || c.label}${unitOf(c) ? ` (${unitOf(c)})` : ""}`).join(" | ")} |`);
  lines.push(`|${all.map(c => (c.num ? " ---: " : " --- ")).join("|")}|`);
  for (const x of ranked.list) lines.push(`| ${all.map(c => c.text(x)).join(" | ")} |`);
  if (ranked.cut) lines.push("", `From rank ${ranked.cut.rank}, ${fmtInt(ranked.cut.n)} rows tie; they are not listed.`);
  if (luck) lines.push("", `Luck line: ${fmtT(lt, luck.line)}, the best of ${fmtInt(luck.n)} rows by noise alone; ${fmtInt(luck.clear)} ${luck.clear === 1 ? "row clears" : "rows clear"} it.`);
  return lines.join("\n");
}
