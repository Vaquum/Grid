// Chart primitives. Marks follow the data-viz specs: hairline axes, 2px
// lines, dots with a 2px surface ring, intervals as thin bars, withheld
// values hollow. Every mark answers hover and focus with its numbers.

import { h, s, tip, fmtT, fmtDelta, fmtInt, fmtNum, fmtPct } from "./ui.js";
import { rankAt } from "./stats.js";

// A horizontal domain for interval bars (the inspector's table): every
// shown level mean and interval, plus the base, with a little air.
export function needleDomain(effects, base) {
  let lo = base, hi = base;
  for (const e of effects) for (const l of e.levels) {
    if (l.withheld || !(l.n > 0)) continue;
    for (const v of [l.mean, l.lo, l.hi]) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

// `past` ("hi" or "lo") is set for a withheld value past the plot's scale.
export function levelTip(l, target, base, past) {
  return h("div", null,
    h("div", null, h("b", { text: l.withheld ? "withheld" : fmtT(target, l.mean) }),
      l.withheld ? "" : h("span", { class: "k", text: `  [${fmtT(target, l.lo)}, ${fmtT(target, l.hi)}]` })),
    h("div", { class: "mono", text: l.label }),
    h("div", { class: "k", text: l.withheld
      ? `${fmtInt(l.n)} rows: fewer than 30, so no number is shown`
      : `${fmtInt(l.n)} rows · ${fmtDelta(target, l.mean - base)} against the base` }),
    past ? h("div", { class: "k", text: `It lies ${past === "hi" ? "above" : "below"} the scale the shown values set.` }) : null);
}

// Interval bar for a table row: a reference line, the interval and a dot,
// placed in percent so the dot stays round at any cell width.
export function intervalBar(mean, lo, hi, ref, domain, opts = {}) {
  const [d0, d1] = domain;
  const box = h("span", { class: "ibar", "aria-hidden": "true" });
  if (![d0, d1].every(Number.isFinite) || !(d1 > d0)) return box;
  const P = v => `${(Math.min(d1, Math.max(d0, v)) - d0) / (d1 - d0) * 100}%`;
  if (Number.isFinite(ref)) box.append(h("i", { class: "ibar-ref", style: { left: P(ref) } }));
  if (Number.isFinite(lo) && Number.isFinite(hi)) box.append(h("i", { class: "ibar-ci", style: { left: P(lo), width: `calc(${P(hi)} - ${P(lo)})` } }));
  if (Number.isFinite(mean)) box.append(h("i", { class: "ibar-dot" + (opts.hollow ? " hollow" : opts.tone ? " " + opts.tone : ""), style: { left: P(mean) } }));
  return box;
}

export function miniBar(l, domain, base) {
  return intervalBar(l.mean, l.withheld ? NaN : l.lo, l.withheld ? NaN : l.hi, base, domain, { hollow: l.withheld });
}

// Diverging fill for a value against a base: `better` toward the target's
// better direction, `worse` the other way, grey at the base. `t` in [-1, 1].
// A pole's share runs up to the theme's --heat-cap, the most it can take
// with the ink still 4.5:1 on the cell, so the text is the ink throughout.
export function divergingFill(t) {
  const a = Math.min(1, Math.abs(t));
  if (!(a > 0.02)) return { background: "var(--mid)", color: "var(--ink)" };
  const pole = t > 0 ? "var(--better)" : "var(--worse)";
  const share = (0.15 + 0.85 * a).toFixed(3);
  return { background: `color-mix(in oklab, ${pole} calc(var(--heat-cap) * ${share}), var(--mid))`, color: "var(--ink)" };
}

// Line chart with a crosshair: series [{label, color, points: [[x, y]], dash,
// group}], x numeric. Series that share a group read as one; a legend is
// drawn for two or more.
export function lineChart(series, opts = {}) {
  const W = opts.width || 640, H = opts.height || 200;
  const m = { l: 52, r: 14, t: 10, b: 26 };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const sr of series) for (const [x, y] of sr.points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (opts.yZero) { y0 = Math.min(0, y0); }
  if (!(x1 > x0)) { x1 = x0 + 1; }
  if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
  const ypad = (y1 - y0) * 0.08;
  y0 -= opts.yZero && y0 === 0 ? 0 : ypad; y1 += ypad;
  const X = x => m.l + (x - x0) / (x1 - x0) * (W - m.l - m.r);
  const Y = y => H - m.b - (y - y0) / (y1 - y0) * (H - m.t - m.b);
  const svgEl = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "chart" });
  const yt = niceTicks(y0, y1, 4);
  for (const t of yt) {
    svgEl.append(s("line", { class: "grid", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
    svgEl.append(s("text", { class: "label", x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end", text: (opts.fmtY || fmtNum)(t) }));
  }
  const xt = niceTicks(x0, x1, 5);
  for (const t of xt) {
    svgEl.append(s("text", { class: "label", x: X(t), y: H - 8, "text-anchor": "middle", text: (opts.fmtX || fmtInt)(t) }));
  }
  svgEl.append(s("line", { class: "axis", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  for (const sr of series) {
    const pts = sr.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (!pts.length) continue;
    const d = (sr.step ? stepPath(pts, X, Y) : pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(""));
    svgEl.append(s("path", { class: "series", d, stroke: sr.color, "stroke-dasharray": sr.dash || null, "stroke-width": sr.width || 2 }));
    if (sr.endDot !== false && pts.length) {
      const [lx, ly] = pts[pts.length - 1];
      svgEl.append(s("circle", { class: "marker", cx: X(lx), cy: Y(ly), r: 4, fill: sr.color }));
    }
  }
  for (const mk of opts.marks || []) {
    svgEl.append(s("line", { x1: X(mk.x), x2: X(mk.x), y1: m.t, y2: H - m.b, stroke: mk.color || "var(--critical)", "stroke-width": 1.5 }));
    if (mk.label) svgEl.append(s("text", { class: "label ink", x: X(mk.x) + 4, y: m.t + 10, text: mk.label }));
  }
  // crosshair
  const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, visibility: "hidden" });
  svgEl.append(cross);
  const overlay = s("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent", class: "has-tip" });
  let hoverX = null;
  overlay.addEventListener("pointermove", (e) => {
    const r = svgEl.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * W;
    hoverX = x0 + (px - m.l) / (W - m.l - m.r) * (x1 - x0);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
  });
  overlay.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hoverX = null; });
  // series that share a group (an interval's two bounds) are one entry: one
  // legend item, and in the tip their values as a range
  const entries = [];
  for (const sr of series) {
    const e = sr.group ? entries.find(x => x.group === sr.group) : null;
    if (e) e.members.push(sr);
    else entries.push({ group: sr.group, label: sr.label, color: sr.color, dash: sr.dash, members: [sr] });
  }
  const fmtY = opts.fmtY || fmtNum;
  tip(overlay, () => {
    if (hoverX === null) return null;
    const rows = entries.map(e => {
      const ys = e.members.map(sr => nearest(sr.points, hoverX)).filter(Boolean).map(p => p[1]);
      if (!ys.length) return null;
      const lo = Math.min(...ys), hi = Math.max(...ys);
      return h("div", null, h("span", { style: { display: "inline-block", width: "12px", height: "2px", background: e.color, verticalAlign: "middle", marginRight: "6px" } }),
        h("b", { text: hi > lo ? `${fmtY(lo)} to ${fmtY(hi)}` : fmtY(lo) }), h("span", { class: "k", text: "  " + e.label }));
    });
    const p0 = nearest(series[0] ? series[0].points : [], hoverX);
    return h("div", null, h("div", { class: "k", text: `${opts.xLabel || "x"} ${(opts.fmtX || fmtInt)(p0 ? p0[0] : hoverX)}` }), rows);
  });
  svgEl.append(overlay);
  const wrap = h("figure", { class: "fig", style: { margin: 0 } });
  if (entries.length >= 2 || opts.legend) {
    wrap.append(h("div", { class: "legend" }, entries.map(e =>
      h("span", null, h("i", { style: { background: e.color, height: e.dash ? "0" : "2px", borderTop: e.dash ? `2px dashed ${e.color}` : null } }), e.label))));
  }
  wrap.append(svgEl);
  return wrap;
}

function stepPath(pts, X, Y) {
  let d = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `H${X(pts[i][0]).toFixed(1)}V${Y(pts[i][1]).toFixed(1)}`;
  }
  return d;
}

function nearest(points, x) {
  let best = null, bd = Infinity;
  for (const p of points) {
    if (!Number.isFinite(p[1])) continue;
    const d = Math.abs(p[0] - x);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

export function niceTicks(a, b, n) {
  const span = b - a;
  if (!(span > 0)) return [a];
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  // whole multiples of the step: summing steps drifts (0 came out 1.4e-17)
  const out = [];
  for (let k = Math.ceil(a / step - 1e-9); k * step <= b + step * 1e-9; k++) out.push(+(k * step).toPrecision(12));
  return out;
}

// A gate's needle over the rows: how many rows sit at each value, the ones
// that pass in the data colour and the rest in grey, with the need marked.
// A bin edge sits on the need, so a bin holds rows from one side of it;
// only rows at the need itself can share a bin with the others (a strict
// need), and then the two are stacked. The 1st to 99th percentile is drawn
// (with the need); `outside` counts the rows beyond.
export function passHistogram(values, passOf, rows, opts = {}) {
  const W = opts.width || 420, H = opts.height || 104;
  const m = { l: 6, r: 6, t: 16, b: 20 };
  const pts = [];
  for (let j = 0; j < rows.length; j++) {
    const i = rows[j], v = values[i], p = passOf(i);
    if (v === v && p === p) pts.push([v, p]);
  }
  if (!pts.length) return { svg: h("p", { class: "muted", text: "No row has a value." }), outside: 0 };
  pts.sort((a, b) => a[0] - b[0]);
  const n = pts.length, qt = f => pts[Math.min(n - 1, Math.floor(f * n))][0];
  const need = opts.need;
  let lo = n >= 200 ? qt(0.01) : pts[0][0], hi = n >= 200 ? qt(0.99) : pts[n - 1][0];
  if (Number.isFinite(need)) { lo = Math.min(lo, need); hi = Math.max(hi, need); }
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const bins = opts.bins || 32;
  const w = (hi - lo) / bins;
  const start = Number.isFinite(need) ? need - Math.ceil((need - lo) / w - 1e-9) * w : lo;
  const nb = Math.floor((hi - start) / w + 1e-9) + 1;
  const pass = new Array(nb).fill(0), fail = new Array(nb).fill(0);
  let outside = 0;
  for (const [v, p] of pts) {
    if (v < lo || v > hi) { outside++; continue; }
    const b = Math.min(nb - 1, Math.max(0, Math.floor((v - start) / w + 1e-9)));
    if (p) pass[b]++; else fail[b]++;
  }
  const end = start + nb * w;
  const X = v => m.l + (v - start) / (end - start) * (W - m.l - m.r);
  // one bin far taller than the rest (most rounds at exactly 0) is drawn
  // broken at twice the next, with its count, so the rest stay readable
  const totals = pass.map((c, b) => c + fail[b]);
  const order = totals.map((c, b) => [c, b]).sort((x, y) => y[0] - x[0]);
  let top = Math.max(1, order[0][0]), broken = -1;
  if (order.length > 1 && order[0][0] > 4 * Math.max(1, order[1][0])) { top = 2 * Math.max(1, order[1][0]); broken = order[0][1]; }
  const plotH = H - m.t - m.b;
  const Y = c => Math.min(c, top) / top * plotH;
  const svgEl = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "distribution against the need" });
  const bw = (W - m.l - m.r) / nb, base = H - m.b;
  for (let b = 0; b < nb; b++) {
    const c = pass[b] + fail[b];
    if (!c) continue;
    const x = m.l + b * bw + 1, width = Math.max(1, bw - 2);
    // passing rows at the foot, failing above, a 2px gap between; a
    // broken bin keeps their shares of its height
    const full = Y(c), hp = full * pass[b] / c, hf = full * fail[b] / c, gap = pass[b] && fail[b] ? 2 : 0;
    const bar = s("g", { class: "has-tip" });
    if (pass[b]) bar.append(s("rect", { x, y: base - hp, width, height: Math.max(1, hp), rx: 1.5, fill: "var(--data-bar)" }));
    if (fail[b]) bar.append(s("rect", { x, y: base - hp - gap - hf, width, height: Math.max(1, hf), rx: 1.5, fill: "var(--off-bar)" }));
    if (b === broken) {
      bar.append(s("rect", { x: x - 1, y: base - full + 7, width: width + 2, height: 2, fill: "var(--surface)" }));
      const left = x + width + 40 > W;
      svgEl.append(s("text", { class: "label ink", x: left ? x - 3 : x + width + 3, y: m.t + 9, "text-anchor": left ? "end" : "start", text: fmtInt(c) }));
    }
    const a = start + b * w, z = a + w;
    tip(bar, () => h("div", null, h("b", { text: `${fmtInt(c)} row${c === 1 ? "" : "s"}` }),
      h("span", { class: "k", text: ` from ${fmtNum(a, opts.digits)} to ${fmtNum(z, opts.digits)}` }),
      h("div", { class: "k", text: pass[b] && fail[b] ? `${fmtInt(pass[b])} pass, ${fmtInt(fail[b])} fail` : pass[b] ? "every one passes" : "none passes" })));
    svgEl.append(bar);
  }
  svgEl.append(s("line", { class: "axis", x1: m.l, x2: W - m.r, y1: base, y2: base }));
  const ticks = niceTicks(lo, hi, 5);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const tickDigits = Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  for (const t of ticks) svgEl.append(s("text", { class: "label", x: Math.min(W - m.r - 12, Math.max(m.l + 12, X(t))), y: H - 6, "text-anchor": "middle", text: fmtNum(t, tickDigits) }));
  if (Number.isFinite(need)) {
    const x = X(need);
    svgEl.append(s("line", { x1: x, x2: x, y1: m.t - 4, y2: base, stroke: "var(--ink)", "stroke-width": 1.25, "stroke-dasharray": "3 2" }));
    const right = x > W * 0.62;
    svgEl.append(s("text", { class: "label ink", x: x + (right ? -5 : 5), y: m.t - 5, "text-anchor": right ? "end" : "start", text: opts.needLabel || "need" }));
  }
  return { svg: svgEl, outside };
}

// A value's quantile in sorted values (linear between order statistics).
export function quantile(sorted, f) {
  const n = sorted.length;
  if (!n) return NaN;
  const x = f * (n - 1), i = Math.floor(x), r = x - i;
  return i + 1 < n ? sorted[i] + r * (sorted[i + 1] - sorted[i]) : sorted[n - 1];
}

// Where one or two groups of rows sit on an outcome: each group's share of
// its own rows in each bin (so a small group reads against a large one),
// side by side, and under the axis each group's middle half (box), its
// 5th to 95th percentile (whisker) and its median (tick), each a value the
// rows have (stats rankAt), as the cards print them. An outcome with
// a dozen whole values or fewer gets a bar per value. Bins span the 1st to
// 99th percentile of the rows drawn (`outside` counts the rest). One bin
// far taller than the rest (most rounds at exactly 0) is drawn broken at
// twice the next, with its share, so the rest stay readable.
//
// groups: [{ label, fill, ink, text, vals }] with vals the group's values,
// sorted; `ink` draws its spread, `text` writes its share over a broken
// bin when two groups are drawn (default: its ink).
export function distChart(groups, opts = {}) {
  const W = opts.width || 420;
  const shown = groups.filter(g => g.vals.length);
  if (!shown.length) return { svg: h("p", { class: "muted", text: "No row has a value." }), outside: 0, discrete: false };
  const pooled = [].concat(...shown.map(g => Array.from(g.vals))).sort((a, b) => a - b);
  const N = pooled.length;
  const distinct = [];
  for (const v of pooled) if (v !== distinct[distinct.length - 1]) { distinct.push(v); if (distinct.length > 12) break; }
  const discrete = distinct.length <= 12 && distinct.every(Number.isInteger);
  const boxes = !(discrete && distinct.length <= 2);
  const m = { l: 6, r: 6, t: 16, b: 20 };
  const plotH = opts.plotHeight || 78, boxH = boxes ? 10 * shown.length + 6 : 0;
  const H = m.t + plotH + m.b + boxH;
  let edges = null, lo, hi, nb;
  if (discrete) {
    nb = distinct.length;
    lo = distinct[0] - 0.5; hi = distinct[nb - 1] + 0.5;
  } else {
    lo = N >= 200 ? quantile(pooled, 0.01) : pooled[0];
    hi = N >= 200 ? quantile(pooled, 0.99) : pooled[N - 1];
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    nb = shown.length > 1 ? 24 : 30;
    edges = Array.from({ length: nb + 1 }, (_, b) => lo + (hi - lo) * b / nb);
  }
  // discrete: the bar of each value at its place; continuous: equal bins
  const at = discrete ? v => distinct.indexOf(v) : v => (v < lo || v > hi ? -1 : Math.min(nb - 1, Math.floor((v - lo) / (hi - lo) * nb)));
  let outside = 0;
  const share = shown.map(g => {
    const c = new Float64Array(nb);
    for (const v of g.vals) { const b = at(v); if (b < 0) { outside++; continue; } c[b]++; }
    return Float64Array.from(c, x => x / g.vals.length);
  });
  const counts = shown.map((g, gi) => Array.from(share[gi], x => Math.round(x * g.vals.length)));
  const tall = Array.from({ length: nb }, (_, b) => Math.max(...share.map(sh => sh[b])));
  const order = tall.map((x, b) => [x, b]).sort((a, b) => b[0] - a[0]);
  let top = Math.max(1e-9, order[0][0]);
  const brokenAt = new Set();
  if (nb > 1 && order[0][0] > 4 * Math.max(1e-9, order[1][0])) {
    top = 2 * order[1][0] || order[0][0];
    for (let b = 0; b < nb; b++) if (tall[b] > top) brokenAt.add(b);
  }
  const bw = (W - m.l - m.r) / nb;
  // a discrete outcome's values sit at their bars' centres, in order
  const X = discrete
    ? v => {
      if (v <= distinct[0]) return m.l + bw / 2;
      for (let j = 0; j + 1 < nb; j++) {
        if (v <= distinct[j + 1]) return m.l + (j + 0.5 + (v - distinct[j]) / (distinct[j + 1] - distinct[j])) * bw;
      }
      return m.l + (nb - 0.5) * bw;
    }
    : v => m.l + (v - lo) / (hi - lo) * (W - m.l - m.r);
  const Y = x => Math.min(x, top) / top * plotH;
  const base = m.t + plotH;
  const svg = s("svg", { class: "chart dist", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "distribution" });
  // a value on the outcome's scale (a bin's edges); a value the rows have
  // (a discrete outcome's values, the quantiles), as the cards print it;
  // and a discrete value on the axis
  const fmtV = opts.fmt || (v => fmtNum(v, opts.digits));
  const fmtRow = opts.fmtValue || fmtV;
  const fmtTick = opts.fmtTick || fmtRow;
  for (let b = 0; b < nb; b++) {
    if (!shown.some((_, gi) => share[gi][b] > 0)) continue;
    const g0 = m.l + b * bw + 1, inner = Math.max(1, bw - 2), each = inner / shown.length;
    const bar = s("g", { class: "has-tip" });
    const cut = [];
    shown.forEach((g, gi) => {
      const x = share[gi][b];
      if (!(x > 0)) return;
      const hgt = Math.max(1, Y(x));
      bar.append(s("rect", { x: g0 + gi * each + (shown.length > 1 ? 0.5 : 0), y: base - hgt, width: Math.max(1, each - (shown.length > 1 ? 1 : 0)), height: hgt, rx: 1.5, fill: g.fill }));
      if (brokenAt.has(b) && x > top) {
        bar.append(s("rect", { x: g0 + gi * each, y: base - hgt + 7, width: each + 0.5, height: 2, fill: "var(--surface)" }));
        cut.push({ text: fmtPct(x, x < 0.1 ? 1 : 0), fill: shown.length > 1 ? g.text || g.ink || g.fill : null });
      }
    });
    if (cut.length) svg.append(cutLabel(cut, g0 + inner / 2, m, W));
    const range = discrete ? fmtRow(distinct[b]) : `${fmtV(edges[b])} to ${fmtV(edges[b + 1])}`;
    tip(bar, () => h("div", null, h("b", { text: range }),
      shown.map((g, gi) => h("div", { class: "k", text: `${g.label}: ${fmtPct(share[gi][b], share[gi][b] < 0.01 ? 2 : 1)} (${fmtInt(counts[gi][b])} of ${fmtInt(g.vals.length)})` }))));
    svg.append(bar);
  }
  svg.append(s("line", { class: "axis", x1: m.l, x2: W - m.r, y1: base, y2: base }));
  // the axis: each value of a discrete outcome, else round ticks
  const ticks = discrete ? distinct : niceTicks(lo, hi, 5);
  const step = !discrete && ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const tickDigits = discrete ? 0 : Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  const every = discrete ? Math.max(1, Math.ceil(nb / 10)) : 1;
  ticks.forEach((t, j) => {
    if (j % every) return;
    svg.append(s("text", { class: "label", x: Math.min(W - m.r - 12, Math.max(m.l + 12, X(t))), y: base + 14, "text-anchor": "middle", text: discrete ? fmtTick(t) : fmtNum(t, tickDigits) }));
  });
  // each group's spread, on the same axis
  if (boxes) {
    shown.forEach((g, gi) => {
      const y = base + m.b + 4 + gi * 10;
      const clamp = v => Math.min(W - m.r, Math.max(m.l, X(v)));
      // the same values the cards print (stats rankAt)
      const q = f => rankAt(g.vals, f);
      const p5 = clamp(q(0.05)), p25 = clamp(q(0.25)), p50 = clamp(q(0.5)), p75 = clamp(q(0.75)), p95 = clamp(q(0.95));
      const box = s("g", { class: "has-tip dist-box" });
      box.append(s("line", { x1: p5, x2: p95, y1: y, y2: y, stroke: g.ink || g.fill, "stroke-width": 1.25 }));
      box.append(s("rect", { x: p25, y: y - 3.5, width: Math.max(1.5, p75 - p25), height: 7, rx: 1.5, fill: g.fill }));
      box.append(s("line", { x1: p50, x2: p50, y1: y - 5, y2: y + 5, stroke: "var(--ink)", "stroke-width": 2 }));
      tip(box, () => h("div", null, h("b", { text: g.label }),
        h("div", { class: "k", text: `median ${fmtRow(q(0.5))} · middle half ${fmtRow(q(0.25))} to ${fmtRow(q(0.75))} · 5th to 95th percentile ${fmtRow(q(0.05))} to ${fmtRow(q(0.95))}` })));
      svg.append(box);
    });
  }
  return { svg, outside, discrete };
}

// A broken bin's label, once over the bin and inside the chart: the share
// of each group whose bar breaks there, in the order the bars stand, so
// two groups' shares never print over each other.
function cutLabel(cut, mid, m, W) {
  const half = 3.3 * (cut.reduce((n, c) => n + c.text.length, 0) + 3 * (cut.length - 1));
  const [x, anchor] = mid - half < m.l ? [m.l, "start"] : mid + half > W - m.r ? [W - m.r, "end"] : [mid, "middle"];
  const text = s("text", { class: "label ink", x, y: m.t - 4, "text-anchor": anchor });
  cut.forEach((c, k) => {
    if (k) text.append(s("tspan", { text: " · " }));
    text.append(s("tspan", { fill: c.fill, text: c.text }));
  });
  return text;
}
