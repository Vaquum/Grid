// Gates: needs on needles, set here or by the runner. The view is a gate
// factory: its first card sets a gate on any needle, showing the needle's
// rows against the need as it is typed; each gate gets a card of its own
// (how often rows pass it, its needle against the need, what bounds one
// that never passed, what moves it). The strip reads the gates together,
// and the foot says what stops the rows that pass the most.

import { h, tip, icon, clear, fmtInt, fmtPct, fmtNum, fmtRowValue, inText, pctRange, unitSuffix, runName } from "./ui.js";
import { strip, stripCell, about } from "./strip.js";
import { gateStats, coFailure, strongestCorrelate } from "./engine.js";
import { passHistogram } from "./charts.js";
import { wilson } from "./stats.js";
import { OPS, gateable, needText, nextGateId } from "./gates.js";
import { bestRows } from "./model.js";

// The gate being set or edited, kept across redraws (arriving rows redraw
// the view): its run, the gate it edits (null for a new one), its needle,
// its comparison and its need as typed.
let draft = null;

export function renderGates(view, m, A) {
  const sc = m.schema;
  view.append(h("h1", { class: "sr", text: "Gates" }));
  const d = draftFor(m);
  const stats = new Map(gateStats(sc, m.rows).map(s => [s.id, s]));
  const together = readTogether(m);
  view.append(gatesStrip(m, A, stats, together));
  const set = sc.gatesSet.length, runner = sc.gates.length - set;
  view.append(h("h2", { class: "sec-title" }, h("span", { text: "Gates" }),
    h("span", { class: "count num", text: fmtInt(sc.gates.length) }),
    h("span", { class: "note", text: runner && set ? `${fmtInt(runner)} the runner's, ${fmtInt(set)} set here` : runner ? "the runner's" : set ? "set here" : "set the first one" })));
  const grid = h("div", { class: "gt-grid", role: "list" });
  if (!d.editing) grid.append(maker(m, A, null));
  for (const g of sc.gates) grid.append(d.editing === g.id ? maker(m, A, g) : gateCard(m, A, g, stats.get(g.id)));
  for (const p of sc.gateProblems) grid.append(problemCard(m, A, p));
  if (!sc.gates.length && !sc.gateProblems.length) {
    grid.append(h("div", { class: "gt-ghost", role: "note" },
      h("b", { text: "Each gate gets a card here" }),
      h("p", { text: "How often rows pass it, with its interval; its needle's rows against the need, the passing ones in blue; for a gate that never passed, what bounds it; and what moves it, on the board." }),
      h("p", { text: "With gates set, the strip says how many rows pass them all, the hardest one, and what stops the rows that pass the most." })));
  }
  view.append(grid);
  if (sc.gates.length >= 2) view.append(stopsSection(m, together));
}

// ---------------------------------------------------------------------------
// Every gate at once, for each row in view: how many it passes, and whether
// it passes them all (a row fails every gate it fails; it passes them all
// only when each has a value and passes).

function readTogether(m) {
  const G = m.schema.gates;
  if (!G.length) return null;
  let all = 0, decided = 0, most = 0, atMost = 0;
  for (let j = 0; j < m.rows.length; j++) {
    const i = m.rows[j];
    let k = 0, failed = false, unknown = false;
    for (const g of G) { const p = g.pass[i]; if (p === 1) k++; else if (p === 0) failed = true; else unknown = true; }
    if (!failed && !unknown) all++;
    if (failed || !unknown) decided++;
    if (k > most) { most = k; atMost = 1; } else if (k === most) atMost++;
  }
  const cf = G.length >= 2 ? coFailure(m.schema, m.rows, Math.max(0, most - 1)) : null;
  return { all, decided, most, atMost, cf };
}

const label = (sc, id) => (sc.gates.find(g => g.id === id) || { label: id }).label;
const rate = (r) => fmtPct(r, r > 0 && r < 0.01 ? 2 : 1);

function gatesStrip(m, A, stats, tg) {
  const sc = m.schema, G = sc.gates;
  const aboutIt = { key: "gates", label: "About the gates", content: () => gatesAbout(m) };
  const rowsCell = stripCell("Rows", fmtInt(m.rows.length), m.rows.length < m.ds.n ? `of ${fmtInt(m.ds.n)}` : null,
    () => h("div", null, h("b", { text: "Rows in view" }), h("div", { class: "k", text: m.context.length ? "Rows that hold every condition of the context." : m.edge < m.ds.n ? "Rows up to the replay edge." : "Every row of the run so far." })));
  if (!G.length) {
    return strip("The gates in figures", [
      stripCell("Gates", "0", "none set yet", () => h("div", null, h("b", { text: "Needs on needles" }), h("div", { class: "k", text: "Set one with the first card: a needle, a comparison and a need." }))),
      rowsCell], aboutIt, null, A);
  }
  const cells = [];
  const share = tg.decided ? tg.all / tg.decided : NaN;
  const [lo, hi] = wilson(tg.all, tg.decided);
  cells.push(stripCell("Pass every gate", tg.decided ? rate(share) : "–", `${fmtInt(tg.all)} of ${fmtInt(tg.decided)} rows`,
    () => h("div", null, h("b", { text: `Rows that pass all ${G.length} gates` }),
      h("div", { text: tg.all ? `95% ${pctRange(lo, hi, 2)} (Wilson).` : `None of ${fmtInt(tg.decided)}: the true share is under ${fmtPct(3 / Math.max(1, tg.decided), 3)} (95%, rule of three).` }),
      h("div", { class: "k", text: "A row without a value for a gate's needle can fail another gate, but cannot pass them all." }))));
  const known = [...stats.values()].filter(s => s.n > 0);
  const hardest = known.length ? known.reduce((a, b) => (b.rate < a.rate ? b : a)) : null;
  cells.push(stripCell("Hardest", hardest ? rate(hardest.rate) : "–", hardest ? label(sc, hardest.id) : "no gate has rows",
    () => h("div", null, h("b", { text: "The gate the fewest rows pass" }), h("div", { class: "k", text: "Its share of the rows with a value for its needle." }))));
  const never = known.filter(s => s.never);
  cells.push(stripCell("Never passed", fmtInt(never.length), never.length ? `${label(sc, never[0].id)}${never.length > 1 ? ` and ${never.length - 1} more` : ""}` : "every gate has passed",
    () => h("div", null, h("b", { text: "Gates no row in view has passed" }), h("div", { class: "k", text: "Their cards bound the true pass rate and name what holds them back." }))));
  const stop = tg.cf ? tg.cf.combos.find(c => c.failing.length) : null;
  if (G.length >= 2) {
    cells.push(stripCell("Stops the best", stop ? rate(stop.share) : "–", stop ? stop.failing.map(id => label(sc, id)).join(" + ") : "nothing: they pass every gate",
      () => h("div", null, h("b", { text: `What the rows passing ${Math.max(0, tg.most - 1)} or more gates fail together` }),
        h("div", { class: "k", text: `${fmtInt(tg.cf.total)} rows; the commonest set of gates they fail, and its share of them. Every set is at the foot of the page.` }))));
  }
  const best = bestRows(m);
  const top = best && best.list.length && best.list[0].rank === 1 ? best.list[0].i : null;
  if (top !== null) {
    const fails = G.filter(g => g.pass[top] !== 1);
    const passed = G.length - fails.length;
    const sel = m.state.sel;
    cells.push(stripCell("Best row", `${passed} of ${G.length}`, `row ${fmtInt(top)} · ${fails.length ? `fails ${fails[0].label}${fails.length > 1 ? ` and ${fails.length - 1} more` : ""}` : "passes every gate"}`,
      () => h("div", null, h("b", { text: `The first row by ${sc.objectiveLabel}, against the gates` }), h("div", { class: "k", text: "How many gates the runner's best row passes. Choose it to open its record." })),
      () => A.select(sel && sel.kind === "row" && sel.i === top ? null : { kind: "row", i: top })));
  }
  cells.push(rowsCell);
  return strip("The gates in figures", cells, aboutIt,
    { label: "Copy the gates as notes", what: "Every gate with its pass rate, the rows that pass them all and what stops the best.", text: () => gatesNotes(m, stats, tg), done: "Gates copied." }, A);
}

function gatesAbout(m) {
  const runner = m.schema.gates.length > m.schema.gatesSet.length;
  return about("Gates",
    "A gate is a need on a needle: a row passes it when its value meets the need (net PnL per bar above 0 bps, entries at least 30, AUC at least 0.55). The first card sets one: choose a needle, a comparison and a need, and its rows show against the need as you type.",
    "Each gate gets a card: how often rows pass it, with a 95% interval; its needle's rows, the passing ones in blue; and for a gate that never passed, the most its true rate can be (the rule of three) and the outcome that holds it back.",
    "A gate is a needle too: What moves it opens the board on it. With gates set, Passes every gate and Gates passed are needles as well, so the board can say which parameters make rows pass them all.",
    runner ? "The runner's gates come with the sweep; the ones set here sit beside them and are kept in the page's address." : "Gates set here are kept in the page's address.");
}

function gatesNotes(m, stats, tg) {
  const sc = m.schema;
  const lines = [`${m.sweep.meta.name} · ${runName(m.ds.meta)} · ${fmtInt(m.rows.length)} rows: gates`];
  for (const g of sc.gates) {
    const s = stats.get(g.id);
    lines.push(`- ${g.label}${g.set ? "" : " (the runner's)"}: ${s.n ? `${rate(s.rate)} pass (${fmtInt(s.passed)} of ${fmtInt(s.n)}; 95% ${pctRange(s.lo, s.hi, 2)})` : "no row has a value"}${s.never ? `; never passed, under ${fmtPct(s.ruleOfThree, 3)} (95%)` : ""}`);
  }
  lines.push(`Pass every gate: ${fmtInt(tg.all)} of ${fmtInt(tg.decided)} rows.`);
  const stop = tg.cf ? tg.cf.combos.find(c => c.failing.length) : null;
  if (stop) lines.push(`What stops the rows passing ${tg.most - 1} or more: ${stop.failing.map(id => label(sc, id)).join(" + ")} (${rate(stop.share)} of ${fmtInt(tg.cf.total)}).`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The maker: a needle, a comparison, a need; the needle's rows against it.

const parseNeed = (text) => {
  const t = String(text).trim().replace(/[\s,_]/g, "").replace(/^[−–]/, "-");
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
};
const defaultOp = (t) => (t.better < 0 ? "<=" : ">=");

// The median of a needle over the rows in view, at its shown digits: a
// need the reader moves from, with half the rows on each side.
function median(m, t) {
  const vals = [];
  for (let j = 0; j < m.rows.length; j++) { const v = t.values[m.rows[j]]; if (v === v) vals.push(v); }
  if (!vals.length) return "0";
  vals.sort((a, b) => a - b);
  const v = vals[Math.floor(vals.length / 2)];
  return String(+v.toFixed(Math.max(0, Math.min(6, t.digits ?? 2))));
}

function draftFor(m) {
  const sc = m.schema;
  const ok = (id) => { const t = sc.targetById.get(id); return !!t && gateable(t); };
  if (!draft || draft.run !== m.ds.id || !ok(draft.target)) {
    const keys = sc.objective ? sc.objective.map(([c]) => c) : [];
    const first = [m.target.id, ...keys.slice().reverse()].find(ok) || (sc.targets.find(gateable) || {}).id;
    const t = first ? sc.targetById.get(first) : null;
    draft = { run: m.ds.id, editing: null, target: first || null, op: t ? defaultOp(t) : ">=", text: t ? median(m, t) : "0" };
  }
  if (draft.editing && !sc.gatesSet.some(g => g.id === draft.editing)) draft.editing = null;
  return draft;
}

function needleGroups(sc) {
  const list = sc.targets.filter(gateable);
  return [["Outcome", list.filter(t => !t.diagnostic)], ["Fit diagnostics", list.filter(t => t.diagnostic)]].filter(([, l]) => l.length);
}

function maker(m, A, gate) {
  const sc = m.schema, d = draft;
  const card = h("section", { class: "island gt-card gt-maker", role: "listitem", "aria-label": gate ? `Edit ${gate.label}` : "New gate" },
    h("header", { class: "gt-head" }, h("h3", { class: "gt-title", text: gate ? "Edit the gate" : "New gate" })));
  if (!d.target) {
    card.append(h("p", { class: "gt-note", text: "This run has no needle with values to set a need on." }));
    return card;
  }
  const t = sc.targetById.get(d.target);
  const sel = h("select", { class: "gt-needle", "aria-label": "Needle", dataset: { focus: "gate-needle" } },
    needleGroups(sc).map(([name, list]) => h("optgroup", { label: name }, list.map(x => h("option", { value: x.id, text: x.label })))));
  sel.value = d.target;
  sel.addEventListener("change", () => {
    const nt = sc.targetById.get(sel.value);
    draft = { ...draft, target: nt.id, op: defaultOp(nt), text: median(m, nt) };
    A.rerender();
  });
  const ops = h("div", { class: "seg gt-ops", role: "group", "aria-label": "Comparison" });
  for (const [k, o] of Object.entries(OPS)) {
    const b = h("button", { type: "button", "aria-pressed": d.op === k ? "true" : "false", "aria-label": o.word, dataset: { focus: `gate-op-${k}` },
      onclick: () => { draft = { ...draft, op: k }; A.rerender(); } }, o.sym);
    tip(b, o.word);
    ops.append(b);
  }
  const input = h("input", { class: "gt-need", type: "text", inputmode: "decimal", spellcheck: "false", autocomplete: "off",
    value: d.text, "aria-label": `Need${t.unit ? `, in ${t.unit}` : ""}`, dataset: { focus: "gate-need" } });
  const preview = h("div", { class: "gt-preview" });
  const foot = h("div", { class: "gt-actions" });
  const defs = m.state.gates;
  const commit = () => {
    const x = parseNeed(draft.text);
    if (!Number.isFinite(x)) return;
    const def = { id: draft.editing || nextGateId(defs, sc), target: draft.target, op: draft.op, value: x };
    if (defs.some(g => g.id !== def.id && g.target === def.target && g.op === def.op && g.value === def.value)) return;
    const next = draft.editing ? defs.map(g => (g.id === draft.editing ? def : g)) : [...defs, def];
    draft = { ...draft, editing: null, text: String(x) };
    A.set({ gates: next });
  };
  const refresh = () => {
    const x = parseNeed(draft.text);
    const valid = Number.isFinite(x);
    input.setAttribute("aria-invalid", valid || draft.text === "" ? "false" : "true");
    const test = OPS[draft.op].test;
    const passOf = valid ? (i => { const v = t.values[i]; return v === v ? (test(v, x) ? 1 : 0) : NaN; }) : (() => 0);
    let k = 0, n = 0;
    for (let j = 0; j < m.rows.length; j++) { const p = passOf(m.rows[j]); if (p === p && t.values[m.rows[j]] === t.values[m.rows[j]]) { n++; k += p; } }
    const chart = passHistogram(t.values, passOf, m.rows, { need: valid ? x : undefined, needLabel: valid ? `need ${needText(t, x)}` : undefined, label: `${t.label} against the need` });
    clear(preview);
    preview.append(chart.svg, h("div", { class: "gt-cap" }, valid
      ? h("span", null, h("b", { class: "num", text: n ? rate(k / n) : "–" }), ` of the rows pass · ${fmtInt(k)} of ${fmtInt(n)}`)
      : h("span", { text: draft.text === "" ? "Type the need." : "The need is not a number." })));
    const dup = valid && defs.some(g => g.id !== draft.editing && g.target === draft.target && g.op === draft.op && g.value === x);
    clear(foot);
    foot.append(h("button", { class: "btn primary", type: "button", disabled: !valid || dup ? true : null, onclick: commit }, dup ? "Already set" : gate ? "Save" : "Add gate"));
    if (gate) {
      foot.append(h("button", { class: "btn", type: "button", onclick: () => { draft = { ...draft, editing: null }; A.rerender(); } }, "Cancel"),
        h("button", { class: "btn gt-remove", type: "button", onclick: () => removeGate(m, A, gate.id) }, "Remove"));
    }
  };
  input.addEventListener("input", () => { draft = { ...draft, text: input.value }; refresh(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
  card.append(sel, h("div", { class: "gt-row" }, ops, input, t.unit ? h("span", { class: "gt-unit", text: t.unit }) : null), preview, foot);
  refresh();
  return card;
}

function removeGate(m, A, id) {
  const next = m.state.gates.filter(g => g.id !== id);
  const target = m.state.target;
  // a needle that was this gate, or every gate together, goes with it
  const gone = target === `gate:${id}` || (!next.length && (target === "gates:all" || target === "gates:count"));
  if (draft && draft.editing === id) draft = { ...draft, editing: null };
  A.set({ gates: next, target: gone ? null : target });
}

// ---------------------------------------------------------------------------
// A gate's card.

// A gate's value: a gate set here reads as its needle does; the runner's
// as written, whole numbers whole, dollars as dollars, and a 0/1 value no
// or yes.
function gateValueText(g, v) {
  if (!Number.isFinite(v)) return "–";
  if (g.set) return fmtRowValue(g.target, v);
  if (g.yesNo) return v === 1 ? "yes" : v === 0 ? "no" : fmtNum(v, 2);
  if (g.unit === "$") return fmtRowValue({ kind: "cont", unit: "$", digits: 0 }, v);
  return `${fmtNum(v, Number.isInteger(v) ? 0 : 2)}${unitSuffix(g.unit)}`;
}

function gateCard(m, A, g, s) {
  const sc = m.schema;
  const card = h("article", { class: "island gt-card" + (s.never ? " never" : ""), role: "listitem", "aria-label": g.label });
  card.append(h("header", { class: "gt-head" }, h("h3", { class: "gt-title", text: g.label }),
    h("span", { class: "gt-rate num", text: s.n ? rate(s.rate) : "–" })));
  card.append(h("div", { class: "gt-sub" },
    h("span", { class: "num", text: s.n ? `${fmtInt(s.passed)} of ${fmtInt(s.n)} rows pass · 95% ${pctRange(s.lo, s.hi, 1)}` : "No row has a value." }),
    s.never ? h("span", { class: "sev crit" }, icon("alert"), "never passed") : s.always ? h("span", { class: "sev ok" }, icon("check"), "always passes") : null,
    g.set ? null : h("span", { class: "gt-tag", text: "the runner's" })));
  if (!g.set) card.append(h("div", { class: "gt-need-line", text: `Need: ${g.need}` }));
  // the needle's rows against the need
  const sign = g.set && g.def.op[0] === "<" ? -1 : 1;
  let lo = Infinity, hi = -Infinity;
  const vals = [];
  for (let j = 0; j < m.rows.length; j++) { const v = g.value[m.rows[j]]; if (v === v) { vals.push(v); if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (vals.length) {
    vals.sort((a, b) => a - b);
    const chart = passHistogram(g.value, i => g.pass[i], m.rows, { need: g.needAt, needLabel: g.needAt !== undefined ? `need ${g.set ? needText(g.target, g.needAt) : gateValueText(g, g.needAt)}` : undefined,
      labels: g.yesNo ? [[0, "no"], [1, "yes"]] : undefined, label: `${g.label}: rows against the need` });
    card.append(h("div", { class: "gt-chart" }, chart.svg));
    // a gate set here knows which way is better; the runner's says only its
    // need; a yes or no gate's pass line above says it all
    const extreme = g.set ? `best ${gateValueText(g, sign > 0 ? hi : lo)}` : `max ${gateValueText(g, hi)}`;
    if (!g.yesNo) card.append(h("div", { class: "gt-cap num", text: `median ${gateValueText(g, vals[Math.floor(vals.length / 2)])} · ${extreme}${chart.outside ? ` · ${fmtInt(chart.outside)} beyond what is drawn` : ""}` }));
  }
  if (s.never) {
    const corr = strongestCorrelate(sc, g.value, m.rows, aliasesOf(sc, g.value, m.rows));
    const p = h("p", { class: "gt-note" }, h("b", { text: "Never passed" }), ` in ${fmtInt(s.n)} rows: its true pass rate is under ${fmtPct(s.ruleOfThree, 3)} (95%, rule of three).`);
    if (corr && Math.abs(corr.r) > 0.8) p.append(" ", h("b", { text: `It moves with ${inText(corr.label)} (r = ${fmtNum(corr.r, 3)})` }), ", so that holds it back: no parameter here can pass it while that stays where it is.");
    card.append(p);
  }
  const acts = h("div", { class: "gt-actions" },
    h("button", { class: "btn", type: "button", onclick: () => A.set({ target: `gate:${g.id}`, view: "board" }) }, "What moves it"));
  if (g.set) {
    acts.append(h("button", { class: "btn", type: "button", onclick: () => {
      draft = { run: m.ds.id, editing: g.id, target: g.def.target, op: g.def.op, text: String(g.def.value) };
      A.rerender();
    } }, "Edit"),
    h("button", { class: "btn gt-remove", type: "button", onclick: () => removeGate(m, A, g.id) }, "Remove"));
  }
  card.append(acts);
  return card;
}

// A gate set here that cannot be read: what it was set as, in words, and
// why it cannot be read, with its way out.
function problemCard(m, A, p) {
  const d = p.def && typeof p.def === "object" ? p.def : null;
  const op = d && OPS[d.op] ? OPS[d.op].sym : d && d.op !== undefined ? String(d.op) : "?";
  const need = d && Number.isFinite(d.value) ? needText({ unit: "" }, d.value) : String(d && d.value !== undefined ? d.value : "?");
  const what = d ? h("span", null, "It was set as ", h("span", { class: "mono", text: `${d.target ?? "?"} ${op} ${need}` }), `, and ${p.why}.`)
    : `It is not a gate (${p.why}).`;
  return h("article", { class: "island gt-card gt-problem", role: "listitem" },
    h("header", { class: "gt-head" }, h("h3", { class: "gt-title", text: "A gate that cannot be read" })),
    h("p", { class: "gt-note" }, what),
    h("div", { class: "gt-actions" }, h("button", { class: "btn gt-remove", type: "button",
      onclick: () => A.set({ gates: m.state.gates.filter(g => JSON.stringify(g) !== JSON.stringify(p.def)) }) }, "Remove")));
}

// Targets that are the gate's value itself (|r| > 0.999) are not an
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

// ---------------------------------------------------------------------------
// What stops the rows that pass the most gates: the sets they fail.

function stopsSection(m, tg) {
  const sc = m.schema;
  const sec = h("section", { class: "island gt-stops", "aria-labelledby": "gt-stops-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "gt-stops-title", text: "What stops the best rows" }),
      h("span", { class: "isl-count num", text: tg.cf.total ? `${fmtInt(tg.cf.total)} rows pass ${Math.max(0, tg.most - 1)} or more of ${sc.gates.length}` : "no row has a value for every gate" })));
  if (!tg.cf.total) return sec;
  const list = h("div", { class: "gt-stop-rows", role: "list" });
  const top = tg.cf.combos[0].share;
  for (const c of tg.cf.combos.slice(0, 8)) {
    list.append(h("div", { class: "gt-stop", role: "listitem" },
      h("span", { class: "num gt-stop-share", text: rate(c.share) }),
      h("span", { class: "gt-stop-bar", "aria-hidden": "true" }, h("i", { style: { width: `${(c.share / top) * 100}%` } })),
      h("span", { class: "gt-stop-set", text: c.failing.length ? c.failing.map(id => label(sc, id)).join(" + ") : "nothing: they pass every gate" }),
      h("span", { class: "num muted", text: `${fmtInt(c.count)} row${c.count === 1 ? "" : "s"}` })));
  }
  sec.append(list);
  if (tg.cf.combos.length > 8) sec.append(h("p", { class: "isl-note", text: `${fmtInt(tg.cf.combos.length - 8)} rarer sets are left out.` }));
  return sec;
}
