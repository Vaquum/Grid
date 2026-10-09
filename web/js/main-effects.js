// The plot on a board card: the needle (y) at each value of one parameter
// (x), the main-effects plot of a designed experiment. A number's values
// sit at their own place on x (a log axis when they are spaced by
// factors), each a dot with its 95% interval, joined in order; a
// category's values are bars from zero with their interval on top. Every
// card on the board shares one y scale, so a flat card and a steep card
// compare at a glance. Marks are placed in percent of the plot box, so dots
// stay round and text keeps its size at any card width.

import { h, s, tip, fmtT } from "./ui.js";
import { levelTip } from "./charts.js";

const PAD = 7;        // % of the width kept clear inside each edge
const NULL_GAP = 13;  // % between "none" and the first number

// One y scale for every card: zero, the reference, every shown value's
// mean, and the intervals up to a quarter of that span beyond (a longer
// interval is cut at the edge and marked so), rounded out to the finest
// step of 1, 2, 2.5 or 5 that needs at most three intervals.
export function plotDomain(groups, ref, target) {
  const binary = target.kind === "binary";
  let lo = Math.min(0, ref), hi = Math.max(0, ref);
  let ciLo = lo, ciHi = hi;
  for (const levels of groups) {
    for (const l of levels) {
      if (l.withheld || !(l.n > 0) || !Number.isFinite(l.mean)) continue;
      lo = Math.min(lo, l.mean);
      hi = Math.max(hi, l.mean);
      if (Number.isFinite(l.lo)) ciLo = Math.min(ciLo, l.lo);
      if (Number.isFinite(l.hi)) ciHi = Math.max(ciHi, l.hi);
    }
  }
  if (!(hi > lo)) hi = lo + (binary ? 0.01 : 1);
  const span = hi - lo;
  const a = Math.min(lo, Math.max(ciLo, lo - span / 4));
  const b = Math.max(hi, Math.min(ciHi, hi + span / 4));
  const step = stepFor(a, b);
  let y0 = Math.floor(a / step + 1e-9) * step;
  let y1 = Math.ceil(b / step - 1e-9) * step;
  if (binary) { y0 = Math.max(0, y0); y1 = Math.min(1, y1); }
  const ticks = [];
  for (let t = y0; t <= y1 + step * 1e-9; t += step) ticks.push(+t.toPrecision(12));
  return { y0, y1, ticks, step };
}

function stepFor(a, b) {
  const mag = Math.pow(10, Math.floor(Math.log10((b - a) / 3)));
  for (const f of [1, 2, 2.5, 5, 10, 20]) {
    const step = f * mag;
    if (Math.ceil(b / step - 1e-9) - Math.floor(a / step + 1e-9) <= 3) return step;
  }
  return 50 * mag;
}

// Is a set of positive values spaced by factors (0.01, 0.1, 1) rather than
// by steps (0.2, 0.4, 0.6)? Then they are drawn on a log axis.
export function spacedByFactors(vals) {
  if (vals.length < 3 || !(vals[0] > 0)) return false;
  if (vals[vals.length - 1] / vals[0] < 8) return false;
  const cv = xs => {
    const g = xs.slice(1).map((x, i) => x - xs[i]);
    const mean = g.reduce((p, q) => p + q, 0) / g.length;
    const sd = Math.sqrt(g.reduce((p, q) => p + (q - mean) ** 2, 0) / g.length);
    return sd / mean;
  };
  return cv(vals.map(Math.log)) < cv(vals);
}

// Where each value of a number sits on x, in percent; "none" first, apart.
export function numericPlaces(levels) {
  const at = v => (Array.isArray(v) ? v : [v, v]);
  const nums = levels.filter(l => l.value !== null && l.n > 0);
  const centres = nums.map(l => at(l.value));
  const flat = [...new Set(centres.flat())].sort((p, q) => p - q);
  const log = spacedByFactors(flat);
  const t = v => (log ? Math.log(v) : v);
  const mid = ([p, q]) => (log ? Math.exp((Math.log(p) + Math.log(q)) / 2) : (p + q) / 2);
  const hasNull = levels.some(l => l.value === null && l.n > 0);
  const left = hasNull ? PAD + NULL_GAP : PAD, right = 100 - PAD;
  const xs = centres.map(mid);
  const t0 = t(Math.min(...xs)), t1 = t(Math.max(...xs));
  const place = new Map();
  nums.forEach((l, j) => place.set(l.key, t1 > t0 ? left + (t(xs[j]) - t0) / (t1 - t0) * (right - left) : (left + right) / 2));
  if (hasNull) place.set(levels.find(l => l.value === null).key, PAD);
  return { place, log, hasNull, nullEdge: hasNull ? PAD + NULL_GAP / 2 : null };
}

// The plot. `levels` are the effect's levels (with key, label, value, n,
// mean, lo, hi, withheld); opts: kind ("num" or "cat"), target, domain,
// ref (the reference line), on (the parameter moves the needle), best and
// worst keys to label, selected key, pick(key), tone(level) for a bar's
// own state (set members), rows (for the tooltips' share).
export function effectPlot(levels, opts) {
  const { target, domain, ref } = opts;
  const Y = v => (Math.min(domain.y1, Math.max(domain.y0, v)) - domain.y0) / (domain.y1 - domain.y0) * 100;
  const shown = levels.filter(l => l.n > 0 || opts.kind === "cat");
  const box = h("div", { class: "plot", dataset: { kind: opts.kind } });
  const yAxis = h("div", { class: "plot-y", "aria-hidden": "true" });
  const area = h("div", { class: "plot-area" });
  const corner = h("div", { class: "plot-c", "aria-hidden": "true" });
  const xAxis = h("div", { class: "plot-x", dataset: { kind: opts.kind }, "aria-hidden": "true" });
  box.append(yAxis, area, corner, xAxis);

  // scale: gridlines and their labels; the reference labelled in ink
  const refY = Y(ref);
  for (const t of domain.ticks) {
    const y = Y(t);
    area.append(h("i", { class: t === 0 ? "gl zero" : "gl", style: { bottom: `${y}%` }, dataset: { y: y.toFixed(2) } }));
    yAxis.append(h("span", { class: "yl", style: { bottom: `${y}%` }, dataset: { y: y.toFixed(2) }, text: tickText(target, t, domain.step) }));
  }
  area.append(h("i", { class: "ref", style: { bottom: `${refY}%` } }));
  yAxis.append(h("span", { class: "yl ref-l", style: { bottom: `${refY}%` }, dataset: { y: refY.toFixed(2) }, text: fmtT(target, ref, { unit: false }) }));

  // x places
  let place, log = false, nullEdge = null;
  if (opts.kind === "num") {
    const np = numericPlaces(shown);
    place = np.place; log = np.log; nullEdge = np.nullEdge;
  } else {
    const slot = 100 / Math.max(1, shown.length);
    place = new Map(shown.map((l, j) => [l.key, (j + 0.5) * slot]));
  }
  const order = shown.filter(l => place.has(l.key)).sort((p, q) => place.get(p.key) - place.get(q.key));

  // the trend through a number's values, in order ("none" stands apart)
  if (opts.kind === "num") {
    const pts = order.filter(l => l.value !== null && !l.withheld && Number.isFinite(l.mean));
    if (pts.length >= 2) {
      area.append(s("svg", { class: "trend", viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" },
        s("polyline", { points: pts.map(l => `${place.get(l.key).toFixed(2)},${(100 - Y(l.mean)).toFixed(2)}`).join(" "), "vector-effect": "non-scaling-stroke" })));
    }
    if (nullEdge !== null) area.append(h("i", { class: "gap", style: { left: `${nullEdge}%` } }));
  }

  // one column per value: the whole height answers the pointer
  order.forEach((l, j) => {
    const x = place.get(l.key);
    const prev = j > 0 ? place.get(order[j - 1].key) : 0;
    const next = j < order.length - 1 ? place.get(order[j + 1].key) : 100;
    const a = j > 0 ? (prev + x) / 2 : 0, b = j < order.length - 1 ? (x + next) / 2 : 100;
    const cls = ["col"];
    if (l.withheld) cls.push("withheld");
    if (opts.selected === l.key) cls.push("sel");
    const tone = opts.tone ? opts.tone(l) : null;
    if (tone) cls.push(tone);
    const col = h("span", { class: cls.join(" ") + " has-tip", style: { left: `${a}%`, width: `${b - a}%` },
      dataset: { key: l.key } });
    const inner = (x - a) / (b - a) * 100;  // the mark's centre inside its column
    if (l.n > 0) {
      const m = Number.isFinite(l.mean) ? l.mean : NaN;
      if (opts.kind === "cat") {
        const z = Y(Math.max(domain.y0, Math.min(domain.y1, 0)));
        const ym = Y(m);
        col.append(h("i", { class: "bar" + (m < 0 ? " neg" : ""), style: { left: `${inner}%`, bottom: `${Math.min(z, ym)}%`, height: `${Math.abs(ym - z)}%` } }));
      }
      if (!l.withheld && Number.isFinite(l.lo) && Number.isFinite(l.hi)) {
        const ylo = Y(l.lo), yhi = Y(l.hi);
        const cut = (l.lo < domain.y0 ? " cut-lo" : "") + (l.hi > domain.y1 ? " cut-hi" : "");
        col.append(h("i", { class: "ci" + cut, style: { left: `${inner}%`, bottom: `${ylo}%`, height: `${Math.max(0, yhi - ylo)}%` } }));
      }
      if (opts.kind === "num" && Number.isFinite(m)) col.append(h("i", { class: "pt", style: { left: `${inner}%`, bottom: `${Y(m)}%` } }));
      if (opts.on && !l.withheld && (l.key === opts.best || l.key === opts.worst)) {
        const top = Number.isFinite(l.hi) ? Y(l.hi) : Y(m);
        col.append(h("span", { class: "dl" + (l.key === opts.best ? " best" : ""), style: { left: `${inner}%`, bottom: `${top}%` }, text: fmtT(target, m, { unit: false }) }));
      }
    }
    tip(col, () => levelTip(l, target, ref));
    if (opts.pick) col.addEventListener("click", (ev) => { ev.stopPropagation(); opts.pick(l.key); });
    area.append(col);
    // its label on x, with a priority for the fitting pass
    const marked = l.key === opts.selected || (opts.on && (l.key === opts.best || l.key === opts.worst));
    if (opts.labels === "marked" && !marked) return;
    const prio = l.key === opts.selected ? 5 : l.key === opts.best ? 4 : l.key === opts.worst ? 3 : (j === 0 || j === order.length - 1) ? 2 : 1;
    const dead = opts.dead && opts.dead.includes(l.key);
    xAxis.append(h("span", { class: "xl" + (l.n > 0 ? "" : " empty") + (l.key === opts.best && opts.on ? " best" : "") + (dead ? " dead" : ""), style: { left: `${x}%` },
      dataset: { prio: String(prio) }, text: l.label }));
  });
  if (log) corner.append(h("span", { class: "xs", title: "The values are spaced by factors: a log axis", text: "log" }));
  return box;
}

// A tick in as many decimals as its step has (0.025 needs three).
function tickText(target, t, step) {
  const decimals = s => { const m = /\.(\d+)$/.exec(String(+s.toPrecision(12))); return m ? m[1].length : 0; };
  if (target.kind === "binary") return `${(t * 100).toFixed(decimals(step * 100))}%`;
  const digits = decimals(step);
  if (target.unit === "$") return (t < 0 ? "−$" : "$") + Math.abs(t).toLocaleString("en-US", { maximumFractionDigits: digits });
  return (t < 0 ? "−" : "") + Math.abs(t).toFixed(digits);
}

// After the cards are in the page: hide x labels that would collide
// (keeping the ends, the best, the worst and the selected value), let a
// category's labels take two staggered lines first, keep the end labels
// inside the card and the value labels inside the plot, and hide a y label
// or gridline that sits on the reference.
export function fitPlots(root) {
  for (const row of root.querySelectorAll(".plot-x")) fitRow(row);
  for (const area of root.querySelectorAll(".plot-area")) {
    const box = area.getBoundingClientRect();
    for (const dl of area.querySelectorAll(".dl")) {
      dl.style.transform = "";
      const r = dl.getBoundingClientRect();
      const shift = r.left < box.left ? box.left - r.left : r.right > box.right + 8 ? box.right + 8 - r.right : 0;
      if (shift) dl.style.transform = `translate(calc(-50% + ${shift}px), -5px)`;
    }
  }
  for (const plot of root.querySelectorAll(".plot")) {
    const ref = plot.querySelector(".ref-l");
    if (!ref) continue;
    const h0 = plot.querySelector(".plot-area").getBoundingClientRect().height;
    const ry = Number(ref.dataset.y) / 100 * h0;
    const near = (el, px) => Math.abs(Number(el.dataset.y) / 100 * h0 - ry) < px;
    for (const yl of plot.querySelectorAll(".yl:not(.ref-l)")) yl.hidden = near(yl, 12);
    for (const gl of plot.querySelectorAll(".gl:not(.zero)")) gl.hidden = near(gl, 5);
  }
}

function fitRow(row) {
  const labels = [...row.querySelectorAll(".xl")];
  if (!labels.length) return;
  row.classList.remove("stagger");
  for (const l of labels) { l.hidden = false; l.style.transform = ""; }
  const clash = (p, q) => p.left < q.right + 4 && q.left < p.right + 4 && p.top < q.bottom && q.top < p.bottom;
  const anyClash = (rs) => rs.some((r, i) => i > 0 && clash(rs[i - 1], r));
  let rects = labels.map(l => l.getBoundingClientRect());
  if (anyClash(rects) && row.dataset.kind === "cat") {
    row.classList.add("stagger");
    rects = labels.map(l => l.getBoundingClientRect());
    const even = rects.filter((_, i) => i % 2 === 0), odd = rects.filter((_, i) => i % 2 === 1);
    if (anyClash(even) || anyClash(odd)) { row.classList.remove("stagger"); rects = labels.map(l => l.getBoundingClientRect()); }
  }
  const order = labels.map((l, i) => i).sort((p, q) => Number(labels[q].dataset.prio) - Number(labels[p].dataset.prio) || p - q);
  const kept = [];
  for (const i of order) {
    if (kept.some(k => clash(rects[i], rects[k]))) labels[i].hidden = true;
    else kept.push(i);
  }
  // the end labels stay inside the card's padding
  const card = row.closest(".pcard") || row;
  const cb = card.getBoundingClientRect();
  for (const i of kept) {
    const r = rects[i];
    const over = r.right - (cb.right - 6), under = (cb.left + 6) - r.left;
    if (over > 0) labels[i].style.transform = `translateX(calc(-50% - ${over}px))`;
    else if (under > 0) labels[i].style.transform = `translateX(calc(-50% + ${under}px))`;
  }
}
