// Board: what moves the needle. A strip sums the board up; below it, one
// card per parameter, strongest first: how sure and how strong its effect
// is, and the needle at each of its values on the board's shared scale.

import { h, tip, fmtT, fmtP, fmtInt, fmtNum, fmtPct, fmtOmega2, rafThrottle, inText, rangeText, runName } from "./ui.js";
import { strip, stripCell, about } from "./strip.js";
import { effectPlot, plotDomain, fitPlots } from "./main-effects.js";
import { ensureModerators, independence, memberBoard, memberDims, setName, TOGETHER, together, togetherWhy } from "./model.js";

export function strengthText(e) {
  return fmtOmega2(e.omega2);
}

export function scopeShare(m, d) {
  if (!d.scope) return null;
  let n = 0;
  for (let j = 0; j < m.rows.length; j++) if (d.codes[m.rows[j]] >= 0) n++;
  return n / Math.max(1, m.rows.length);
}

// Where a nested parameter applies, said one way on its card and in the
// inspector: only when its scope holds, and the share of the rows that is.
export function scopeText(m, d) {
  return `only when ${d.scope.label} · ${fmtPct(scopeShare(m, d), 0)}`;
}

// The words for where a dim acts (engine actsSummary).
export function actsPhrase(m, acts) {
  if (!acts) return null;
  const P = m.schema.dimById.get(acts.parent);
  const lab = t => t.levelLabel;
  if (acts.kind === "only") {
    if (acts.off.length < acts.on.length) return `acts except when ${P.label} = ${acts.off.map(lab).join(" or ")}`;
    return `acts only when ${P.label} = ${acts.on.map(lab).join(" or ")}`;
  }
  if (acts.kind === "modulated") return `strongest when ${P.label} = ${acts.strongest ? acts.strongest.levelLabel : "?"}`;
  return `depends on ${P.label}`;
}

const sentence = t => t.charAt(0).toUpperCase() + t.slice(1);
const observed = new WeakSet();

// While rows arrive the cards keep their places: the order and the
// sections hold while the question stands (the run, the needle, the
// context, the replay edge), and the reader re-sorts when they choose; a
// new question sorts afresh.
let held = null;   // { key, on: [card ids], off: [card ids] }

// Where each card stands: in its held place, a card new since at the end
// of the section the rows put it in; and how many would move if sorted:
// those that would change section, or place among the cards that move
// the needle (the order of the rest is the order of noise).
export function holdPlaces(live, hold) {
  const ids = new Set([...live.on, ...live.off]);
  const kept = new Set([...hold.on, ...hold.off]);
  const on = [...hold.on.filter(id => ids.has(id)), ...live.on.filter(id => !kept.has(id))];
  const off = [...hold.off.filter(id => ids.has(id)), ...live.off.filter(id => !kept.has(id))];
  const sortedOn = new Map(live.on.map((id, j) => [id, j]));
  let moved = 0;
  on.forEach((id, j) => { if (sortedOn.get(id) !== j) moved++; });
  for (const id of off) if (sortedOn.has(id)) moved++;
  return { on, off, moved };
}

export function renderBoard(view, m, A) {
  const { schema, target, base, board } = m;
  const mods = ensureModerators(m, A.rerender);
  const dependent = dependentOn(m);
  const sets = setGroups(m);
  const domain = plotDomain([...board.effects.map(e => e.levels), ...sets.map(g => g.members.map(x => x.level))], base.mean, target);
  const strongest = Math.max(1e-9, ...board.effects.filter(e => e.detectable).map(e => e.omega2),
    ...sets.flatMap(g => g.members.filter(x => x.e.detectable).map(x => x.e.omega2)));
  const ctx = { mods, dependent, domain, strongest };

  view.append(h("h1", { class: "sr", text: `What moves ${target.label}` }));
  view.append(summaryStrip(m, A, mods, sets));

  // each card by its id, in the order and sections the rows give now
  const cards = new Map(), names = new Map(), live = { on: [], off: [] };
  for (const e of m.order) {
    const d = schema.dimById.get(e.dim), id = `dim:${e.dim}`;
    cards.set(id, () => card(m, A, d, e, ctx));
    names.set(id, { name: d.label, open: () => A.select({ kind: "dim", id: d.id }), why: `${e.detectable ? "Moves the needle now" : "No detectable effect"} (${fmtP(e.q)}). Open it in the inspector.` });
    live[e.detectable ? "on" : "off"].push(id);
  }
  for (const g of sets) {
    const id = `set:${g.column}`;
    cards.set(id, () => setCard(m, A, g, ctx));
    names.set(id, { name: g.column, open: () => A.set({ view: "features" }), why: "None of its members moves the needle detectably. Every member is in Features." });
    live[g.detectable ? "on" : "off"].push(id);
  }
  // the places held while the question stands
  const key = m.cache.akey;
  if (!held || held.key !== key) held = { key, on: live.on, off: live.off };
  const places = holdPlaces(live, held);
  const resort = places.moved ? h("button", { class: "btn small sec-tool", type: "button",
    onclick: () => { held = { key, on: live.on, off: live.off }; A.rerender(); } }, `Re-sort · ${fmtInt(places.moved)} would move`) : null;
  if (resort) tip(resort, "The cards keep their places while rows arrive, so nothing moves under you. Re-sort to put them in order again.");
  if (places.on.length) {
    view.append(section("Moves the needle", places.on.length, "strongest first", places.on.map(id => cards.get(id)()), resort));
  }
  if (places.off.length) {
    // the cards with no detectable effect fold to their names
    const shown = m.state.show.flat !== false;
    const fold = h("button", { class: "btn small sec-tool", type: "button", "aria-expanded": shown ? "true" : "false",
      onclick: () => A.set({ show: { ...m.state.show, flat: !shown } }, { replace: true }) }, shown ? "Fold to names" : "Show the cards");
    view.append(shown
      ? section("No detectable effect", places.off.length, "their spread is within noise", places.off.map(id => cards.get(id)()), places.on.length ? null : resort, fold)
      : section("No detectable effect", places.off.length, "their spread is within noise", null, places.on.length ? null : resort, fold,
        h("div", { class: "chips" }, places.off.map(id => {
          const x = names.get(id);
          return tip(h("button", { class: "chip mono", type: "button", onclick: x.open, text: x.name }), x.why);
        }))));
  }
  const quiet = notOnBoard(m);
  if (quiet) view.append(quiet);

  fitPlots(view);
  if (!observed.has(view)) {
    observed.add(view);
    new ResizeObserver(rafThrottle(() => fitPlots(view))).observe(view);
  }
}

// ---------------------------------------------------------------------------
// The strip: the board in one line of figures.

function summaryStrip(m, A, mods, sets) {
  const t = m.target, b = m.base;
  const det = m.order.filter(e => e.detectable);
  const dims = m.schema.dimById;
  const top = det[0] || null;
  let best = null;
  for (const e of det) {
    if (!e.best) continue;
    if (!best || e.best.mean * (t.better || 1) > best.l.mean * (t.better || 1)) best = { e, l: e.best };
  }
  const dead = [];
  for (const e of m.board.effects) for (const k of e.dead) dead.push({ e, l: e.levels.find(x => x.key === k) });
  // parameters that act only under a condition (and nowhere else); one
  // that is merely stronger somewhere is common at many rows and is told on
  // its card. Members are counted on the Features view.
  const conditional = mods ? m.board.effects.filter(e => { const md = mods.byDim.get(e.dim); return md && md.acts && md.acts.kind === "only"; }).length : null;
  const range = rangeText(t, b.lo, b.hi);
  const name = id => dims.get(id).label;

  const cell = stripCell;
  const cells = [
    cell(t.label, fmtT(t, b.mean), `95% ${range}`, () => h("div", null, h("b", { text: `${t.label} over the rows in view` }),
      t.definition ? h("div", { text: t.definition }) : null,
      h("div", { class: "k", text: `${fmtT(t, b.mean)} with its 95% interval ${range}${t.kind === "binary" ? " (Wilson)" : ""}. This is the dashed line on every card.` }),
      b.missing ? h("div", { class: "k", text: `${fmtInt(b.missing)} rows have no value for it and are left out.` }) : null)),
    cell("Rows", fmtInt(m.rows.length), m.rows.length < m.ds.n ? `of ${fmtInt(m.ds.n)}` : null,
      () => h("div", null, h("b", { text: "Rows in view" }), h("div", { class: "k", text: m.context.length ? "Rows that hold every condition of the context." : m.edge < m.ds.n ? "Rows up to the replay edge." : "Every row of the run so far." }))),
    cell("Moves the needle", fmtInt(det.length + sets.filter(g => g.detectable).length), `of ${fmtInt(m.board.tests + sets.length)}`,
      () => h("div", null, h("b", { text: "Parameters with a detectable effect" }), h("div", { class: "k", text: `After correcting for ${fmtInt(m.board.tests)} tests (Benjamini–Hochberg, q < 0.05). A set counts once, when any of its members moves the needle.` }))),
    cell("Strongest", top ? name(top.dim) : "–", top ? `ω² ${strengthText(top)}` : "nothing detectable",
      () => h("div", null, h("b", { text: "The parameter that explains the most on its own" }), h("div", { class: "k", text: "ω²: the share of the needle's variance it explains, bias-corrected." })),
      top ? () => A.select({ kind: "dim", id: top.dim }) : null, top ? { valueClass: "mono" } : {}),
    cell("Best value", best ? fmtT(t, best.l.mean) : "–", best ? `${name(best.e.dim)} = ${best.l.label}` : "nothing detectable",
      () => h("div", null, h("b", { text: "The single value with the best needle" }), h("div", { class: "k", text: "Among the parameters that move it; its interval is in the inspector." })),
      best ? () => A.select({ kind: "level", dim: best.e.dim, key: best.l.key }) : null),
    cell("Dead values", fmtInt(dead.length), dead.length ? `${name(dead[0].e.dim)} = ${dead[0].l.label}${dead.length > 1 ? ` and ${dead.length - 1} more` : ""}` : "none",
      () => h("div", null, h("b", { text: "Values the sweep can stop drawing" }), h("div", { class: "k", text: "At least 30 rows and even the top of the 95% interval is under a fifth of the base." })),
      dead.length ? () => A.select({ kind: "level", dim: dead[0].e.dim, key: dead[0].l.key }) : null),
    cell("Conditional", conditional === null ? "…" : fmtInt(conditional), conditional === null ? "checking" : `of ${fmtInt(m.board.tests)}`,
      () => h("div", null, h("b", { text: "Parameters that act only under a condition" }), h("div", { text: "Their effect is detectable inside some values of another parameter and nowhere else; the card names them." }), h("div", { class: "k", text: mods ? `${fmtInt(mods.tests)} interaction tests, corrected together.` : "Testing every pair in the background." })),
      null, { dataset: { ready: mods ? "true" : "false" } })];
  return strip("The board in figures", cells,
    { key: "board", label: "About the board", content: () => boardAbout(m) },
    { label: "Copy the board as notes", what: "Every parameter that moves the needle, with its values, strength and q.",
      text: () => boardSummary(m, mods), done: "Board copied." }, A);
}

// What the board is, behind the strip's (i).
function boardAbout(m) {
  const t = m.target;
  return about(`What moves ${t.label}`,
    t.definition ? `${t.definition}.` : null,
    `Each card is a parameter. Its plot puts ${t.kind === "binary" ? `the share of its rows that are ${inText(t.label)}` : `the mean ${inText(t.label)} of its rows`} at each of its values, with a 95% interval, on one scale every card shares; the dashed line is the base, ${fmtT(t, m.base.mean)} over the rows in view.`,
    `A parameter moves the needle when its effect is detectable after correcting for ${fmtInt(m.board.tests)} tests (Benjamini–Hochberg); the rest have no detectable effect. Choose a card to open it in the inspector.`);
}

// A section of cards (or, folded, `body` in their place) under its title,
// with its tools at the title's end.
function section(title, count, note, cards, ...rest) {
  const tools = rest.slice(0, 2).filter(Boolean), body = rest[2] || null;
  const grid = cards ? h("div", { class: "pgrid", role: "list" }, cards) : body;
  if (cards) grid.addEventListener("keydown", (ev) => gridKeys(ev, grid));
  return h("section", { class: "board-sec" },
    h("h2", { class: "sec-title" }, h("span", { text: title }), h("span", { class: "count num", text: fmtInt(count) }), h("span", { class: "note", text: note }), tools),
    grid);
}

// ---------------------------------------------------------------------------
// Cards

function card(m, A, d, e, ctx) {
  const t = m.target;
  const on = e.detectable;
  const sel = m.state.sel;
  const selected = !!sel && ((sel.kind === "dim" && sel.id === d.id) || (sel.kind === "level" && sel.dim === d.id));
  const el = h("div", { class: "pcard" + (on ? "" : " off"), role: "listitem", tabindex: "0", "aria-pressed": selected ? "true" : "false",
    "aria-label": `${d.label}: ${on ? `moves ${t.label}, ω² ${strengthText(e)}, ${fmtP(e.q)}` : "no detectable effect"}`,
    dataset: { focus: "dim:" + d.id, dim: d.id } });
  // a second click on the open card closes the inspector
  const open = () => A.select(selected ? null : { kind: "dim", id: d.id });
  el.addEventListener("click", open);
  el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });

  const sub = d.scope ? scopeText(m, d) : `${d.levels.length} values`;
  el.append(head(d.label, sub, evidence(m, d, e, ctx.strongest)));
  // a nested parameter is read against its scope's own level
  const ref = d.scope ? scopeMean(e) : m.base.mean;
  el.append(effectPlot(e.levels, {
    kind: d.ordered ? "num" : "cat", target: t, domain: ctx.domain, ref, on,
    best: e.best ? e.best.key : null, worst: e.worst ? e.worst.key : null, dead: e.dead,
    selected: sel && sel.kind === "level" && sel.dim === d.id ? sel.key : null,
    pick: key => A.select(sel && sel.kind === "level" && sel.dim === d.id && sel.key === key ? null : { kind: "level", dim: d.id, key }),
  }));
  el.append(tags(m, d, e, ctx));
  return el;
}

// A long name takes a second line, the scope starting it (min_child_weight
// / · xgb_hp); the cards of a row keep their plots level (grid.css).
function head(name, sub, ev) {
  return h("div", { class: "pc-head" },
    h("div", { class: "pc-row" }, h("span", { class: "pc-name", title: name, text: name.replace(" · ", " ·\u00a0") }), ev.top),
    h("div", { class: "pc-row" }, h("span", { class: "pc-sub", title: sub, text: sub }), ev.bottom));
}

// How strong (ω², and a meter against the strongest on the board) and how
// sure (q, corrected across the board).
function evidence(m, d, e, strongest) {
  const on = e.detectable;
  const w = on && Number.isFinite(e.omega2) ? Math.max(0.04, Math.min(1, e.omega2 / strongest)) : 0;
  const top = h("span", { class: "pc-w2 has-tip" }, h("span", { class: "meter", "aria-hidden": "true" }, h("i", { style: { width: `${(w * 100).toFixed(1)}%` } })),
    h("span", { class: "k", text: "ω²" }), h("b", { class: "num", text: strengthText(e) }));
  const bottom = h("span", { class: "pc-q num has-tip", text: fmtP(e.q) });
  const explain = () => h("div", null, h("b", { text: on ? `Moves ${inText(m.target.label)}: ω² ${strengthText(e)}` : "No detectable effect" }),
    h("div", { text: `ω² is the share of the needle's variance this parameter explains on its own${d.scope ? ", inside its scope" : ""}; the bar compares it with the strongest on the board.` }),
    h("div", { class: "k", text: `${e.test === "G" ? `G-test, ${e.k - 1} df` : `F(${e.df1}, ${e.df2}) = ${fmtNum(e.F, 2)}`} · ${fmtP(e.p, "p")} · ${fmtP(e.q)} after correcting across the board` }));
  tip(top, explain);
  tip(bottom, explain);
  return { top, bottom };
}

function tags(m, d, e, ctx) {
  const box = h("div", { class: "pc-foot" });
  const md = ctx.mods && ctx.mods.byDim.get(d.id);
  if (md && md.acts) {
    const phrase = actsPhrase(m, md.acts);
    box.append(tag(sentence(phrase), "acts", () => h("div", null, h("b", { text: sentence(phrase) }),
      h("div", { text: `The ${setName(m, [md.acts.parent, d.id])} interaction ${fmtP(md.acts.q)} after correcting across the board.` }))));
  }
  if (e.dead.length) {
    const levels = e.dead.map(k => e.levels.find(l => l.key === k));
    box.append(tag(`Dead: ${levels.map(l => l.label).join(", ")}`, "crit",
      `${levels.map(l => `${l.label} gave ${fmtInt(l.hits)} of ${fmtInt(l.n)}`).join("; ")}: even the top of the 95% interval is under a fifth of the base rate. Rows spent there are lost.`));
  }
  const dep = ctx.dependent.get(d.id);
  if (dep) {
    const other = m.schema.dimById.get(dep.other);
    box.append(tag(`${sentence(TOGETHER)} with ${other ? other.label : dep.other}`, "warn", togetherWhy(dep.V)));
  }
  const withheld = e.levels.filter(l => l.withheld && l.n > 0).length;
  if (withheld) box.append(tag(`${withheld} withheld`, null, `${withheld} value${withheld > 1 ? "s have" : " has"} fewer than 30 rows: drawn hollow, with no number.`));
  if (d.inferred) box.append(tag("Role inferred", null, "No profile names this field; it is treated as a sampled parameter because it has few distinct values."));
  return box;
}

function tag(text, kind, tipText) {
  const el = h("span", { class: "tag" + (kind ? " " + kind : "") + " has-tip", text });
  tip(el, tipText);
  return el;
}

// A set (feature subsets): one bar per member, the needle on the rows that
// included it, best first; members with no detectable effect are muted.
function setCard(m, A, g, ctx) {
  const t = m.target;
  const sel = m.state.sel;
  const selected = !!sel && g.members.some(x => (sel.kind === "dim" && sel.id === x.d.id) || (sel.kind === "level" && sel.dim === x.d.id));
  const el = h("div", { class: "pcard" + (g.detectable ? "" : " off"), role: "listitem", tabindex: "0", "aria-pressed": selected ? "true" : "false",
    "aria-label": `${g.column}: ${g.members.filter(x => x.e.detectable).length} of ${g.members.length} members move ${t.label}`,
    dataset: { focus: "set:" + g.column } });
  const open = () => A.set({ view: "features" });
  el.addEventListener("click", open);
  el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  const movers = g.members.filter(x => x.e.detectable).length;
  const top = g.best;
  const w = top && top.e.detectable ? Math.max(0.04, Math.min(1, top.e.omega2 / ctx.strongest)) : 0;
  const explain = () => h("div", null, h("b", { text: `${movers} of ${g.members.length} members move ${inText(t.label)}` }),
    h("div", { text: "Each member's inclusion is tested on its own and corrected across the members. The Features view has every member's effect inside each subset size." }));
  const ev = {
    top: tip(h("span", { class: "pc-w2 has-tip" }, h("span", { class: "meter", "aria-hidden": "true" }, h("i", { style: { width: `${(w * 100).toFixed(1)}%` } })),
      h("span", { class: "k", text: "ω² max" }), h("b", { class: "num", text: top ? strengthText(top.e) : "–" })), explain),
    bottom: tip(h("span", { class: "pc-q num has-tip", text: `${movers} of ${g.members.length} move it` }), explain),
  };
  el.append(head(g.column, `${g.members.length} members · needle when included`, ev));
  const better = t.better || 1;
  const order = g.members.slice().sort((p, q) => (q.level.mean - p.level.mean) * better);
  const levels = order.map(x => ({ ...x.level, key: x.d.id, label: x.d.name }));
  // name the strongest member on each side of the base, if it moves the needle
  const shown = order.filter(x => x.e.detectable && !x.level.withheld);
  const above = shown.find(x => (x.level.mean - m.base.mean) * better > 0);
  const below = [...shown].reverse().find(x => (x.level.mean - m.base.mean) * better < 0);
  el.append(effectPlot(levels, {
    kind: "cat", target: t, domain: ctx.domain, ref: m.base.mean, on: g.detectable, labels: "marked",
    best: above ? above.d.id : null, worst: below ? below.d.id : null,
    selected: sel && (sel.kind === "dim" || sel.kind === "level") ? (sel.kind === "dim" ? sel.id : sel.dim) : null,
    tone: l => (order.find(x => x.d.id === l.key).e.detectable ? null : "off"),
    pick: key => A.select(sel && ((sel.kind === "dim" && sel.id === key) || (sel.kind === "level" && sel.dim === key)) ? null : { kind: "dim", id: key }),
  }));
  el.append(h("div", { class: "pc-foot" }, h("span", { class: "tag link", text: "Every member in Features →" })));
  return el;
}

// Set members grouped by their set, with each member's effect from the
// members' own board (q corrected across the members).
function setGroups(m) {
  const members = memberDims(m.schema);
  if (!members.length) return [];
  const mb = memberBoard(m);
  const byDim = new Map(mb.effects.map(e => [e.dim, e]));
  const groups = new Map();
  for (const d of members) {
    const e = byDim.get(d.id);
    const level = e.levels[1];
    if (!(level.n > 0)) continue;
    if (!groups.has(d.set.column)) groups.set(d.set.column, []);
    groups.get(d.set.column).push({ d, e, level });
  }
  return [...groups.entries()].map(([column, list]) => {
    const best = list.reduce((a, x) => (x.e.detectable && (!a || x.e.omega2 > a.e.omega2) ? x : a), null);
    return { column, members: list, detectable: list.some(x => x.e.detectable), best };
  });
}

// The mean over a nested parameter's own rows (its scope).
function scopeMean(e) {
  let n = 0, s = 0;
  for (const l of e.levels) if (l.n > 0 && Number.isFinite(l.mean)) { n += l.n; s += l.n * l.mean; }
  return n ? s / n : NaN;
}

function dependentOn(m) {
  const out = new Map();
  for (const p of independence(m)) {
    if (!together(p.p, p.V)) continue;
    for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) {
      const cur = out.get(x);
      if (!cur || p.V > cur.V) out.set(x, { other: y, V: p.V });
    }
  }
  return out;
}

// Fixed values, aliases and runner-resolved fields: named, not plotted.
function notOnBoard(m) {
  const { schema } = m;
  const quiet = schema.fields.filter(f => f.role === "fixed" || f.role === "alias" || f.role === "effective");
  const aliasDims = schema.dims.filter(d => d.role === "alias" && d.aliasOf);
  if (!quiet.length && !aliasDims.length) return null;
  const chips = h("div", { class: "chips" });
  for (const f of quiet) {
    const why = f.role === "fixed" ? f.note : f.role === "alias" ? `alias: ${f.note}` : "resolved by the runner from other parameters, not sampled";
    const c = h("span", { class: "chip has-tip" }, h("span", { class: "mono", text: f.name }),
      h("span", { class: "muted", text: f.role === "fixed" ? (f.note || "").replace("one value in every row: ", "= ") : f.role }));
    tip(c, why);
    chips.append(c);
  }
  for (const d of aliasDims) {
    const c = h("span", { class: "chip has-tip" }, h("span", { class: "mono", text: d.label }), h("span", { class: "muted", text: `= ${d.aliasOf}` }));
    tip(c, d.note);
    chips.append(c);
  }
  return h("section", { class: "board-sec quiet" },
    h("h2", { class: "sec-title" }, h("span", { text: "Not on the board" }), h("span", { class: "count num", text: fmtInt(quiet.length + aliasDims.length) }), h("span", { class: "note", text: "fixed, aliases and fields the runner resolves" })),
    chips);
}

function gridKeys(ev, grid) {
  const items = [...grid.querySelectorAll(".pcard")];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  const w = items[0].getBoundingClientRect().width;
  const cols = Math.max(1, Math.round((grid.clientWidth + 12) / (w + 12)));
  let j = i;
  if (ev.key === "ArrowRight") j = i + 1;
  else if (ev.key === "ArrowLeft") j = i - 1;
  else if (ev.key === "ArrowDown") j = i + cols;
  else if (ev.key === "ArrowUp") j = i - cols;
  else return;
  ev.preventDefault();
  j = Math.max(0, Math.min(items.length - 1, j));
  items[j].focus();
}


// The board as plain text, in the style of the research notes.
export function boardSummary(m, mods) {
  const t = m.target, b = m.base;
  const lines = [];
  const ctx = m.context.map(c => {
    const d = m.schema.dimById.get(c.dim);
    return `${d.label} = ${c.keys.map(k => (d.levels.find(l => l.key === k) || { label: k }).label).join("/")}`;
  });
  lines.push(`${m.sweep.meta.name} · ${runName(m.ds.meta)} · ${fmtInt(b.n)} rows${ctx.length ? ` inside ${ctx.join(", ")}` : ""}${m.state.edge !== null && m.state.edge < m.ds.n ? ` (up to row ${fmtInt(m.edge)})` : ""}`);
  lines.push(`${t.label}${t.definition ? ` (${t.definition})` : ""}: ${fmtT(t, b.mean)} (95% ${rangeText(t, b.lo, b.hi)})`);
  const det = m.order.filter(e => e.detectable);
  lines.push(`Moves it (${det.length} of ${m.board.tests} parameters, q < 0.05):`);
  for (const e of det) {
    const d = m.schema.dimById.get(e.dim);
    const md = mods && mods.byDim.get(d.id);
    const acts = md && md.acts ? `; ${actsPhrase(m, md.acts)}` : "";
    const dead = e.dead.length ? `; dead: ${e.dead.map(k => (e.levels.find(l => l.key === k) || {}).label).join(", ")}` : "";
    lines.push(`- ${d.label}: ${e.best.label} ${fmtT(t, e.best.mean)} vs ${e.worst.label} ${fmtT(t, e.worst.mean)}, ω² ${strengthText(e)}, ${fmtP(e.q)}${acts}${dead}`);
  }
  const flat = m.order.filter(e => !e.detectable).map(e => m.schema.dimById.get(e.dim).label);
  if (flat.length) lines.push(`No detectable effect: ${flat.join(", ")}.`);
  return lines.join("\n");
}
