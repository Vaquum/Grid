// The page: loads a sweep (embedded, live from the server, or a dropped
// file), keeps the state (in the address), computes what the views need,
// and routes keys, clicks and live updates.

import { decodePack, Dataset } from "./pack.js";
import { buildSchema } from "./schema.js";
import { limenProfile } from "./profiles.js";
import { rowsIn, summarize, board, boardOrder, MIN_N } from "./engine.js";
import { boardDims, objectiveTop, objectiveKeys } from "./model.js";
import { h, clear, icon, installTips, hideTip, syncInfo, fmtInt, fmtRowValue, runName, tip } from "./ui.js";
import { runStatus, rowsSince } from "./status.js";
import { manifestSection, figureLine } from "./manifest.js";
import { applyGates } from "./gates.js";
import { renderBoard } from "./view-board.js";
import { renderInspector } from "./inspector.js";
import { renderPocket } from "./view-pocket.js";
import { renderPairs } from "./view-pairs.js";
import { renderFeatures } from "./view-features.js";
import { renderTrials } from "./view-trials.js";
import { renderGates } from "./view-gates.js";
import { renderRun, runHealth, runLog, segmentOf } from "./view-run.js";
import { renderReference } from "./reference.js";

const VIEWS = [
  { id: "board", label: "Board", icon: "board", key: "1", title: "What moves the needle" },
  { id: "pocket", label: "Pocket", icon: "pocket", key: "2", title: "Compose a pocket" },
  { id: "pairs", label: "Pairs", icon: "pairs", key: "3", title: "Which parameters change each other's effect" },
  { id: "features", label: "Features", icon: "features", key: "4", title: "Feature inclusion" },
  { id: "trials", label: "Trials", icon: "trials", key: "5", title: "The best rows" },
  { id: "gates", label: "Gates", icon: "gates", key: "6", title: "Set gates, see what they allow" },
  { id: "run", label: "Run", icon: "run", key: "7", title: "The whole run: its distributions and clusters" },
];

const DEFAULT_STATE = {
  run: null, view: "board", target: null, context: [], pocket: [], pocketB: null,
  sel: null, edge: null, show: { flat: true }, pair: null, order: 2, featSort: "effect",
  trialCols: ["movers"], gates: [], clusters: [], compare: false, clusterK: null,
};

const app = {
  config: null, sweep: null, state: null, cache: {}, live: null, playback: null,
  els: {}, top: null, lastBest: new Map(), started: Date.now(),
  // what happened while the page was open, newest first; the run and the
  // state the pill last said, to tell a change of it
  events: [], watch: null,
  // the archive to move the reader to once its rows are here
  stayOn: null,
};

// ---------------------------------------------------------------------------
// State in the address: a base64url token, which survives hosts that pass
// only a bare #anchor.

function encodeState(st) {
  const o = { v: st.view, r: st.run, t: st.target, c: st.context, p: st.pocket, pb: st.pocketB, s: st.sel, e: st.edge, pr: st.pair, po: st.order, sh: st.show, fs: st.featSort, tc: st.trialCols, g: st.gates,
    cl: st.clusters, cm: st.compare, ck: st.clusterK };
  const json = JSON.stringify(o);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return "s1." + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeState(hash) {
  const m = /^#?s1\.([A-Za-z0-9_-]+)$/.exec(hash || "");
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const o = JSON.parse(new TextDecoder().decode(bytes));
    return { ...DEFAULT_STATE, view: o.v, run: o.r, target: o.t, context: o.c || [], pocket: o.p || [], pocketB: Array.isArray(o.pb) ? o.pb : null, sel: o.s || null,
      edge: o.e ?? null, pair: o.pr || null, order: o.po || 2, show: o.sh || DEFAULT_STATE.show, featSort: o.fs || "effect",
      trialCols: Array.isArray(o.tc) ? o.tc : DEFAULT_STATE.trialCols, gates: Array.isArray(o.g) ? o.g : [],
      clusters: Array.isArray(o.cl) ? o.cl : [], compare: !!o.cm, clusterK: Number.isInteger(o.ck) ? o.ck : null };
  } catch (err) {
    console.warn("ignoring an address that is not a Grid view", err);
    return null;
  }
}

function pushState(next, replace = false) {
  app.state = next;
  const token = "#" + encodeState(next);
  try {
    if (replace) history.replaceState(null, "", token);
    else history.pushState(null, "", token);
  } catch (err) { /* sandboxed hosts may refuse history; the page still works */ }
  update();
}

export function setState(patch, opts = {}) {
  pushState({ ...app.state, ...patch }, opts.replace);
}

// ---------------------------------------------------------------------------
// Loading

async function gunzipBase64(b64) {
  const bytes = Uint8Array.from(atob(b64.trim()), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

async function loadEmbedded() {
  const el = document.getElementById("grid-pack");
  const b64 = el ? el.textContent.trim() : "";
  if (!b64) return null;
  const text = await gunzipBase64(b64);
  return JSON.parse(text);
}

async function loadLive(cfg) {
  const res = await fetch(cfg.pack, { cache: "no-store" });
  if (!res.ok) throw new Error(`the server answered ${res.status} for ${cfg.pack}`);
  const body = await res.json();
  return body;
}

function startStream(cfg, cursor) {
  const es = new EventSource(`${cfg.stream}?cursor=${encodeURIComponent(cursor)}`);
  app.live = { es, connected: false, lastMessage: Date.now(), cfg };
  es.onopen = () => { app.live.connected = true; updateTop(); };
  es.onmessage = (ev) => {
    app.live.lastMessage = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch (err) { console.error("bad stream message", err); return; }
    applyMessage(msg);
  };
  es.onerror = () => {
    // The cursor is single-use: start over from a fresh pack after a pause.
    es.close();
    app.live.connected = false;
    updateTop();
    setTimeout(() => reconnect(cfg), 3000);
  };
}

async function reconnect(cfg) {
  try {
    const body = await loadLive(cfg);
    // the run on screen, and its generation: it may have started over while
    // the stream was down, and its rows kept then are in the pack, not resent
    const was = app.sweep.runs.find(r => r.id === app.state.run);
    const gen = was ? was.meta.generation : null;
    installSweep(body.pack, true);
    const now = was && app.sweep.runs.find(r => r.id === was.id);
    if (now && now.meta.generation !== gen && !app.stayOn) app.stayOn = `${was.id}.g${gen}`;
    settleStay();
    startStream(cfg, body.cursor);
    note(null, "Reconnected.", "Rows read again from the server.");
  } catch (err) {
    console.error(err);
    setTimeout(() => reconnect(cfg), 5000);
  }
}

function applyMessage(msg) {
  const sw = app.sweep;
  if (msg.type === "run") {
    const meta = msg.run;
    const old = sw.runs.find(r => r.id === meta.id);
    if (old && msg.known) {
      // the run started over: its rows so far came just before, kept as an
      // archived run, which the reader is on if they were on this run
      const fresh = new Dataset(meta);
      sw.runs[sw.runs.indexOf(old)] = fresh;
      app.lastBest.delete(meta.id);
      const stayed = sw.runs.some(r => r.id === app.state.run && r.meta.archivedFrom === meta.id);
      note("warn", `${meta.label} started over.`,
        stayed ? "The page stays on the rows it had, kept as an archived run. Follow the run from its first new row:" : "Its rows so far are kept as an archived run.",
        () => setState({ run: meta.id, sel: null, context: [], pocket: [], edge: null, clusters: [], clusterK: null }));
    } else if (!old) {
      sw.runs.push(new Dataset(meta));
      // the run on screen started over: the reader stays on the rows they
      // had, once they are here (they come in the next message, and a
      // draw can fall between the two)
      if (meta.archivedFrom && meta.archivedFrom === app.state.run) app.stayOn = meta.id;
    } else {
      old.meta = meta;
    }
  } else if (msg.type === "rows") {
    const ds = sw.runs.find(r => r.id === msg.run);
    if (!ds) { console.error("rows for an unknown run", msg.run); return; }
    ds.append(msg.lo, msg.hi, msg.columns, msg.arrivals);
    ds.meta = msg.meta;
    if (app.stayOn === ds.id) settleStay();
  } else if (msg.type === "rounds") {
    const ds = sw.runs.find(r => r.id === msg.run);
    if (!ds) { console.error("rounds for an unknown run", msg.run); return; }
    ds.addRounds(msg.entries, msg.reset);
  } else if (msg.type === "log") {
    mergeLog(sw, msg.logId, msg.log);
  } else if (msg.type === "meta") {
    sw.meta = { ...sw.meta, ...msg.meta };
  }
  scheduleUpdate();
}

// The reader stays on the rows kept when the run on screen started over,
// once they are here; a run the reader chose in the meantime stands.
function settleStay() {
  const id = app.stayOn;
  const ds = id && app.sweep.runs.find(r => r.id === id);
  if (!ds || !ds.n) return;
  app.stayOn = null;
  if (app.state.run !== ds.meta.archivedFrom) return;
  app.state = { ...app.state, run: id };
  try { history.replaceState(null, "", "#" + encodeState(app.state)); } catch (err) { /* host refused */ }
}

function mergeLog(sw, logId, delta) {
  const cur = sw.logs[logId];
  if (!cur) { sw.logs[logId] = { ...delta, segments: delta.segments.map(x => ({ ...x, progress: x.progress.slice() })) }; return; }
  const prevCrashes = cur.crashes.length;
  const segs = new Map(cur.segments.map(x => [x.index, x]));
  for (const seg of delta.segments) {
    const old = segs.get(seg.index);
    if (!old) { cur.segments.push({ ...seg, progress: seg.progress.slice() }); continue; }
    old.progress.length = seg.progressBase || 0;
    old.progress.push(...seg.progress);
    Object.assign(old, { ...seg, progress: old.progress });
  }
  cur.lines = delta.lines;
  cur.warnings = delta.warnings;
  cur.crashes = delta.crashes;
  cur.other = delta.other;
  cur.openTraceback = delta.openTraceback;
  if (delta.crashes.length > prevCrashes) {
    const c = delta.crashes[delta.crashes.length - 1];
    note("crit", "A run crashed.", `${c.exception || "An exception"}${c.where ? ` at ${c.where.path.split("/").pop()}:${c.where.line}` : ""}.`,
      () => setState({ view: "run" }));
  }
}

function installSweep(pack, keepState) {
  const { meta, runs, logs } = decodePack(pack);
  app.sweep = { meta, runs, logs };
  app.cache = {};
  if (!keepState) {
    const fromUrl = decodeState(location.hash);
    const st = fromUrl || { ...DEFAULT_STATE };
    if (!st.run || !runs.some(r => r.id === st.run)) st.run = (runs.find(r => r.id === "r0") || runs.find(r => r.meta.live) || runs[runs.length - 1]).id;
    app.state = st;
  }
}

// ---------------------------------------------------------------------------
// The model the views read

const NO_NEEDLE = { id: "none", label: "Needle", kind: "cont", unit: "", better: 0, digits: 2, values: new Float64Array(0) };

function currentRun() {
  return app.sweep.runs.find(r => r.id === app.state.run) || app.sweep.runs[0];
}

export function model() {
  const ds = currentRun();
  const c = app.cache;
  if (c.ds !== ds || c.version !== ds.version) {
    c.ds = ds; c.version = ds.version;
    // a Limen run says what its columns are; other runs are matched to a
    // known profile or inferred
    const exp = ds.meta.experiment;
    c.schema = buildSchema(ds, exp && exp.kind === "limen" ? { profile: limenProfile(exp) } : {});
    c.key = null; c.indep = null;  // background results (mods, pairs) refresh on their own
    c.gatedKey = null;
  }
  const st = app.state;
  // the gates set here, on the schema: gates, and needles of their own
  const gatesKey = JSON.stringify(st.gates);
  if (c.gatedKey !== gatesKey) { c.gated = applyGates(c.schema, st.gates); c.gatedKey = gatesKey; }
  const schema = c.gated;
  let targetId = st.target && schema.targetById.has(st.target) ? st.target : schema.defaultTarget;
  // a run with no row yet (one that has just started over) has no needle
  // to measure: a stand-in with no values, so every view can say so
  const target = schema.targetById.get(targetId) || NO_NEEDLE;
  const edge = st.edge === null ? ds.n : Math.min(st.edge, ds.n);
  const ctx = (st.context || []).filter(cnd => schema.dimById.has(cnd.dim));
  // a gate's needle changes with its need: its revision is part of the question
  const rev = target.rev || "";
  const key = `${ds.id}|${ds.version}|${targetId}|${rev}|${edge}|${JSON.stringify(ctx)}`;
  // the same question, whatever rows have arrived since
  c.akey = `${ds.id}|${ds.meta.generation}|${targetId}|${rev}|${st.edge === null ? "latest" : edge}|${JSON.stringify(ctx)}`;
  // the same rows, whatever the needle (the clusters do not read it)
  c.rkey = `${ds.id}|${ds.meta.generation}|${st.edge === null ? "latest" : edge}|${JSON.stringify(ctx)}`;
  if (c.key !== key) {
    c.key = key;
    c.rows = rowsIn(schema, ctx, edge);
    c.allRows = rowsIn(schema, [], edge);
    c.base = summarize(target, c.rows);
    const dims = boardDims(schema);
    c.board = board(schema, target, c.rows, dims);
    c.order = boardOrder(c.board.effects);
    c.record = null;
  }
  return { sweep: app.sweep, ds, schema, target, edge, rows: c.rows, allRows: c.allRows, base: c.base,
    board: c.board, order: c.order, state: st, context: ctx, cache: c };
}

// ---------------------------------------------------------------------------
// Rendering

// Live redraws: at most once a second, and never more than a fifth of the
// time (a board over a million rows takes long enough to matter).
let updateQueued = false, lastLiveRender = 0, lastCost = 0, heldBy = null;
function scheduleUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  const gap = Math.max(1000, 5 * lastCost);
  const wait = Math.max(0, gap - (Date.now() - lastLiveRender));
  setTimeout(() => {
    updateQueued = false;
    // a menu in the view (the gate maker's needle) would close under a
    // redraw: arriving rows wait until it lets go of the focus
    const a = document.activeElement;
    if (a && a.tagName === "SELECT" && app.els.view.contains(a)) {
      if (heldBy !== a) { heldBy = a; a.addEventListener("blur", () => { heldBy = null; scheduleUpdate(); }, { once: true }); }
      return;
    }
    lastLiveRender = Date.now();
    const t0 = performance.now();
    notifyRecords();
    update();
    lastCost = performance.now() - t0;
  }, wait);
}

function update() {
  if (!app.sweep) return;
  hideTip();
  const m = model();
  updateTop(m);
  updateRail(m);
  const view = app.els.view;
  const sameView = app.lastView === app.state.view;
  app.lastView = app.state.view;
  const render = { board: renderBoard, pocket: renderPocket, pairs: renderPairs, features: renderFeatures,
    trials: renderTrials, gates: renderGates, run: renderRun }[app.state.view] || renderBoard;
  redraw(view, sameView, () => {
    try {
      if (!m.rows.length && app.state.view !== "run") renderNoRows(view, m);
      else {
        // every view ends with the experiment's manifest, narrowed to what
        // it looks at: the context, unless the view says otherwise
        const drawn = render(view, m, ACTIONS);
        const spec = (drawn && drawn.manifest) || { conditions: m.context, scope: "the context",
          figure: m.context.length ? figureLine(m, m.base.n, m.base) : null };
        const manifest = manifestSection(m, spec.conditions, spec.scope, spec.figure);
        if (manifest) view.append(manifest);
      }
    } catch (err) {
      console.error(err);
      view.append(h("div", { class: "empty" }, h("b", { text: "This view failed to draw. " }), String(err && err.message || err)));
    }
  });
  // the inspector keeps its place while the same parameter or row stays
  // open in it (choosing one of its values included)
  const sel = app.state.sel;
  const selKey = !sel ? null : sel.kind === "row" ? `row:${sel.i}` : `dim:${sel.kind === "dim" ? sel.id : sel.dim}`;
  redraw(app.els.insp, selKey !== null && app.lastSel === selKey, () => renderInspector(app.els.insp, m, ACTIONS));
  app.lastSel = selKey;
  syncInfo();
  app.els.root.dataset.insp = app.state.sel ? "open" : "closed";
}

// Redraw a container, keeping what the reader is doing in it while it shows
// the same thing: its scroll and its inner lists' and tables' ([data-scroll],
// both ways), and the focused control ([data-focus]) with its caret.
function redraw(el, same, draw) {
  const scroll = same ? el.scrollTop : 0;
  const inner = same ? new Map([...el.querySelectorAll("[data-scroll]")].map(x => [x.dataset.scroll, [x.scrollTop, x.scrollLeft]])) : new Map();
  const active = document.activeElement;
  const focusId = same && active && el.contains(active) && active.dataset ? active.dataset.focus : null;
  const caret = focusId && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  clear(el);
  draw();
  el.scrollTop = scroll;
  for (const x of el.querySelectorAll("[data-scroll]")) if (inner.has(x.dataset.scroll)) [x.scrollTop, x.scrollLeft] = inner.get(x.dataset.scroll);
  if (!focusId) return;
  const x = el.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
  if (!x) return;
  x.focus({ preventScroll: true });
  if (caret && typeof x.setSelectionRange === "function") x.setSelectionRange(caret[0], caret[1]);
}

// Nothing to measure: say why, and how to get rows back.
function renderNoRows(view, m) {
  const why = m.edge === 0 ? "The replay edge is at the first row, so no row has arrived yet."
    : m.edge < m.ds.n && m.allRows.length ? "No row up to the replay edge holds every condition of the context."
      : m.context.length ? "No row holds every condition of the context." : "This run has no rows yet.";
  view.append(h("div", { class: "empty" },
    h("p", null, h("b", { text: "No rows in view. " }), why),
    h("div", { class: "actions", style: { justifyContent: "center" } },
      m.edge < m.ds.n ? h("button", { class: "btn", onclick: () => { stopPlay(); setState({ edge: null }, { replace: true }); } }, "Show every row ", h("kbd", { text: "End" })) : null,
      m.context.length ? h("button", { class: "btn", onclick: () => setState({ context: [] }) }, "Clear the context ", h("kbd", { text: "Shift C" })) : null)));
}

// The top bar is built once. An update changes only what has changed, so
// a control under the reader's hand (an open select, a button being
// pressed) survives rows arriving and the clock ticking.
function buildTop() {
  const t = app.els.top;
  clear(t);
  const els = {};
  els.name = h("span", { class: "sweep-name" });
  els.runSel = h("select", { class: "run-pick", id: "run-pick", "aria-label": "Run" });
  els.runSel.addEventListener("change", () => setState({ run: els.runSel.value, sel: null, context: [], pocket: [], edge: null, clusters: [], clusterK: null }));
  els.runOne = h("span", { class: "run-one" });
  els.statusLabel = h("b");
  els.statusDetail = h("span", { class: "detail" });
  els.pill = h("span", { class: "status" }, els.statusLabel, els.statusDetail);
  tip(els.pill, () => (app.top.status ? app.top.status.tip : null));
  els.progress = h("span", { class: "progress-text num" });
  t.append(h("div", { class: "sweep" }, h("div", { class: "sweep-line" }, els.name, els.runSel, els.runOne, els.pill), els.progress));
  els.tsel = h("select", { id: "target-pick", "aria-label": "Needle" });
  els.tsel.addEventListener("change", () => setState({ target: els.tsel.value }));
  const picker = h("label", { class: "picker" }, h("span", { class: "label", text: "Needle" }), els.tsel);
  tip(picker, () => {
    const tg = app.top.target;
    if (!tg) return null;
    return h("div", null, h("b", { text: tg.label }),
      h("div", { text: tg.definition || `${tg.unit || "value"}; ${tg.better > 0 ? "higher is better" : tg.better < 0 ? "lower is better" : "no better direction"}` }),
      h("div", { class: "k" }, "Key ", h("kbd", { text: "T" })));
  });
  els.chips = h("div", { class: "chips" });
  t.append(h("div", { class: "top-mid" }, picker, els.chips));
  els.play = btnIcon("play", "Replay the rows as they arrived", "Space", togglePlay);
  t.append(h("div", { class: "top-right" },
    h("div", { class: "group", role: "group", "aria-label": "Replay" },
      btnIcon("start", "Start of the run", "Home", () => setState({ edge: 0 }, { replace: true })),
      btnIcon("back", "Step back", "[", () => stepEdge(-1)),
      els.play,
      btnIcon("fwd", "Step forward", "]", () => stepEdge(1)),
      btnIcon("end", "Latest row (follow live)", "End", () => { stopPlay(); setState({ edge: null }, { replace: true }); })),
    h("div", { class: "group", role: "group", "aria-label": "Help" },
      btnIcon("sun", "Light or dark", "D", toggleTheme),
      btnIcon("keys", "Keys", "?", () => openReference("keys")),
      btnIcon("info", "System reference", "I", () => openReference()))));
  app.top = { els, runsKey: null, targetsKey: null, contextKey: null, count: null, status: null, target: null, playing: false };
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function updateTop(m0) {
  if (!app.sweep) return;
  const m = m0 || model();
  if (!app.top) buildTop();
  const top = app.top, els = top.els;
  const ds = m.ds, runs = app.sweep.runs;
  setText(els.name, app.sweep.meta.name || "sweep");
  // runs: their options change only when a run is added or renamed; a
  // sweep of one run names it in the same place, unless the sweep's name
  // already says it
  const runsKey = runs.map(r => `${r.id}\t${runName(r.meta)}`).join("\n");
  if (runsKey !== top.runsKey) {
    top.runsKey = runsKey;
    els.runSel.replaceChildren(...runs.map(r => h("option", { value: r.id, text: runName(r.meta) })));
  }
  els.runSel.hidden = runs.length < 2;
  els.runOne.hidden = runs.length > 1 || ds.meta.label === app.sweep.meta.name;
  setText(els.runOne, runName(ds.meta));
  if (els.runSel.value !== ds.id) els.runSel.value = ds.id;
  const st = statusOf(m);
  top.status = st;
  if (els.pill.dataset.kind !== st.kind) els.pill.dataset.kind = st.kind;
  setText(els.statusLabel, st.label);
  setText(els.statusDetail, st.detail ? `· ${st.detail}` : "");
  els.statusDetail.hidden = !st.detail;
  setText(els.progress, runHealth(m).line);
  // a run being written going quiet, or getting rows again, is news
  const w = app.watch;
  if (w && w.run === ds.id && w.kind !== st.kind && (st.kind === "quiet" || (w.kind === "quiet" && st.kind === "live"))) {
    note(st.kind === "quiet" ? "warn" : null, `${runName(ds.meta)} ${st.kind === "quiet" ? "is quiet." : "has rows again."}`,
      st.kind === "quiet" ? "No row has arrived for ten minutes." : "Rows are arriving again.");
  }
  app.watch = { run: ds.id, kind: st.kind };
  syncTab(st);
  // needles: their options change only when the schema's targets do
  const targetsKey = m.schema.targets.map(x => `${x.id}\t${x.label}\t${x.diagnostic ? 1 : 0}`).join("\n");
  if (targetsKey !== top.targetsKey) {
    top.targetsKey = targetsKey;
    const groups = [["Outcome", x => !x.diagnostic && !x.gate], ["Gates passing", x => !x.diagnostic && x.gate], ["Fit diagnostics", x => x.diagnostic]];
    els.tsel.replaceChildren(...groups.map(([label, keep]) => [label, m.schema.targets.filter(keep)]).filter(([, list]) => list.length)
      .map(([label, list]) => h("optgroup", { label }, list.map(x => h("option", { value: x.id, text: x.label })))));
  }
  if (els.tsel.value !== m.target.id) els.tsel.value = m.target.id;
  top.target = m.target;
  // the context: chips change with it; the row count in place
  const contextKey = `${ds.id}\n${JSON.stringify(m.context)}`;
  if (contextKey !== top.contextKey) {
    top.contextKey = contextKey;
    top.count = null;
    els.chips.replaceChildren();
    for (const cnd of m.context) {
      const d = m.schema.dimById.get(cnd.dim);
      const labels = cnd.keys.map(k => (d.levels.find(l => l.key === k) || { label: k }).label);
      els.chips.append(h("span", { class: "chip" },
        h("span", { class: "mono", text: `${d.label} = ${labels.join(" or ")}` }),
        h("button", { "aria-label": `Remove ${d.label} from the context`, onclick: () => setState({ context: app.state.context.filter(x => x.dim !== cnd.dim) }), text: "×" })));
    }
    if (!m.context.length) els.chips.append(h("span", { class: "chip ghost", text: "All rows" }));
    else { top.count = h("span", { class: "muted num" }); els.chips.append(top.count); }
  }
  if (top.count) setText(top.count, `${fmtInt(m.rows.length)} of ${fmtInt(m.allRows.length)} rows`);
  // play turns to pause while a replay runs
  const playing = !!app.playback;
  if (playing !== top.playing) {
    top.playing = playing;
    els.play.replaceChildren(icon(playing ? "pause" : "play"));
    els.play.setAttribute("aria-label", playing ? "Pause the replay" : "Replay the rows as they arrived");
    if (playing) els.play.setAttribute("aria-pressed", "true"); else els.play.removeAttribute("aria-pressed");
  }
}

// The tab: the sweep's name and the view, or the run's trouble in place of
// the view, so a row of tabs says which sweep is which and which needs the
// reader; the icon carries a dot for a run live, quiet or down.
const TAB_INK = "#6a86bd";
const TAB_DOT = { live: "#6f9a52", quiet: "#d0902e", down: "#d24c5e" };
function syncTab(st) {
  const v = VIEWS.find(x => x.id === app.state.view) || VIEWS[0];
  const trouble = st.kind === "down" || st.kind === "quiet";
  const title = `${app.sweep.meta.name || "sweep"} · ${trouble ? st.label : v.label} — Grid`;
  if (document.title !== title) document.title = title;
  const link = document.getElementById("favicon");
  const href = tabIcon(TAB_DOT[st.kind]);
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
}

// Grid's mark, with a dot in place of its top right square
function tabIcon(dot) {
  const k = TAB_INK;
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="1.2" fill="${k}"/>`
    + `<rect x="1.5" y="9.5" width="5" height="5" rx="1" fill="none" stroke="${k}"/><rect x="9" y="9" width="6" height="6" rx="1.2" fill="${k}"/>`
    + (dot ? `<circle cx="12" cy="4" r="3.5" fill="${dot}"/>` : `<rect x="9.5" y="1.5" width="5" height="5" rx="1" fill="none" stroke="${k}"/>`) + "</svg>");
}

function btnIcon(name, label, key, fn) {
  const b = h("button", { class: "icon-btn", "aria-label": label, onclick: fn }, icon(name));
  tip(b, () => h("div", null, h("b", { text: b.getAttribute("aria-label") }), key ? h("span", { class: "k" }, "  ", h("kbd", { text: key })) : null));
  return b;
}

// The pill says the run's own state (status.js): its replay edge, the link
// to the server, and what its rows and its log say about it.
function statusOf(m) {
  const ds = m.ds, log = runLog(m);
  return runStatus({ meta: ds.meta, n: ds.n, edge: app.state.edge, mode: app.config.mode, connected: !!(app.live && app.live.connected),
    playing: !!app.playback, seg: segmentOf(m), writing: !!(log && log.openTraceback), lastRow: ds.n ? ds.arrivals[ds.n - 1] : NaN,
    since: rowsSince(Number.isFinite(app.sweep.meta.started) ? app.sweep.meta.started : app.started / 1000, ds.meta), now: Date.now() / 1000 });
}

function updateRail(m) {
  const rail = app.els.rail;
  clear(rail);
  const health = runHealth(m);
  VIEWS.forEach((v, i) => {
    if (i === 6) rail.append(h("div", { class: "sep" }));
    const b = h("button", { "aria-label": v.label, "aria-current": app.state.view === v.id ? "page" : null,
      onclick: () => setState({ view: v.id }) }, icon(v.icon), h("span", { text: v.label }));
    if (v.id === "run" && health.issues) b.append(h("span", { class: "badge", text: String(health.issues) }));
    tip(b, () => h("div", null, h("b", { text: v.title }), h("span", { class: "k" }, "  ", h("kbd", { text: v.key }))));
    rail.append(b);
  });
}

// ---------------------------------------------------------------------------
// Replay

function stepEdge(dir) {
  const ds = currentRun();
  const cur = app.state.edge === null ? ds.n : app.state.edge;
  const step = Math.max(1, Math.round(ds.n / 100));
  const next = Math.max(0, Math.min(ds.n, cur + dir * step));
  setState({ edge: next >= ds.n ? null : next }, { replace: true });
}

function togglePlay() {
  if (app.playback) { stopPlay(); updateTop(); return; }
  const ds = currentRun();
  if (app.state.edge === null || app.state.edge >= ds.n) app.state.edge = Math.floor(ds.n * 0.5);
  startPlay();
}

function startPlay(rate) {
  const ds = currentRun();
  // pace: about 40 seconds for the remaining rows, at least 20 rows a second
  const remaining = ds.n - (app.state.edge ?? ds.n);
  const perSec = rate || Math.max(20, Math.round(remaining / 40));
  let last = performance.now(), carry = 0;
  const tick = (now) => {
    if (!app.playback) return;
    carry += (now - last) / 1000 * perSec;
    last = now;
    const add = Math.floor(carry);
    if (add > 0) {
      carry -= add;
      const next = Math.min(ds.n, (app.state.edge ?? ds.n) + add);
      if (next >= ds.n) { stopPlay(); setState({ edge: null }, { replace: true }); toast(h("span", null, h("b", { text: "Replay done. " }), "All rows are in.")); return; }
      app.state = { ...app.state, edge: next };
      try { history.replaceState(null, "", "#" + encodeState(app.state)); } catch (err) { /* host refused */ }
      scheduleUpdate();
    }
    app.playback.raf = requestAnimationFrame(tick);
  };
  app.playback = { perSec, raf: requestAnimationFrame(tick) };
  updateTop();
}

function stopPlay() {
  if (app.playback) cancelAnimationFrame(app.playback.raf);
  app.playback = null;
}

// New records as rows arrive (live or replay), once a run has rows enough
// to rank (its first rows each set one), one toast at a time.
function notifyRecords() {
  if (!app.sweep) return;
  const m = model();
  if (!m.schema.objective) return;
  const top = objectiveTop(m, m.allRows, 1)[0];
  const prev = app.lastBest.get(m.ds.id);
  app.lastBest.set(m.ds.id, top);
  if (prev === undefined || top === undefined || top === prev) return;
  if (top < prev && app.state.edge === null && app.config.mode !== "live") return;
  if (m.allRows.length < MIN_N) return;
  const run = m.ds.id, gen = m.ds.meta.generation;
  note("good", "New best row.", `${objectiveKeys(m).map(({ t }) => `${t.label} ${fmtRowValue(t, t.values[top])}`).join(" · ")} (row ${fmtInt(top)})`,
    () => openRow(run, gen, top), "best");
}

// A row a toast or the list of what happened names: in the run it was
// found in, even after the reader moved to another run, or after that run
// started over (its rows are then its archive's).
function openRow(run, gen, i) {
  const now = app.sweep.runs.find(r => r.id === run);
  const id = now && now.meta.generation === gen ? run : `${run}.g${gen}`;
  if (!app.sweep.runs.some(r => r.id === id)) return;
  if (id === app.state.run) setState({ view: "trials", sel: { kind: "row", i } });
  else setState({ run: id, view: "trials", sel: { kind: "row", i }, context: [], pocket: [], edge: null, clusters: [], clusterK: null });
}

// ---------------------------------------------------------------------------
// Toasts, theme, reference, keys

// A toast says its kind (crit, warn, good) at its edge; one that opens
// something ends in an arrow; one told once at a time (`one`) replaces the
// one before it.
export function toast(content, kind, onClick, one) {
  if (one) for (const x of app.els.toasts.querySelectorAll(`[data-one="${one}"]`)) x.remove();
  const el = h("div", { class: "toast" + (kind ? " " + kind : "") + (onClick ? " go" : ""), role: "status", dataset: one ? { one } : null },
    content, onClick ? h("span", { class: "go-k", "aria-hidden": "true", text: " →" }) : null);
  if (onClick) el.addEventListener("click", () => { onClick(); el.remove(); });
  app.els.toasts.append(el);
  while (app.els.toasts.children.length > 3) app.els.toasts.firstChild.remove();
  setTimeout(() => el.remove(), 7000);
}

// What happened while the page was open: said in a toast, and kept after
// the toast goes, newest first (the Run view lists them).
function note(kind, title, text, go, one) {
  app.events.unshift({ at: Date.now() / 1000, kind, title, text, go });
  if (app.events.length > 100) app.events.length = 100;
  toast(h("span", null, h("b", { text: `${title} ` }), text), kind, go, one);
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("grid-theme", root.dataset.theme); } catch (err) { /* storage refused */ }
}

function openReference(topic) {
  let pane = document.getElementById("reference");
  if (!pane) {
    pane = h("aside", { id: "reference", class: "reference", "aria-label": "System reference", tabindex: "-1" });
    app.els.root.append(pane);
  }
  pane.hidden = false;
  renderReference(pane, topic, () => { pane.hidden = true; });
  pane.focus();
  if (topic) { const t = pane.querySelector(`#ref-${topic}`); if (t) t.scrollIntoView(); }
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const v = VIEWS.find(x => x.key === e.key);
  if (v) { setState({ view: v.id }); e.preventDefault(); return; }
  switch (e.key) {
    case "Escape": {
      const ref = document.getElementById("reference");
      if (ref && !ref.hidden) { ref.hidden = true; return; }
      if (app.state.sel) { setState({ sel: null }); return; }
      return;
    }
    case "t": case "T": { const el = document.getElementById("target-pick"); if (el) el.focus(); e.preventDefault(); return; }
    case "/": { const el = document.querySelector("[data-search]"); if (el) { el.focus(); e.preventDefault(); } return; }
    case " ": togglePlay(); e.preventDefault(); return;
    case "[": stepEdge(-1); return;
    case "]": stepEdge(1); return;
    case "Home": setState({ edge: 0 }, { replace: true }); return;
    case "End": stopPlay(); setState({ edge: null }, { replace: true }); return;
    case "?": openReference("keys"); return;
    case "i": case "I": openReference(); return;
    case "d": case "D": toggleTheme(); return;
    case "c": ACTIONS.contextFromSelection(); return;
    case "C": setState({ context: [] }); return;
    case "p": case "P": ACTIONS.pocketFromSelection(); return;
    default:
  }
}

// What views may ask the app to do.
export const ACTIONS = {
  set: setState,
  select(sel) { setState({ sel }); },
  addContext(dim, key) {
    const ctx = (app.state.context || []).filter(c => c.dim !== dim);
    setState({ context: [...ctx, { dim, keys: [key] }] });
  },
  addPocket(dim, key) {
    const p = (app.state.pocket || []).slice();
    const i = p.findIndex(c => c.dim === dim);
    if (i >= 0) { if (!p[i].keys.includes(key)) p[i] = { dim, keys: [...p[i].keys, key] }; }
    else p.push({ dim, keys: [key] });
    setState({ pocket: p });
    // from another view, say where it went; in the pocket it is in sight
    if (app.state.view !== "pocket") toast(h("span", null, h("b", { text: "Added to the pocket. " }), "Open it with ", h("kbd", { text: "2" }), "."), null, () => setState({ view: "pocket" }));
  },
  contextFromSelection() {
    const sel = app.state.sel;
    if (sel && sel.kind === "level") ACTIONS.addContext(sel.dim, sel.key);
  },
  pocketFromSelection() {
    const sel = app.state.sel;
    if (sel && sel.kind === "level") ACTIONS.addPocket(sel.dim, sel.key);
  },
  openReference,
  toast,
  events: () => app.events,
  opened: () => app.started / 1000,
  rerender: () => update(),
  isLive: () => app.config.mode === "live",
  rowUrl: () => (app.config.mode === "live" ? app.config.row : null),
};

// ---------------------------------------------------------------------------
// Start

function buildFrame() {
  const root = document.getElementById("app");
  const top = document.getElementById("top");
  const shell = document.getElementById("shell");
  clear(shell);
  const rail = h("nav", { class: "rail", "aria-label": "Views" });
  const view = h("main", { class: "view", id: "view", tabindex: "-1" });
  const insp = h("aside", { class: "inspector", id: "inspector", "aria-label": "Inspector" });
  shell.append(rail, view, insp);
  app.els = { root, top, rail, view, insp, toasts: document.getElementById("toasts") };
  installTips(root, document.getElementById("tip"));
}

function fail(err) {
  console.error(err);
  const root = document.getElementById("app");
  root.dataset.state = "error";
  const note = document.getElementById("loading-note");
  if (note) note.textContent = `The sweep could not be read: ${err && err.message ? err.message : err}`;
}

// Load timings, for the performance checks (tests read them).
const TIMINGS = {};
function mark(name) { TIMINGS[name] = Math.round(performance.now()); }
window.__gridTimings = TIMINGS;

async function start() {
  mark("start");
  try {
    const theme = (() => { try { return localStorage.getItem("grid-theme"); } catch (err) { return null; } })();
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    app.config = JSON.parse(document.getElementById("grid-config").textContent || "{}");
    let pack = null, cursor = null;
    if (app.config.mode === "live") {
      const body = await loadLive(app.config);
      pack = body.pack; cursor = body.cursor;
    } else {
      pack = await loadEmbedded();
    }
    if (!pack) throw new Error("this page holds no sweep; serve it with python3 -m grid serve");
    mark("loaded");
    buildFrame();
    installSweep(pack, false);
    mark("decoded");
    document.getElementById("app").dataset.state = "ready";
    addEventListener("keydown", onKey);
    addEventListener("popstate", () => { const st = decodeState(location.hash); if (st) { app.state = st; update(); } });
    update();
    mark("drawn");
    notifyRecords();
    if (cursor) startStream(app.config, cursor);
    if (app.config.mode === "demo" && app.config.autoplay) {
      const ds = currentRun();
      if (app.state.edge === null) { app.state = { ...app.state, edge: Math.floor(ds.n * app.config.autoplay) }; update(); }
      startPlay();
    }
    setInterval(() => updateTop(), 5000);
  } catch (err) {
    fail(err);
  }
}

start();
