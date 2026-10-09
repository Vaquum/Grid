// Pocket: stack value blocks into a pocket (a conjunction), read what it
// holds, and take its code to the next sweep.

import { h, icon, tip, fmtT, fmtInt, fmtPct, fmtDelta, fmtP, copyText } from "./ui.js";
import { pocketStats, rowsIn, suggestions, summarize, MIN_N } from "./engine.js";
import { boardDims, memberDims } from "./model.js";
import { runRate } from "./view-run.js";

export function renderPocket(view, m, A) {
  const { schema, target } = m;
  const pocket = (m.state.pocket || []).filter(c => schema.dimById.has(c.dim));
  view.append(h("div", { class: "view-head" },
    h("div", null, h("h1", { text: "Compose a pocket" }),
      h("div", { class: "sub" }, "Stack blocks to narrow the sweep to the rows that hold every one of them. A block holds one or more values of a parameter; values in one block are alternatives, blocks on top of each other must all hold. ",
        "Because the sweep draws every parameter independently and uniformly, the rate inside a pocket estimates what a new sweep drawn only inside it would hit."))));
  const grid = h("div", { class: "pocket-grid" });
  view.append(grid);
  const left = h("div"), right = h("div", { style: { minWidth: 0 } });
  grid.append(left, right);

  // ---- the stack (first block at the bottom)
  const steps = cumulative(m, pocket);
  const stack = h("div", { class: "stack", "aria-label": "The pocket's blocks, first at the bottom" });
  stack.append(h("div", { class: "floor", text: pocket.length ? `All ${fmtInt(m.rows.length)} rows · ${fmtT(target, m.base.mean)}` : "Drop or add a block to start" }));
  pocket.forEach((c, k) => stack.append(brick(m, A, pocket, c, k, steps[k])));
  stack.addEventListener("dragover", (e) => { e.preventDefault(); stack.style.borderColor = "var(--ink)"; });
  stack.addEventListener("dragleave", () => { stack.style.borderColor = ""; });
  stack.addEventListener("drop", (e) => {
    e.preventDefault();
    stack.style.borderColor = "";
    const raw = e.dataTransfer.getData("text/plain");
    try { const { dim, key } = JSON.parse(raw); if (dim && key !== undefined) A.addPocket(dim, key); }
    catch (err) { console.warn("ignored a drop that is not a value block", err); }
  });
  left.append(h("div", { class: "section-title", style: { marginTop: 0 }, text: "The stack" }), stack);
  if (pocket.length) {
    left.append(h("div", { class: "actions" },
      h("button", { class: "btn", onclick: () => A.set({ pocket: [] }) }, "Clear"),
      h("button", { class: "btn", onclick: () => A.set({ pocketB: pocket.map(c => ({ ...c })) }) }, "Pin as A to compare"),
      h("button", { class: "btn", onclick: () => A.set({ context: pocket.map(c => ({ ...c })), view: "board" }) }, "Look inside it on the board")));
  }
  left.append(palette(m, A, pocket));

  // ---- readout
  if (!pocket.length) {
    right.append(h("div", { class: "empty" }, h("p", { text: "No blocks yet." }),
      h("p", null, "Choose a value in the inspector and press ", h("kbd", { text: "P" }), ", drag a value from the list on the left, or take a suggestion below.")));
    right.append(suggestBlock(m, A, [], m.rows));
    return;
  }
  const ps = pocketStats(schema, pocket, target, m.rows, m.edge);
  right.append(readout(m, ps, "This pocket"));
  if (m.state.pocketB && m.state.pocketB.length) {
    const pb = m.state.pocketB.filter(c => schema.dimById.has(c.dim));
    const psB = pocketStats(schema, pb, target, m.rows, m.edge);
    right.append(h("div", { class: "section-title", text: "Against the pinned pocket" }), compare(m, pb, psB, ps, A));
  }
  right.append(h("div", { class: "section-title", text: "Does each block earn its place?" }), withoutEach(m, pocket, ps));
  right.append(suggestBlock(m, A, pocket, ps.rows));
  right.append(h("div", { class: "section-title", text: "Take it to the next sweep" }), codeBlock(m, pocket, ps));
}

// Rows and rate after each block, bottom up.
function cumulative(m, pocket) {
  const out = [];
  for (let k = 1; k <= pocket.length; k++) {
    const rows = rowsIn(m.schema, pocket.slice(0, k), m.edge);
    const inCtx = intersect(rows, m.rows);
    out.push({ rows: inCtx, s: summarize(m.target, inCtx) });
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

function brick(m, A, pocket, c, k, step) {
  const d = m.schema.dimById.get(c.dim);
  const labels = c.keys.map(key => (d.levels.find(l => l.key === key) || { label: key }).label);
  const name = d.kind === "scoped" ? `${d.name} (${d.scope.label})` : d.label;
  const el = h("div", { class: "brick", draggable: "true" },
    h("div", { class: "what" }, h("b", { text: name }), " = ", labels.join(" or "),
      h("div", { class: "muted num", text: `${fmtInt(step.s.n)} rows · ${fmtT(m.target, step.s.mean)}` })),
    h("button", { class: "icon-btn x", "aria-label": `Remove ${name}`, onclick: () => A.set({ pocket: pocket.filter((_, j) => j !== k) }) }, icon("close")));
  tip(el.querySelector(".what"), () => h("div", null, h("b", { text: `After block ${k + 1}` }),
    h("div", { text: `${fmtInt(step.s.n)} rows, ${fmtT(m.target, step.s.mean)} [${fmtT(m.target, step.s.lo)}, ${fmtT(m.target, step.s.hi)}]` }),
    h("div", { class: "k", text: "Drag a block to reorder the path; the pocket itself does not change." })));
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

// What the reader typed into the palette, kept across redraws.
let paletteQuery = "";

function palette(m, A, pocket) {
  const box = h("div");
  const input = h("input", { class: "search", type: "search", placeholder: "Find a parameter or value", "data-search": "1",
    "aria-label": "Find a parameter or value", dataset: { focus: "pocket-search" } });
  input.value = paletteQuery;
  const list = h("div", { dataset: { scroll: "pocket-palette" }, style: { marginTop: "8px", display: "flex", flexDirection: "column", gap: "8px", maxHeight: "460px", overflowY: "auto" } });
  const dims = boardDims(m.schema).concat(memberDims(m.schema));
  const draw = () => {
    list.replaceChildren();
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const d of dims) {
      const name = d.kind === "scoped" ? `${d.name} ${d.scope.label}` : d.label;
      const levels = d.levels.filter(l => !q || name.toLowerCase().includes(q) || String(l.label).toLowerCase().includes(q));
      if (!levels.length) continue;
      if (++shown > 40) break;
      const row = h("div", null, h("div", { class: "mono", style: { fontSize: "11px", color: "var(--ink-2)", marginBottom: "4px" }, text: name }));
      const chips = h("div", { class: "chips" });
      for (const l of (d.kind === "member" ? levels.filter(x => x.key === "in") : levels)) {
        const inPocket = pocket.some(c => c.dim === d.id && c.keys.includes(l.key));
        const chip = h("button", { class: "chip", draggable: "true", disabled: inPocket ? "disabled" : null,
          style: { paddingRight: "8px", opacity: inPocket ? "0.45" : "1" },
          onclick: () => A.addPocket(d.id, l.key) }, d.kind === "member" ? "included" : l.label);
        chip.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", JSON.stringify({ dim: d.id, key: l.key })));
        chips.append(chip);
      }
      row.append(chips);
      list.append(row);
    }
    if (!shown) list.append(h("p", { class: "muted", text: "Nothing matches." }));
  };
  input.addEventListener("input", () => { paletteQuery = input.value; draw(); });
  draw();
  box.append(h("div", { class: "section-title", text: "Blocks" }), input, list);
  return box;
}

function readout(m, ps, title) {
  const t = m.target;
  const binary = t.kind === "binary";
  const card = h("div", { class: "card" });
  card.append(h("h3", { text: title }));
  const hero = h("div", { class: "hero", style: { margin: "6px 0 10px" } },
    h("span", { class: "big num", text: fmtT(t, ps.mean) }),
    h("span", { class: "ci num", text: `[${fmtT(t, ps.lo)}, ${fmtT(t, ps.hi)}] · base ${fmtT(t, ps.base.mean)}` }));
  card.append(hero);
  const stats = h("div", { class: "stat-row" });
  const stat = (k, v, d, tipText) => { const el = h("div", { class: "stat has-tip" }, h("div", { class: "k", text: k }), h("div", { class: "v num", text: v }), d ? h("div", { class: "d", text: d }) : null); if (tipText) tip(el, tipText); stats.append(el); };
  stat("Rows", fmtInt(ps.n), `${fmtPct(ps.share, 1)} of the sweep`, "Rows that hold every block (inside the context).");
  if (binary) {
    stat("Lift", Number.isFinite(ps.lift) ? `${ps.lift.toFixed(2)}×` : "–", "rate over the base", "The pocket's rate divided by the base rate.");
    stat("Hits", fmtInt(ps.hits), `${fmtPct(ps.recall, 0)} of all hits`, "Recall: the share of every hit in the sweep that falls inside the pocket.");
  } else {
    stat("Against the base", fmtDelta(t, ps.mean - ps.base.mean), null);
  }
  const sec = m.schema.targetById.get("sec");
  if (sec && binary && ps.hits > 0) {
    let total = 0;
    for (let j = 0; j < ps.rows.length; j++) { const v = sec.values[ps.rows[j]]; if (v === v) total += v; }
    stat("Compute per hit", `${(total / ps.hits).toFixed(1)} s`, "worker seconds per hit", "Sum of the rows' seconds inside the pocket, divided by its hits: what a hit costs if a sweep ran only here.");
    const rate = runRate(m);
    if (rate && rate.rowsPerSec > 0) stat("At the run's pace", `${fmtInt(rate.rowsPerSec * ps.mean * 3600)} hits/h`, `${rate.rowsPerSec.toFixed(1)} rows/s`, "Hits per hour a sweep drawn only inside this pocket would find at the current run's row rate (the pocket's rows cost about what the run's rows cost).");
  }
  card.append(stats);
  // split-half
  const [a, b] = ps.halves;
  const agree = Number.isFinite(ps.halvesP) ? ps.halvesP >= 0.05 : null;
  const half = h("p", { class: "note" },
    h("span", { class: "sev " + (agree === null ? "warn" : agree ? "ok" : "crit") }, icon(agree === false ? "alert" : "check"),
      agree === null ? "Too few rows to compare halves" : agree ? "No detectable difference between the halves" : "The halves differ"),
    agree === null ? "" : `: ${fmtT(t, a.mean)} in the first half of the arrivals, ${fmtT(t, b.mean)} in the second (${fmtP(ps.halvesP, "p")}).`);
  tip(half, "The context's rows split at their median arrival. A pocket mined on one half and confirmed on the other is less likely to be noise; one that only holds in one half is suspect.");
  card.append(half);
  card.append(gatesInside(m, ps.rows));
  return card;
}

function gatesInside(m, rows) {
  const g = m.schema.targetById.get("gates");
  if (!g) return null;
  const inside = new Float64Array(10), all = new Float64Array(10);
  for (let j = 0; j < rows.length; j++) { const v = g.values[rows[j]]; if (v >= 0 && v <= 9) inside[v]++; }
  for (let j = 0; j < m.rows.length; j++) { const v = g.values[m.rows[j]]; if (v >= 0 && v <= 9) all[v]++; }
  const ni = inside.reduce((a, b) => a + b, 0), na = all.reduce((a, b) => a + b, 0);
  const wrap = h("div", { style: { marginTop: "10px" } }, h("div", { class: "muted", style: { fontSize: "11.5px", marginBottom: "4px" }, text: "Gates passed: share of the pocket's rows (dark) and of all rows (light)" }));
  const row = h("div", { style: { display: "flex", alignItems: "flex-end", gap: "6px", height: "70px" } });
  const top = Math.max(...inside.map(x => x / Math.max(1, ni)), ...all.map(x => x / Math.max(1, na)), 0.01);
  for (let k = 0; k <= 9; k++) {
    if (!inside[k] && !all[k]) continue;
    const pi = inside[k] / Math.max(1, ni), pa = all[k] / Math.max(1, na);
    const col = h("div", { class: "has-tip", style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" } },
      h("div", { style: { display: "flex", alignItems: "flex-end", gap: "2px", height: "52px" } },
        h("div", { style: { width: "9px", height: `${Math.max(1, 52 * pi / top)}px`, background: "var(--ink)", borderRadius: "2px 2px 0 0" } }),
        h("div", { style: { width: "9px", height: `${Math.max(1, 52 * pa / top)}px`, background: "var(--line-2)", borderRadius: "2px 2px 0 0" } })),
      h("div", { class: "muted num", style: { fontSize: "10.5px" }, text: String(k) }));
    tip(col, `${k} gates: ${fmtPct(pi, 1)} of the pocket (${fmtInt(inside[k])} rows), ${fmtPct(pa, 1)} of all rows`);
    row.append(col);
  }
  wrap.append(row);
  return wrap;
}

function compare(m, pb, psB, ps, A) {
  const t = m.target;
  const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null, h("th", { text: "" }), h("th", { class: "r", text: "pinned A" }), h("th", { class: "r", text: "this pocket" }))));
  const tb = h("tbody");
  const row = (k, a, b) => tb.append(h("tr", null, h("td", { text: k }), h("td", { class: "r num", text: a }), h("td", { class: "r num", text: b })));
  row("blocks", String(pb.length), String((m.state.pocket || []).length));
  row("rows", fmtInt(psB.n), fmtInt(ps.n));
  row(t.label, `${fmtT(t, psB.mean)} [${fmtT(t, psB.lo)}, ${fmtT(t, psB.hi)}]`, `${fmtT(t, ps.mean)} [${fmtT(t, ps.lo)}, ${fmtT(t, ps.hi)}]`);
  if (t.kind === "binary") row("hits", fmtInt(psB.hits), fmtInt(ps.hits));
  tbl.append(tb);
  const overlap = !(psB.hi < ps.lo || ps.hi < psB.lo);
  return h("div", { class: "card" }, h("div", { class: "table-wrap" }, tbl),
    h("p", { class: "note", text: overlap ? "Their intervals overlap: these rows do not tell the two pockets apart." : "Their intervals do not overlap." }),
    h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => A.set({ pocket: pb.map(c => ({ ...c })) }) }, "Bring A back"),
      h("button", { class: "btn", onclick: () => A.set({ pocketB: null }) }, "Unpin")));
}

function withoutEach(m, pocket, ps) {
  const t = m.target;
  const tbl = h("table", { class: "vals" }, h("thead", null, h("tr", null, h("th", { text: "without" }), h("th", { class: "r", text: "rows" }), h("th", { class: "r", text: t.label }), h("th", { class: "r", text: "change" }))));
  const tb = h("tbody");
  pocket.forEach((c, k) => {
    const rest = pocket.filter((_, j) => j !== k);
    const s = rest.length ? pocketStats(m.schema, rest, t, m.rows, m.edge) : { n: m.rows.length, mean: m.base.mean };
    const d = m.schema.dimById.get(c.dim);
    const delta = ps.mean - s.mean;
    const tr = h("tr", null, h("td", { class: "v", text: d.kind === "scoped" ? `${d.name} (${d.scope.label})` : d.label }),
      h("td", { class: "r num", text: fmtInt(s.n) }), h("td", { class: "r num", text: fmtT(t, s.mean) }),
      h("td", { class: "r num", text: `${fmtDelta(t, delta)} for ${fmtInt(s.n - ps.n)} fewer rows` }));
    tb.append(tr);
  });
  tbl.append(tb);
  return h("div", { class: "table-wrap" }, tbl,
    h("p", { class: "muted", text: "A block that barely changes the pocket's rate only costs rows; a block whose removal drops the rate is doing the work." }));
}

function suggestBlock(m, A, pocket, rows) {
  const t = m.target;
  const used = new Set(pocket.map(c => c.dim));
  const dims = boardDims(m.schema).concat(memberDims(m.schema)).filter(d => !used.has(d.id));
  const base = summarize(t, rows);
  const sug = suggestions(m.schema, dims, t, rows, base, 10);
  const wrap = h("div");
  wrap.append(h("div", { class: "section-title", text: pocket.length ? "Next block" : "Where to start" }),
    h("p", { class: "muted", text: `Values ranked by the ${t.better < 0 ? "upper" : "lower"} end of their 95% interval inside ${pocket.length ? "the pocket" : "the sweep"}: the conservative estimate, not the luckiest. Values with fewer than ${MIN_N} rows are left out.` }));
  const tbl = h("table", { class: "vals suggest" }, h("thead", null, h("tr", null, h("th", { text: "add" }), h("th", { class: "r", text: "rows" }), h("th", { class: "r", text: t.label }), h("th", { class: "r", text: "95% interval" }))));
  const tb = h("tbody");
  for (const sgt of sug) {
    const d = m.schema.dimById.get(sgt.dim);
    const name = d.kind === "member" ? `${sgt.dimLabel} included` : `${d.kind === "scoped" ? `${d.name} (${d.scope.label})` : sgt.dimLabel} = ${sgt.label}`;
    tb.append(h("tr", { class: "clickable", tabindex: "0", onclick: () => A.addPocket(sgt.dim, sgt.key), onkeydown: (e) => { if (e.key === "Enter") A.addPocket(sgt.dim, sgt.key); } },
      h("td", { class: "v", text: name }),
      h("td", { class: "r num", text: fmtInt(sgt.n) }), h("td", { class: "r num", text: fmtT(t, sgt.mean) }),
      h("td", { class: "r num", text: `${fmtT(t, sgt.lo)} – ${fmtT(t, sgt.hi)}` })));
  }
  tbl.append(tb);
  wrap.append(h("div", { class: "table-wrap" }, tbl));
  return wrap;
}

// The target as a Python expression on one row dict `r`.
function targetPy(t) {
  if (t.id === "tradeable") return '(r["gates"] >= 6 and r["total"] >= 3000)';
  if (t.id === "gates7") return 'r["gates"] >= 7';
  if (t.gate) return `r["gates_detail"][${JSON.stringify(t.gate)}]["pass"]`;
  return `r[${JSON.stringify(t.id)}]`;
}

function pyValue(v) {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

function yamlValue(v) {
  if (v === null) return "null";
  return typeof v === "string" ? v : String(v);
}

function codeBlock(m, pocket, ps) {
  const sc = m.schema;
  const conds = [], yaml = [];
  for (const c of pocket) {
    const d = sc.dimById.get(c.dim);
    const vals = c.keys.map(k => (d.levels.find(l => l.key === k) || {}).value);
    if (d.kind === "member") {
      conds.push(`${JSON.stringify(d.name)} in (r[${JSON.stringify(d.set.column)}] or [])`);
      yaml.push(`# ${d.set.column}: always include ${d.name}`);
      continue;
    }
    if (d.kind === "size") {
      conds.push(`len(r[${JSON.stringify(d.column)}] or []) in (${vals.map(pyValue).join(", ")},)`);
      continue;
    }
    const path = d.column.split(".").map(p => `[${JSON.stringify(p)}]`).join("");
    if (d.scope) {
      const sd = sc.dimById.get(d.scope.dim);
      conds.push(`r[${JSON.stringify(sd.column)}] == ${pyValue(sd.levels[d.scope.level].value)}`);
    }
    conds.push(`r${path} in (${vals.map(pyValue).join(", ")},)`);
    const all = d.levels.map(l => yamlValue(l.value));
    yaml.push(`${d.scope ? `${d.name}  # under ${d.scope.label}` : d.column}: [${vals.map(yamlValue).join(", ")}]  # was [${all.join(", ")}]`);
  }
  const py = `def in_pocket(r):\n    """${fmtInt(ps.n)} rows, ${fmtT(m.target, ps.mean)} [${fmtT(m.target, ps.lo)}, ${fmtT(m.target, ps.hi)}] ${m.target.label.toLowerCase()} (${m.ds.meta.label})."""\n    return (${conds.join("\n            and ")})`;
  const space = `# narrowed space: ${fmtInt(ps.n)} rows here hit ${fmtT(m.target, ps.mean)} [${fmtT(m.target, ps.lo)}, ${fmtT(m.target, ps.hi)}]\n${yaml.join("\n")}`;
  const src = (m.ds.meta.source || "results.jsonl").split(":").pop();
  const query = `import json\n\nrows = [json.loads(l) for l in open(${JSON.stringify(src)})]\ninside = [r for r in rows if in_pocket(r)]\ny = [${targetPy(m.target)} for r in inside]\nprint(len(inside), sum(y) / len(y))`;
  const out = h("div");
  for (const [label, text] of [["Python predicate (one row as a dict)", py], ["The pocket as a space, for the next sweep's YAML", space], ["Check it on the results file", query]]) {
    const pre = h("pre", { class: "code", text });
    out.append(h("div", { class: "code-head" }, h("span", { text: label }),
      h("button", { class: "btn small", onclick: async () => { await copyText(text, pre); } }, icon("copy"), "Copy")), pre);
  }
  return out;
}

