// Chart primitives. Marks follow the data-viz specs: hairline axes, 2px
// lines, dots with a 2px surface ring, intervals as thin bars, withheld
// values hollow. Every mark answers hover and focus with its numbers.

import { h, s, tip, fmtT, fmtDelta, fmtInt, fmtNum } from "./ui.js";

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

export function levelTip(l, target, base) {
  return h("div", null,
    h("div", null, h("b", { text: l.withheld ? "withheld" : fmtT(target, l.mean) }),
      l.withheld ? "" : h("span", { class: "k", text: `  [${fmtT(target, l.lo)}, ${fmtT(target, l.hi)}]` })),
    h("div", { class: "mono", text: l.label }),
    h("div", { class: "k", text: l.withheld
      ? `${fmtInt(l.n)} rows: fewer than 30, so no number is shown`
      : `${fmtInt(l.n)} rows · ${fmtDelta(target, l.mean - base)} against the base` }));
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
  const all = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!all.length) return h("p", { class: "muted", text: "No values." });
  // the 1st to 99th percentile (and the need): a few extreme values would
  // otherwise squeeze everything else into one bar; the rest are counted
  const qt = f => all[Math.min(all.length - 1, Math.floor(f * all.length))];
  let lo = opts.min ?? (all.length >= 200 ? qt(0.01) : all[0]);
  let hi = opts.max ?? (all.length >= 200 ? qt(0.99) : all[all.length - 1]);
  if (opts.need !== undefined) { lo = Math.min(lo, opts.need); hi = Math.max(hi, opts.need); }
  const vals = all.filter(v => v >= lo && v <= hi);
  const outside = all.length - vals.length;
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
  if (outside) {
    svgEl.append(s("text", { class: "label", x: W - m.r, y: m.t + 20, "text-anchor": "end",
      text: `${fmtInt(outside)} outside ${fmtNum(lo, 2)} – ${fmtNum(hi, 2)} not drawn` }));
  }
  if (opts.need !== undefined) {
    svgEl.append(s("line", { x1: X(opts.need), x2: X(opts.need), y1: m.t - 2, y2: H - m.b, stroke: "var(--critical)", "stroke-width": 1.5 }));
    const right = X(opts.need) > W * 0.7;
    svgEl.append(s("text", { class: "label ink", x: X(opts.need) + (right ? -4 : 4), y: m.t + 8, "text-anchor": right ? "end" : "start", text: opts.needLabel || "need" }));
  }
  return svgEl;
}
