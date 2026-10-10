// Experiment: make and run a Limen experiment, in the Limen project the
// server serves (serve --project). The project's experiments, each a
// working manifest in manifests/; the chosen one's manifest in an editor
// that limen validate checks as you type, its problems on their lines,
// the search space it draws from, and its diff against the manifest its
// last run started from; a new experiment from one of Limen's templates,
// from the manifest of the run in view, or from what a view narrowed that
// manifest to; and its runs: rounds, shards side by side and what they
// record, with stop and resume. A run opens in the other views once each
// of its shards has written a round.
//
// The project is read every two seconds while the view shows. The view is
// kept, not drawn again: each part is put back only when what it shows
// has changed, and the parts typed in (the manifest, the run's settings,
// the new experiment) are made once and painted in place, so the caret,
// the undo and an open menu stay.

import { h, tip, keyTip, fmtInt, fmtPct, fmtAgo, fmtClock, fmtStamp, clear, icon, syncInfo } from "./ui.js";
import { strip, stripCell, about } from "./strip.js";
import { searchSpace, fmtCount } from "./manifest.js";

const POLL_MS = 2000;
const CHECK_MS = 600;
const MAX_ROUNDS = 10000000;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

const lab = {
  A: null, dom: null, timer: null, loading: false, again: false,
  project: null, key: "", error: null,
  chosen: null, drafts: new Map(), forms: new Map(), making: null, busy: null,
  run: null,   // the Limen run in view: its manifest, for a new experiment
};

const say = (err) => String((err && err.message) || err);

// ---------------------------------------------------------------------------
// A manifest's keys, as far as the view reads them: where a dotted path
// (uel.search_strategy.type) is written, as deep as the text goes, and
// its plain value.

function locate(text, path) {
  const keys = String(path).replace(/\[[^\]]*\]/g, "").split(".").filter(Boolean);
  const lines = text.split("\n");
  let from = 0, parent = -1, found = null, depth = 0;
  for (const key of keys) {
    let own = -1, hit = null;
    for (let i = from; i < lines.length; i++) {
      const t = lines[i].trimStart();
      if (!t || t.startsWith("#")) continue;
      const ind = lines[i].length - t.length;
      if (ind <= parent) break;
      if (own < 0) own = ind;
      if (ind !== own) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/.exec(t);
      if (m && m[1] === key) { hit = { line: i + 1, rest: m[2] || "" }; from = i + 1; parent = ind; break; }
    }
    if (!hit) break;
    found = hit;
    depth++;
  }
  return { found, whole: depth === keys.length && keys.length > 0 };
}

// The line a problem's path is written on (1-based), or the line of as
// much of the path as is written; null when none of it is.
export function lineOf(text, path) {
  const { found } = locate(text, path);
  return found ? found.line : null;
}

// A plain value written at a dotted path, as text (quotes and comment
// taken off), or null.
export function valueOf(text, path) {
  const { found, whole } = locate(text, path);
  if (!whole) return null;
  let v = found.rest;
  const cut = v.search(/(^|\s)#/);
  if (cut >= 0) v = v.slice(0, cut);
  v = v.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
  return v === "" ? null : v;
}

function nPerm(text) {
  const n = Number(valueOf(text, "uel.n_permutations"));
  return Number.isInteger(n) && n >= 1 && n <= MAX_ROUNDS ? n : null;
}

// ---------------------------------------------------------------------------
// The server

async function get(url) {
  const res = await fetch(url, { cache: "no-store" });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the server answered ${res.status}`);
  return out;
}

async function post(action, body) {
  const P = lab.A.project;
  const res = await fetch(`${P.url}/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Grid-Token": P.token }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the server answered ${res.status}`);
  return out;
}

async function load() {
  if (!lab.A) return;
  if (lab.loading) { lab.again = true; return; }
  lab.loading = true;
  let changed = false;
  try {
    const state = await get(lab.A.project.url);
    const key = JSON.stringify(state);
    if (key !== lab.key || lab.error) {
      changed = true;
      lab.project = state;
      lab.key = key;
      lab.error = null;
      if (!state.experiments.some(e => e.name === lab.chosen)) lab.chosen = firstChoice(state);
      if (!state.experiments.length && !lab.making) lab.making = fresh(state);
    }
  } catch (err) {
    if (lab.error !== say(err)) { lab.error = say(err); changed = true; }
  } finally {
    lab.loading = false;
  }
  if (changed) draw();
  if (lab.again) { lab.again = false; load(); }
}

// The experiment to show first: of those with a working manifest, the one
// run last.
function firstChoice(state) {
  const at = new Map(state.runs.map(r => [r.id, r.started || 0]));
  const latest = e => Math.max(0, ...e.runs.map(id => at.get(id) || 0));
  const own = state.experiments.filter(e => e.file);
  const pool = own.length ? own : state.experiments;
  return pool.length ? pool.reduce((a, b) => (latest(b) > latest(a) ? b : a)).name : null;
}

function watch() {
  if (lab.timer) return;
  load();
  lab.timer = setInterval(() => {
    if (!lab.A || lab.A.view() !== "experiment") { clearInterval(lab.timer); lab.timer = null; return; }
    load();
  }, POLL_MS);
}

// An action on the server: one at a time, its buttons held meanwhile, a
// failure said in a toast, and the project read again after.
async function act(label, fn, done) {
  if (lab.busy) return;
  lab.busy = label;
  draw();
  try {
    const out = await fn();
    if (done) done(out);
  } catch (err) {
    lab.A.toast(h("span", null, h("b", { text: `${label} failed. ` }), say(err)), "crit");
  } finally {
    lab.busy = null;
    draw();
    await load();
  }
}

// ---------------------------------------------------------------------------
// The view

// What the page redraws the view for: the run in view, the source of a new
// experiment. Everything else the view draws itself.
export function experimentKey(m) {
  const r = runInView(m);
  return r ? `${r.id}|${r.label}` : "";
}

function runInView(m) {
  const exp = m && m.ds.meta.experiment;
  if (!exp || exp.kind !== "limen" || typeof exp.manifestText !== "string") return null;
  return { id: m.ds.id, label: m.ds.meta.label, text: exp.manifestText, name: ((exp.manifest || {}).metadata || {}).name || "experiment" };
}

export function renderExperiment(view, m, A, fresh) {
  lab.A = A;
  lab.run = runInView(m);
  if (fresh || !lab.dom || !view.contains(lab.dom.root)) build(view);
  draw();
  watch();
}

// A new experiment from a view's manifest (New experiment, under it): its
// text as the view narrowed it, with `label` saying what it is, or null
// for the manifest of the run in view as it ran.
export function startFrom(text, label, name) {
  lab.making = { gen: (lab.making ? lab.making.gen : 0) + 1, source: text === null ? "run" : "given",
    given: text === null ? null : { text, label }, name: freeName(name || "experiment"), focus: true };
}

function fresh(state) {
  const t = (state || lab.project || {}).templates || [];
  return { gen: 0, source: t.length ? `t:${t[0].name}` : null, given: null, name: freeName(t.length ? t[0].name : "experiment") };
}

function freeName(base) {
  const taken = new Set(((lab.project && lab.project.experiments) || []).map(e => e.name));
  const name = String(base).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "experiment";
  if (!taken.has(name)) return name;
  const stem = name.replace(/_\d+$/, "");
  let k = 2;
  while (taken.has(`${stem}_${k}`)) k++;
  return `${stem}_${k}`;
}

function build(view) {
  clear(view);
  view.scrollTop = 0;
  const slot = () => h("div", { class: "slot" });
  const dom = { strip: slot(), note: slot(), make: slot(), table: slot(), manifest: slot(), form: slot(), runs: slot() };
  dom.count = h("span", { class: "isl-count num" });
  dom.newBtn = h("button", { class: "btn small", type: "button", "aria-expanded": "false", dataset: { key: "n", focus: "ex-new" },
    onclick: () => { lab.making = lab.making ? null : fresh(); draw(); if (lab.making && lab.making.input) lab.making.input.focus(); } }, "New experiment");
  tip(dom.newBtn, keyTip("Make a new experiment", "N", "From one of Limen's templates, or from the manifest of the run in view; a view's manifest makes one from what it narrowed to (New experiment, under it)."));
  dom.list = h("section", { class: "island", "aria-labelledby": "ex-list" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id: "ex-list", text: "Experiments" }), dom.count, h("span", { class: "ex-tools" }, dom.newBtn)),
    dom.make, dom.table);
  dom.runIsland = h("section", { class: "island", "aria-labelledby": "ex-run" },
    h("header", { class: "isl-head" }, dom.runTitle = h("h2", { class: "isl-title", id: "ex-run", text: "Runs" })), dom.form, dom.runs);
  dom.root = h("div", { class: "ex" }, h("h1", { class: "sr", text: "Experiment" }), dom.strip, dom.note, dom.list, dom.manifest, dom.runIsland);
  view.append(dom.root);
  lab.dom = dom;
}

// A part put back when its key changes, the focus and caret in it kept.
function put(slot, key, make) {
  if (slot.dataset.key === key) return;
  slot.dataset.key = key;
  const a = document.activeElement;
  const focus = a && slot.contains(a) && a.dataset ? a.dataset.focus : null;
  const caret = focus && typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null;
  const node = make();
  if (slot.childNodes.length === 1 && slot.firstChild === node) return;
  slot.replaceChildren(...(node ? [node] : []));
  const x = focus && slot.querySelector(`[data-focus="${CSS.escape(focus)}"]`);
  if (!x) return;
  x.focus({ preventScroll: true });
  if (caret) try { x.setSelectionRange(caret[0], caret[1]); } catch (err) { /* a number field has no caret to set */ }
}

function draw() {
  const dom = lab.dom;
  if (!dom || !lab.A) return;
  const p = lab.project;
  put(dom.strip, p ? stripKey(p) : `wait|${lab.error}`, () => (p ? labStrip(p) : h("div", { class: "empty", role: "status" },
    lab.error ? [h("b", { text: "The project could not be read. " }), lab.error] : h("b", { text: "Reading the project…" }))));
  syncInfo();
  put(dom.note, p && lab.error ? lab.error : "", () => (p && lab.error ? h("div", { class: "empty", role: "status" },
    h("b", { text: "The project could not be read again. " }), `${lab.error}. What shows is as it was last read.`) : null));
  dom.list.hidden = !p;
  dom.runIsland.hidden = true;
  if (!p) { put(dom.manifest, "", () => null); return; }
  dom.count.textContent = `${fmtInt(p.experiments.length)} in ${p.project.name}`;
  dom.newBtn.setAttribute("aria-expanded", lab.making ? "true" : "false");
  const mk = lab.making;
  put(dom.make, mk ? `${mk.gen}|${lab.run ? lab.run.id : ""}|${p.templates.map(t => t.name).join()}` : "", () => (mk ? makeForm(p, mk) : null));
  if (mk) paintMake(mk);
  if (mk && mk.focus && mk.input) { mk.focus = false; mk.input.focus(); mk.input.select(); }
  put(dom.table, tableKey(p), () => experimentsTable(p));
  const e = p.experiments.find(x => x.name === lab.chosen) || null;
  const d = e && e.file ? draftOf(e) : null;
  put(dom.manifest, d ? `${d.name}|${d.phase}|${d.gen}` : "", () => (d ? manifestPart(d) : null));
  if (d) paint(d);
  if (!e) return;
  dom.runIsland.hidden = false;
  dom.runTitle.textContent = e.file ? "Run" : `Runs of ${e.name}`;
  const f = d && d.phase === "ready" ? formOf(p, e) : null;
  put(dom.form, f ? `form|${e.name}` : `none|${e.name}|${!!e.file}`, () => (f ? f.node : e.file ? null
    : h("p", { class: "isl-note", text: `${e.name} has no working manifest in manifests/, only runs. Make one from a run's manifest: Analyze the run, then New experiment under its manifest.` })));
  if (f) paintForm(f);
  put(dom.runs, runsKey(e, p), () => runsTable(p, e));
}

// ---------------------------------------------------------------------------
// The project in figures

function running(p) {
  const runs = p.runs.filter(r => r.state === "running");
  return { runs: runs.length, shards: runs.reduce((n, r) => n + r.shards.filter(s => s.state === "running").length, 0) };
}

function stripKey(p) {
  return JSON.stringify([p.project, p.limen, p.cores, p.experiments.length, p.runs.length, running(p)]);
}

function labStrip(p) {
  const now = running(p);
  return strip("The project in figures", [
    stripCell("Project", p.project.name, null, () => h("div", null, h("b", { text: "The Limen project Grid serves" }), h("div", { class: "k mono", text: p.project.root }))),
    stripCell("Limen", p.limen.version, null, () => h("div", null, h("b", { text: "The limen command every experiment runs with" }), h("div", { class: "k mono", text: p.limen.cli }))),
    stripCell("Experiments", fmtInt(p.experiments.length), `${fmtInt(p.runs.length)} run${p.runs.length === 1 ? "" : "s"}`,
      () => h("div", null, h("b", { text: "The project's experiments" }), h("div", { class: "k", text: "Each working manifest in manifests/, with its runs in results/." }))),
    stripCell("Running", fmtInt(now.runs), now.runs ? `${fmtInt(now.shards)} shard${now.shards === 1 ? "" : "s"} on ${fmtInt(p.cores)} cores` : `${fmtInt(p.cores)} cores free`,
      () => h("div", null, h("b", { text: "Runs with a shard running" }), h("div", { class: "k", text: "Each shard is a limen run of its own, side by side with the others, on its share of the cores." }))),
  ], { key: "experiment", label: "About experiments", content: () => about("Experiment",
    "The Limen project Grid serves: each experiment is a working manifest in manifests/, and each of its runs a folder in results/. Grid reaches Limen only through its command line, so what runs here is what limen run runs.",
    "The manifest is checked by limen validate as you type, its problems on their lines, with the size of the search space it draws from. A new experiment starts from one of Limen's templates or from the manifest of the run in view; under any view's manifest, New experiment starts one from that manifest as the view narrowed it, to the pocket or the context.",
    "Run runs the experiment in shards: limen run side by side on copies of the manifest that differ only in their search seed and where they write, each with its share of the rounds and of the cores, recording each round's execution and model outputs unless told not to. The run opens in the other views once each shard has written a round. Stop is Limen's own: the round in hand finishes and a checkpoint is written, from which Resume runs on.") }, null, lab.A);
}

// ---------------------------------------------------------------------------
// The experiments

const STATES = { running: ["Running", "live"], stopping: ["Stopping", "live"], stopped: ["Stopped", "warn"], failed: ["Failed", "crit"],
  finished: ["Finished", ""], incomplete: ["Incomplete", "warn"] };

function stateTag(r) {
  const [text, kind] = STATES[r.stopping && r.state === "running" ? "stopping" : r.state] || [String(r.state), ""];
  return h("span", { class: "tag" + (kind ? ` ${kind}` : ""), text });
}

function runsOf(p, e) {
  return e.runs.map(id => p.runs.find(r => r.id === id)).filter(Boolean);
}

function when(sec) {
  const ago = Date.now() / 1000 - sec;
  if (ago < 86400) return fmtAgo(Math.max(0, ago));
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${fmtClock(sec)}`;
}

function rounds(r) {
  return r.planned ? `${fmtInt(r.rows)} of ${fmtInt(r.planned)}` : fmtInt(r.rows);
}

function tableKey(p) {
  return JSON.stringify([lab.chosen, Math.floor(Date.now() / 60000), p.experiments.map(e => {
    const r = runsOf(p, e)[0];
    return [e.name, e.file, e.runs.length, r ? [r.started, r.rows, r.planned, r.state, r.stopping] : null];
  })]);
}

function experimentsTable(p) {
  if (!p.experiments.length) return h("p", { class: "isl-note", text: "No experiment yet: make the first, from one of Limen's templates." });
  const tbody = h("tbody");
  for (const e of p.experiments) {
    const r = runsOf(p, e)[0] || null;
    const on = e.name === lab.chosen;
    const choose = () => { if (lab.chosen !== e.name) { lab.chosen = e.name; draw(); } };
    tbody.append(h("tr", { class: "clickable" + (on ? " sel" : ""), tabindex: "0", "aria-selected": on ? "true" : "false",
      dataset: { focus: `ex-e-${e.name}`, experiment: e.name }, onclick: choose, onkeydown: (ev) => { if (ev.key === "Enter") choose(); } },
    h("td", { class: "v" }, e.name, e.file ? null : h("span", { class: "muted", text: " · runs only" })),
    h("td", { class: "r num", text: fmtInt(e.runs.length) }),
    h("td", { class: "num", text: r && r.started ? when(r.started) : "–" }),
    h("td", { class: "r num", text: r ? rounds(r) : "–" }),
    h("td", null, r ? stateTag(r) : h("span", { class: "muted", text: "Not run" }))));
  }
  return h("div", { class: "table-wrap" }, h("table", { class: "vals ex-table", "aria-label": "Experiments" },
    h("thead", null, h("tr", null, h("th", { text: "Experiment" }), h("th", { class: "r", text: "Runs" }), h("th", { text: "Last run" }),
      h("th", { class: "r", text: "Rounds" }), h("th", { text: "State" }))), tbody));
}

// A new experiment: its name, and what it starts from.
function makeForm(p, mk) {
  const sources = [];
  if (mk.given) sources.push({ id: "given", label: mk.given.label });
  if (lab.run) sources.push({ id: "run", label: `The manifest of ${lab.run.label}` });
  for (const t of p.templates) sources.push({ id: `t:${t.name}`, label: `Template ${t.name}${t.about ? ` · ${t.about}` : ""}` });
  if (!sources.some(s => s.id === mk.source)) mk.source = sources.length ? sources[0].id : null;
  const name = h("input", { class: "ex-input mono", type: "text", value: mk.name, spellcheck: "false", autocomplete: "off", maxlength: "64",
    "aria-label": "The new experiment's name", dataset: { focus: "ex-new-name" } });
  name.addEventListener("input", () => { mk.name = name.value; paintMake(mk); });
  name.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); make(mk); } });
  const from = h("select", { "aria-label": "What it starts from", dataset: { focus: "ex-new-from" } },
    sources.map(s => h("option", { value: s.id, text: s.label })));
  from.value = mk.source || "";
  from.addEventListener("change", () => { mk.source = from.value; paintMake(mk); });
  mk.go = h("button", { class: "btn primary", type: "button", onclick: () => make(mk) }, "Make it");
  mk.input = name;
  mk.why = h("span", { class: "ex-why" });
  return h("div", { class: "ex-make", role: "group", "aria-label": "A new experiment" },
    h("label", { class: "ex-field" }, h("span", { class: "k", text: "Name" }), name),
    h("label", { class: "ex-field ex-grow" }, h("span", { class: "k", text: "From" }), from),
    h("div", { class: "ex-acts" }, mk.go, h("button", { class: "btn", type: "button", onclick: () => { lab.making = null; draw(); } }, "Cancel")),
    mk.why);
}

function paintMake(mk) {
  if (!mk.go) return;
  const name = mk.name.trim();
  const taken = lab.project && lab.project.experiments.some(e => e.name === name && e.file);
  const why = !name ? "" : !NAME.test(name) ? "A name is letters, digits, _ and -, at most 64, starting with a letter, digit or _."
    : taken ? `${name} is taken.` : !mk.source ? "Nothing to start from: Limen lists no template." : "";
  mk.go.disabled = !!lab.busy || !name || !!why;
  mk.input.setAttribute("aria-invalid", why && name ? "true" : "false");
  mk.why.textContent = why;
}

function make(mk) {
  if (!mk.go || mk.go.disabled) return;
  const body = { name: mk.name.trim() };
  if (mk.source === "given") body.text = mk.given.text;
  else if (mk.source === "run") body.text = lab.run.text;
  else body.template = mk.source.slice(2);
  act("Making the experiment", () => post("create", body), (out) => { lab.making = null; lab.chosen = out.name; });
}

// ---------------------------------------------------------------------------
// The manifest

function draftOf(e) {
  let d = lab.drafts.get(e.name);
  if (!d) {
    d = { name: e.name, file: e.file, phase: "loading", gen: 0, text: "", saved: "", version: null, disk: e.version,
      errors: null, checked: null, timer: 0, island: null, diff: null, why: null };
    lab.drafts.set(e.name, d);
    read(d);
  } else if (d.phase === "ready" && e.version !== d.version && d.text === d.saved && !lab.busy && !d.reading) {
    // changed on disk, and nothing here unsaved: read it again
    read(d);
  }
  d.disk = e.version;
  d.file = e.file;
  return d;
}

function read(d) {
  d.reading = true;
  get(`${lab.A.project.url}/manifest?name=${encodeURIComponent(d.name)}`).then((body) => {
    Object.assign(d, { phase: "ready", gen: d.gen + 1, text: body.text, saved: body.text, version: body.version, disk: body.version,
      island: null, errors: null, checked: null, diff: null, reading: false, gkey: null, pkey: null });
    check(d, 0);
    draw();
  }, (err) => {
    Object.assign(d, { phase: d.phase === "ready" ? "ready" : "failed", why: say(err), reading: false });
    if (d.phase === "ready") lab.A.toast(h("span", null, h("b", { text: `${d.file} could not be read again. ` }), say(err)), "crit");
    draw();
  });
}

// limen validate on the manifest once typing pauses; its answer counts
// while the text is still what it checked.
function check(d, delay) {
  clearTimeout(d.timer);
  d.timer = setTimeout(async () => {
    const text = d.text;
    if (text === d.checked) return;
    let errors;
    try {
      errors = (await post("validate", { text })).errors;
    } catch (err) {
      errors = [{ line: null, path: "", message: `limen validate could not be run: ${say(err)}` }];
    }
    if (d.text !== text) return;
    d.errors = errors.map(x => ({ ...x, line: x.line || (x.path ? lineOf(text, x.path) : null) }));
    d.checked = text;
    paint(d);
  }, delay);
}

function manifestPart(d) {
  if (d.phase === "loading") return h("section", { class: "island" }, h("p", { class: "isl-note", text: `Reading ${d.file}…` }));
  if (d.phase === "failed") return h("section", { class: "island" }, h("p", { class: "isl-note" }, h("b", { text: `${d.file} could not be read. ` }), d.why));
  if (!d.island) d.island = manifestIsland(d);
  return d.island;
}

function manifestIsland(d) {
  const id = `ex-mf-${d.name}`;
  d.status = h("span", { class: "ex-status", role: "status" });
  d.again = h("button", { class: "btn small", type: "button", hidden: true, onclick: () => read(d) }, "Open it again");
  tip(d.again, "The file changed on disk since it was opened here: read it again, leaving the edits made here.");
  d.diffBtn = h("button", { class: "btn small", type: "button", onclick: () => compare(d) }, "Diff with the last run");
  tip(d.diffBtn, "This manifest, as it is here, against the one its last run started from.");
  d.saveBtn = h("button", { class: "btn small", type: "button", onclick: () => save(d) }, "Save");
  tip(d.saveBtn, keyTip("Save it to its file", "⌘ S", "Saving never writes over a file that changed on disk since it was opened here."));
  d.gutter = h("pre", { class: "ed-gutter", "aria-hidden": "true" });
  d.ta = h("textarea", { class: "ed-text", spellcheck: "false", autocapitalize: "off", autocomplete: "off", wrap: "off",
    "aria-label": `The manifest of ${d.name}`, "aria-describedby": `${id}-problems`, dataset: { focus: `ed-${d.name}` } });
  d.ta.value = d.text;
  d.ta.addEventListener("input", () => { d.text = d.ta.value; check(d, CHECK_MS); paint(d); });
  d.ta.addEventListener("scroll", () => { d.gutter.scrollTop = d.ta.scrollTop; });
  d.ta.addEventListener("keydown", (ev) => editorKey(ev, d));
  d.problems = h("ul", { class: "ex-problems", id: `${id}-problems` });
  d.diffSlot = h("div", { class: "slot" });
  return h("section", { class: "island ex-mf", "aria-labelledby": id },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", id }, "Manifest ", h("span", { class: "mf-file mono", text: d.file })),
      d.status, h("span", { class: "ex-tools" }, d.again, d.diffBtn, d.saveBtn)),
    h("div", { class: "ed" }, d.gutter, d.ta), d.problems, d.diffSlot);
}

function editorKey(ev, d) {
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "s") { ev.preventDefault(); save(d); return; }
  if (ev.key !== "Enter" || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey || ev.isComposing) return;
  // a new line keeps its line's indentation, two more under a key that
  // opens a block
  const ta = d.ta;
  const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
  const line = ta.value.slice(start, ta.selectionStart);
  const indent = /^ */.exec(line)[0];
  const opens = !/^\s*#/.test(line) && /^\s*(- )?[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*(#.*)?$/.test(line);
  ev.preventDefault();
  const text = "\n" + indent + (opens ? "  " : "");
  // as typing does, so the browser's undo keeps it
  if (!document.execCommand("insertText", false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input"));
  }
}

// The manifest's marks, status and problems, painted in place.
function paint(d) {
  if (!d.ta) return;
  const current = d.checked === d.text ? d.errors : null;
  const n = d.text.split("\n").length;
  const bad = new Set((current || []).map(x => x.line).filter(Boolean));
  const gkey = `${n}|${[...bad].join(",")}`;
  if (d.gkey !== gkey) {
    d.gkey = gkey;
    d.gutter.replaceChildren(...Array.from({ length: n }, (_, i) => h("span", { class: bad.has(i + 1) ? "bad" : null, text: String(i + 1) })));
    d.gutter.scrollTop = d.ta.scrollTop;
  }
  const space = searchSpace(d.text);
  const unsaved = d.text !== d.saved;
  d.status.replaceChildren(...[
    !current ? h("span", { class: "muted", text: "Checking…" })
      : current.length ? h("span", { class: "sev crit" }, icon("alert"), `${fmtInt(current.length)} problem${current.length === 1 ? "" : "s"}`)
        : h("span", { class: "sev ok" }, icon("check"), "Valid"),
    h("span", { class: "muted num", text: space.params ? `· ${fmtInt(space.params)} parameters, ${fmtCount(space.combinations)} combinations` : "· no parameters in sfd.params" }),
    unsaved ? h("span", { class: "ex-unsaved", text: "· unsaved" }) : null].filter(Boolean));
  d.again.hidden = d.disk === d.version;
  d.saveBtn.disabled = !!lab.busy || !unsaved;
  d.diffBtn.disabled = !!lab.busy;
  const pkey = current ? JSON.stringify(current) : "";
  if (d.pkey !== pkey) {
    d.pkey = pkey;
    d.problems.replaceChildren(...(current || []).map(x => h("li", null,
      x.line ? h("button", { class: "ex-where", type: "button", text: `Line ${x.line}`, onclick: () => goTo(d.ta, x.line) }) : null,
      x.path ? h("span", { class: "mono", text: x.path }) : null,
      h("span", { class: "ex-msg", text: x.message }))));
  }
  if (d.diffNote) d.diffNote.hidden = !d.diff || d.diff.text === d.text;
  const f = lab.forms.get(d.name);
  if (f) paintForm(f);
}

function goTo(ta, line) {
  const lines = ta.value.split("\n");
  let at = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) at += lines[i].length + 1;
  ta.focus();
  ta.setSelectionRange(at, at + (lines[line - 1] || "").length);
  ta.scrollTop = Math.max(0, (line - 4) * (parseFloat(getComputedStyle(ta).lineHeight) || 18));
}

function save(d) {
  if (d.text === d.saved || lab.busy) return;
  const text = d.text;
  act("Saving", () => post("save", { name: d.name, text, version: d.version }), (out) => { d.saved = text; d.version = out.version; d.disk = out.version; });
}

function compare(d) {
  const text = d.text;
  act("Comparing", () => post("diff", { name: d.name, text }), (out) => { d.diff = { ...out, text }; paintDiff(d); });
}

function paintDiff(d) {
  if (!d.diff) { d.diffSlot.replaceChildren(); d.diffNote = null; return; }
  const close = h("button", { class: "icon-btn", type: "button", "aria-label": "Close the diff", onclick: () => { d.diff = null; paintDiff(d); } }, icon("close"));
  d.diffNote = h("span", { class: "note", text: "the manifest has changed since: compare again", hidden: d.diff.text === d.text ? true : null });
  const body = !d.diff.against ? h("p", { class: "isl-note", text: "No run of this experiment kept the manifest it started from." })
    : !d.diff.diff ? h("p", { class: "isl-note", text: "The same as the manifest it started from." }) : diffBlock(d.diff.diff);
  d.diffSlot.replaceChildren(h("div", { class: "isl-part ex-diff-part" },
    h("h3", { class: "part-title" }, h("span", { text: "Against the last run" }), d.diff.against ? h("span", { class: "note mono", text: d.diff.against }) : null,
      d.diffNote, h("span", { class: "ex-tools" }, close)),
    body));
}

function diffBlock(text) {
  const pre = h("pre", { class: "code ex-diff" });
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const kind = /^(\+\+\+|---)/.test(line) ? "hd" : line[0] === "+" ? "add" : line[0] === "-" ? "del" : line.startsWith("@@") ? "at" : null;
    pre.append(h("span", { class: kind ? `df df-${kind}` : "df", text: line }));
  }
  return pre;
}

// ---------------------------------------------------------------------------
// Running it

function formOf(p, e) {
  let f = lab.forms.get(e.name);
  if (!f) {
    const d = lab.drafts.get(e.name);
    f = { name: e.name, cores: p.cores, rounds: nPerm(d.text) || 1000, roundsSet: false, shards: Math.max(1, Math.min(4, Math.floor(p.cores / 2))),
      execution: true, outputs: true, bad: new Set(), inputs: {} };
    lab.forms.set(e.name, f);
    f.node = runForm(f);
  }
  return f;
}

function runForm(f) {
  const num = (key, label, max) => {
    const input = h("input", { class: "ex-num num", type: "number", inputmode: "numeric", min: "1", max: String(max), step: "1",
      value: String(f[key]), "aria-label": label, dataset: { focus: `ex-${key}` } });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      const ok = input.value !== "" && Number.isInteger(v) && v >= 1 && v <= max;
      input.setAttribute("aria-invalid", ok ? "false" : "true");
      if (ok) { f[key] = v; f.bad.delete(key); if (key === "rounds") f.roundsSet = true; } else f.bad.add(key);
      paintForm(f);
    });
    f.inputs[key] = input;
    return h("label", { class: "ex-field" }, h("span", { class: "k", text: label }), input);
  };
  const box = (key, label, why) => {
    const input = h("input", { type: "checkbox", checked: f[key] ? true : null, dataset: { focus: `ex-${key}` } });
    input.addEventListener("change", () => { f[key] = input.checked; });
    return tip(h("label", { class: "ex-check" }, input, h("span", { text: label })), why);
  };
  f.go = h("button", { class: "btn primary", type: "button", dataset: { focus: "ex-go" }, onclick: () => startRun(f) }, "Run");
  tip(f.go, () => h("div", null, h("b", { text: "Run it" }), h("div", { class: "k", text: f.go.disabled ? f.sum.textContent : "Saves the manifest, then runs it in the shards set here." })));
  f.sum = h("p", { class: "isl-note ex-sum num" });
  return h("div", { class: "ex-run-form" },
    h("div", { class: "ex-form" },
      num("rounds", "Rounds", MAX_ROUNDS),
      num("shards", "Shards side by side", f.cores),
      h("div", { class: "ex-checks" },
        box("execution", "Record each round's execution", "uel.record_execution (Limen 5.16): each round's bars, from which Grid reads trades, timing and the test window's halves."),
        box("outputs", "Record model outputs", "uel.record_model_outputs (Limen 5.17): each round's test probabilities and threshold, from which Grid tells the rounds that never traded.")),
      f.go),
    f.sum);
}

// The run's settings against the manifest, and what Run will do.
function paintForm(f) {
  const d = lab.drafts.get(f.name);
  if (!d || !f.go) return;
  // the rounds follow the manifest's n_permutations until set here
  if (!f.roundsSet) {
    const n = nPerm(d.text);
    if (n && n !== f.rounds) { f.rounds = n; f.inputs.rounds.value = String(n); f.bad.delete("rounds"); f.inputs.rounds.setAttribute("aria-invalid", "false"); }
  }
  const search = valueOf(d.text, "uel.search_strategy.type");
  const checked = d.checked === d.text && d.errors;
  const share = Math.ceil(f.rounds / f.shards);
  const threads = Math.max(1, Math.floor(f.cores / f.shards));
  const why = !checked ? "Waiting for limen validate…"
    : d.errors.length ? "The manifest has problems: limen run would refuse it."
      : f.bad.has("rounds") ? `Rounds is a whole number from 1 to ${fmtInt(MAX_ROUNDS)}.`
        : f.bad.has("shards") ? `Shards is a whole number from 1 to ${fmtInt(f.cores)}, this machine's cores.`
          : f.shards > f.rounds ? `${fmtInt(f.shards)} shards cannot share ${fmtInt(f.rounds)} rounds.`
            : f.shards > 1 && search !== "random" ? `Shards draw apart only in a random search (uel.search_strategy.type: random); this manifest's is ${search || "not set"}.`
              : "";
  f.go.disabled = !!lab.busy || !!why;
  f.go.textContent = lab.busy === "Starting the run" ? "Starting…" : "Run";
  f.sum.classList.toggle("warn", !!why && !!checked);
  f.sum.textContent = why || (f.shards === 1
    ? `One limen run of ${fmtInt(f.rounds)} rounds on ${fmtInt(threads)} thread${threads === 1 ? "" : "s"}.`
    : `${fmtInt(f.shards)} limen runs side by side, ${fmtInt(share)} rounds each${share * f.shards !== f.rounds ? ` (${fmtInt(share * f.shards)} in all)` : ""}, on ${fmtInt(threads)} thread${threads === 1 ? "" : "s"} each, their search seeds apart.`);
}

function startRun(f) {
  const d = lab.drafts.get(f.name);
  if (!d || f.go.disabled) return;
  act("Starting the run", async () => {
    if (d.text !== d.saved) {
      const text = d.text;
      const out = await post("save", { name: d.name, text, version: d.version });
      Object.assign(d, { saved: text, version: out.version, disk: out.version });
    }
    return post("start", { name: f.name, rounds: f.rounds, shards: f.shards, execution: f.execution, outputs: f.outputs });
  }, (out) => lab.A.toast(h("span", null, h("b", { text: "Started. " }), `${out.run} opens in the other views once each shard has written a round.`), "good"));
}

function runsKey(e, p) {
  return JSON.stringify([e.name, lab.busy, Math.floor(Date.now() / 60000), runsOf(p, e)]);
}

function runsTable(p, e) {
  const runs = runsOf(p, e);
  if (!runs.length) return h("p", { class: "isl-note", text: "Not run yet." });
  const tbody = h("tbody");
  for (const r of runs) {
    const started = h("span", { text: r.started ? when(r.started) : "–" });
    tip(started, () => h("div", null, h("b", { class: "mono", text: r.id }), r.started ? h("div", { class: "k", text: `Started ${fmtStamp(r.started)}` }) : null));
    const shards = h("span", { text: fmtInt(r.shards.length) });
    tip(shards, () => h("div", null, h("b", { text: r.shards.length === 1 ? "One shard" : `${fmtInt(r.shards.length)} shards side by side` }),
      r.shards.map(s => h("div", { class: "k num", text: `${s.label}: ${s.planned ? `${fmtInt(s.rows)} of ${fmtInt(s.planned)}` : fmtInt(s.rows)} rounds`
        + `${s.seed !== null && s.seed !== undefined ? ` · seed ${s.seed}` : ""} · ${(STATES[s.state] || [String(s.state)])[0]}` }))));
    const notes = [];
    if (r.note) notes.push(h("p", null, r.note));
    for (const s of r.shards.filter(x => x.tail)) {
      notes.push(h("p", null, `${s.label} failed${s.exit !== null && s.exit !== undefined ? ` (exit ${s.exit})` : ""}; the end of its log, logs/${s.label}.log:`),
        h("pre", { class: "code", text: s.tail }));
    }
    tbody.append(h("tr", { class: notes.length ? "has-note" : null, dataset: { run: r.id } },
      h("td", { class: "num" }, started),
      h("td", { class: "r num", text: `${rounds(r)}${r.state === "running" && r.planned ? ` · ${fmtPct(r.rows / r.planned, 0)}` : ""}` }),
      h("td", { class: "r num" }, shards),
      h("td", null, stateTag(r)),
      h("td", { class: "ex-do" }, actions(r))));
    if (notes.length) tbody.append(h("tr", { class: "ex-note-row" }, h("td", { colspan: "5" }, h("div", { class: "ex-note" }, icon("alert"), h("div", null, notes)))));
  }
  return h("div", { class: "table-wrap" }, h("table", { class: "vals ex-runs", "aria-label": `Runs of ${e.name}` },
    h("thead", null, h("tr", null, h("th", { text: "Started" }), h("th", { class: "r", text: "Rounds" }), h("th", { class: "r", text: "Shards" }),
      h("th", { text: "State" }), h("th", null, h("span", { class: "sr", text: "Actions" })))), tbody));
}

// A button that says why it does nothing now, rather than being disabled
// (a disabled button shows no tip).
function heldBtn(btn, why) {
  if (why) { btn.setAttribute("aria-disabled", "true"); tip(btn, why); }
  return btn;
}

function actions(r) {
  const out = [];
  const ready = !!r.open || (r.rows > 0 && r.shards.every(s => s.state !== "running" || s.rows > 0));
  const analyze = h("button", { class: "btn small", type: "button", disabled: lab.busy ? true : null, dataset: { focus: `ex-an-${r.id}` },
    onclick: () => {
      if (!ready) return;
      if (r.open) lab.A.openRun(r.open);
      else act("Opening the run", () => post("open", { run: r.id }), (o) => lab.A.openRun(o.sweepRun));
    } }, "Analyze");
  out.push(heldBtn(analyze, ready ? null : r.state === "running" ? "It opens by itself once each shard has written a round." : "It wrote no round to read."));
  if (ready) tip(analyze, r.open ? "Show it in the other views." : "Read it into the other views.");
  if (r.kind === "grid" && r.state === "running") {
    const stop = h("button", { class: "btn small", type: "button", disabled: lab.busy ? true : null, dataset: { focus: `ex-stop-${r.id}` },
      onclick: () => act("Stopping", () => post("stop", { run: r.id })) }, r.stopping ? "Stop now" : "Stop");
    tip(stop, r.stopping ? "Cuts the round in hand short; Limen checkpoints the last whole round." : "Limen finishes the round in hand and writes a checkpoint, from which Resume runs on.");
    out.push(stop);
  } else if (r.kind === "grid" && (r.state === "stopped" || (r.state === "failed" && r.rows > 0))) {
    const resume = h("button", { class: "btn small", type: "button", disabled: lab.busy ? true : null, dataset: { focus: `ex-res-${r.id}` },
      onclick: () => act("Resuming", () => post("resume", { run: r.id })) }, "Resume");
    tip(resume, "limen run --resume on each shard that stopped or failed, from its checkpoint.");
    out.push(resume);
  }
  return out;
}
