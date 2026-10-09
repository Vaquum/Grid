// Pairs: which parameters change each other's effect, two at a time or
// more, and how the sampler drew them together.
//
// The page: the strip (the chosen size in figures); the interactions of
// that size, strongest first, over the map of every pair; and beside them
// the chosen set (the strongest until one is chosen): a pair as the needle
// in every combination of its values with each value's own margin, three
// as that grid for each value of the third, more as their strongest and
// weakest combinations.

import { h, tip, fmtT, fmtInt, fmtP, fmtDelta, inText } from "./ui.js";
import { pairEffect, cramersV, dimEffect, summarize, comboEffect, ALPHA } from "./engine.js";
import { bhQ } from "./stats.js";
import { moderatorParents, background } from "./model.js";
import { divergingFill, intervalBar } from "./charts.js";
import { strip, stripCell, about } from "./strip.js";

// The parameters paired: the ones a value can moderate (2 to 12 values),
// the strongest on the board first, at most this many.
const PAIR_DIMS = 26;

// Larger sets: how many parameters at once, what each size is called, and
// what keeps the search sound and quick. A set is tested only when every
// cell of its grid holds MIN_CELL rows; a size combines only the strongest
// parameters (by what each does alone or with one other: effect
// heredity), as many as keep it within SET_BUDGET sets and WORK_BUDGET rows
// read; it runs in the background, and only when chosen.
const SIZES = [2, 3, 4, 5, 6];
const SIZE_NAME = { 2: ["pair", "pairs"], 3: ["triple", "triples"], 4: ["set of four", "sets of four"], 5: ["set of five", "sets of five"], 6: ["set of six", "sets of six"] };
const MIN_CELL = 5;
const SET_BUDGET = 2000;
const WORK_BUDGET = 4e8;

function choose(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

// The parameters a size combines, strongest first, and how many sets.
function comboPlan(m, size, pairs) {
  const score = new Map(pairs.dims.map(id => [id, 0]));
  for (const e of m.board.effects) if (score.has(e.dim) && e.omega2 > 0) score.set(e.dim, e.omega2);
  for (const r of pairs.list) if (r.detectable) for (const id of [r.a, r.b]) score.set(id, Math.max(score.get(id), r.omega2));
  const ranked = pairs.dims.slice().sort((a, b) => score.get(b) - score.get(a));
  const budget = Math.max(50, Math.min(SET_BUDGET, Math.floor(WORK_BUDGET / Math.max(1, m.rows.length * size))));
  let P = Math.min(size, ranked.length);
  while (P < ranked.length && choose(P + 1, size) <= budget) P++;
  return { size, pool: ranked.slice(0, P), of: ranked.length, sets: P >= size ? choose(P, size) : 0 };
}

// Every set of the plan, in slices; q over the sets tested.
function* comboJob(m, plan) {
  const k = plan.size, pool = plan.pool.map(id => m.schema.dimById.get(id));
  const base = summarize(m.target, m.rows);
  const list = [];
  let sparse = 0, since = 0;
  if (pool.length >= k) {
    const idx = Array.from({ length: k }, (_, i) => i);
    for (;;) {
      const ds = idx.map(i => pool[i]);
      const r = comboEffect(ds, m.target, m.rows, base, MIN_CELL);
      if (r.sparse) sparse++;
      else list.push({ dims: ds.map(d => d.id), p: r.p, omega2: r.omega2 });
      if (++since >= 4) { since = 0; yield; }
      let i = k - 1;
      while (i >= 0 && idx[i] === pool.length - k + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
  }
  const q = bhQ(list.map(r => r.p));
  list.forEach((r, j) => { r.q = q[j]; r.detectable = q[j] < ALPHA; });
  return { size: k, pool: plan.pool, of: plan.of, sets: plan.sets, tested: list.length, sparse, list, rows: m.rows.length };
}

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
  view.append(h("h1", { class: "sr", text: "Parameters at once" }));
  const size = SIZES.includes(m.state.order) ? m.state.order : 2;
  const pairs = background(m, "pairs", pairsJob, A.rerender);
  const plan = pairs && size > 2 ? comboPlan(m, size, pairs) : null;
  const combos = plan ? background(m, `combos${size}`, () => comboJob(m, plan), A.rerender) : null;
  view.append(pairsStrip(m, A, pairs, size, plan, combos));
  if (!pairs) {
    view.append(h("div", { class: "island pending", role: "status" }, h("span", { text: "Testing every pair…" })));
    return;
  }
  const ranked = pairs.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2);
  const chosen = chosenSet(m, pairs, ranked, size, combos);
  let detail;
  if (size === 2) detail = chosen ? pairIsland(m, A, pairs, chosen) : noPair(pairs);
  else if (!combos) detail = h("section", { class: "island pr-pair pending", role: "status" }, h("p", { class: "isl-note", text: `Testing every ${SIZE_NAME[size][0]} of the ${fmtInt(plan.pool.length)} strongest parameters…` }));
  else detail = chosen ? comboIsland(m, A, combos, chosen) : noCombo(combos);
  // which sets on the left (the ranked ones over the map of every pair),
  // the chosen one on the right, in sight of either
  view.append(h("div", { class: "pr-grid" }, listIsland(m, A, pairs, ranked, chosen, size, plan, combos), detail, mapIsland(m, A, pairs, chosen)));
}

// The set the reader chose, of this size; else the strongest; for pairs,
// else the pair the sampler linked most, which matters as much: its
// effects mix.
function chosenSet(m, pairs, ranked, size, combos) {
  const pr = m.state.pair;
  if (Array.isArray(pr) && pr.length === size && new Set(pr).size === size && pr.every(id => m.schema.dimById.has(id))) return { dims: pr.slice(), why: null };
  if (size === 2) {
    if (ranked.length) return { dims: [ranked[0].a, ranked[0].b], why: "the strongest" };
    const linked = pairs.list.filter(r => r.linked).sort((a, b) => b.V - a.V);
    return linked.length ? { dims: [linked[0].a, linked[0].b], why: "the most linked" } : null;
  }
  const top = combos ? combos.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2)[0] : null;
  return top ? { dims: top.dims.slice(), why: "the strongest" } : null;
}

const pairOf = (pairs, a, b) => pairs.byKey.get(`${a}|${b}`) || pairs.byKey.get(`${b}|${a}`) || null;
const sameSet = (x, y) => x.length === y.length && x.every(id => y.includes(id));
const isChosen = (c, r) => !!c && c.dims.length === 2 && sameSet(c.dims, [r.a, r.b]);
const setName = (m, ids) => ids.map(id => shortName(m.schema.dimById.get(id))).join(" × ");

function shortName(d) {
  return d.kind === "scoped" ? `${d.name}@${d.scope.label.split(" = ")[1]}` : d.label;
}

function pairName(m, r) {
  return `${shortName(m.schema.dimById.get(r.a))} × ${shortName(m.schema.dimById.get(r.b))}`;
}

const omega = (r) => `${(Math.max(0, r.omega2) * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// The strip

function pairsStrip(m, A, pairs, size, plan, combos) {
  const t = m.target;
  const cells = [];
  if (pairs && size > 2) {
    const [one, many] = SIZE_NAME[size];
    const ranked = combos ? combos.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2) : [];
    const top = ranked[0] || null;
    const beyond = size === 3 ? "every pair within them" : "every smaller set within them";
    cells.push(stripCell(`Interacting ${many}`, combos ? fmtInt(ranked.length) : "…", combos ? `of ${fmtInt(combos.tested)} tested` : `testing ${fmtInt(plan.sets)}`,
      () => h("div", null, h("b", { text: `${cap(many)} that act together beyond ${beyond}` }),
        h("div", { class: "k", text: `What the ${size} explain of ${inText(t.label)} once ${beyond} is accounted for: ${t.kind === "binary" ? "a logistic likelihood-ratio test" : "an F test"} per ${one}, corrected across every ${one} tested (Benjamini–Hochberg, q < 0.05).` }))));
    cells.push(stripCell(`Strongest ${one}`, top ? setName(m, top.dims) : "–", top ? `ω² ${omega(top)}` : !combos ? "testing" : combos.tested ? `none detectable beyond ${size === 3 ? "its pairs" : "its smaller sets"}` : "none testable yet",
      () => h("div", null, h("b", { text: `The ${one} whose interaction explains the most` }), h("div", { class: "k", text: `ω²: the share of the needle's variance the ${size} explain together beyond ${beyond}.` })),
      top ? () => A.set({ pair: top.dims }) : null));
    cells.push(stripCell("Too sparse", combos ? fmtInt(combos.sparse) : "…", `of ${fmtInt(plan.sets)} ${many}`,
      () => h("div", null, h("b", { text: `${cap(many)} left untested` }), h("div", { class: "k", text: `A ${one} is tested only when every combination of its values holds ${MIN_CELL} rows or more, so its test has the degrees of freedom it claims. More rows open more of them.` }))));
    cells.push(stripCell("Parameters", fmtInt(plan.pool.length), `of ${fmtInt(plan.of)} · the strongest`,
      () => h("div", null, h("b", { text: `Parameters combined ${size} at a time` }),
        h("div", { class: "k", text: `The strongest by what each does alone or with one other (an interaction mostly involves parameters that act on their own or in a pair), as many as keep a search at ${fmtInt(SET_BUDGET)} ${many} or fewer.` }))));
    cells.push(stripCell("Rows", fmtInt(combos ? combos.rows : m.rows.length), combos && combos.rows < m.rows.length ? `of ${fmtInt(m.rows.length)} · refreshing` : null));
    return strip(`The ${many} in figures`, cells,
      { key: "pairs", label: "About the interactions", content: () => pairsAbout(m, pairs) },
      combos ? { label: `Copy the ${many} as notes`, what: `Every interacting ${one} with its ω² and q.`, text: () => combosNotes(m, combos), done: `${cap(many)} copied.` } : null, A);
  }
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
  return about("Parameters at once",
    `Two parameters interact when one changes the other's effect on ${inText(t.label)}: their combinations explain more than their two separate effects add up to (${t.kind === "binary" ? "a logistic likelihood-ratio test" : "an F test"} per pair, corrected across ${pairs ? `all ${fmtInt(pairs.list.length)} pairs` : "every pair"}).`,
    `Choose 3 to 6 for larger sets: what they explain together beyond every smaller set within them. A set is tested only when every combination of its values holds ${MIN_CELL} rows, and a size combines only the strongest parameters, so the search stays sound and quick; when no set of a size acts, its smaller sets give the full picture.`,
    "A pair opens as the needle in every combination of their values with each value's own margin, three as that grid for each value of the third, more as their strongest and weakest combinations; a cell opens on the board.",
    "The map below holds every pair: the interaction under the diagonal, and above it how the sampler drew the pair together (Cramér's V; near zero is what an independent sampler gives).");
}

function combosNotes(m, combos) {
  const [one, many] = SIZE_NAME[combos.size];
  const ranked = combos.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2);
  const lines = [`${cap(many)} on ${m.ds.meta.label}: ${m.target.label}, ${fmtInt(combos.rows)} rows, ${fmtInt(combos.tested)} of ${fmtInt(combos.sets)} ${many} of the ${fmtInt(combos.pool.length)} strongest parameters tested (${fmtInt(combos.sparse)} too sparse)`];
  lines.push(ranked.length ? `Interacting beyond every smaller set (q < 0.05), strongest first:` : `No ${one} acts beyond its smaller sets.`);
  for (const r of ranked) lines.push(`- ${setName(m, r.dims)}: ω² ${omega(r)}, ${fmtP(r.q)}`);
  return lines.join("\n");
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

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

function sizePicker(A, size) {
  const seg = h("div", { class: "seg pr-size", role: "group", "aria-label": "Parameters at once" });
  for (const k of SIZES) seg.append(h("button", { type: "button", "aria-pressed": k === size ? "true" : "false", "aria-label": `${k} parameters at once`, onclick: () => A.set({ order: k }) }, String(k)));
  return seg;
}

function listIsland(m, A, pairs, ranked, chosen, size, plan, combos) {
  if (size > 2) return comboList(m, A, chosen, size, plan, combos);
  const linked = pairs.list.filter(r => r.linked).sort((a, b) => b.V - a.V);
  const strongest = ranked.length ? Math.max(1e-9, ranked[0].omega2) : 1;
  const isl = h("section", { class: "island pr-list", "aria-labelledby": "pr-list-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "pr-list-title", text: "Interactions" }),
      h("span", { class: "isl-count num", text: `${fmtInt(ranked.length)} of ${fmtInt(pairs.list.length)} pairs` }), sizePicker(A, size)));
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

function comboList(m, A, chosen, size, plan, combos) {
  const [one, many] = SIZE_NAME[size];
  const isl = h("section", { class: "island pr-list", "aria-labelledby": "pr-list-title" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "pr-list-title", text: "Interactions" }),
      h("span", { class: "isl-count num", text: combos ? `${fmtInt(combos.list.filter(r => r.detectable).length)} of ${fmtInt(combos.tested)} ${many}` : `${fmtInt(plan.sets)} ${many}` }), sizePicker(A, size)));
  const coverage = `Every ${one} of the ${fmtInt(plan.pool.length)} strongest parameters: ${fmtInt(plan.sets)} ${many}`;
  if (!combos) { isl.append(h("p", { class: "isl-note", role: "status", text: `${coverage}, being tested…` })); return isl; }
  const ranked = combos.list.filter(r => r.detectable).sort((a, b) => b.omega2 - a.omega2);
  const row = (r, strongest, quiet) => {
    const on = !!chosen && sameSet(chosen.dims, r.dims);
    return h("button", { class: "pr-row" + (quiet ? " quiet" : ""), type: "button", role: "listitem", "aria-pressed": on ? "true" : "false", onclick: () => A.set({ pair: r.dims }) },
      h("span", { class: "pr-name", text: setName(m, r.dims) }),
      h("span", { class: "pr-meter", "aria-hidden": "true" }, h("i", { style: { width: `${Math.max(4, Math.max(0, r.omega2) / strongest * 100)}%` } })),
      h("span", { class: "pr-fig num", text: `ω² ${omega(r)}` }),
      h("span", { class: "pr-q num", text: fmtP(r.q) }));
  };
  if (!ranked.length) isl.append(h("p", { class: "isl-note", text: combos.tested ? `No ${one} acts detectably beyond ${size === 3 ? "its pairs" : "its smaller sets"}: at these rows, ${size === 3 ? "the pairs give" : "the smaller sets give"} the full picture.` : `No ${one} has ${MIN_CELL} rows in every combination of its values yet.` }));
  else {
    const strongest = Math.max(1e-9, ranked[0].omega2);
    isl.append(h("div", { class: "pr-rows", role: "list" }, ranked.map(r => row(r, strongest, false))));
  }
  // nothing detectable: the closest ones, to open and judge by eye
  if (!ranked.length && combos.tested) {
    const closest = combos.list.slice().sort((a, b) => a.p - b.p || b.omega2 - a.omega2).slice(0, 5);
    const strongest = Math.max(1e-9, closest[0].omega2);
    isl.append(h("div", { class: "isl-part" }, h("h3", { class: "part-title" }, h("span", { text: "The closest" }),
      h("span", { class: "note", text: "the nearest to detectable, none after correction" })),
      h("div", { class: "pr-rows", role: "list" }, closest.map(r => row(r, strongest, true)))));
  }
  isl.append(h("p", { class: "isl-note", text: `${coverage}; ${fmtInt(combos.tested)} tested, ${fmtInt(combos.sparse)} too sparse (a combination under ${MIN_CELL} rows) at ${fmtInt(combos.rows)} rows.` }));
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

// A cell of a heat table: the needle in one combination, coloured against
// the base on the table's own span, hatched under 30 rows; a click opens
// the combination on the board.
function heatCell(ctx, c, conds, where, cls = "") {
  const { m, A, t, base, span } = ctx;
  if (!c.n) return h("td", { class: `empty ${cls}` });
  if (c.withheld) {
    const td = h("td", { class: `withheld has-tip ${cls}` }, h("span", { class: "n", text: fmtInt(c.n) }));
    tip(td, `${where}: ${fmtInt(c.n)} rows, fewer than 30, so no number is shown`);
    return td;
  }
  const look = () => A.set({ context: [...m.context.filter(x => !conds.some(k => k.dim === x.dim)), ...conds], view: "board" });
  const d = (c.mean - base.mean) * (t.better < 0 ? -1 : 1);
  const td = h("td", { class: `click has-tip ${cls}`, style: divergingFill(span ? d / span : 0), tabindex: "0",
    onclick: look, onkeydown: (e) => { if (e.key === "Enter") look(); } },
    h("span", { class: "v", text: fmtT(t, c.mean, { unit: false, digits: t.kind === "binary" ? 0 : undefined }) }), h("span", { class: "n", text: fmtInt(c.n) }));
  tip(td, () => h("div", null, h("b", { text: fmtT(t, c.mean) }), h("span", { class: "k", text: `  [${fmtT(t, c.lo)}, ${fmtT(t, c.hi)}]` }),
    h("div", { class: "mono", text: where }),
    h("div", { class: "k", text: `${fmtInt(c.n)} rows · ${fmtDelta(t, c.mean - base.mean)} against the base${Number.isFinite(c.fitted) ? ` · the two effects alone: ${fmtT(t, c.fitted)}` : ""}` }),
    h("div", { class: "k", text: "Click to look inside it on the board." })));
  return td;
}

function heatLegend(t) {
  return h("div", { class: "legend" },
    h("span", null, h("i", { class: "box", style: { background: "var(--better)" } }), t.better < 0 ? "lower (better)" : "higher than the base"),
    h("span", null, h("i", { class: "box", style: { background: "var(--mid)", outline: "1px solid var(--line)" } }), "at the base"),
    h("span", null, h("i", { class: "box", style: { background: "var(--worse)" } }), t.better < 0 ? "higher (worse)" : "lower than the base"));
}

function pairIsland(m, A, pairs, chosen) {
  const t = m.target;
  let da = m.schema.dimById.get(chosen.dims[0]), db = m.schema.dimById.get(chosen.dims[1]);
  // the parameter with more values runs down the rows
  if (db.levels.length > da.levels.length) [da, db] = [db, da];
  const base = summarize(t, m.rows);
  const pe = pairEffect(da, db, t, m.rows, base);
  const r = pairOf(pairs, chosen.dims[0], chosen.dims[1]);
  const ea = dimEffect(da, t, m.rows, base), eb = dimEffect(db, t, m.rows, base);
  // diverging scale: the largest shown distance from the base, margins included
  let span = 0;
  const reach = (c) => { if (!c.withheld && c.n && Number.isFinite(c.mean)) span = Math.max(span, Math.abs(c.mean - base.mean)); };
  pe.table.forEach(reach); ea.levels.forEach(reach); eb.levels.forEach(reach);

  const ctx = { m, A, t, base, span };
  const cell = (c, conds, where, cls) => heatCell(ctx, c, conds, where, cls);

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
    heatLegend(t));
  return isl;
}

// ---------------------------------------------------------------------------
// Three or more: what the set does together beyond its smaller sets

function noCombo(combos) {
  const [one] = SIZE_NAME[combos.size];
  return h("section", { class: "island pr-pair empty-pair" }, h("p", { class: "isl-note", text: combos.tested
    ? `No ${one} acts detectably beyond ${combos.size === 3 ? "its pairs" : "its smaller sets"} over these ${fmtInt(combos.rows)} rows, so they give the full picture. Choose one of the closest to open it anyway.`
    : `No ${one} can be tested at ${fmtInt(combos.rows)} rows: each has a combination of values under ${MIN_CELL} rows.` }));
}

function comboIsland(m, A, combos, chosen) {
  const t = m.target, k = chosen.dims.length;
  const dims = chosen.dims.map(id => m.schema.dimById.get(id));
  const base = summarize(t, m.rows);
  const r = comboEffect(dims, t, m.rows, base, MIN_CELL, true);
  const rec = combos.list.find(x => sameSet(x.dims, chosen.dims)) || null;
  const smaller = k === 3 ? "every pair within them" : "every smaller set within them";
  let span = 0;
  for (const c of r.table) if (!c.withheld && c.n && Number.isFinite(c.mean)) span = Math.max(span, Math.abs(c.mean - base.mean));
  const ctx = { m, A, t, base, span };
  const verdict = rec && rec.detectable ? "they act together" : r.sparse ? "too few rows to test" : `not detectable beyond ${k === 3 ? "its pairs" : "its smaller sets"}`;
  const testLine = r.sparse ? `Not tested: its thinnest combination holds ${fmtInt(r.minN)} rows, under ${MIN_CELL}`
    : `${t.kind === "binary" ? "Likelihood-ratio" : "F"} test ${fmtP(r.p, "p")}${rec ? `, ${fmtP(rec.q)} across the ${fmtInt(combos.tested)} ${SIZE_NAME[k][1]} tested` : ""}`;
  return h("section", { class: "island pr-pair", "aria-labelledby": "pr-pair-title" },
    h("header", { class: "isl-head pr-pair-head" },
      h("h2", { class: "isl-title mono", id: "pr-pair-title", text: dims.map(shortName).join(" × ") }),
      h("span", { class: "isl-count" }, chosen.why ? `${chosen.why} · ` : "", verdict)),
    h("div", { class: "pr-figs" },
      h("span", null, h("span", { class: "k", text: `All ${k} together ` }), h("b", { class: "num", text: Number.isFinite(r.omega2) ? `ω² ${(Math.max(0, r.omega2) * 100).toFixed(1)}%` : "–" })),
      h("span", { class: "muted", text: testLine })),
    h("p", { class: "isl-note pr-what", text: `${t.label} in every combination against the base ${fmtT(t, base.mean)}. Their interaction is what is left once ${smaller} is accounted for.${r.table.some(c => c.withheld) ? " Hatched cells hold fewer than 30 rows." : ""}` }),
    k === 3 ? facets(ctx, dims, r) : combinations(ctx, dims, r),
    heatLegend(t));
}

// Three parameters: the grid of two for each value of the third (the one
// with the fewest values), on one colour scale.
function facets(ctx, dims, r) {
  const by = [0, 1, 2].sort((a, b) => dims[a].levels.length - dims[b].levels.length);
  const [f, cb, ra] = by;
  const L = dims.map(d => d.levels.length);
  const at = (x) => r.table[(x[0] * L[1] + x[1]) * L[2] + x[2]];
  const wrap = h("div", { class: "pr-facets" });
  dims[f].levels.forEach((lf, vf) => {
    const tbl = h("table", { class: "heat pr-heat" });
    const head = h("tr", null, h("th", { class: "corner" }, vf === 0 ? [h("span", { class: "mono", text: shortName(dims[ra]) }), " ↓ ", h("span", { class: "mono", text: shortName(dims[cb]) }), " →"] : ""));
    dims[cb].levels.forEach(l => head.append(h("th", { class: "col-h", text: l.label })));
    tbl.append(h("thead", null, head));
    const tb = h("tbody");
    dims[ra].levels.forEach((la, va) => {
      const tr = h("tr", null, h("th", { class: "row-h", text: la.label }));
      dims[cb].levels.forEach((lb, vb) => {
        const x = [0, 0, 0];
        x[f] = vf; x[ra] = va; x[cb] = vb;
        const conds = [{ dim: dims[f].id, keys: [lf.key] }, { dim: dims[ra].id, keys: [la.key] }, { dim: dims[cb].id, keys: [lb.key] }];
        tr.append(heatCell(ctx, at(x), conds, `${shortName(dims[f])} = ${lf.label}, ${shortName(dims[ra])} = ${la.label}, ${shortName(dims[cb])} = ${lb.label}`));
      });
      tb.append(tr);
    });
    tbl.append(tb);
    wrap.append(h("div", { class: "pr-facet" }, h("h3", { class: "facet-title" }, h("span", { class: "mono", text: shortName(dims[f]) }), " = ", h("b", { class: "mono", text: lf.label })), h("div", { class: "table-wrap" }, tbl)));
  });
  return wrap;
}

// Four or more: the combinations with the best and the worst needle.
function combinations(ctx, dims, r) {
  const { t, base } = ctx;
  const better = t.better || 1;
  const shown = r.table.filter(c => !c.withheld && c.n).sort((a, b) => (b.mean - a.mean) * better);
  const best = shown.slice(0, 6), worst = shown.length > 12 ? shown.slice(-6) : shown.slice(6);
  const all = [...best, ...worst];
  const lo = Math.min(base.mean, ...all.map(c => c.lo).filter(Number.isFinite)), hi = Math.max(base.mean, ...all.map(c => c.hi).filter(Number.isFinite));
  const pad = (hi - lo) * 0.08 || 1;
  const domain = [lo - pad, hi + pad];
  const part = (title, cells) => {
    const tbl = h("table", { class: "vals pr-combos" }, h("thead", null, h("tr", null, h("th", { text: "combination" }), h("th", { class: "r", text: "rows" }), h("th", { class: "r", text: t.label }), h("th", { class: "iv", text: "95% interval" }))));
    const tb = h("tbody");
    for (const c of cells) {
      const conds = c.keys.map((key, i) => ({ dim: dims[i].id, keys: [key] }));
      const what = c.at.map((x, i) => `${shortName(dims[i])} = ${dims[i].levels[x].label}`).join(" · ");
      const look = () => ctx.A.set({ context: [...ctx.m.context.filter(x => !conds.some(k => k.dim === x.dim)), ...conds], view: "board" });
      tb.append(h("tr", { class: "clickable", tabindex: "0", onclick: look, onkeydown: (e) => { if (e.key === "Enter") look(); } },
        h("td", { class: "v", text: what }), h("td", { class: "r num", text: fmtInt(c.n) }), h("td", { class: "r num", text: fmtT(t, c.mean) }),
        h("td", { class: "iv" }, intervalBar(c.mean, c.lo, c.hi, base.mean, domain))));
    }
    tbl.append(tb);
    return h("div", { class: "isl-part" }, h("h3", { class: "part-title", text: title }), h("div", { class: "table-wrap" }, tbl));
  };
  const hidden = r.table.filter(c => c.withheld).length;
  if (!best.length) return h("p", { class: "isl-note", text: `Every one of its ${fmtInt(r.table.length)} combinations holds fewer than 30 rows at ${fmtInt(r.N || r.table.reduce((a, c) => a + c.n, 0))} rows, so none is shown on its own; the test above uses them all.` });
  const out = h("div", null, part("The best combinations", best));
  if (worst.length) out.append(part("The worst combinations", worst));
  if (hidden) out.append(h("p", { class: "isl-note", text: `${fmtInt(hidden)} of ${fmtInt(r.table.length)} combinations hold fewer than 30 rows and are left out.` }));
  return out;
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
      const inSet = !!chosen && chosen.dims.length > 2 && i > j && chosen.dims.includes(da.id) && chosen.dims.includes(db.id);
      const td = h("td", { class: `cell has-tip${cls}${isChosen(chosen, r) ? " sel" : ""}${inSet ? " in-set" : ""}`, style, tabindex: "0", dataset: { i: String(i), j: String(j) },
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
  // the chosen set's names stand out
  if (chosen) {
    for (const id of chosen.dims) {
      const k = pairs.dims.indexOf(id);
      if (k < 0) continue;
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
