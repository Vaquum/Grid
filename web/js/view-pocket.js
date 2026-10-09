// Pocket: stack value blocks into a pocket (a conjunction), read what it
// holds and whether each block earns its place, and take it to the next
// sweep as the experiment's manifest narrowed to it.
//
// The page: the strip (the pocket in figures); the stack, which reads from
// the rows in view at the bottom up through each block as a path; a pinned
// pocket to compare, when there is one; the blocks to add, suggested and
// every one; and, at the foot, the manifest (drawn by the app).

import { h, icon, tip, fmtT, fmtInt, fmtNum, fmtPct, fmtDelta, fmtP, inText, rangeText, runName } from "./ui.js";
import { ALPHA, MIN_N, blockTests, pocketStats, rowsIn, suggestions, summarize } from "./engine.js";
import { boardDims, memberDims } from "./model.js";
import { intervalBar } from "./charts.js";
import { strip, stripCell, about } from "./strip.js";
import { mergeConditions, figureLine } from "./manifest.js";

export function renderPocket(view, m, A) {
  const { schema, target: t } = m;
  const pocket = (m.state.pocket || []).filter(c => schema.dimById.has(c.dim));
  const ps = pocket.length ? pocketStats(schema, pocket, t, m.rows, m.edge) : null;
  const verdicts = ps ? blockTests(schema, pocket, t, m.rows, m.edge, ps.rows).map(r => ({ ...r, kind: blockVerdict(t, ps, r) })) : [];
  const sug = suggest(m, pocket, ps ? ps.rows : m.rows);

  view.append(h("h1", { class: "sr", text: "The pocket" }));
  view.append(pocketStrip(m, A, pocket, ps, verdicts, sug));
  const left = h("div", { class: "pk-col" }), right = h("div", { class: "pk-col" });
  view.append(h("div", { class: "pk-grid" }, left, right));
  left.append(stackIsland(m, A, pocket, ps, verdicts));
  const pinned = (m.state.pocketB || []).filter(c => schema.dimById.has(c.dim));
  if (pinned.length && ps) left.append(compareIsland(m, A, pinned, ps));
  right.append(addIsland(m, A, pocket, sug));
  return { manifest: { conditions: mergeConditions(m.context, pocket), scope: "the pocket", figure: ps ? figureLine(m, ps.n, ps) : null } };
}

// what a dragged value chip carries
const VALUE = "application/x-grid-value";

const labels = (d, keys) => keys.map(key => (d.levels.find(l => l.key === key) || { label: key }).label);

// What a block does: its rows against the rows it takes away.
function blockVerdict(t, ps, r) {
  if (!Number.isFinite(r.q)) return "few";
  if (!(r.q < ALPHA)) return "narrows";
  if (!t.better) return "changes";
  return (ps.mean - r.removed.mean) * t.better > 0 ? "earns" : "hurts";
}

const VERDICT = {
  earns: "Earns its place",
  hurts: "Holds the needle back",
  changes: "Changes the needle",
  narrows: "Only narrows",
  few: "Too few rows to tell",
};

// ---------------------------------------------------------------------------
// The strip

function pocketStrip(m, A, pocket, ps, verdicts, sug) {
  const t = m.target, b = m.base, binary = t.kind === "binary";
  const range = (s) => `95% ${rangeText(t, s.lo, s.hi)}`;
  const inView = m.context.length ? "the rows in view" : "every row";
  const cells = [];
  if (!ps) {
    cells.push(stripCell(t.label, fmtT(t, b.mean), range(b), () => h("div", null, h("b", { text: `${t.label} over ${inView}` }),
      h("div", { class: "k", text: "With its 95% interval: where the stack starts, and the line every block is read against." }))));
    cells.push(stripCell("Rows", fmtInt(m.rows.length), m.rows.length < m.ds.n ? `of ${fmtInt(m.ds.n)}` : null));
    cells.push(stripCell("Blocks", "0", "add one to start"));
    const top = sug[0];
    const d = top && m.schema.dimById.get(top.dim);
    cells.push(stripCell("Best start", top ? fmtT(t, top.mean) : "–", top ? `${top.dimLabel} = ${top.label}` : "nothing ranked yet",
      () => h("div", null, h("b", { text: "The value to start from" }), h("div", { class: "k", text: `Ranked by the ${t.better < 0 ? "upper" : "lower"} end of its 95% interval: the conservative estimate, not the luckiest.` })),
      top ? () => A.addPocket(top.dim, top.key) : null, top ? { "aria-label": `Start the pocket with ${d.label} = ${top.label}` } : {}));
  } else {
    const earn = verdicts.filter(r => r.kind === "earns" || r.kind === "changes").length;
    const idle = pocket.filter((_, k) => verdicts[k].kind === "narrows").map(c => m.schema.dimById.get(c.dim).label);
    const few = verdicts.every(r => r.kind === "few");
    const agree = Number.isFinite(ps.halvesP) ? ps.halvesP >= ALPHA : null;
    const [h1, h2] = ps.halves;
    cells.push(stripCell(t.label, fmtT(t, ps.mean), range(ps), () => h("div", null, h("b", { text: `${t.label} inside the pocket` }),
      h("div", { class: "k", text: `Over its ${fmtInt(ps.n)} rows, with the 95% interval${binary ? " (Wilson)" : ""}. A sweep drawn only inside the pocket should land here, since the sweep draws every parameter independently and uniformly.` }))));
    cells.push(stripCell("Against the base", binary ? (Number.isFinite(ps.lift) ? `${fmtNum(ps.lift, 2)}×` : "–") : fmtDelta(t, ps.mean - b.mean), `base ${fmtT(t, b.mean)}`,
      () => h("div", null, h("b", { text: binary ? "The pocket's rate over the base rate" : "The pocket against the base" }), h("div", { class: "k", text: `The base is ${inText(t.label)} over ${inView}.` }))));
    cells.push(stripCell("Rows", fmtInt(ps.n), `${fmtPct(ps.share, 1)} of ${fmtInt(m.rows.length)}`,
      () => h("div", null, h("b", { text: "Rows that hold every block" }), h("div", { class: "k", text: m.context.length ? "Inside the context." : "Of every row so far." }))));
    cells.push(stripCell("Earn their place", `${earn} of ${pocket.length}`, few ? "too few rows to tell" : idle.length ? `${idle.join(", ")} only ${idle.length === 1 ? "narrows" : "narrow"}` : "every block",
      () => h("div", null, h("b", { text: "Blocks that change the needle" }), h("div", { class: "k", text: `Each block's rows against the rows it takes away (those that hold every other block but not this one), a two-sample test, corrected across the ${fmtInt(pocket.length)} blocks. A block that only narrows costs rows without changing the needle.` }))));
    cells.push(stripCell("Halves", agree === null ? "–" : agree ? "agree" : "differ",
      agree === null ? `fewer than ${MIN_N} rows in a half` : `${fmtT(t, h1.mean)}, then ${fmtT(t, h2.mean)}`,
      () => h("div", null, h("b", { text: "The first and second half of the arrivals" }),
        h("div", { class: "k", text: `${agree === null ? "Each half needs" : `${fmtP(ps.halvesP, "p")}. Each half has`} at least ${MIN_N} rows. A pocket that holds in both halves is less likely to be noise; one that holds in only one is suspect.` }))));
    if (binary) cells.push(stripCell("Hits", fmtInt(ps.hits), `${fmtPct(ps.recall, 0)} of all hits`,
      () => h("div", null, h("b", { text: "Hits inside the pocket" }), h("div", { class: "k", text: "Its share of every hit in view: the recall." }))));
  }
  return strip("The pocket in figures", cells,
    { key: "pocket", label: "About the pocket", content: () => pocketAbout(m) },
    ps ? { label: "Copy the pocket as notes", what: "Its blocks with what each does, its rows and needle against the base, and the halves.", text: () => pocketNotes(m, pocket, ps, verdicts), done: "Pocket copied." } : null, A);
}

function pocketAbout(m) {
  const t = m.target, binary = t.kind === "binary";
  const exp = m.ds.meta.experiment;
  return about("The pocket",
    "Stack blocks to narrow the sweep to the rows that hold every one of them. A block holds one or more values of a parameter; values in one block are alternatives, blocks on top of each other must all hold.",
    `Because the sweep draws every parameter independently and uniformly, ${binary ? "the rate" : inText(t.label)} inside a pocket estimates what a new sweep drawn only inside it would ${binary ? "hit" : "get"}.`,
    "The stack reads from the bottom: the rows in view, then each block with the rows and the needle once it is added. Each block says whether it earns its place.",
    exp && exp.kind === "limen" ? "The manifest at the foot of the page is the experiment's, narrowed to the pocket, for the next sweep." : null);
}

function pocketNotes(m, pocket, ps, verdicts) {
  const t = m.target;
  const lines = [`Pocket on ${runName(m.ds.meta)}: ${t.label}`];
  pocket.forEach((c, k) => {
    const d = m.schema.dimById.get(c.dim), v = verdicts[k];
    lines.push(`- ${d.label} = ${labels(d, c.keys).join(" or ")}: ${VERDICT[v.kind].toLowerCase()}${Number.isFinite(v.q) ? ` (${fmtP(v.q)})` : ""}; without it ${fmtT(t, v.without.mean)} on ${fmtInt(v.without.n)} rows`);
  });
  lines.push(`${fmtInt(ps.n)} rows (${fmtPct(ps.share, 1)} of ${fmtInt(m.rows.length)}): ${fmtT(t, ps.mean)} (95% ${rangeText(t, ps.lo, ps.hi)}), base ${fmtT(t, m.base.mean)}.`);
  if (Number.isFinite(ps.halvesP)) lines.push(`Halves of the arrivals: ${fmtT(t, ps.halves[0].mean)}, then ${fmtT(t, ps.halves[1].mean)} (${fmtP(ps.halvesP, "p")}).`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The stack: the rows in view at the bottom, each block on top

function stackIsland(m, A, pocket, ps, verdicts) {
  const steps = cumulative(m, pocket);
  const all = [m.base, ...steps];
  const lo = Math.min(...all.map(s => s.lo).filter(Number.isFinite)), hi = Math.max(...all.map(s => s.hi).filter(Number.isFinite));
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  const domain = [lo - pad, hi + pad];

  const stack = h("div", { class: "stack", "aria-label": "The pocket's blocks, the first at the bottom" });
  stack.append(floor(m, domain));
  if (!pocket.length) {
    stack.append(h("div", { class: "drop" }, h("b", { text: "Drop a value here" }),
      h("span", null, "or take one from the right, or press ", h("kbd", { text: "P" }), " on a value in the inspector")));
  }
  pocket.forEach((c, k) => stack.append(brick(m, A, pocket, c, k, steps[k], verdicts[k], domain, ps)));
  // only Grid's own value chips are taken; anything else is refused
  stack.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(VALUE)) return;
    e.preventDefault();
    stack.classList.add("over");
  });
  stack.addEventListener("dragleave", (e) => { if (!stack.contains(e.relatedTarget)) stack.classList.remove("over"); });
  stack.addEventListener("drop", (e) => {
    stack.classList.remove("over");
    if (!e.dataTransfer.types.includes(VALUE)) return;
    e.preventDefault();
    const v = JSON.parse(e.dataTransfer.getData(VALUE));
    A.addPocket(v.dim, v.key);
  });

  const isl = h("section", { class: "island stack-island", "aria-labelledby": "stack-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "stack-title", text: "Stack" }),
      h("span", { class: "isl-count num", text: pocket.length === 1 ? "1 block" : `${fmtInt(pocket.length)} blocks` })),
    stack);
  if (pocket.length) {
    isl.append(h("footer", { class: "isl-foot" },
      h("button", { class: "btn small", type: "button", onclick: () => A.set({ context: pocket.map(c => ({ ...c })), view: "board" }) }, "Open on the board"),
      h("button", { class: "btn small", type: "button", onclick: () => A.set({ pocketB: pocket.map(c => ({ ...c })) }) }, "Pin to compare"),
      h("button", { class: "btn small", type: "button", onclick: () => A.set({ pocket: [] }) }, "Clear")));
  }
  return isl;
}

// Rows and the needle after each block, bottom up.
function cumulative(m, pocket) {
  const out = [];
  for (let k = 1; k <= pocket.length; k++) {
    const rows = intersect(rowsIn(m.schema, pocket.slice(0, k), m.edge), m.rows);
    out.push(summarize(m.target, rows));
  }
  return out;
}

function intersect(a, b) {
  const mark = new Uint8Array(Math.max(a.length ? a[a.length - 1] + 1 : 0, b.length ? b[b.length - 1] + 1 : 0));
  for (let j = 0; j < b.length; j++) mark[b[j]] = 1;
  const out = [];
  for (let j = 0; j < a.length; j++) if (mark[a[j]]) out.push(a[j]);
  return Uint32Array.from(out);
}

function floor(m, domain) {
  const t = m.target, b = m.base;
  const el = h("div", { class: "floor has-tip" },
    h("span", { class: "fl-what", text: m.context.length ? "Rows in view" : "Every row" }),
    h("span", { class: "fl-fig num" }, h("span", { text: `${fmtInt(m.rows.length)} rows` }), h("b", { text: fmtT(t, b.mean) })),
    intervalBar(b.mean, b.lo, b.hi, b.mean, domain, { tone: "base" }));
  tip(el, () => h("div", null, h("b", { text: "Where the stack starts" }), h("div", { text: `${fmtT(t, b.mean)} (95% ${rangeText(t, b.lo, b.hi)}) over ${fmtInt(m.rows.length)} rows: the base, the dashed line on every bar.` })));
  return el;
}

function brick(m, A, pocket, c, k, step, v, domain, ps) {
  const t = m.target;
  const d = m.schema.dimById.get(c.dim);
  const vals = labels(d, c.keys);
  const el = h("div", { class: `brick v-${v.kind}`, draggable: "true", dataset: { dim: c.dim } },
    h("div", { class: "bk-top" },
      h("span", { class: "bk-what" }, h("span", { class: "bk-name", text: d.label }), h("span", { class: "bk-eq", text: " = " }), h("span", { class: "bk-vals", text: vals.join(" or ") })),
      h("button", { class: "icon-btn bk-x", type: "button", "aria-label": `Remove ${d.label}`, onclick: () => A.set({ pocket: pocket.filter((_, j) => j !== k) }) }, icon("close"))),
    h("div", { class: "bk-path has-tip" },
      h("span", { class: "bk-fig num" }, h("span", { text: `${fmtInt(step.n)} rows` }), h("b", { text: fmtT(t, step.mean) })),
      intervalBar(step.mean, step.lo, step.hi, m.base.mean, domain)),
    h("div", { class: "bk-verdict has-tip" },
      h("span", { class: "vtag", text: VERDICT[v.kind] }),
      h("span", { class: "bk-without num", text: `without it ${fmtT(t, v.without.mean)} on ${fmtInt(v.without.n)} rows` })));
  tip(el.querySelector(".bk-path"), () => h("div", null, h("b", { text: k === pocket.length - 1 ? "The whole pocket" : `After block ${k + 1}` }),
    h("div", { text: `${fmtInt(step.n)} rows, ${fmtT(t, step.mean)} (95% ${rangeText(t, step.lo, step.hi)})` }),
    h("div", { class: "k", text: "The blocks below and this one. Drag a block to reorder the path; the pocket itself does not change." })));
  tip(el.querySelector(".bk-verdict"), () => h("div", null, h("b", { text: VERDICT[v.kind] }),
    h("div", { text: v.kind === "few" ? `Its rows or the ${fmtInt(v.removed.n)} it takes away are under ${MIN_N}, so no test is made.`
      : `The pocket's ${fmtInt(ps.n)} rows (${fmtT(t, ps.mean)}) against the ${fmtInt(v.removed.n)} this block takes away (${fmtT(t, v.removed.mean)}): ${fmtP(v.p, "p")}, ${fmtP(v.q)} across the blocks.` }),
    h("div", { class: "k", text: `Without it the pocket holds ${fmtInt(v.without.n)} rows at ${fmtT(t, v.without.mean)} (${fmtDelta(t, v.without.mean - ps.mean)}).` })));
  el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-grid-brick", String(k)); e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-grid-brick")) { e.preventDefault(); e.stopPropagation(); } });
  el.addEventListener("drop", (e) => {
    const from = e.dataTransfer.getData("application/x-grid-brick");
    if (from === "") return;
    e.preventDefault(); e.stopPropagation();
    const p = pocket.slice();
    const [moved] = p.splice(+from, 1);
    p.splice(k, 0, moved);
    A.set({ pocket: p });
  });
  return el;
}

// ---------------------------------------------------------------------------
// A pinned pocket against this one

function compareIsland(m, A, pinned, ps) {
  const t = m.target;
  const pb = pocketStats(m.schema, pinned, t, m.rows, m.edge);
  const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null, h("th", { text: "" }), h("th", { class: "r", text: "Pinned" }), h("th", { class: "r", text: "This pocket" }))));
  const tb = h("tbody");
  const row = (k, a, b) => tb.append(h("tr", null, h("td", { text: k }), h("td", { class: "r num", text: a }), h("td", { class: "r num", text: b })));
  row("Blocks", fmtInt(pinned.length), fmtInt((m.state.pocket || []).length));
  row("Rows", fmtInt(pb.n), fmtInt(ps.n));
  row(t.label, fmtT(t, pb.mean), fmtT(t, ps.mean));
  row("95% interval", rangeText(t, pb.lo, pb.hi), rangeText(t, ps.lo, ps.hi));
  if (t.kind === "binary") row("Hits", fmtInt(pb.hits), fmtInt(ps.hits));
  tbl.append(tb);
  const overlap = !(pb.hi < ps.lo || ps.hi < pb.lo);
  return h("section", { class: "island", "aria-labelledby": "pin-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "pin-title", text: "Against the pinned pocket" })),
    h("div", { class: "table-wrap" }, tbl),
    h("p", { class: "isl-note", text: overlap ? "Their intervals overlap: these rows do not tell the two pockets apart." : "Their intervals do not overlap." }),
    h("footer", { class: "isl-foot" },
      h("button", { class: "btn small", type: "button", onclick: () => A.set({ pocket: pinned.map(c => ({ ...c })) }) }, "Bring the pinned one back"),
      h("button", { class: "btn small", type: "button", onclick: () => A.set({ pocketB: null }) }, "Unpin")));
}

// ---------------------------------------------------------------------------
// Blocks to add: suggested, then every value, under one search

// What the reader typed into the search, kept across redraws.
let query = "";

function suggest(m, pocket, rows) {
  const used = new Set(pocket.map(c => c.dim));
  const dims = boardDims(m.schema).concat(memberDims(m.schema)).filter(d => !used.has(d.id));
  return suggestions(m.schema, dims, m.target, rows, summarize(m.target, rows), 10);
}

function addIsland(m, A, pocket, sug) {
  const input = h("input", { class: "search", type: "search", placeholder: "Find a parameter or value", "data-search": "1",
    "aria-label": "Find a parameter or value", dataset: { focus: "pocket-search" } });
  input.value = query;
  const body = h("div", { class: "add-body" });
  const draw = () => {
    body.replaceChildren(suggestedPart(m, A, pocket, sug, query), everyPart(m, A, pocket, query));
  };
  input.addEventListener("input", () => { query = input.value; draw(); });
  draw();
  return h("section", { class: "island add-island", "aria-labelledby": "add-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "add-title", text: "Add a block" }), input),
    body);
}

const matches = (q, ...texts) => !q || texts.some(x => String(x).toLowerCase().includes(q));

function suggestedPart(m, A, pocket, sug, raw) {
  const t = m.target;
  const q = raw.trim().toLowerCase();
  const shown = sug.filter(s => matches(q, s.dimLabel, s.label));
  const lo = Math.min(m.base.lo, ...shown.map(s => s.lo)), hi = Math.max(m.base.hi, ...shown.map(s => s.hi));
  const pad = (hi - lo) * 0.08 || 1;
  const domain = [lo - pad, hi + pad];
  const title = h("h3", { class: "part-title has-tip" }, h("span", { text: pocket.length ? "Next block" : "Where to start" }),
    h("span", { class: "note", text: `ranked by the ${t.better < 0 ? "upper" : "lower"} end of the 95% interval` }));
  tip(title, `Values ranked by the ${t.better < 0 ? "upper" : "lower"} end of their 95% interval inside ${pocket.length ? "the pocket" : "the rows in view"}: the conservative estimate, not the luckiest. Values with fewer than ${MIN_N} rows are left out.`);
  const part = h("div", { class: "isl-part" }, title);
  if (!shown.length) { part.append(h("p", { class: "isl-note", text: q ? "No suggestion matches." : `No value has ${MIN_N} rows ${pocket.length ? "inside the pocket" : "yet"}.` })); return part; }
  const tbl = h("table", { class: "vals suggest" }, h("thead", null, h("tr", null, h("th", { text: "Value" }), h("th", { class: "r", text: "Rows" }),
    h("th", { class: "r", text: t.label }), h("th", { class: "iv", text: "95% interval" }))));
  const tb = h("tbody");
  for (const s of shown) {
    const d = m.schema.dimById.get(s.dim);
    const what = d.kind === "member" ? `${s.dimLabel} included` : `${d.label} = ${s.label}`;
    const tr = h("tr", { class: "clickable", tabindex: "0", "aria-label": `Add ${what}`, onclick: () => A.addPocket(s.dim, s.key),
      onkeydown: (e) => { if (e.key === "Enter") A.addPocket(s.dim, s.key); } },
      h("td", { class: "v", text: what }), h("td", { class: "r num", text: fmtInt(s.n) }), h("td", { class: "r num", text: fmtT(t, s.mean) }),
      h("td", { class: "iv has-tip" }, intervalBar(s.mean, s.lo, s.hi, m.base.mean, domain)));
    tip(tr.lastChild, `95% ${rangeText(t, s.lo, s.hi)}; the dashed line is the base, ${fmtT(t, m.base.mean)}.`);
    tb.append(tr);
  }
  tbl.append(tb);
  part.append(h("div", { class: "table-wrap" }, tbl));
  return part;
}

function everyPart(m, A, pocket, raw) {
  const q = raw.trim().toLowerCase();
  const part = h("div", { class: "isl-part" }, h("h3", { class: "part-title" }, h("span", { text: "Every value" }),
    h("span", { class: "note", text: "click to add or take out, or drag onto the stack" })));
  const list = h("div", { class: "palette", dataset: { scroll: "pocket-palette" } });
  let shown = 0;
  for (const d of boardDims(m.schema).concat(memberDims(m.schema))) {
    const nm = d.label;
    const levels = (d.kind === "member" ? d.levels.filter(x => x.key === "in") : d.levels).filter(l => matches(q, nm, l.label));
    if (!levels.length) continue;
    shown++;
    const block = pocket.find(c => c.dim === d.id);
    const vals = h("div", { class: "pal-vals" });
    for (const l of levels) {
      const on = !!block && block.keys.includes(l.key);
      const chip = h("button", { class: "vchip", type: "button", draggable: "true", "aria-pressed": on ? "true" : "false",
        "aria-label": `${on ? "Take out" : "Add"} ${nm} = ${l.label}`,
        onclick: () => (on ? takeOut(A, pocket, d.id, l.key) : A.addPocket(d.id, l.key)) }, d.kind === "member" ? "included" : l.label);
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(VALUE, JSON.stringify({ dim: d.id, key: l.key }));
        e.dataTransfer.setData("text/plain", `${nm} = ${l.label}`);
      });
      vals.append(chip);
    }
    list.append(h("div", { class: "pal-item" + (block ? " in" : "") }, h("div", { class: "pal-name", text: nm }), vals));
  }
  part.append(shown ? list : h("p", { class: "isl-note", text: "Nothing matches." }));
  return part;
}

// One value out of its block; the block goes when it holds none.
function takeOut(A, pocket, dim, key) {
  A.set({ pocket: pocket.map(c => (c.dim === dim ? { dim, keys: c.keys.filter(k => k !== key) } : c)).filter(c => c.keys.length) });
}
