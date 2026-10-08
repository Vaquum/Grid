// Chart primitives. Marks follow the data-viz specs: hairline axes, 2px
// lines, dots with a 2px surface ring, intervals as thin bars, withheld
// values hollow. Every mark answers hover and focus with its numbers.

import { h, s, tip, fmtT, fmtDelta, fmtInt, fmtNum } from "./ui.js";

// A shared horizontal domain for needle strips: every shown level mean and
// interval, plus the base, with a little air.
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

const NW = 240, NH = 40, AXIS_Y = 33;

// The needle strip of one dim: where each value puts the target, against
// the base (vertical line). Lanes keep close dots apart.
export function needle(effect, target, base, domain, opts = {}) {
  const [d0, d1] = domain;
  const X = v => 6 + (v - d0) / (d1 - d0) * (NW - 12);
  const svgEl = s("svg", { class: "needle", viewBox: `0 0 ${NW} ${NH}`, role: "img",
    "aria-label": opts.label || "values against the base" });
  svgEl.append(s("line", { class: "axis-line", x1: 0, x2: NW, y1: AXIS_Y, y2: AXIS_Y }));
  const bx = X(base);
  svgEl.append(s("line", { class: "base-line", x1: bx, x2: bx, y1: 3, y2: NH - 1 }));
  const shown = effect.levels.filter(l => l.n > 0).map(l => ({ l, x: Number.isFinite(l.mean) ? X(l.mean) : NaN }))
    .filter(o => Number.isFinite(o.x)).sort((a, b) => a.x - b.x);
  const lanes = [];
  for (const o of shown) {
    let lane = 0;
    while (lanes[lane] !== undefined && o.x - lanes[lane] < 9) lane++;
    lanes[lane] = o.x;
    o.lane = Math.min(lane, 2);
  }
  const laneY = [AXIS_Y - 9, AXIS_Y - 19, AXIS_Y - 28];
  for (const o of shown) {
    const { l } = o;
    const y = laneY[o.lane];
    const g = s("g", { class: "has-tip", tabindex: opts.focusable ? "0" : null });
    if (!l.withheld && Number.isFinite(l.lo)) {
      g.append(s("line", { class: "ci-bar", x1: X(l.lo), x2: X(l.hi), y1: y, y2: y }));
    }
    let cls = "dot";
    if (l.withheld) cls += " hollow";
    else if (effect.best && l.key === effect.best.key && effect.detectable) cls += " best";
    else if (effect.worst && l.key === effect.worst.key && effect.detectable) cls += " worst";
    if (opts.selected && opts.selected === l.key) cls += " sel";
    g.append(s("circle", { class: cls, cx: o.x, cy: y, r: 4 }));
    g.append(s("circle", { class: "hit", cx: o.x, cy: y, r: 11 }));
    tip(g, () => levelTip(l, target, base));
    svgEl.append(g);
  }
  return svgEl;
}

export function levelTip(l, target, base) {
  return h("div", null,
    h("div", null, h("b", { text: l.withheld ? "withheld" : fmtT(target, l.mean) }),
      l.withheld ? "" : h("span", { class: "k", text: `  [${fmtT(target, l.lo)}, ${fmtT(target, l.hi)}]` })),
    h("div", { class: "mono", text: l.label }),
    h("div", { class: "k", text: l.withheld
      ? `${fmtInt(l.n)} rows: fewer than 30, so no number is shown`
      : `${fmtInt(l.n)} rows · ${fmtDelta(target, l.mean - base)} against the base` }));
}

// Mini interval bar for table rows (same domain as its siblings).
export function miniBar(l, domain, base, target) {
  const [d0, d1] = domain;
  const W = 120, H = 14;
  const X = v => 4 + (Math.min(d1, Math.max(d0, v)) - d0) / (d1 - d0) * (W - 8);
  const el = s("svg", { class: "mini", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  el.append(s("line", { class: "base-line", x1: X(base), x2: X(base), y1: 0, y2: H }));
  if (!l.withheld && Number.isFinite(l.lo)) el.append(s("line", { class: "ci-bar", x1: X(l.lo), x2: X(l.hi), y1: H / 2, y2: H / 2 }));
  if (Number.isFinite(l.mean)) el.append(s("circle", { class: l.withheld ? "dot hollow" : "dot", cx: X(l.mean), cy: H / 2, r: 3.5 }));
  return el;
}

// Diverging fill for a value against a base: `better` toward the target's
// better direction, `worse` the other way, grey at the base. `t` in [-1, 1].
export function divergingFill(t) {
  const a = Math.min(1, Math.abs(t));
  const pct = Math.round(12 + a * 78);
  if (!(a > 0.02)) return { background: "var(--mid)", color: "var(--ink)" };
  const pole = t > 0 ? "var(--better)" : "var(--worse)";
  return { background: `color-mix(in oklab, ${pole} ${pct}%, var(--mid))`, color: a > 0.55 ? "#ffffff" : "var(--ink)" };
}

// Line chart with a crosshair: series [{label, color, points: [[x, y]], dash}],
// x numeric. A legend is drawn for two or more series.
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
  tip(overlay, () => {
    if (hoverX === null) return null;
    const rows = series.map(sr => {
      const p = nearest(sr.points, hoverX);
      return p ? h("div", null, h("span", { style: { display: "inline-block", width: "12px", height: "2px", background: sr.color, verticalAlign: "middle", marginRight: "6px" } }),
        h("b", { text: (opts.fmtY || fmtNum)(p[1]) }), h("span", { class: "k", text: "  " + sr.label })) : null;
    });
    const p0 = nearest(series[0] ? series[0].points : [], hoverX);
    return h("div", null, h("div", { class: "k", text: `${opts.xLabel || "x"} ${(opts.fmtX || fmtInt)(p0 ? p0[0] : hoverX)}` }), rows);
  });
  svgEl.append(overlay);
  const wrap = h("figure", { class: "fig", style: { margin: 0 } });
  if (series.length >= 2 || opts.legend) {
    wrap.append(h("div", { class: "legend" }, series.map(sr =>
      h("span", null, h("i", { style: { background: sr.color, height: sr.dash ? "0" : "2px", borderTop: sr.dash ? `2px dashed ${sr.color}` : null } }), sr.label))));
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
  const out = [];
  for (let t = Math.ceil(a / step) * step; t <= b + step * 1e-9; t += step) out.push(+t.toPrecision(12));
  return out;
}

// Histogram with an optional need line.
export function histogram(values, opts = {}) {
  const W = opts.width || 420, H = opts.height || 120;
  const m = { l: 36, r: 10, t: 8, b: 24 };
  const vals = values.filter(Number.isFinite);
  if (!vals.length) return h("p", { class: "muted", text: "No values." });
  let lo = opts.min ?? Math.min(...vals), hi = opts.max ?? Math.max(...vals);
  if (opts.need !== undefined) { lo = Math.min(lo, opts.need); hi = Math.max(hi, opts.need); }
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const bins = opts.bins || 30;
  const cnt = new Array(bins).fill(0);
  for (const v of vals) cnt[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / (hi - lo) * bins)))]++;
  const top = Math.max(...cnt);
  const X = v => m.l + (v - lo) / (hi - lo) * (W - m.l - m.r);
  const Y = c => H - m.b - c / top * (H - m.t - m.b);
  const svgEl = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "distribution" });
  const bw = (W - m.l - m.r) / bins;
  cnt.forEach((c, i) => {
    if (!c) return;
    const x = m.l + i * bw;
    const r = s("rect", { x: x + 1, y: Y(c), width: Math.max(1, bw - 2), height: H - m.b - Y(c), rx: 1.5, fill: "var(--ink-2)", class: "has-tip" });
    const a = lo + i * (hi - lo) / bins, b = lo + (i + 1) * (hi - lo) / bins;
    tip(r, () => h("div", null, h("b", { text: fmtInt(c) }), h("span", { class: "k", text: ` rows between ${fmtNum(a)} and ${fmtNum(b)}` })));
    svgEl.append(r);
  });
  svgEl.append(s("line", { class: "axis", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  for (const t of niceTicks(lo, hi, 5)) svgEl.append(s("text", { class: "label", x: X(t), y: H - 8, "text-anchor": "middle", text: fmtNum(t, Math.abs(hi - lo) < 5 ? 2 : 0) }));
  if (opts.need !== undefined) {
    svgEl.append(s("line", { x1: X(opts.need), x2: X(opts.need), y1: m.t - 2, y2: H - m.b, stroke: "var(--critical)", "stroke-width": 1.5 }));
    const right = X(opts.need) > W * 0.7;
    svgEl.append(s("text", { class: "label ink", x: X(opts.need) + (right ? -4 : 4), y: m.t + 8, "text-anchor": right ? "end" : "start", text: opts.needLabel || "need" }));
  }
  return svgEl;
}
