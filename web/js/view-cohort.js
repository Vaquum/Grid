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

export const COHORT_DEFAULT = 5;
const JUDGE_MS = 300;
// the rows of the pool shown past the members, and how many more a click
// shows
const MORE = 10;
const MORE_STEP = 20;

// What the view holds for the run in view: how many members it starts
// from, the rows taken out of and put into them, the result directory, the
// costs set, how many rows past the members are shown, and the judgement
// as last fetched.
const pick = { run: null, n: COHORT_DEFAULT, out: new Set(), in: new Set(), dir: null, fee: null, slip: null,
  more: MORE, key: "", judged: null, judging: false, error: null, timer: 0 };

function reset(id) {
  Object.assign(pick, { run: id, n: COHORT_DEFAULT, out: new Set(), in: new Set(), dir: null, fee: null, slip: null,
    more: MORE, key: "", judged: null, judging: false, error: null });
}

// The gates a pool is filtered by: those set in Gates and the runner's
// own, not Grid's standing ones.
export function poolGates(schema) {
  const standing = new Set(schema.gatesStanding || []);
  return schema.gates.filter(g => !standing.has(g));
}

// The rows in view that are in the pocket and pass every gate of
// poolGates.
export function poolOf(schema, rows, pocket, edge) {
  const inView = new Uint8Array(schema.n);
  for (let j = 0; j < rows.length; j++) inView[rows[j]] = 1;
  const gates = poolGates(schema);
  const out = [];
  for (const i of rowsIn(schema, pocket, edge)) {
    if (!inView[i]) continue;
    let ok = true;
    for (const g of gates) if (g.pass[i] !== 1) { ok = false; break; }
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

// Each row's result directory, on a run read from several (its shard).
export function dirsOf(schema) {
  const d = schema.dims.find(x => x.column === "shard");
  if (!d) return null;
  return (i) => { const c = d.codes[i]; return c >= 0 ? String(d.levels[c].value) : null; };
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
  const t = m.target;
  const pool = poolOf(m.schema, m.rows, m.state.pocket || [], m.edge);
  const ranked = rankedOf(t, pool);
  const dirOf = dirsOf(m.schema);
  const counts = new Map();
  if (dirOf) for (const i of ranked) counts.set(dirOf(i), (counts.get(dirOf(i)) || 0) + 1);
  if (dirOf && (!pick.dir || !counts.has(pick.dir))) pick.dir = ranked.length ? dirOf(ranked[0]) : null;
  const { mine, members } = membersOf(ranked, dirOf, pick.dir, pick.n, pick.out, pick.in);
  judge(m, A, members);
  view.append(cohortStrip(m, A, pool, members, t));
  view.append(poolIsland(m, A, pool));
  view.append(cohortMembersIsland(m, A, t, mine, members, dirOf, counts));
  view.append(judgedIsland(m, A, members, t));
  if (A.project) view.append(makeIsland(m, A, members));
}

// ---------------------------------------------------------------------------
// The judgement, fetched from the server as the members change

function judge(m, A, members) {
  const key = `${m.ds.id}|${members.join(",")}|${pick.fee}|${pick.slip}`;
  if (key === pick.key) return;
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
      Object.assign(pick, { judged: null, error: String(err.message || err) });
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
      h("div", { class: "k", text: "Its members' probabilities averaged, over 0.5, executed long-flat at the costs set below." })), null, stale),
    stripCell("Best member alone", best ? bpsText(pnlOf(second(best))) : "–", "net per bar", () => h("div", null,
      h("b", { text: "The member best on the first half, alone, on the second" })), null, stale),
    stripCell("Members' mean", mean ? bpsText(mean.pnl) : "–", "net per bar", () => h("div", null,
      h("b", { text: "The members one by one, on average, on the second half" })), null, stale),
  ];
  return strip("The cohort in figures", cells, { key: "cohort", label: "About the cohort", content: () => about("Cohort",
    "The pool is the rows in view that are in the pocket and pass every gate set in Gates (Grid's own standing gates only when set there): the pocket found with the other views, filtered down. Its members are the pool's best by the needle on the first half of the test window, from one result directory, since a Limen Cohort takes one (each shard's manifest differs by its seed).",
    "The cohort is judged on the second half, which chose nothing: rebuilt from what the run recorded, its members' probabilities averaged and over 0.5 as Limen's Cohort averages them, and executed as Limen executes a signal (long on the bar after a 1, at the fee and slippage set here). Its best member alone and its members' mean are executed the same way, so the three compare like for like.",
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

function poolIsland(m, A, pool) {
  const pocket = m.state.pocket || [];
  const gates = poolGates(m.schema);
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
    gates.length ? `Passing every gate (${fmtInt(gates.length)}): ${gates.map(g => g.label).join("; ")}.` : "No gate set.",
    standing.length ? ` Grid's own gates (${standing.map(g => g.label).join("; ")}) are not applied here; set them in Gates to apply them.` : ""));
  isl.append(h("div", { class: "co-acts" },
    h("button", { class: "btn small", type: "button", onclick: () => A.set({ view: "pocket" }) }, "Pocket ", h("kbd", { text: "2" })),
    h("button", { class: "btn small", type: "button", onclick: () => A.set({ view: "gates" }) }, "Gates ", h("kbd", { text: "6" }))));
  if (!pool.length) isl.append(h("p", { class: "isl-note", text: "No row in view is in the pocket and passes every gate: widen the pocket or loosen a gate." }));
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
    isl.append(h("p", { class: "isl-note", text: `${t.label} has no halves (the run did not record its execution), so the members are chosen on the whole window and the second half below has chosen them too.` }));
  }
  if (!mine.length) {
    isl.append(h("p", { class: "isl-note", text: "No row of the pool has a value of the needle on both halves." }));
    return isl;
  }
  const [a, b] = t.halves || [t.values, t.values];
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
    h("td", { class: "r num", text: fmtRowValue(t, a[i]) }), h("td", { class: "r num", text: fmtRowValue(t, b[i]) })));
  });
  isl.append(h("div", { class: "table-wrap" }, h("table", { class: "vals co-table", "aria-label": "The pool, best on the first half first" },
    h("thead", null, h("tr", null, h("th", null, h("span", { class: "sr", text: "Member" })), h("th", { class: "r", text: "Rank" }),
      h("th", { class: "r", text: "Row" }), h("th", { class: "r", text: t.halves ? "First half" : t.label }),
      h("th", { class: "r", text: t.halves ? "Second half" : "" }))), tb)));
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

function judgedIsland(m, A, members, t) {
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
    const input = h("input", { class: "co-num num", type: "number", min: "0", max: "1000", step: "0.5", value: String(value),
      "aria-label": label, dataset: { focus: `co-${key}` } });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v >= 0 && v < 1000) { pick[key] = v; A.rerender(); }
    });
    return h("label", { class: "co-cost" }, h("span", { text: label }), input, h("span", { class: "muted", text: "bps" }));
  };
  isl.append(h("div", { class: "co-costs" }, cost("fee", "Fee", j.fee), cost("slip", "Slippage", j.slip),
    h("span", { class: "isl-note", text: `per fill; the members' own, unless set here. ${fmtInt(j.bars)} bars they share, the cohort long on ${fmtPct(j.fired, 0)} of their signals.` })));
  const best = j.members[0], mean = { whole: meanOf(j.members.map(x => x.whole)), halves: [meanOf(j.members.map(x => x.halves && x.halves[0])), meanOf(j.members.map(second))] };
  const c2 = second(j.cohort), b2 = second(best);
  isl.append(h("p", { class: "co-verdict" }, `Chosen on the first half, the cohort makes ${bpsText(pnlOf(c2))} a bar on the second; its best member alone ${bpsText(pnlOf(b2))}; its members on average ${bpsText(pnlOf(mean.halves[1]))}.`));
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
      h("tr", null, h("th", null), h("th", { colspan: "4", class: "co-half", text: "First half (chose it)" }), h("th", { colspan: "4", class: "co-half co-h2", text: "Second half (judges it)" })),
      h("tr", null, h("th", null), ...heads.map(x => h("th", { class: "r", text: x })), ...heads.map(x => h("th", { class: "r co-h2", text: x })))),
    tb)));
  return isl;
}

// ---------------------------------------------------------------------------
// The predictor, on a Limen project: Limen's Trainer retrains each member
// and Limen's Cohort binds them (grid/limen_cohort.py, run in Limen's own
// Python), into cohorts/<name>/ in the project.

const made = { list: null, at: 0, loading: false, name: null, busy: false, error: null, timer: 0 };

async function cohorts(A) {
  if (made.loading) return;
  made.loading = true;
  try {
    const res = await fetch(A.project.url, { cache: "no-store" });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `the server answered ${res.status}`);
    const list = out.cohorts || [];
    const changed = JSON.stringify(list) !== JSON.stringify(made.list);
    made.list = list;
    made.error = null;
    if (changed) A.rerender();
  } catch (err) {
    made.error = String(err.message || err);
  } finally {
    made.loading = false;
    made.at = Date.now();
  }
  // read again while one is being made
  clearTimeout(made.timer);
  if ((made.list || []).some(c => c.state === "training") && A.view() === "cohort") made.timer = setTimeout(() => cohorts(A), 2000);
}

function makeIsland(m, A, members) {
  const isl = h("section", { class: "island", "aria-labelledby": "co-make" });
  isl.append(h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "co-make", text: "Predictor" })));
  if (made.list === null || Date.now() - made.at > 5000) cohorts(A);
  const exp = m.ds.meta.experiment;
  const base = String(((exp.manifest || {}).metadata || {}).name || "experiment").replace(/[^A-Za-z0-9_-]+/g, "_");
  if (made.name === null) made.name = `${base}_cohort`;
  const name = h("input", { class: "ex-input mono", type: "text", value: made.name, maxlength: "64", spellcheck: "false",
    "aria-label": "The predictor's name", dataset: { focus: "co-name" } });
  name.addEventListener("input", () => { made.name = name.value; });
  const go = h("button", { class: "btn primary", type: "button", disabled: made.busy || !members.length ? true : null, dataset: { focus: "co-go" },
    onclick: () => makePredictor(m, A, members, howChosen(m, members)) }, made.busy ? "Starting…" : "Make predictor");
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
// it: the predictor keeps it (cohort.json's "chosen").
export function howChosen(m, members) {
  const t = m.target;
  const j = pick.judging ? null : pick.judged;
  const pocket = (m.state.pocket || []).map(c => {
    const d = m.schema.dimById.get(c.dim);
    return d ? `${d.label} = ${c.keys.map(k => (d.levels.find(l => l.key === k) || { label: k }).label).join(" or ")}` : null;
  }).filter(Boolean);
  const out = { needle: t.label, on: t.halves ? "the first half" : "the whole window", best: pick.n,
    byHand: { out: pick.out.size, in: pick.in.size },
    pocket, gates: poolGates(m.schema).map(g => g.label) };
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
    made.at = 0;
    cohorts(A);
    A.rerender();
  }
}
