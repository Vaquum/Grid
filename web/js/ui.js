// Small DOM helpers, number formats, tooltips and icons. Text from the data
// (names, values, log lines) is always set as text, never as markup.

const SVG_NS = "http://www.w3.org/2000/svg";

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  appendKids(el, kids);
  return el;
}

export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  appendKids(el, kids);
  return el;
}

function setAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") {
      // custom properties (--fam) only take through setProperty
      for (const [prop, val] of Object.entries(v)) {
        if (val === undefined || val === null) continue;
        if (prop.startsWith("--")) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
}

function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------------------------------------------------------------------------
// Numbers

export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "–";
}

export function fmtNum(x, digits = 2) {
  if (!Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a >= 1e6) return (x / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e4) return Math.round(x).toLocaleString("en-US");
  return x.toFixed(digits);
}

export function fmtPct(x, digits = 1) {
  if (!Number.isFinite(x)) return "–";
  const t = (x * 100).toFixed(digits);
  return (/^-0\.?0*$/.test(t) ? t.slice(1) : t) + "%";
}

export function fmtSigned(x, digits = 2) {
  if (!Number.isFinite(x)) return "–";
  return (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x).toFixed(digits);
}

// p- and q-values as a reader needs them.
export function fmtP(p, name = "q") {
  if (!Number.isFinite(p)) return `${name} n/a`;
  if (p < 1e-4) return `${name} < 0.0001`;
  if (p < 0.001) return `${name} < 0.001`;
  return `${name} = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;
}

// A target value in its own unit.
export function fmtT(target, x, opts = {}) {
  if (!Number.isFinite(x)) return "–";
  if (target.kind === "binary") return fmtPct(x, opts.digits ?? 1);
  const d = opts.digits ?? target.digits ?? 2;
  if (target.unit === "$") return (x < 0 ? "−$" : "$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: Math.max(0, d) });
  return fmtNum(x, d) + (opts.unit === false || !target.unit || target.unit === "" ? "" : unitSuffix(target.unit));
}

// The difference of two target values in the target's unit.
export function fmtDelta(target, d, opts = {}) {
  if (!Number.isFinite(d)) return "–";
  // the sign of the value as printed: a difference that rounds to zero is ±0
  const digits = target.kind === "binary" ? (opts.digits ?? 1) + 2 : (opts.digits ?? target.digits ?? 2);
  const r = Number(d.toFixed(Math.min(12, Math.max(0, digits))));
  const sign = r > 0 ? "+" : r < 0 ? "−" : "±";
  if (target.kind === "binary") return `${sign}${(Math.abs(d) * 100).toFixed(opts.digits ?? 1)} pts`;
  if (target.unit === "$") return `${sign}$${Math.abs(d).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `${sign}${fmtNum(Math.abs(d), opts.digits ?? target.digits ?? 2)}${unitSuffix(target.unit)}`;
}

function unitSuffix(u) {
  if (!u) return "";
  if (u.startsWith("%")) return u === "%" ? "%" : " " + u;
  return " " + u;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return "–";
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${(sec / 3600).toFixed(sec < 36000 ? 1 : 0)} h`;
  return `${(sec / 86400).toFixed(1)} days`;
}

export function fmtAgo(sec) {
  if (!Number.isFinite(sec)) return "–";
  if (sec < 2) return "just now";
  return fmtDuration(sec) + " ago";
}

// ---------------------------------------------------------------------------
// Tooltips: data-tip holds plain text, or a function in tipFns. The first
// shows after 600 ms; once one has shown, the next shows at once.

const tipFns = new WeakMap();
let tipTimer = null, tipWarm = false, tipCool = null, tipEl = null;

export function tip(el, content) {
  if (typeof content === "function") tipFns.set(el, content);
  else el.dataset.tip = content;
  return el;
}

export function installTips(root, tipBox) {
  tipEl = tipBox;
  const show = (target, x, y) => {
    const fn = tipFns.get(target);
    clear(tipEl);
    if (fn) {
      const c = fn();
      if (!c) return;
      tipEl.append(c);
    } else tipEl.textContent = target.dataset.tip;
    tipEl.hidden = false;
    place(x, y);
    tipWarm = true;
  };
  const place = (x, y) => {
    const r = tipEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x + 14, top = y + 16;
    if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
    if (top + r.height > vh - 8) top = Math.max(8, y - r.height - 12);
    tipEl.style.left = left + "px";
    tipEl.style.top = top + "px";
  };
  let current = null;
  root.addEventListener("pointermove", (e) => {
    const t = e.target.closest ? e.target.closest("[data-tip], .has-tip") : null;
    if (t !== current) {
      current = t;
      clearTimeout(tipTimer);
      if (!t) { hideTip(); return; }
      clearTimeout(tipCool);
      if (tipWarm) show(t, e.clientX, e.clientY);
      else tipTimer = setTimeout(() => current === t && show(t, e.clientX, e.clientY), 600);
    } else if (t && !tipEl.hidden) place(e.clientX, e.clientY);
  });
  root.addEventListener("pointerleave", () => { current = null; hideTip(); });
  root.addEventListener("focusin", (e) => {
    const t = e.target.closest ? e.target.closest("[data-tip], .has-tip") : null;
    if (!t) return;
    const r = t.getBoundingClientRect();
    show(t, r.left, r.bottom);
  });
  root.addEventListener("focusout", () => hideTip());
}

export function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) tipEl.hidden = true;
  clearTimeout(tipCool);
  tipCool = setTimeout(() => { tipWarm = false; }, 800);
}

// ---------------------------------------------------------------------------
// Clipboard: inside the click handler; on refusal the text is selected so
// the reader can copy it by hand.

export async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Icons (24-unit strokes)

const ICONS = {
  board: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  pocket: "M5 18h14M7 14h10M9 10h6M11 6h2",
  pairs: "M4 4h16v16H4zM4 12h16M12 4v16",
  features: "M5 6h14M5 12h9M5 18h12",
  trials: "M7 4v16M17 4v16M4 8h16M4 16h16",
  gates: "M4 12h3l2-6 3 12 3-9 2 3h3",
  run: "M4 19V5M4 19h16M7 15l4-5 3 3 5-7",
  info: "M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  keys: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
  close: "M6 6l12 12M18 6 6 18",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  play: "M8 5v14l11-7z",
  pause: "M8 5v14M16 5v14",
  back: "M15 6l-6 6 6 6",
  fwd: "M9 6l6 6-6 6",
  end: "M7 6l6 6-6 6M17 6v12",
  start: "M17 6l-6 6 6 6M7 6v12",
  plus: "M12 5v14M5 12h14",
  copy: "M9 9h10v10H9zM5 15V5h10",
  alert: "M12 3 2 20h20zM12 10v4M12 17h.01",
  check: "M5 12l5 5 9-10",
  cat: "M5 5h6v6H5zM13 13h6v6h-6zM13 5h6v6h-6z",
  numk: "M4 18 9 6l4 8 3-5 4 9",
  bool: "M4 12a5 5 0 0 1 5-5h6a5 5 0 0 1 0 10H9a5 5 0 0 1-5-5zM15 12h.01",
  member: "M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10",
  scoped: "M4 4h16v16H4zM8 8h8v8H8z",
  size: "M4 18h4V12H4zM10 18h4V8h-4zM16 18h4V4h-4z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
};

export function icon(name, cls) {
  const d = ICONS[name];
  if (!d) throw new Error(`no icon ${name}`);
  return s("svg", { viewBox: "0 0 24 24", class: cls, "aria-hidden": "true" }, s("path", { d }));
}

export const FAMILY_VAR = {
  backtest: "--f-backtest", labels: "--f-labels", model: "--f-model", features: "--f-features",
  sizing: "--f-sizing", logreg: "--f-logreg", hp: "--f-hp", inferred: "--f-inferred",
};

export function famColor(family) {
  return `var(${FAMILY_VAR[family] || "--f-inferred"})`;
}

// Debounce to one call per animation frame.
export function rafThrottle(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}
