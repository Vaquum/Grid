// A pocket becomes a new native Inspect run only after its exact parameter
// scope and permutation count are reviewed. Retrying keeps the same identity.
import { h } from "./ui.js";
import { mergeConditions, fmtCount } from "./manifest.js";
import { inspectPreflight } from "./capabilities.js";

function inspectEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => inspectEqual(v, b[i]));
  return a === b;
}

export function inspectScope(m) {
  const params = m.ds.meta.experiment?.manifest?.sfd?.params || {};
  const constraints = [], problems = [], scope = [];
  const provenance = inspectPreflight(m.ds.meta.experiment);
  if (!provenance.available) problems.push(provenance.reason);
  let before = 1n, after = 1n;
  for (const values of Object.values(params)) before *= BigInt(Array.isArray(values) ? values.length : 1);
  const conditions = mergeConditions(m.state.context, m.state.pocket);
  if (!(m.state.pocket || []).length) problems.push("Select a parameter pocket before creating an Inspect run.");
  for (const c of conditions) {
    const d = m.schema.dimById.get(c.dim), values = d && params[d.column];
    if (!d || !Array.isArray(values)) { problems.push(`${d?.label || c.dim} cannot be mapped to a manifest parameter; the selected scope cannot be launched.`); continue; }
    const selected = c.keys.map(k => d.levels.find(l => l.key === k)?.value);
    if (!selected.length || selected.some(v => !values.some(x => inspectEqual(x, v)))) { problems.push(`${d.label} has an empty or unmappable selection.`); continue; }
    const prev = constraints.find(x => x.param === d.column);
    const kept = values.filter(v => selected.some(x => inspectEqual(x, v)) && (!prev || prev.values.some(x => inspectEqual(x, v))));
    if (prev) prev.values = kept; else constraints.push({ param: d.column, values: kept });
    scope.push(`${d.label} = ${kept.map(v => JSON.stringify(v)).join(" or ")}`);
    if (!kept.length) problems.push(`${d.label} has no values in the selected scope.`);
  }
  for (const [param, values] of Object.entries(params)) after *= BigInt(constraints.find(c => c.param === param)?.values.length ?? (Array.isArray(values) ? values.length : 1));
  const shards = Math.max(1, m.ds.meta.experiment?.shards?.length || 1);
  if (!constraints.length || after >= before) problems.push("The selection does not narrow the source search space. Narrow a parameter before launching.");
  if ((m.state.gates || []).length) problems.push("Outcome gates cannot define a new parameter region. Clear the gates before launching this pocket.");
  return { constraints, problems, scope, before, after, shards };
}

export function inspectBudget(plan, sourceRoundsPerShard) {
  const maxRounds = Math.floor(Math.min(Number(plan.after) * plan.shards, 10000000) / plan.shards) * plan.shards;
  const source = Number.isInteger(sourceRoundsPerShard) && sourceRoundsPerShard > 0 ? sourceRoundsPerShard : 1000;
  const defaultRounds = Math.min(maxRounds, Math.min(Number(plan.after), source) * plan.shards);
  return { maxRounds, defaultRounds };
}

const inspectRequests = new Map();

function retainInspectRequest(key, req) {
  try { sessionStorage.setItem(`grid-inspect:${key}`, JSON.stringify({ ...req, busy: false })); } catch { /* storage may be unavailable in an exported page */ }
}

export function inspectSection(m, A) {
  if (m.ds.meta.experiment?.kind !== "limen") return null;
  const plan = inspectScope(m);
  const budget = inspectBudget(plan, m.ds.meta.experiment.manifest?.uel?.n_permutations);
  const key = JSON.stringify([m.ds.id, m.ds.meta.generation, plan.constraints]);
  let req = inspectRequests.get(key);
  if (!req) {
    req = { name: `${m.ds.meta.experiment.manifest?.metadata?.name || "pocket"}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) + "_inspect",
      rounds: budget.defaultRounds,
      review: false, busy: false, error: null, result: null, requestId: null, payload: null };
    try {
      const saved = JSON.parse(sessionStorage.getItem(`grid-inspect:${key}`) || "null");
      if (saved?.payload && saved.requestId === saved.payload.requestId) Object.assign(req, saved, { busy: false, review: true });
    } catch { /* a request can still be retried within this page */ }
    inspectRequests.set(key, req);
  }
  const section = h("section", { class: "island", "aria-label": "Run pocket in Inspect mode" },
    h("header", { class: "isl-head" }, h("h2", { class: "isl-title", text: "Inspect this pocket" })),
    h("p", { class: "isl-note", text: "Creates a linked run for this parameter region after checking the source data and runtime fingerprints. Costs, dates and seeds stay as recorded. Pocket discovery and inspection remain exploratory." }));
  if (!A.project) { section.append(h("p", { class: "isl-note", text: "Run in Inspect mode requires this run to be served in its Limen project." })); return section; }
  if (plan.problems.length) { section.append(h("ul", { class: "mf-problems" }, plan.problems.map(text => h("li", { text })))); return section; }
  if (req.result) {
    const out = req.result;
    section.append(h("p", { class: "isl-note", role: "status", text: `Inspect run ${out.run} created. Source ${m.ds.id}, generation ${m.ds.meta.generation}. Request ${req.requestId}.` }),
      out.provenance?.sourceSnapshot ? h("p", { class: "isl-note", text: `Immutable source snapshot: ${out.provenance.sourceSnapshot}` }) : null);
    return section;
  }
  const go = h("button", { class: "btn primary", type: "button", disabled: req.busy ? true : null, onclick: () => { req.review = true; A.rerender(); } }, "Run in Inspect mode");
  section.append(h("p", { class: "isl-note num", text: `${fmtCount(plan.after)} unique parameter combinations of ${fmtCount(plan.before)} in the source.` }));
  if (!req.review) { section.append(go); return section; }
  const name = h("input", { type: "text", value: req.name, "aria-label": "Inspect experiment name", disabled: req.payload ? true : null });
  const rounds = h("input", { class: "ex-num num", type: "number", min: String(plan.shards), max: String(budget.maxRounds), step: String(plan.shards), value: String(req.rounds), "aria-label": "Inspect rounds", disabled: req.payload ? true : null });
  const evaluationNote = h("p", { class: "isl-note num" });
  const showEvaluations = () => { evaluationNote.textContent = `Planned evaluations: ${Number.isInteger(req.rounds) && req.rounds >= 0 ? fmtCount(BigInt(req.rounds)) : "unavailable"} across ${plan.shards} source seeds; ${fmtCount(plan.after)} unique parameter combinations. Maximum ${fmtCount(BigInt(budget.maxRounds))} evaluations.`; };
  showEvaluations();
  name.addEventListener("input", () => { req.name = name.value; });
  rounds.addEventListener("input", () => { req.rounds = Number(rounds.value); showEvaluations(); });
  const error = h("p", { class: "isl-note warn", role: "status", text: req.error || "" });
  const launch = h("button", { class: "btn primary", type: "button", disabled: req.busy ? true : null, onclick: async () => {
    if (req.busy) return;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(req.name) || !Number.isInteger(req.rounds) || req.rounds < plan.shards || req.rounds % plan.shards !== 0 || req.rounds > budget.maxRounds) {
      req.error = `Use a valid experiment name and a round count within this region, divisible by ${plan.shards} to preserve all source seeds.`; A.rerender(); return;
    }
    if (!req.payload) {
      req.requestId = crypto.randomUUID();
      req.payload = { name: req.name, source: { run: m.ds.id, generation: m.ds.meta.generation }, constraints: plan.constraints, requestId: req.requestId, rounds: req.rounds };
      retainInspectRequest(key, req);
    }
    req.busy = true; req.error = null; A.rerender();
    try {
      const res = await fetch(`${A.project.url}/inspect`, { method: "POST", headers: { "Content-Type": "application/json", "X-Grid-Token": A.project.token }, body: JSON.stringify(req.payload) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `The server answered ${res.status}.`);
      req.result = out;
    } catch (err) { req.error = `${String(err.message || err)} Retry uses the same request identity; it cannot create another run.`; }
    finally { req.busy = false; retainInspectRequest(key, req); A.rerender(); }
  } }, req.busy ? "Starting…" : req.payload ? "Retry Inspect request" : "Confirm and run Inspect");
  section.append(h("p", { class: "isl-note", text: `Source: ${m.ds.id}, generation ${m.ds.meta.generation}. The server pins an immutable snapshot when this request is admitted.` }),
    h("ul", null, plan.scope.map(text => h("li", { class: "mono", text }))),
    h("p", { class: "isl-note", text: `Rounds must be divisible by ${plan.shards} to retain every source seed. Each seed evaluates only this parameter region. Inspect records detailed evidence.` }),
    h("label", { class: "ex-field" }, "Experiment name", name), h("label", { class: "ex-field" }, "Rounds", rounds), evaluationNote, error, launch);
  return section;
}
