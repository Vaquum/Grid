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
// Numbers. Every number on the page is written one way: a true minus
// (−0.021), thousands grouped (8,000), a range with an en dash between ends
// that are not negative (21.6–24.5%) and "to" when one is (−0.03 to
// −0.01 bps), the unit once at its end, "%" attached and other units spaced,
// and "–" for a figure that is missing.

// A label inside a sentence: its first word lowercased when that word is
// an ordinary capitalised one, so "Net PnL per bar" reads "net PnL per bar"
// and "AUC" stays "AUC".
export function inText(label) {
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

// A number in `digits` decimals: a true minus, thousands grouped, and no
// sign on a value that rounds to zero.
export function fmtFixed(x, digits = 2) {
  if (!Number.isFinite(x)) return "–";
  const [whole, frac] = Math.abs(x).toFixed(Math.max(0, digits)).split(".");
  const t = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
  return x < 0 && /[1-9]/.test(t) ? `−${t}` : t;
}

// Two ends of a range, each already written (the unit on the second): an
// en dash between them, or "to" when either carries a sign (−0.025 to
// −0.013 reads; −0.025–−0.013 does not). A parameter's values are written
// as the sweep wrote them (-0.5), so a hyphen counts as a sign too.
export function spanText(a, b) {
  return /^[−+±-]/.test(a) || /^[−+±-]/.test(b) ? `${a} to ${b}` : `${a}–${b}`;
}

// A 95% interval in the target's unit.
export function rangeText(target, lo, hi, opts = {}) {
  if (target.kind === "binary") return pctRange(lo, hi, opts.digits ?? 1);
  return spanText(fmtT(target, lo, { ...opts, unit: false }), fmtT(target, hi, opts));
}

// Two shares as percentages, the sign once at the end: 21.6–24.5%.
export function pctRange(lo, hi, digits = 1) {
  return spanText(fmtFixed(lo * 100, digits), fmtPct(hi, digits));
}

// An interval of a difference: both ends signed, the unit once.
export function deltaRange(target, lo, hi, opts = {}) {
  return spanText(fmtDelta(target, lo, { ...opts, unit: false }), fmtDelta(target, hi, opts));
}

export function fmtInt(n) {
  return Number.isFinite(n) ? fmtFixed(Math.round(n), 0) : "–";
}

export function fmtNum(x, digits = 2) {
  if (!Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a >= 1e6) return `${fmtFixed(x / 1e6, a >= 1e7 ? 1 : 2)}M`;
  return fmtFixed(x, a >= 1e4 ? 0 : digits);
}

export function fmtPct(x, digits = 1) {
  if (!Number.isFinite(x)) return "–";
  return `${fmtFixed(x * 100, digits)}%`;
}

// The decimals a step has (0.025 needs three; 5e-7, which String() writes
// with an exponent, seven).
export function stepDecimals(step) {
  const m = /^-?\d+(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(+step.toPrecision(12)));
  return m ? Math.max(0, (m[1] ? m[1].length : 0) - (m[2] ? Number(m[2]) : 0)) : 0;
}

// An axis tick: as many decimals as its step has, and no unit, which the
// chart states once ("%" and "$" are how a rate and money are written, so
// they stay).
export function tickText(target, t, step) {
  if (target.kind === "binary") return fmtPct(t, stepDecimals(step * 100));
  const text = fmtFixed(t, stepDecimals(step));
  if (target.unit === "$") return text.startsWith("−") ? `−$${text.slice(1)}` : `$${text}`;
  return text;
}

// ω², a share of the needle's variance: never below zero, in a tenth of a
// percent, or a hundredth under 0.1%.
export function fmtOmega2(w) {
  return Number.isFinite(w) ? fmtPct(Math.max(0, w), w < 0.001 ? 2 : 1) : "–";
}

// Rows per second, as the top bar, the strip and Pace all write it.
export function fmtPace(r) {
  return Number.isFinite(r) ? `${fmtFixed(r, r >= 10 ? 1 : 2)} rows/s` : "–";
}

// p- and q-values as a reader needs them.
export function fmtP(p, name = "q") {
  if (!Number.isFinite(p)) return `${name} n/a`;
  if (p < 1e-4) return `${name} < 0.0001`;
  if (p < 0.001) return `${name} < 0.001`;
  return `${name} = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;
}

// A target value in its own unit; dollars are written $1,500 and −$1,500.
export function fmtT(target, x, opts = {}) {
  if (!Number.isFinite(x)) return "–";
  if (target.kind === "binary") return fmtPct(x, opts.digits ?? 1);
  const d = opts.digits ?? target.digits ?? 2;
  if (target.unit === "$") {
    const t = fmtFixed(x, Math.max(0, d));
    return t.startsWith("−") ? `−$${t.slice(1)}` : `$${t}`;
  }
  return fmtNum(x, d) + (opts.unit === false ? "" : unitSuffix(target.unit));
}

// One row's value: no finer than the target's shown digits, nor than the
// decimals its values were written with; a 0/1 value reads yes or no.
export function fmtRowValue(target, x, opts = {}) {
  if (!Number.isFinite(x)) return "–";
  if (target.kind === "binary") return x === 1 ? "yes" : x === 0 ? "no" : fmtT(target, x, opts);
  const digits = target.digits ?? 2;
  return fmtT(target, x, { ...opts, digits: target.decimals === null || target.decimals === undefined ? digits : Math.min(digits, target.decimals) });
}

// The difference of two target values in the target's unit.
export function fmtDelta(target, d, opts = {}) {
  if (!Number.isFinite(d)) return "–";
  // the sign of the value as printed: a difference that rounds to zero is ±0
  const digits = target.kind === "binary" ? (opts.digits ?? 1) + 2 : (opts.digits ?? target.digits ?? 2);
  const r = Number(d.toFixed(Math.min(12, Math.max(0, digits))));
  const sign = r > 0 ? "+" : r < 0 ? "−" : "±";
  const unit = opts.unit !== false;
  if (target.kind === "binary") return `${sign}${fmtFixed(Math.abs(d) * 100, opts.digits ?? 1)}${unit ? " pts" : ""}`;
  if (target.unit === "$") return `${sign}$${fmtFixed(Math.abs(d), 0)}`;
  return `${sign}${fmtNum(Math.abs(d), opts.digits ?? target.digits ?? 2)}${unit ? unitSuffix(target.unit) : ""}`;
}

// A unit after its number: "%" attached (12.5%), any other unit spaced
// (12.5 %/mo, 0.4 bps, 3 green months).
export function unitSuffix(u) {
  if (!u) return "";
  return u === "%" ? "%" : ` ${u}`;
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

// A wall time (seconds since the epoch) on the reader's clock: 18:24, or
// 18:24:11 with its seconds.
const pad2 = (n) => String(n).padStart(2, "0");
export function fmtClock(sec, seconds = false) {
  if (!Number.isFinite(sec)) return "–";
  const d = new Date(sec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ""}`;
}

// A wall time in full: its date, the reader's clock and the reader's zone
// (2026-10-09 18:24:11 GMT+3).
export function fmtStamp(sec) {
  if (!Number.isFinite(sec)) return "–";
  const d = new Date(sec * 1000);
  const zone = (new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d).find(p => p.type === "timeZoneName") || {}).value;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClock(sec, true)}${zone ? ` ${zone}` : ""}`;
}

// A run's name; a run kept after its results file started over says until
// when, on the reader's clock.
export function runName(meta) {
  return meta.archivedFrom && Number.isFinite(meta.archivedAt) ? `${meta.label} · until ${fmtClock(meta.archivedAt)}` : meta.label;
}

// ---------------------------------------------------------------------------
// Tooltips: data-tip holds plain text, or a function in tipFns. The first
// shows after half a second; once one has shown, the next shows at once.

const TIP_DELAY = 500;
const tipFns = new WeakMap();
let tipTimer = null, tipWarm = false, tipCool = null, tipEl = null;

export function tip(el, content) {
  if (typeof content === "function") { tipFns.set(el, content); el.classList.add("has-tip"); }
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
      if (!c) { tipEl.hidden = true; return; }
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
      else tipTimer = setTimeout(() => current === t && show(t, e.clientX, e.clientY), TIP_DELAY);
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
// A view's blurb behind an (i). A click opens and closes it; resting the
// mouse on the (i) for five seconds opens it too, and what the mouse
// opened closes once it leaves the (i) and the blurb. The blurb lives
// outside the view, so rows arriving (which redraw the view) leave it
// open: after each redraw syncInfo moves it to the new (i), or closes it
// when the view has none.

const INFO_DWELL = 5000;
const infoContent = new Map();   // key -> () => Node, from the latest draw
let infoPop = null, infoOpen = null, infoClose = null, dwell = null;

export function infoButton(key, label, content) {
  infoLayer();
  infoContent.set(key, content);
  const open = !!infoOpen && infoOpen.key === key;
  const b = h("button", { class: "icon-btn info-btn", type: "button", "aria-label": label, "aria-expanded": open ? "true" : "false",
    "aria-controls": "info-pop", dataset: { info: key } }, icon("info"));
  b.addEventListener("click", () => {
    stopDwell();
    if (infoOpen && infoOpen.key === key && infoOpen.how === "click") closeInfo();
    else openInfo(key, "click");
  });
  return b;
}

export function syncInfo() {
  if (!infoOpen) return;
  const t = infoTrigger(infoOpen.key);
  const content = infoContent.get(infoOpen.key);
  if (!t || !content) { closeInfo(); return; }
  const next = content();
  if (next.textContent !== infoPop.textContent) { clear(infoPop); infoPop.append(next); }
  t.setAttribute("aria-expanded", "true");
  placeInfo();
}

export function infoIsOpen() { return !!infoOpen; }

export function closeInfo(refocus) {
  stopDwell();
  clearTimeout(infoClose); infoClose = null;
  if (!infoOpen) return;
  const t = infoTrigger(infoOpen.key);
  infoOpen = null;
  infoPop.hidden = true;
  if (t) { t.setAttribute("aria-expanded", "false"); if (refocus) t.focus(); }
}

function openInfo(key, how) {
  const t = infoTrigger(key), content = infoContent.get(key);
  if (!t || !content) return;
  clearTimeout(infoClose); infoClose = null;
  if (infoOpen && infoOpen.key !== key) closeInfo();
  infoOpen = { key, how };
  clear(infoPop);
  infoPop.append(content());
  infoPop.hidden = false;
  t.setAttribute("aria-expanded", "true");
  placeInfo();
}

function infoTrigger(key) {
  return document.querySelector(`[data-info="${CSS.escape(key)}"]`);
}

function stopDwell() {
  if (dwell) clearTimeout(dwell.timer);
  dwell = null;
}

// Under the (i), its right edge on the (i)'s, inside the window.
function placeInfo() {
  if (!infoOpen) return;
  const t = infoTrigger(infoOpen.key);
  if (!t) { closeInfo(); return; }
  const r = t.getBoundingClientRect();
  const w = infoPop.offsetWidth, ht = infoPop.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = r.bottom + 8;
  if (top + ht > window.innerHeight - 8) top = Math.max(8, r.top - ht - 8);
  infoPop.style.left = `${left}px`;
  infoPop.style.top = `${top}px`;
}

function infoLayer() {
  if (infoPop) return;
  infoPop = h("div", { class: "info-pop", id: "info-pop", role: "note", hidden: true });
  document.body.append(infoPop);
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const t = e.target.closest ? e.target.closest("[data-info]") : null;
    const key = t ? t.dataset.info : null;
    // five seconds resting on one (i) opens its blurb
    if (key && !(infoOpen && infoOpen.key === key)) {
      if (!dwell || dwell.key !== key) {
        stopDwell();
        dwell = { key, timer: setTimeout(() => {
          dwell = null;
          const now = infoTrigger(key);
          if (now && now.matches(":hover")) openInfo(key, "hover");
        }, INFO_DWELL) };
      }
    } else if (dwell && dwell.key !== key) stopDwell();
    // what the mouse opened closes when it leaves the (i) and the blurb
    if (infoOpen && infoOpen.how === "hover") {
      if (key === infoOpen.key || infoPop.contains(e.target)) { clearTimeout(infoClose); infoClose = null; }
      else if (!infoClose) infoClose = setTimeout(() => { infoClose = null; if (infoOpen && infoOpen.how === "hover") closeInfo(); }, 300);
    }
  }, { passive: true });
  document.addEventListener("pointerdown", (e) => {
    if (!infoOpen || infoPop.contains(e.target) || (e.target.closest && e.target.closest("[data-info]"))) return;
    closeInfo();
  });
  // before the app's own keys: Escape closes the blurb, and only the blurb
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !infoOpen) return;
    e.stopPropagation();
    closeInfo(true);
  }, true);
  document.addEventListener("scroll", () => placeInfo(), { capture: true, passive: true });
  window.addEventListener("resize", () => placeInfo());
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
  copy: "M9 9h10v10H9zM5 15V5h10",
  alert: "M12 3 2 20h20zM12 10v4M12 17h.01",
  check: "M5 12l5 5 9-10",
  // the Trials view's column sets
  needle: "M4 17a8 8 0 0 1 16 0M12 17l4-5M3 20h18",
  sliders: "M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M7 15v4",
  like: "M5 10c2.3-2 4.7-2 7 0s4.7 2 7 0M5 15c2.3-2 4.7-2 7 0s4.7 2 7 0",
  activity: "M5 20v-6M10 20V9M15 20v-9M20 20V5",
  risk: "M3 7l6 6 4-4 8 8M21 11v6h-6",
  skill: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
};

export function icon(name, cls) {
  const d = ICONS[name];
  if (!d) throw new Error(`no icon ${name}`);
  return s("svg", { viewBox: "0 0 24 24", class: cls, "aria-hidden": "true" }, s("path", { d }));
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
