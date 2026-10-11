// Cohort: from the pocket found in the analysis to a cohort of a Limen
// run's rounds, and on a Limen project to its predictor. The pool is the
// rows in view that are in the pocket and pass every gate set (the pocket,
// filtered down; Grid's own standing gates apply only when set in Gates, as
// they would leave few rounds and cannot be taken off). The members are
// chosen on the first half of the test window: the pool's best by the
// needle's first half, from one result directory (a Limen Cohort takes one;
// each shard's manifest differs by its seed). The cohort is judged on the
// second half, rebuilt by the server from what the run recorded
// (grid/cohort.py): the members' probabilities averaged over 0.5 as Limen's
// Cohort averages them, executed as Limen executes a signal, against its
// best member and its members' mean, on one execution at the fee and
// slippage set here.

import { h, tip, fmtInt, fmtNum, fmtPct, fmtRowValue, fmtClock } from "./ui.js";
import { strip, stripCell, about } from "./strip.js";
import { rowsIn } from "./engine.js";
import { OPS, gateLabel } from "./gates.js";

export const COHORT_DEFAULT = 5;
const JUDGE_MS = 300;
// a judgement or a listing that failed is asked for again after this long
const RETRY_MS = 5000;
// the fee and slippage the view takes, in bps a fill
const COST_MAX = 1000;
// the rows of the pool shown past the members, and how many more a click
// shows
const MORE = 10;
const MORE_STEP = 20;

// What the view holds for the run in view: how many members it starts
// from, the rows taken out of and put into them, the result directory, the
// costs set, how many rows past the members are shown, and the judgement
// as last fetched.
const pick = { run: null, n: COHORT_DEFAULT, out: new Set(), in: new Set(), dir: null, fee: null, slip: null,
  more: MORE, key: "", judged: null, judging: false, error: null, failedAt: 0, timer: 0 };

function reset(id) {
  Object.assign(pick, { run: id, n: COHORT_DEFAULT, out: new Set(), in: new Set(), dir: null, fee: null, slip: null,
    more: MORE, key: "", judged: null, judging: false, error: null, failedAt: 0 });
}

// The gates a pool is filtered by: those set in Gates and the runner's
// own, not Grid's standing ones.
export function poolGates(schema) {
  const standing = new Set(schema.gatesStanding || []);
  return schema.gates.filter(g => !standing.has(g));
}

// The pocket's conditions on this run's parameters: one kept in the
// address may name a parameter the run does not have (as the Pocket view
// and the context, it is passed over).
export function pocketOf(schema, pocket) {
  return (pocket || []).filter(c => schema.dimById.has(c.dim));
}

// Each gate of the pool as the pool reads it, under its needle's own name.
// A gate set in Gates on a needle measured on each half is read on the
// first half of the test window, so the second half chooses no row of the
// pool; any other (on a needle of the whole window, or the runner's own)
// is read as it stands, over the whole window. With First half on, a
// gate's needle is its first half already; its own (`base`) has both.
export function gateReads(schema) {
  return poolGates(schema).map(g => {
    const base = g.target && (g.target.base || g.target);
    const halves = g.def && base && base.halves;
    const op = halves && OPS[g.def.op];
    if (!op) return { gate: g, label: g.label, firstHalf: false, pass: g.pass };
    const first = halves[0], pass = new Float64Array(schema.n);
    for (let i = 0; i < schema.n; i++) {
      const v = first[i];
      pass[i] = v === v ? (op.test(v, g.def.value) ? 1 : 0) : NaN;
    }
    return { gate: g, label: gateLabel(base, g.def), firstHalf: true, pass };
  });
}

// Why the second half helped choose the members, or null when it chose
// none of them: the needle, or a gate of the pool, read over the whole
// window.
export function touchedBy(t, reads) {
  if (!t.halves) return `${t.label} is not measured on each half`;
  const whole = reads.filter(r => !r.firstHalf).map(r => r.label);
  if (!whole.length) return null;
  return whole.length === 1 ? `the gate ${whole[0]} is read over the whole window`
    : `the gates ${whole.join("; ")} are read over the whole window`;
}

// The rows in view that are in the pocket and pass every gate of the pool,
// each read as gateReads reads it.
export function poolOf(schema, rows, pocket, edge, reads = gateReads(schema)) {
  const inView = new Uint8Array(schema.n);
  for (let j = 0; j < rows.length; j++) inView[rows[j]] = 1;
  const out = [];
  for (const i of rowsIn(schema, pocketOf(schema, pocket), edge)) {
    if (!inView[i]) continue;
    let ok = true;
    for (const r of reads) if (r.pass[i] !== 1) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

// The pool's rows with a value on both halves, the best on the first half
// first (ties in the order they arrived); on a needle without halves, by
// the needle over the whole window.
export function rankedOf(t, pool) {
  const dir = t.better < 0 ? -1 : 1;
  const [a, b] = t.halves || [t.values, t.values];
  return pool.filter(i => a[i] === a[i] && b[i] === b[i]).sort((p, q) => (a[q] - a[p]) * dir || p - q);
}

// Each row's result directory, on a run read from several: its shard, as
// the run wrote it (not the shard parameter's levels, which fold all past
// the first few dozen into one).
export function dirsOf(ds) {
  const col = ds.cols && ds.cols.get("shard");
  if (!col || (col.kind !== "str" && col.kind !== "num")) return null;
  return (i) => col.stateAt(i) !== 0 ? null : col.kind === "str" ? col.levels[col.codes[i]] : String(col.vals[i]);
}

// The members: the best n of the chosen directory's ranked rows, less those
// taken out, with those put in.
export function membersOf(ranked, dirOf, dir, n, out, put) {
  const mine = dirOf ? ranked.filter(i => dirOf(i) === dir) : ranked;
  const chosen = mine.slice(0, n).filter(i => !out.has(i));
  for (const i of mine) if (put.has(i) && !chosen.includes(i)) chosen.push(i);
  return { mine, members: chosen.sort((p, q) => mine.indexOf(p) - mine.indexOf(q)) };
}

export function renderCohort(view, m, A) {
  view.append(h("h1", { class: "sr", text: "Cohort" }));
  const exp = m.ds.meta.experiment;
  if (!exp || exp.kind !== "limen") {
    view.append(h("div", { class: "empty" }, h("b", { text: "A cohort is made of a Limen run's rounds. " }),
      "This run is not a Limen run."));
    return;
  }
  if (pick.run !== m.ds.id) reset(m.ds.id);
  // the needle as measured, on each half: with First half on, the needle
  // in view is its first half, read from this
  const t = m.target.base || m.target;
  const pocket = pocketOf(m.schema, m.state.pocket);
  const reads = gateReads(m.schema);
  const touched = touchedBy(t, reads);
  const pool = poolOf(m.schema, m.rows, pocket, m.edge, reads);
  const ranked = rankedOf(t, pool);
  const dirOf = dirsOf(m.ds);
  const counts = new Map();
  if (dirOf) for (const i of ranked) counts.set(dirOf(i), (counts.get(dirOf(i)) || 0) + 1);
  if (dirOf && (!pick.dir || !counts.has(pick.dir))) pick.dir = ranked.length ? dirOf(ranked[0]) : null;
  const { mine, members } = membersOf(ranked, dirOf, pick.dir, pick.n, pick.out, pick.in);
  judge(m, A, members);
  view.append(cohortStrip(m, A, pool, members, t));
  view.append(poolIsland(m, A, pocket, reads, pool));
  view.append(cohortMembersIsland(m, A, t, mine, members, dirOf, counts));
  view.append(judgedIsland(m, A, members, t, touched));
  if (A.project) view.append(makeIsland(m, A, pocket, reads, mine, members));
}

// ---------------------------------------------------------------------------
// The judgement, fetched from the server as the members change

function judge(m, A, members) {
  const key = `${m.ds.id}|${members.join(",")}|${pick.fee}|${pick.slip}`;
  // the same members are judged once, but asked for again a while after
  // a failure (a round's line still being written, a server back up)
  if (key === pick.key && !(pick.error && !pick.judging && Date.now() - pick.failedAt >= RETRY_MS)) return;
  pick.key = key;
  clearTimeout(pick.timer);
  if (!members.length || !A.isLive()) { pick.judged = null; pick.judging = false; pick.error = null; return; }
  pick.judging = true;
  pick.timer = setTimeout(async () => {
    const q = new URLSearchParams({ run: m.ds.id, rows: members.join(",") });
    if (pick.fee !== null) q.set("fee", pick.fee);
    if (pick.slip !== null) q.set("slip", pick.slip);
    try {
      const res = await fetch(`api/cohort?${q}`, { cache: "no-store" });
      const out = await res.json().catch(() => ({}));
      if (pick.key !== key) return;
      if (!res.ok) throw new Error(out.error || `the server answered ${res.status}`);
      Object.assign(pick, { judged: out, error: null });
    } catch (err) {
      if (pick.key !== key) return;
      Object.assign(pick, { judged: null, error: String(err.message || err), failedAt: Date.now() });
      setTimeout(() => { if (pick.key === key && pick.error && A.view() === "cohort") A.rerender(); }, RETRY_MS);
    } finally {
      if (pick.key === key) { pick.judging = false; A.rerender(); }
    }
  }, JUDGE_MS);
}

// ---------------------------------------------------------------------------
// The strip

function second(part) {
  return part && part.halves ? part.halves[1] : null;
}

function pnlOf(part) {
  return part ? part.pnl : NaN;
}

function bpsText(x) {
  return Number.isFinite(x) ? `${fmtNum(x, 2)} bps` : "–";
}

function cohortStrip(m, A, pool, members, t) {
  const j = pick.judged;
  const best = j ? j.members[0] : null;
  const mean = j ? meanOf(j.members.map(second)) : null;
  // figures of members no longer chosen, while the new ones are judged
  const stale = { valueClass: pick.judging && j ? "co-stale" : null };
  const cells = [
    stripCell("Pool", fmtInt(pool.length), `of ${fmtInt(m.rows.length)} in view`, () => h("div", null,
      h("b", { text: "The rows in view that are in the pocket and pass every gate set" }),
      h("div", { class: "k", text: "Find the pocket with the other views and filter it down in Gates; the cohort is chosen from what is left." }))),
    stripCell("Members", fmtInt(members.length), pick.dir ? `from ${pick.dir}` : t.halves ? "chosen on the first half" : "chosen on the whole window",
      () => h("div", null, h("b", { text: "The cohort's members" }),
        h("div", { class: "k", text: `The pool's best by ${t.label}${t.halves ? " on the first half of the test window" : ""}, as set below.` }))),
    stripCell("Cohort, second half", j ? bpsText(pnlOf(second(j.cohort))) : "–", "net per bar", () => h("div", null,
      h("b", { text: "The cohort on the second half of the test window" }),
      h("div", { class: "k", text: j && j.aggregation === "majority_vote"
        ? "Its members' votes, as Limen's Cohort aggregates their architecture: long where more than half of them vote for it, executed long-flat at the costs set below."
        : "Its members' probabilities averaged, over 0.5, executed long-flat at the costs set below." })), null, stale),
    stripCell("Best member alone", best ? bpsText(pnlOf(second(best))) : "–", "net per bar", () => h("div", null,
      h("b", { text: t.halves ? "The member best on the first half, alone, on the second" : "The member best on the whole window, alone, on the second half" })), null, stale),
    stripCell("Members' mean", mean ? bpsText(mean.pnl) : "–", "net per bar", () => h("div", null,
      h("b", { text: "The members one by one, on average, on the second half" })), null, stale),
  ];
  return strip("The cohort in figures", cells, { key: "cohort", label: "About the cohort", content: () => about("Cohort",
    "The pool is the rows in view that are in the pocket and pass every gate set in Gates (Grid's own standing gates only when set there): the pocket found with the other views, filtered down. Its members are the pool's best by the needle on the first half of the test window, from one result directory, since a Limen Cohort takes one (each shard's manifest differs by its seed).",
    "The cohort is judged on the second half, which chose nothing: rebuilt from what the run recorded, aggregated as Limen's Cohort aggregates the members' architecture (their probabilities averaged and over 0.5, or for an architecture it does not average, their votes, more than half, a regressor voting for a predicted move above 0), and executed as Limen executes a signal (long on the bar after a 1, at the fee and slippage set here). Its best member alone and its members' mean are executed the same way, so the three compare like for like. A gate set in Gates is read on the first half where its needle is measured on each half; a gate or a needle of the whole window lets the second half help choose, and the view says so. The pocket is yours: found by reading the whole window in the other views, it was chosen with the second half too.",
    "Exits by take-profit or stop-loss are not rebuilt (the run does not record the prices they need); calibrated and uncalibrated members' probabilities are averaged as they come, as Limen's Cohort averages them.") }, null, A);
}

// A part's mean over its members: their figures averaged, those of no
// trades left out of the per-trade mean.
export function meanOf(parts) {
  const ok = parts.filter(Boolean);
  if (!ok.length) return null;
  const avg = (key) => {
    const v = ok.map(p => p[key]).filter(x => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  return { pnl: avg("pnl"), trades: avg("trades"), tradeMean: avg("tradeMean"), tradeT: NaN, wins: avg("wins") };
}

// ---------------------------------------------------------------------------
// The pool

function poolIsland(m, A, pocket, reads, pool) {
  const standing = m.schema.gatesStanding || [];
  const isl = h("section", { class: "island", "aria-labelledby": "co-pool" });
  isl.append(h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "co-pool", text: "Pool" }),
    h("span", { class: "isl-count num", text: `${fmtInt(pool.length)} rows` })));
  const said = pocket.length ? pocket.map(c => {
    const d = m.schema.dimById.get(c.dim);
    return d ? `${d.label} = ${c.keys.map(k => (d.levels.find(l => l.key === k) || { label: k }).label).join(" or ")}` : null;
  }).filter(Boolean) : [];
  isl.append(h("p", { class: "isl-note" },
    said.length ? ["In the pocket: ", h("span", { class: "mono", text: said.join("; ") }), ". "] : "No pocket: every row in view. ",
    reads.length ? `Passing every gate (${fmtInt(reads.length)}): ${reads.map(r => `${r.label}, ${r.firstHalf ? "on the first half" : "over the whole window"}`).join("; ")}.` : "No gate set.",
    reads.some(r => !r.firstHalf) ? " A gate read over the whole window lets the second half help choose the pool, so it no longer judges the cohort untouched." : "",
    standing.length ? ` Grid's own gates (${standing.map(g => g.label).join("; ")}) are not applied here; set them in Gates to apply them.` : ""));
  isl.append(h("div", { class: "co-acts" },
    h("button", { class: "btn small", type: "button", onclick: () => A.set({ view: "pocket" }) }, "Pocket ", h("kbd", { text: "2" })),
    h("button", { class: "btn small", type: "button", onclick: () => A.set({ view: "gates" }) }, "Gates ", h("kbd", { text: "6" }))));
  if (!pool.length) isl.append(h("p", { class: "isl-note", text: "No row in view is in the pocket and passes every gate: widen the pocket or loosen a gate." }));
  // the pocket is found with the other views: how it was found, as the
  // address kept it (app.js, halves.js choiceFound)
  if (m.cache.schema.targets.some(x => x.halves)) {
    const st = m.state;
    const chosen = ["pocket", "gates", "context"].some(k => (st[k] || []).length > 0);
    const on = (label) => h("button", { class: "btn small", type: "button", onclick: () => A.set({ firstHalf: true }) }, label, " ", h("kbd", { text: "H" }));
    isl.append(h("p", { class: "isl-note co-half" }, !chosen
      ? (st.firstHalf ? "First half is on: find the pocket and set the gates, and the second half stays unseen until the cohort is judged on it."
        : ["The other views read the whole test window, the second half too: turn on ", on("First half"), " before finding the pocket, and the second half stays unseen until the cohort is judged on it."])
      : st.found === "first" ? "Set with First half on: the pocket, the gates and the context were found without the second half."
        : ["The pocket, the gates or the context were set while the other views read the whole window, the second half too, so it helped choose them. To keep it unseen, ",
          h("button", { class: "btn small", type: "button", onclick: () => A.set({ pocket: [], gates: [], context: [], firstHalf: true }) }, "clear them and turn on First half"),
          ", then find them again."]));
  }
  return isl;
}

// ---------------------------------------------------------------------------
// The members

function cohortMembersIsland(m, A, t, mine, members, dirOf, counts) {
  const isl = h("section", { class: "island", "aria-labelledby": "co-members" });
  const n = h("input", { class: "co-num num", type: "number", min: "1", max: "200", step: "1", value: String(pick.n),
    "aria-label": "How many of the best", dataset: { focus: "co-n" } });
  n.addEventListener("change", () => {
    const v = Math.floor(Number(n.value));
    if (v >= 1 && v <= 200) { pick.n = v; pick.out = new Set(); pick.in = new Set(); A.rerender(); }
  });
  const head = h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "co-members", text: "Members" }),
    h("span", { class: "isl-count num", text: `${fmtInt(members.length)} of ${fmtInt(mine.length)}` }),
    h("label", { class: "co-best" }, h("span", { text: "The best" }), n,
      h("span", { text: t.halves ? `by ${t.label}, first half` : `by ${t.label}` })));
  isl.append(head);
  if (dirOf && counts.size) {
    const sel = h("select", { "aria-label": "Result directory", dataset: { focus: "co-dir" } },
      [...counts.keys()].sort().map(d => h("option", { value: d, text: `${d} · ${fmtInt(counts.get(d))} in the pool` })));
    sel.value = pick.dir;
    sel.addEventListener("change", () => { pick.dir = sel.value; pick.out = new Set(); pick.in = new Set(); A.rerender(); });
    isl.append(h("p", { class: "isl-note co-dir" }, h("span", { text: "From " }), sel,
      h("span", { text: ": a Limen Cohort takes one result directory, and each of this run's has a manifest of its own (its seed)." })));
  }
  if (!t.halves) {
    isl.append(h("p", { class: "isl-note", text: `${t.label} is not measured on each half (only the figures of the run's recorded execution are), so the members are chosen on the whole window, and the second half below chose them too; a needle of the execution, such as net PnL per bar, judges them on data that did not choose them.` }));
  }
  if (!mine.length) {
    isl.append(h("p", { class: "isl-note", text: t.halves ? "No row of the pool has a value of the needle on both halves." : "No row of the pool has a value of the needle." }));
    return isl;
  }
  // the needle on each half, or over the whole window
  const values = t.halves || [t.values];
  const shown = mine.slice(0, pick.n + pick.more);
  const tb = h("tbody");
  shown.forEach((i, r) => {
    const on = members.includes(i);
    const box = h("input", { type: "checkbox", checked: on ? true : null, "aria-label": `Row ${fmtInt(i)} a member`, dataset: { focus: `co-m-${i}` } });
    box.addEventListener("change", () => {
      if (box.checked) { pick.out.delete(i); if (r >= pick.n) pick.in.add(i); }
      else { pick.in.delete(i); if (r < pick.n) pick.out.add(i); }
      A.rerender();
    });
    tb.append(h("tr", { class: "clickable" + (on ? " sel" : ""), dataset: { row: String(i) },
      onclick: (ev) => { if (ev.target !== box) A.select({ kind: "row", i }); } },
    h("td", null, box), h("td", { class: "r num", text: fmtInt(r + 1) }), h("td", { class: "r num", text: fmtInt(i) }),
    ...values.map(v => h("td", { class: "r num", text: fmtRowValue(t, v[i]) }))));
  });
  const heads = t.halves ? ["First half", "Second half"] : [t.label];
  isl.append(h("div", { class: "table-wrap" }, h("table", { class: "vals co-table",
    "aria-label": t.halves ? "The pool, best on the first half first" : "The pool, best first" },
    h("thead", null, h("tr", null, h("th", null, h("span", { class: "sr", text: "Member" })), h("th", { class: "r", text: "Rank" }),
      h("th", { class: "r", text: "Row" }), ...heads.map(x => h("th", { class: "r", text: x })))), tb)));
  if (mine.length > shown.length) {
    const left = mine.length - shown.length;
    isl.append(h("p", { class: "isl-note co-more" }, `${fmtInt(left)} more row${left === 1 ? "" : "s"} of the pool rank lower. `,
      h("button", { class: "btn small", type: "button", dataset: { focus: "co-more" }, onclick: () => { pick.more += MORE_STEP; A.rerender(); } },
        `Show ${fmtInt(Math.min(MORE_STEP, left))} more`)));
  }
  return isl;
}

// ---------------------------------------------------------------------------
// The judgement

function judgedIsland(m, A, members, t, touched) {
  const busy = pick.judging && !!pick.judged;
  const isl = h("section", { class: "island co-judged", "aria-labelledby": "co-judged", "aria-busy": busy ? "true" : null });
  isl.append(h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "co-judged", text: "Judged on the second half" }),
    busy ? h("span", { class: "isl-count", text: "Judging the members chosen…" }) : null));
  if (!members.length) { isl.append(h("p", { class: "isl-note", text: "No member yet." })); return isl; }
  if (!A.isLive()) {
    isl.append(h("p", { class: "isl-note", text: "Judging a cohort reads the run's recorded rounds, which Grid's server has: serve the run (python3 -m grid serve --limen …)." }));
    return isl;
  }
  if (pick.error) { isl.append(h("p", { class: "isl-note co-error" }, h("b", { text: "The cohort could not be judged. " }), pick.error)); return isl; }
  const j = pick.judged;
  if (!j) { isl.append(h("p", { class: "isl-note", text: "Judging…" })); return isl; }
  const cost = (key, label, value) => {
    const input = h("input", { class: "co-num num", type: "number", min: "0", max: String(COST_MAX), step: "0.5", value: String(value),
      "aria-label": label, dataset: { focus: `co-${key}` } });
    tip(input, `${label} in bps a fill, 0 to ${fmtInt(COST_MAX)}`);
    input.addEventListener("change", () => {
      const v = Number(input.value);
      const ok = input.value.trim() !== "" && Number.isFinite(v) && v >= 0 && v <= COST_MAX;
      // a cost out of bounds is marked, and the figures stay at the last
      if (!ok) { input.setAttribute("aria-invalid", "true"); return; }
      input.removeAttribute("aria-invalid");
      pick[key] = v;
      A.rerender();
    });
    return h("label", { class: "co-cost" }, h("span", { text: label }), input, h("span", { class: "muted", text: "bps" }));
  };
  isl.append(h("div", { class: "co-costs" }, cost("fee", "Fee", pick.fee !== null ? pick.fee : j.fee),
    cost("slip", "Slippage", pick.slip !== null ? pick.slip : j.slip),
    h("span", { class: "isl-note", text: `per fill; the members' own, unless set here. ${fmtInt(j.bars)} bars they share, the cohort long on ${fmtPct(j.fired, 0)} of them, ${j.aggregation === "majority_vote" ? "by its members' votes" : "its members' probabilities averaged"}, as Limen's Cohort aggregates ${String(j.architecture || "their architecture").split(".").pop()}.` })));
  const best = j.members[0], mean = { whole: meanOf(j.members.map(x => x.whole)), halves: [meanOf(j.members.map(x => x.halves && x.halves[0])), meanOf(j.members.map(second))] };
  const c2 = second(j.cohort), b2 = second(best);
  const verdict = !touched ? `Chosen on the first half, the cohort makes ${bpsText(pnlOf(c2))} a bar on the second`
    : `Chosen with the second half too (${touched}), the cohort makes ${bpsText(pnlOf(c2))} a bar on the second half, which chose it too`;
  isl.append(h("p", { class: "co-verdict" }, `${verdict}; its best member alone ${bpsText(pnlOf(b2))}; its members on average ${bpsText(pnlOf(mean.halves[1]))}.`));
  if (j.notes.length) isl.append(h("ul", { class: "co-notes" }, j.notes.map(x => h("li", { text: x }))));
  const rows = [["Cohort", j.cohort, true], ["Best member alone", best, false], ["Members' mean", mean, false]];
  const cols = (p) => p ? [bpsText(p.pnl), fmtInt(p.trades), bpsText(p.tradeMean), Number.isFinite(p.tradeT) ? fmtNum(p.tradeT, 2) : "–"] : ["–", "–", "–", "–"];
  const tb = h("tbody");
  for (const [label, part, strong] of rows) {
    const halves = part.halves || [null, null];
    tb.append(h("tr", { class: strong ? "co-strong" : null }, h("td", { text: label }),
      ...cols(halves[0]).map(x => h("td", { class: "r num", text: x })), ...cols(halves[1]).map(x => h("td", { class: "r num co-h2", text: x }))));
  }
  const heads = ["Net per bar", "Trades", "Mean trade", "Per-trade t"];
  isl.append(h("div", { class: "table-wrap" }, h("table", { class: "vals co-judge", "aria-label": "The cohort, its best member and its members' mean, on each half" },
    h("thead", null,
      h("tr", null, h("th", null), h("th", { colspan: "4", class: "co-half", text: touched ? "First half" : "First half (chose it)" }),
        h("th", { colspan: "4", class: "co-half co-h2", text: touched ? "Second half (chose it too)" : "Second half (judges it)" })),
      h("tr", null, h("th", null), ...heads.map(x => h("th", { class: "r", text: x })), ...heads.map(x => h("th", { class: "r co-h2", text: x })))),
    tb)));
  return isl;
}

// ---------------------------------------------------------------------------
// The predictor, on a Limen project: Limen's Trainer retrains each member
// and Limen's Cohort binds them (grid/limen_cohort.py, run in Limen's own
// Python), into cohorts/<name>/ in the project.

const made = { list: null, at: 0, gen: 0, loading: false, name: null, busy: false, error: null, timer: 0 };

// The project's predictors read; a read started later answers in place of
// one still on its way.
async function cohorts(A) {
  const gen = ++made.gen;
  made.loading = true;
  clearTimeout(made.timer);
  made.timer = 0;
  let changed = false;
  try {
    const res = await fetch(A.project.url, { cache: "no-store" });
    const out = await res.json().catch(() => ({}));
    if (gen !== made.gen) return;
    if (!res.ok) throw new Error(out.error || `the server answered ${res.status}`);
    const list = out.cohorts || [];
    changed = made.error !== null || JSON.stringify(list) !== JSON.stringify(made.list);
    made.list = list;
    made.error = null;
  } catch (err) {
    if (gen !== made.gen) return;
    const said = `The project's predictors could not be read: ${String(err.message || err)}`;
    changed = said !== made.error;
    made.error = said;
  } finally {
    if (gen === made.gen) {
      made.loading = false;
      made.at = Date.now();
    }
  }
  if (changed) A.rerender();
  // read again while one is being made, or until the listing is read, as
  // long as the view shows them (it starts again when shown)
  if (A.view() === "cohort" && polled()) made.timer = setTimeout(() => { made.timer = 0; cohorts(A); }, made.error ? RETRY_MS : 2000);
}

// Whether the listing is read again by itself: a predictor training, or a
// listing that failed.
function polled() {
  return !!made.error || (made.list || []).some(c => c.state === "training");
}

function makeIsland(m, A, pocket, reads, mine, members) {
  const isl = h("section", { class: "island", "aria-labelledby": "co-make" });
  isl.append(h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "co-make", text: "Predictor" })));
  if (!made.loading && (made.at === 0 || Date.now() - made.at > 5000 || (polled() && !made.timer))) cohorts(A);
  const exp = m.ds.meta.experiment;
  const base = String(((exp.manifest || {}).metadata || {}).name || "experiment").replace(/[^A-Za-z0-9_-]+/g, "_");
  if (made.name === null) made.name = `${base}_cohort`;
  const name = h("input", { class: "ex-input mono", type: "text", value: made.name, maxlength: "64", spellcheck: "false",
    "aria-label": "The predictor's name", dataset: { focus: "co-name" } });
  name.addEventListener("input", () => { made.name = name.value; });
  const go = h("button", { class: "btn primary", type: "button", disabled: made.busy || !members.length ? true : null, dataset: { focus: "co-go" },
    onclick: () => makePredictor(m, A, members, howChosen(m, pocket, reads, mine, members)) }, made.busy ? "Starting…" : "Make predictor");
  tip(go, "Limen's Trainer retrains each member as its round ran, and Limen's Cohort binds them; written into the project's cohorts/.");
  isl.append(h("div", { class: "co-form" }, h("label", { class: "ex-field" }, h("span", { class: "k", text: "Name" }), name), go));
  isl.append(h("p", { class: "isl-note", text: `${fmtInt(members.length)} member${members.length === 1 ? "" : "s"}${pick.dir ? ` from ${pick.dir}` : ""}. Each is trained again on the data its round used, a few seconds each, and checked against what its round recorded.` }));
  if (made.error) isl.append(h("p", { class: "isl-note co-error", text: made.error }));
  const list = made.list || [];
  if (list.length) {
    const tb = h("tbody");
    for (const c of list) {
      const state = c.state === "training" ? `Training${c.progress ? ` ${fmtInt(c.progress.member)} of ${fmtInt(c.progress.of)}` : ""}…`
        : c.state === "made" ? "Made" : c.state === "failed" ? "Failed" : String(c.state);
      const id = h("td", { class: "mono co-id", text: c.cohortId ? c.cohortId.replace(/^sha256:/, "").slice(0, 12) : "–" });
      if (c.cohortId) tip(id, c.cohortId);
      const named = h("td", { class: "v", text: c.name });
      const said = chosenText(c.chosen);
      if (said.length) tip(named, () => h("div", null, h("b", { text: `How ${c.name}'s members were chosen` }), said.map(x => h("div", { class: "k", text: x }))));
      tb.append(h("tr", null, named, h("td", { class: "r num", text: fmtInt(c.members) }),
        h("td", { text: c.source || "–" }), h("td", null, h("span", { class: "tag" + (c.state === "made" ? "" : c.state === "failed" ? " crit" : " live"), text: state })),
        id, h("td", { class: "num", text: c.madeAt ? fmtClock(c.madeAt) : "–" })));
      if (c.state === "failed" && c.tail) tb.append(h("tr", { class: "ex-note-row" }, h("td", { colspan: "6" }, h("pre", { class: "code", text: c.tail }))));
    }
    isl.append(h("div", { class: "table-wrap" }, h("table", { class: "vals co-made", "aria-label": "The project's predictors" },
      h("thead", null, h("tr", null, h("th", { text: "Predictor" }), h("th", { class: "r", text: "Members" }), h("th", { text: "From" }),
        h("th", { text: "State" }), h("th", { text: "Cohort id" }), h("th", { text: "Made" }))), tb)));
  }
  return isl;
}

// How the members were chosen, and how they were judged, as the page says
// it: the predictor keeps it (cohort.json's "chosen"). The rows taken out
// or put in by hand are those that made the members differ from the best
// N of the directory's ranked pool (`mine`) as it stands.
export function howChosen(m, pocket, reads, mine, members) {
  const t = m.target.base || m.target;
  const j = pick.judging ? null : pick.judged;
  const said = pocketOf(m.schema, pocket).map(c => {
    const d = m.schema.dimById.get(c.dim);
    return `${d.label} = ${c.keys.map(k => (d.levels.find(l => l.key === k) || { label: k }).label).join(" or ")}`;
  });
  const top = new Set(mine.slice(0, pick.n)), chosen = new Set(members);
  const out = { needle: t.label, on: t.halves ? "the first half" : "the whole window", best: pick.n,
    byHand: { out: [...top].filter(i => !chosen.has(i)).length, in: members.filter(i => !top.has(i)).length },
    pocket: said, gates: reads.map(r => `${r.label} (${r.firstHalf ? "on the first half" : "over the whole window"})`),
    // what the other views read while the pocket, the gates and the context
    // were found (none chosen: nothing to say)
    analysis: m.state.found === "first" ? "the first half"
      : ["pocket", "gates", "context"].some(k => (m.state[k] || []).length > 0) ? "the whole window" : null,
    untouched: !touchedBy(t, reads) };
  if (j) {
    const half = (p) => p ? { pnl: p.pnl, trades: p.trades } : null;
    out.judged = { on: "the second half", bars: j.bars, fee: j.fee, slip: j.slip, cohort: half(second(j.cohort)),
      bestMember: half(second(j.members[0])), membersMean: half(meanOf(j.members.map(second))), notes: j.notes };
  }
  return out;
}

// What a predictor keeps of how its members were chosen and judged, in a
// line or two.
export function chosenText(how) {
  if (!how || !how.needle) return [];
  const hand = how.byHand ? [how.byHand.out ? `${fmtInt(how.byHand.out)} taken out` : null,
    how.byHand.in ? `${fmtInt(how.byHand.in)} put in` : null].filter(Boolean) : [];
  const pocket = how.pocket && how.pocket.length ? `in the pocket ${how.pocket.join("; ")}` : "no pocket";
  const gates = how.gates && how.gates.length ? `passing ${how.gates.join("; ")}` : "no gate";
  const lines = [`The best ${fmtInt(how.best)} by ${how.needle} on ${how.on}${hand.length ? `, ${hand.join(" and ")} by hand` : ""}; ${pocket}; ${gates}.`];
  if (how.untouched === false) lines.push("The second half helped choose them, so it does not judge them untouched.");
  else if (how.analysis === "the whole window" && ((how.pocket || []).length || (how.gates || []).length)) {
    lines.push("Its pocket and gates were found with the other views reading the whole window, the second half too.");
  }
  const j = how.judged;
  if (j && j.cohort) {
    const pnl = (p) => bpsText(p ? p.pnl : NaN);
    lines.push(`On ${j.on}: the cohort ${pnl(j.cohort)} a bar, its best member alone ${pnl(j.bestMember)}, its members on average ${pnl(j.membersMean)}, at a fee of ${fmtNum(j.fee, 1)} and slippage of ${fmtNum(j.slip, 1)} bps.`);
  }
  return lines;
}

async function makePredictor(m, A, members, how) {
  if (made.busy || !members.length) return;
  made.busy = true;
  A.rerender();
  try {
    const res = await fetch(`${A.project.url}/cohort`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Grid-Token": A.project.token },
      body: JSON.stringify({ run: m.ds.id, rows: members, name: (made.name || "").trim(), how }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `the server answered ${res.status}`);
    A.toast(h("span", null, h("b", { text: "Training. " }), `${out.cohort}: Limen's Trainer retrains each member, then Limen's Cohort binds them.`), "good");
  } catch (err) {
    A.toast(h("span", null, h("b", { text: "Making the predictor failed. " }), String(err.message || err)), "crit");
  } finally {
    made.busy = false;
    cohorts(A);
    A.rerender();
  }
}
