import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodePack } from "../../web/js/pack.js";
import { buildSchema } from "../../web/js/schema.js";
import * as E from "../../web/js/engine.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const G = JSON.parse(readFileSync(new URL("../golden/engine.json", import.meta.url)));
let ds, schema, all;

// The same synthetic sweep the reference values were computed on: written
// by tools/synth.py and packed by the real command line.
before(() => {
  const dir = mkdtempSync(join(tmpdir(), "grid-"));
  execFileSync("python3", ["tools/synth.py", "--rows", String(G.rows), "--seed", String(G.seed), "--out", dir], { cwd: ROOT });
  const out = join(dir, "pack.json.gz");
  execFileSync("python3", ["-m", "grid", "pack", "--results", join(dir, "results.jsonl"),
    "--log", join(dir, "sweep.log"), "--out", out], { cwd: ROOT });
  const pack = JSON.parse(gunzipSync(readFileSync(out)).toString("utf8"));
  ds = decodePack(pack).runs[0];
  schema = buildSchema(ds);
  all = E.rowsIn(schema, [], ds.n);
});

function close(a, b, rel, what) {
  assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-300), `${what}: ${a} vs reference ${b}`);
}

test("the regenerated sweep is the one the references were computed on", () => {
  let s = 0, seeds = 0;
  const mm = ds.col("mean_mo"), sd = ds.col("seed");
  for (let i = 0; i < ds.n; i++) { s += mm.vals[i]; seeds += sd.vals[i]; }
  close(s, G.fingerprint.mean_mo_sum, 1e-9, "sum of mean_mo");
  assert.equal(seeds, G.fingerprint.seed_sum);
});

test("the plate profile classifies the fields", () => {
  assert.equal(schema.profile.id, "plate");
  const role = Object.fromEntries(schema.fields.map(f => [f.name, f.role]));
  assert.equal(role.model, "param");
  assert.equal(role.fsize, "fixed");
  assert.equal(role.sizem, "fixed");
  assert.equal(role.seed, "id");
  assert.equal(role.cal_applied, "effective");
  assert.equal(role["gates_detail.wr.pass"], "gate");
  const mcw = schema.dimById.get("hpcfg.min_child_weight@xgb_hp");
  assert.ok(mcw, "min_child_weight is a knob under xgb_hp");
  assert.equal(schema.dimById.get("hpcfg.min_child_weight@xgb_def"), undefined, "fixed under xgb_def");
  assert.equal(schema.dimById.get("hpcfg.C@logreg").aliasOf, "C_dir");
  assert.equal(schema.dimById.get("tp").levels[0].label, "none");
});

test("one-way effects match scipy f_oneway", () => {
  for (const [tid, dims] of Object.entries(G.oneWay)) {
    // the F statistic itself, also for a 0/1 target (its p-value there is the G-test's)
    const target = { ...schema.targetById.get(tid), kind: "cont" };
    const base = E.summarize(target, all);
    for (const [did, ref] of Object.entries(dims)) {
      const e = E.dimEffect(schema.dimById.get(did), target, all, base);
      close(e.F, ref.F, 1e-9, `${tid}/${did} F`);
      if (ref.p > 1e-290) close(e.p, ref.p, 1e-6, `${tid}/${did} p`);
      close(e.omega2 + 1, ref.omega2 + 1, 1e-12, `${tid}/${did} omega2`);
      for (const l of e.levels) {
        const r = ref.levels[l.key];
        assert.ok(r, `${did} level ${l.key} in reference`);
        assert.equal(l.n, r.n, `${did}=${l.key} n`);
        close(l.mean, r.mean, 1e-12, `${did}=${l.key} mean`);
      }
    }
  }
});

test("the base rate and the tradeable definition", () => {
  const t = schema.targetById.get("tradeable");
  const s = E.summarize(t, all);
  assert.equal(s.hits, G.base.hits);
  assert.equal(s.n, G.base.n);
});

test("binary one-way effects use the G-test, as scipy computes it", () => {
  const trade = schema.targetById.get("tradeable");
  const base = E.summarize(trade, all);
  for (const [did, ref] of Object.entries(G.gTest)) {
    const e = E.dimEffect(schema.dimById.get(did), trade, all, base);
    assert.equal(e.test, "G");
    close(e.G, ref.G, 1e-9, `${did} G`);
    close(e.p, ref.p, 1e-6, `${did} p`);
  }
});

test("binary interactions use a logistic likelihood-ratio test", () => {
  for (const [k, ref] of Object.entries(G.logisticLR)) {
    const [a, b, tid] = k.split("|");
    const target = schema.targetById.get(tid);
    const pe = E.pairEffect(schema.dimById.get(a), schema.dimById.get(b), target, all, E.summarize(target, all));
    assert.equal(pe.test, "LR");
    assert.equal(pe.dfLR, ref.df);
    close(pe.D, ref.D, 1e-5, `${k} deviance`);
    close(pe.p, ref.p, 1e-4, `${k} p`);
  }
});

test("interactions match an OLS fit of the additive and the full model", () => {
  for (const [k, ref] of Object.entries(G.interaction)) {
    const [a, b, tid] = k.split("|");
    const target = { ...schema.targetById.get(tid), kind: "cont" };
    const pe = E.pairEffect(schema.dimById.get(a), schema.dimById.get(b), target, all, E.summarize(target, all));
    close(pe.SSI, ref.SSI, 1e-7, `${k} SS interaction`);
    assert.equal(pe.dfI, ref.dfI);
    assert.equal(pe.dfW, ref.dfW);
    close(pe.p, ref.p, 1e-5, `${k} p`);
  }
});

test("Cramér's V matches scipy chi2_contingency", () => {
  for (const [k, ref] of Object.entries(G.cramers)) {
    const [a, b] = k.split("|");
    const v = E.cramersV(schema.dimById.get(a), schema.dimById.get(b), all);
    close(v.V, ref.V, 1e-10, `${k} V`);
    close(v.p, ref.p, 1e-6, `${k} p`);
    assert.equal(v.df, ref.df);
  }
});

test("stratified inclusion effects match a pandas groupby", () => {
  const set = "feats";
  const members = schema.dims.filter(d => d.kind === "member" && d.set.column === set);
  const size = schema.dimById.get(members[0].set.sizeDim);
  const res = E.memberEffects(schema, members, size, schema.targetById.get("mean_mo"), all);
  for (const [name, ref] of Object.entries(G.members)) {
    const r = res.members.find(m => m.name === name);
    close(r.delta, ref.delta, 1e-9, `${name} delta`);
    close(r.se, ref.se, 1e-9, `${name} se`);
  }
});

test("the leaderboard follows the runner's objective", () => {
  const get = c => { const col = ds.col(c); return i => col.vals[i]; };
  const top = E.topRows(all, schema.objective.map(([c, d]) => [get(c), -d]), 5);
  assert.deepEqual(top, G.top5);
});

test("planted truths are recovered", () => {
  const trade = schema.targetById.get("tradeable");
  const dims = schema.dims.filter(d => d.role === "param");
  const b = E.board(schema, trade, all, dims);
  const eff = id => b.effects.find(e => e.dim === id);
  assert.ok(eff("model").detectable && eff("tp").detectable);
  assert.ok(!eff("sizing").detectable, "sizing is inert");
  // C_meta acts only inside logreg
  const parents = schema.dims.filter(d => d.role === "param" && d.kind !== "member" && d.levels.length <= 12);
  const mm = schema.targetById.get("mean_mo"), cm = schema.dimById.get("C_meta");
  const acts = E.actsSummary(E.moderators(schema, cm, mm, all, parents), E.actsWhere(schema, cm, mm, all, parents));
  assert.equal(acts.parent, "model");
  assert.deepEqual(acts.on.map(t => t.level), ["logreg"]);
  // mthr acts only when meta = 1
  const mt = schema.dimById.get("mthr");
  const am = E.actsSummary(E.moderators(schema, mt, trade, all, parents), E.actsWhere(schema, mt, trade, all, parents));
  assert.equal(am.parent, "meta");
  assert.deepEqual(am.on.map(t => t.level), ["1"]);
  // min_child_weight = 40 under xgb_hp is dead
  const mcw = schema.dimById.get("hpcfg.min_child_weight@xgb_hp");
  const e = E.dimEffect(mcw, trade, all, E.summarize(trade, all));
  assert.deepEqual(e.dead, ["40"]);
  // pf_frac is not independent of model
  const v = E.cramersV(schema.dimById.get("pf_frac"), schema.dimById.get("model"), all);
  assert.ok(v.p < 1e-6);
});

test("a board-wide moderator scan keeps only real conditional effects", () => {
  const mm = schema.targetById.get("mean_mo");
  const parents = schema.dims.filter(d => d.role === "param" && d.kind !== "member" && d.kind !== "scoped" && d.levels.length <= 12);
  const dims = ["C_meta", "cw_dir", "mthr", "sizing", "lr_w", "preg"].map(id => schema.dimById.get(id));
  const scan = E.moderatorScan(schema, dims, mm, all, parents);
  const acts = id => scan.byDim.get(id).acts;
  assert.equal(acts("C_meta").kind, "only");
  assert.equal(acts("C_meta").parent, "model");
  assert.deepEqual(acts("C_meta").on.map(t => t.level), ["logreg"]);
  assert.equal(acts("cw_dir").parent, "model");
  assert.equal(acts("mthr").parent, "meta");
  assert.equal(acts("sizing"), null, "sizing is moderated by nothing");
  assert.equal(acts("lr_w"), null);
  assert.equal(acts("preg"), null);
});

test("board order puts detectable dims first", () => {
  const order = E.boardOrder([{ detectable: false, omega2: 0.5 }, { detectable: true, omega2: 0.01 }, { detectable: true, omega2: 0.02 }]);
  assert.deepEqual(order.map(e => e.omega2), [0.02, 0.01, 0.5]);
});

test("gates: wr never passes, and its bound is found", () => {
  const gs = E.gateStats(schema, all);
  const wr = gs.find(g => g.id === "wr");
  assert.ok(wr.never);
  close(gs.find(g => g.id === "m_green").rate, G.gatePass.m_green, 1e-12, "m_green pass rate");
  const corr = E.strongestCorrelate(schema, schema.gates.find(g => g.id === "wr").value, all, ["winday"]);
  assert.equal(corr.target, "nsig");
});

test("invariants find the logreg fits that stopped at max_iter", () => {
  const inv = schema.invariants.find(v => v.id === "lr-converged-dir");
  const r = E.invariantBreaks(ds, inv, all);
  assert.ok(r.count > 0);
  assert.equal(ds.col("lr_nit_dir").vals[r.first[0]], 10000);
});
