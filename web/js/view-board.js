// Board: one block per parameter, sorted by how much it moves the target.

import { h, icon, tip, fmtT, fmtP, fmtInt, fmtPct, famColor } from "./ui.js";
import { needle, needleDomain } from "./charts.js";
import { dimEffect } from "./engine.js";
import { ensureModerators, independence, memberDims } from "./model.js";

const KIND_ICON = { cat: "cat", num: "numk", bool: "bool", member: "member", scoped: "scoped", size: "size" };

export function strengthText(e) {
  if (!Number.isFinite(e.omega2)) return "–";
  return `${(Math.max(0, e.omega2) * 100).toFixed(e.omega2 < 0.001 ? 2 : 1)}%`;
}

export function scopeShare(m, d) {
  if (!d.scope) return null;
  let n = 0;
  for (let j = 0; j < m.rows.length; j++) if (d.codes[m.rows[j]] >= 0) n++;
  return n / Math.max(1, m.rows.length);
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

export function renderBoard(view, m, A) {
  const { schema, target, base, board } = m;
  const mods = ensureModerators(m, A.rerender);
  const indep = independence(m);
  const dependent = new Map();
  for (const p of indep) {
    if (p.p < 1e-6 && p.V > 0.03) {
      for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) {
        const cur = dependent.get(x);
        if (!cur || p.V > cur.V) dependent.set(x, { other: y, V: p.V });
      }
    }
  }
  // set blocks: one per set column, from its members' effects
  const members = memberDims(schema);
  const setEffects = new Map();
  for (const d of members) {
    const e = dimEffect(d, target, m.rows, base);
    if (!setEffects.has(d.set.column)) setEffects.set(d.set.column, []);
    setEffects.get(d.set.column).push({ d, e });
  }
  const domain = needleDomain(board.effects.concat([...setEffects.values()].flat().map(x => x.e)), base.mean);

  // header
  const head = h("div", { class: "view-head" },
    h("div", null,
      h("h1", null, "What moves ", h("span", { text: target.label })),
      h("div", { class: "sub" },
        target.definition ? h("span", { text: `${target.definition}. ` }) : null,
        "Each block is a parameter; each dot is one of its values, placed by ",
        target.kind === "binary" ? `the share of its rows that are ${target.label.toLowerCase()}` : `the mean ${target.label.toLowerCase()} of its rows`,
        ", with a 95% interval. The vertical line is the base. Raised blocks have a detectable effect after correcting for ",
        h("span", { class: "num", text: fmtInt(board.tests) }), " tests; flat blocks do not.")),
    h("div", { class: "tools" },
      h("div", { class: "hero has-tip" }, h("span", { class: "big num", text: fmtT(target, base.mean) }),
        h("span", { class: "ci num", text: `[${fmtT(target, base.lo)}, ${fmtT(target, base.hi)}] over ${fmtInt(base.n)} rows` }))));
  tip(head.querySelector(".hero"), () => h("div", null, h("b", { text: "The base" }), h("div", { text: `${target.label} over every row in view${m.context.length ? " (the context)" : ""}, with its 95% interval${target.kind === "binary" ? " (Wilson)" : ""}.` }),
    base.missing ? h("div", { class: "k", text: `${fmtInt(base.missing)} rows have no value for this target and are left out.` }) : null));
  view.append(head);

  const legend = h("div", { class: "family-legend", style: { marginBottom: "14px" } },
    schema.families.filter(f => schema.dims.some(d => d.family === f.id && d.role === "param")).map(f =>
      h("span", null, h("i", { style: { background: famColor(f.id) } }), f.label)),
    h("span", { class: "muted" }, mods ? `${fmtInt(mods.tests)} interaction tests checked for where each acts` : "Checking where each parameter acts…"));
  view.append(legend);

  const grid = h("div", { class: "board", role: "list" });
  const ordered = m.order;
  const raised = ordered.filter(e => e.detectable);
  const flat = ordered.filter(e => !e.detectable);
  const setBlocks = [...setEffects.entries()].map(([col, list]) => setBlock(m, A, col, list, domain));
  const anySetRaised = setBlocks.filter(b => b.detectable);
  if (raised.length || anySetRaised.length) {
    grid.append(h("div", { class: "board-group" }, h("b", { text: "Moves the needle" }), `${raised.length + anySetRaised.length} detectable · strongest first`));
    for (const e of raised) grid.append(block(m, A, e, domain, mods, dependent));
    for (const b of anySetRaised) grid.append(b.el);
  }
  if (flat.length && m.state.show.flat !== false) {
    grid.append(h("div", { class: "board-group" }, h("b", { text: "No detectable effect" }), `${flat.length + setBlocks.filter(b => !b.detectable).length} parameters · their spread is within noise`));
    for (const e of flat) grid.append(block(m, A, e, domain, mods, dependent));
    for (const b of setBlocks.filter(x => !x.detectable)) grid.append(b.el);
  }
  view.append(grid);
  grid.addEventListener("keydown", (ev) => gridKeys(ev, grid));

  // fixed, aliases and derived
  const quiet = schema.fields.filter(f => f.role === "fixed" || f.role === "alias" || f.role === "effective");
  const aliasDims = schema.dims.filter(d => d.role === "alias" && d.aliasOf);
  if (quiet.length || aliasDims.length) {
    view.append(h("div", { class: "section-title", text: "Not on the board" }));
    const chips = h("div", { class: "chips" });
    for (const f of quiet) {
      const why = f.role === "fixed" ? f.note : f.role === "alias" ? `alias: ${f.note}` : "resolved by the runner from other parameters, not sampled";
      const c = h("span", { class: "chip has-tip" }, h("i", { class: "fam", style: { background: famColor(f.family || "inferred") } }),
        h("span", { class: "mono", text: f.name }), h("span", { class: "muted", text: f.role === "fixed" ? (f.note || "").replace("one value in every row: ", "= ") : f.role }));
      tip(c, why);
      chips.append(c);
    }
    for (const d of aliasDims) {
      const c = h("span", { class: "chip has-tip" }, h("i", { class: "fam", style: { background: famColor(d.family) } }),
        h("span", { class: "mono", text: d.label }), h("span", { class: "muted", text: `= ${d.aliasOf}` }));
      tip(c, d.note);
      chips.append(c);
    }
    view.append(chips);
  }
}

function block(m, A, e, domain, mods, dependent) {
  const d = m.schema.dimById.get(e.dim);
  const sel = m.state.sel && m.state.sel.kind === "dim" && m.state.sel.id === d.id;
  const lift = e.detectable ? Math.min(6, 2 + 60 * Math.max(0, e.omega2)) : 0;
  const el = h("button", {
    class: "block" + (e.detectable ? "" : " flat"), role: "listitem", "aria-pressed": sel ? "true" : "false",
    dataset: { focus: "dim:" + d.id }, style: { "--fam": famColor(d.family), "--lift": `${lift.toFixed(1)}px` },
    onclick: () => A.select({ kind: "dim", id: d.id }),
  });
  const share = scopeShare(m, d);
  const nameEl = h("span", { class: "block-name" }, d.kind === "scoped" ? d.name : d.label,
    d.scope ? h("span", { class: "block-scope", text: `inside ${d.scope.label} · ${fmtPct(share, 0)} of rows` }) : null);
  const strength = h("span", { class: "strength has-tip" }, h("b", { class: "num", text: strengthText(e) }), " ω²");
  tip(strength, () => h("div", null, h("b", { text: `ω² ${strengthText(e)}` }),
    h("div", { text: `Share of the ${m.target.label.toLowerCase()} variance this parameter explains on its own${d.scope ? ", inside its scope" : ""}.` }),
    h("div", { class: "k", text: `${e.test === "G" ? `G-test, ${e.k - 1} df` : `F(${e.df1}, ${e.df2}) = ${Number.isFinite(e.F) ? e.F.toFixed(2) : "–"}`} · ${fmtP(e.p, "p")} · ${fmtP(e.q)}` })));
  const inner = h("div", { class: "block-in" },
    h("div", { class: "block-head" }, h("span", { class: "kind" }, icon(KIND_ICON[d.kind] || "cat")), nameEl, strength),
    needle(e, m.target, m.base.mean, domain, { label: `${d.label}: values against the base`, selected: m.state.sel && m.state.sel.dim === d.id ? m.state.sel.key : null }));
  const ex = h("div", { class: "extremes" });
  if (e.detectable && e.best && e.worst && e.best !== e.worst) {
    ex.append(h("span", null, h("span", { class: "v", text: e.best.label }), " ", fmtT(m.target, e.best.mean)),
      h("span", null, h("span", { class: "v", text: e.worst.label }), " ", fmtT(m.target, e.worst.mean)));
  } else {
    ex.append(h("span", { class: "muted", text: `${fmtP(e.q)} · ${d.levels.length} values` }));
  }
  inner.append(ex);
  const badges = h("div", { class: "badges" });
  const md = mods && mods.byDim.get(d.id);
  if (md && md.acts) {
    const phrase = actsPhrase(m, md.acts);
    const b = h("span", { class: "badge acts has-tip" }, icon("target"), phrase);
    tip(b, () => h("div", null, h("b", { text: phrase }), h("div", { text: `The ${md.acts.label} × ${d.label} interaction ${fmtP(md.acts.q)} after correcting across the board.` })));
    badges.append(b);
  }
  if (e.dead.length) {
    const labs = e.dead.map(k => (e.levels.find(l => l.key === k) || {}).label);
    const counts = e.dead.map(k => e.levels.find(l => l.key === k)).map(l => `${fmtInt(l.hits)} of ${fmtInt(l.n)}`);
    const b = h("span", { class: "badge crit has-tip" }, icon("alert"), `dead: ${labs.join(", ")}`);
    tip(b, `${labs.join(", ")} gave ${counts.join(", ")} hits; even the top of its 95% interval is under a fifth of the base rate. Rows spent there are lost.`);
    badges.append(b);
  }
  const dep = dependent.get(d.id);
  if (dep) {
    const other = m.schema.dimById.get(dep.other);
    const b = h("span", { class: "badge warn has-tip" }, `not independent of ${other ? other.label : dep.other}`);
    tip(b, `Cramér's V ${dep.V.toFixed(3)} against ${other ? other.label : dep.other}: the sampler does not draw these two independently, so this parameter's marginal effect carries some of the other's.`);
    badges.append(b);
  }
  const withheld = e.levels.filter(l => l.withheld && l.n > 0).length;
  if (withheld) {
    const b = h("span", { class: "badge has-tip", text: `${withheld} withheld` });
    tip(b, `${withheld} value${withheld > 1 ? "s have" : " has"} fewer than 30 rows: drawn hollow, with no number.`);
    badges.append(b);
  }
  if (d.inferred) {
    const b = h("span", { class: "badge has-tip", text: "role inferred" });
    tip(b, "No profile names this field; it is treated as a sampled parameter because it has few distinct values.");
    badges.append(b);
  }
  if (badges.children.length) inner.append(badges);
  el.append(inner);
  return el;
}

function setBlock(m, A, column, list, domain) {
  const detect = list.filter(x => x.e.detectable);
  const best = list.reduce((a, b) => (Number.isFinite(b.e.omega2) && (!a || b.e.omega2 > a.e.omega2) ? b : a), null);
  const fam = list[0].d.family;
  const lift = detect.length ? Math.min(6, 2 + 60 * Math.max(0, best.e.omega2)) : 0;
  const el = h("button", { class: "block" + (detect.length ? "" : " flat"), role: "listitem", dataset: { focus: "set:" + column },
    style: { "--fam": famColor(fam), "--lift": `${lift.toFixed(1)}px` }, onclick: () => A.set({ view: "features" }) });
  const pseudo = { levels: list.map(x => ({ ...x.e.levels[1], label: x.d.name, key: x.d.id })), best: null, worst: null, detectable: false };
  const inner = h("div", { class: "block-in" },
    h("div", { class: "block-head" }, h("span", { class: "kind" }, icon("member")),
      h("span", { class: "block-name" }, column, h("span", { class: "block-scope", text: `${list.length} members · a dot is a member's rows when included` })),
      h("span", { class: "strength" }, h("b", { class: "num", text: detect.length ? strengthText(best.e) : "–" }), " ω² max")),
    needle(pseudo, m.target, m.base.mean, domain, { label: `${column}: rows that included each member` }),
    h("div", { class: "extremes" }, h("span", { class: "muted", text: `${detect.length} of ${list.length} members move it` }), h("span", { class: "v", text: "Features →" })));
  el.append(inner);
  return { el, detectable: detect.length > 0 };
}

function gridKeys(ev, grid) {
  const items = [...grid.querySelectorAll(".block")];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  const cols = Math.max(1, Math.round(grid.clientWidth / (items[0].getBoundingClientRect().width + 16)));
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

