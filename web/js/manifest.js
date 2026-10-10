// The experiment's manifest, at the foot of every view: as it ran, or
// narrowed to what the view looks at (the pocket, the context), ready for
// a sweep drawn only there. It is the copy `limen run` kept, shown as
// written; narrowing rewrites only the value lists of the narrowed
// parameters (in their own spelling, so 1.0 stays 1.0) and says what each
// list was. What cannot be narrowed is said, in the page and in the text.

import { h, icon, fmtInt, fmtT, rangeText, copyAndSay } from "./ui.js";

// ---------------------------------------------------------------------------
// Reading YAML values, as far as a manifest's parameter lists need

// A flow sequence's inside split at its top-level commas, quotes kept.
export function splitFlow(inner) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === quote && !(quote === '"' && inner[i - 1] === "\\")) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  const last = inner.slice(start).trim();
  if (last || out.length) out.push(last);
  return out;
}

// A YAML value as the value it names (the 1.2 core schema; a nested flow
// sequence becomes an array). A flow mapping stays its text.
export function yamlValue(token) {
  const t = token.trim();
  if (t === "" || t === "~" || /^(null|Null|NULL)$/.test(t)) return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t[0] === "[" && t.at(-1) === "]") return splitFlow(t.slice(1, -1)).map(yamlValue);
  if (t.length >= 2 && t[0] === '"' && t.at(-1) === '"') return JSON.parse(t);
  if (t.length >= 2 && t[0] === "'" && t.at(-1) === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  return a === b;
}

// The end of a value's text before its comment (a # after a space, outside
// quotes and brackets).
function commentAt(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return i;
  }
  return -1;
}

const KEY = /^( *)([A-Za-z_][A-Za-z0-9_.-]*) *:(?: +(.*))?$/;

// Where each of sfd.params' entries is written: its line, and its list as
// a flow sequence (on one or more lines) or a block sequence.
function paramSpans(lines) {
  const spans = new Map();
  const path = [];
  let skipBelow = -1;   // inside a block scalar (| or >), deeper lines are text
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (skipBelow >= 0) { if (indent > skipBelow) continue; skipBelow = -1; }
    const m = KEY.exec(line);
    if (!m) continue;
    while (path.length && path[path.length - 1].indent >= indent) path.pop();
    path.push({ indent, key: m[2] });
    const rest = m[3] || "";
    const cut = commentAt(rest);
    const value = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
    if (/^[|>]/.test(value)) { skipBelow = indent; continue; }
    if (!(path.length === 3 && path[0].key === "sfd" && path[1].key === "params")) continue;
    const name = m[2];
    if (value.startsWith("[")) {
      // a flow sequence, perhaps over several lines
      let text = value, end = i;
      while (!balanced(text) && end + 1 < lines.length) {
        end++;
        const more = lines[end];
        const c = commentAt(more);
        text += " " + (c >= 0 ? more.slice(0, c) : more).trim();
      }
      if (!balanced(text) || !text.trimEnd().endsWith("]")) { spans.set(name, { kind: "other", line: i }); continue; }
      spans.set(name, { kind: "flow", line: i, end, indent, tokens: splitFlow(text.trim().slice(1, -1)),
        comment: cut >= 0 && end === i ? rest.slice(cut).trim() : "" });
      i = end;
    } else if (value === "") {
      // a block sequence: the deeper lines that start with "- "
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim() || l.trim().startsWith("#")) continue;
        const ind = l.length - l.trimStart().length;
        if (ind <= indent) break;
        const item = /^ *- (.*)$/.exec(l);
        if (!item) { items.length = 0; break; }
        const c = commentAt(item[1]);
        items.push({ line: j, token: (c >= 0 ? item[1].slice(0, c) : item[1]).trim() });
      }
      spans.set(name, items.length ? { kind: "block", line: i, items, comment: cut >= 0 ? rest.slice(cut).trim() : "" } : { kind: "other", line: i });
    } else {
      spans.set(name, { kind: "other", line: i });
    }
  }
  return spans;
}

function balanced(text) {
  let depth = 0, quote = null;
  for (const c of text) {
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth === 0 && !quote;
}

// ---------------------------------------------------------------------------
// Narrowing

// The manifest text with each narrowed parameter's list cut to the chosen
// values. `narrow` is [{ param, values }]; `params` the parsed manifest's
// sfd.params (for the size of the space). Returns the text, what changed,
// what could not be done, and the space's size before and after.
export function narrowManifest(text, params, narrow) {
  const lines = text.split("\n");
  const spans = paramSpans(lines);
  const changed = [], problems = [];
  const sizes = new Map(Object.entries(params || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1]));
  const before = [...sizes.values()].reduce((a, b) => a * BigInt(b), 1n);
  const drop = new Set();
  for (const { param, values } of narrow) {
    if (!sizes.has(param)) { problems.push(`${param} is not one of the manifest's parameters (sfd.params), so it is not narrowed.`); continue; }
    const span = spans.get(param);
    if (!span || span.kind === "other") { problems.push(`${param} is not written as a list Grid can rewrite, so it is not narrowed.`); continue; }
    const tokens = span.kind === "flow" ? span.tokens : span.items.map(x => x.token);
    const parsed = tokens.map(yamlValue);
    const keep = new Set();
    for (const v of values) {
      const j = parsed.findIndex(p => same(p, v));
      if (j < 0) { problems.push(`${param}: ${JSON.stringify(v)} is not in its list [${tokens.join(", ")}], so it is not narrowed.`); keep.clear(); break; }
      keep.add(j);
    }
    if (!keep.size) continue;
    const kept = tokens.filter((_, j) => keep.has(j));
    const was = `was [${tokens.join(", ")}]`;
    if (span.kind === "flow") {
      const head = lines[span.line].slice(0, lines[span.line].indexOf(":") + 1);
      lines[span.line] = `${head} [${kept.join(", ")}]  # ${was}${span.comment ? `; ${span.comment.replace(/^#\s*/, "")}` : ""}`;
      for (let l = span.line + 1; l <= span.end; l++) drop.add(l);
    } else {
      lines[span.line] = `${lines[span.line].replace(/\s*#.*$/, "")}  # ${was}${span.comment ? `; ${span.comment.replace(/^#\s*/, "")}` : ""}`;
      span.items.forEach((x, j) => { if (!keep.has(j)) drop.add(x.line); });
    }
    sizes.set(param, kept.length);
    changed.push({ param, kept, tokens, line: span.line });
  }
  const after = [...sizes.values()].reduce((a, b) => a * BigInt(b), 1n);
  const out = [], marks = new Set(changed.map(c => c.line));
  const changedLines = [];
  lines.forEach((l, j) => { if (drop.has(j)) return; if (marks.has(j)) changedLines.push(out.length); out.push(l); });
  return { lines: out, changedLines, changed, problems, before, after };
}

// A big count, exact when it is short.
export function fmtCount(n) {
  if (n < 10000000n) return Number(n).toLocaleString("en-US");
  const s = n.toString();
  const exp = s.length - 1;
  const lead = `${s[0]}.${s.slice(1, 3)}`;
  const sup = String(exp).split("").map(d => "⁰¹²³⁴⁵⁶⁷⁸⁹"[+d]).join("");
  return `${lead} × 10${sup}`;
}

// Conditions on the same parameter meet: their values must all hold.
export function mergeConditions(...lists) {
  const out = new Map();
  for (const list of lists) for (const c of list || []) {
    const prev = out.get(c.dim);
    out.set(c.dim, prev ? { dim: c.dim, keys: prev.keys.filter(k => c.keys.includes(k)) } : { dim: c.dim, keys: c.keys.slice() });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// The section

const openKeys = new Set();   // which views' manifests the reader opened

// `conditions` narrow it (none: the manifest as run); `scope` names them
// ("the pocket"); `figure` is a line on what the rows say there; `say` is
// the app's toast, for its copy.
export function manifestSection(m, conditions, scope, figure, say) {
  const exp = m.ds.meta.experiment;
  if (!exp || exp.kind !== "limen") return null;
  if (typeof exp.manifestText !== "string") throw new Error("this run's experiment has no manifest text; pack or serve it again with this Grid");
  const params = (exp.manifest.sfd || {}).params || {};
  const narrow = [];
  const unmapped = [];
  for (const c of conditions) {
    const d = m.schema.dimById.get(c.dim);
    if (!d) continue;
    if (!(d.column in params)) { unmapped.push(d.label); continue; }
    narrow.push({ param: d.column, values: c.keys.map(k => d.levels.find(l => l.key === k).value) });
  }
  const res = narrowManifest(exp.manifestText, params, narrow);
  res.problems.unshift(...unmapped.map(n => `${n} is not one of the manifest's parameters (sfd.params), so it is not narrowed.`));
  const name = ((exp.manifest.metadata || {}).name) || "the experiment";
  const nperm = (exp.manifest.uel || {}).n_permutations;
  const head = [];
  // a run read from several result directories: the first one's copy
  const shards = Array.isArray(exp.shards) ? exp.shards.map(([label]) => label) : [];
  if (shards.length > 1) head.push(`# ${name}, read from ${shards.length} result directories that differ only in uel.search_strategy.seed; this is the copy in ${shards[0]}.`);
  if (res.changed.length) {
    head.push(`# ${name}, narrowed to ${scope} in Grid:`);
    for (const c of res.changed) head.push(`#   ${c.param}: [${c.kept.join(", ")}]  (of ${c.tokens.length})`);
    if (figure) head.push(`# ${figure}`);
    head.push(`# ${fmtCount(res.after)} combinations left of ${fmtCount(res.before)}${Number.isFinite(nperm) ? `; uel.n_permutations is ${fmtInt(nperm)}` : ""}.`);
  }
  for (const p of res.problems) head.push(`# NOT NARROWED: ${p}`);
  if (head.length) head.push("");
  const lines = [...head, ...res.lines];
  const text = lines.join("\n");
  const marks = new Set(res.changedLines.map(j => j + head.length));

  const key = `manifest:${m.state.view}`;
  const pre = h("pre", { class: "code mf-code", dataset: { scroll: key } });
  // one block per line, so a narrowed line can be marked across the code
  lines.forEach((l, j) => pre.append(h("span", { class: "mf-line" + (marks.has(j) ? " changed" : j < head.length - 1 ? " note" : "") }, l)));
  const note = res.changed.length ? `narrowed to ${scope} · ${res.changed.length === 1 ? "1 parameter" : `${res.changed.length} parameters`}`
    : res.problems.length ? `as run · ${scope} could not be narrowed` : "as run";
  const copy = h("button", { class: "btn small", type: "button",
    onclick: () => copyAndSay(text, say, "Manifest copied.", { select: pre, then: res.changed.length ? `Narrowed to ${scope}.` : "" }) }, icon("copy"), "Copy");
  const details = h("details", { class: "manifest", open: openKeys.has(key) ? true : null },
    h("summary", null, icon("fwd", "mf-chev"), h("span", { class: "mf-title", text: "Manifest" }), h("span", { class: "mf-file mono", text: exp.manifestFile }),
      h("span", { class: "mf-note", text: note })),
    h("div", { class: "mf-body" },
      res.problems.length ? h("ul", { class: "mf-problems" }, res.problems.map(p => h("li", null, icon("alert"), h("span", { text: p })))) : null,
      h("div", { class: "mf-tools" },
        h("span", { class: "muted num", text: `${fmtCount(res.after)} combinations${res.changed.length ? ` of ${fmtCount(res.before)}` : ""}` }), copy),
      pre));
  details.addEventListener("toggle", () => { if (details.open) openKeys.add(key); else openKeys.delete(key); });
  return h("section", { class: "manifest-sec", "aria-label": "The experiment's manifest" }, details);
}

// A line for the narrowed manifest's head: what the rows say there.
export function figureLine(m, n, s) {
  return `${fmtInt(n)} rows here: ${m.target.label} ${fmtT(m.target, s.mean)} (95% ${rangeText(m.target, s.lo, s.hi)}), against ${fmtT(m.target, m.base.mean)} over the rows in view.`;
}
