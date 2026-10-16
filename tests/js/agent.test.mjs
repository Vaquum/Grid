import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePack } from "../../web/js/agent-query.js";
import { createModel, decodeState, DEFAULT_STATE } from "../../web/js/core.js";
import { decodePack } from "../../web/js/pack.js";

let agentFixture, agentTemp;
before(() => {
  agentTemp = mkdtempSync(join(tmpdir(), "grid-agent-test-"));
  const out = join(agentTemp, "pack.json");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_run_200", "--out", out]);
  agentFixture = JSON.parse(readFileSync(out));
  agentFixture.agentInstance = "test-instance";
});
after(() => rmSync(agentTemp, { recursive: true, force: true }));
const agentQuery = args => analyzePack(structuredClone(agentFixture), args);

test("every analytical view works headlessly and returns portable JSON", () => {
  for (const analysis of ["schema", "board", "pocket", "pairs", "features", "trials", "gates", "run", "cohort", "manifest"]) {
    const r = agentQuery({ analysis });
    assert.equal(r.apiVersion, 1);
    assert.equal(r.snapshot.rows, 200);
    assert.equal(r.target.id, "backtest_pnl_per_bar_bps");
    assert.doesNotThrow(() => JSON.stringify(r));
    assert.ok(r.result);
  }
});

test("agent Board uses the exact page model, including all corrected tests", () => {
  const r = agentQuery({ analysis: "board" });
  const sweep = decodePack(structuredClone(agentFixture));
  const m = createModel(sweep, { ...DEFAULT_STATE, run: sweep.runs[0].id });
  assert.equal(r.summary.mean, m.base.mean);
  assert.equal(r.result.tests, m.board.tests);
  for (const effect of r.result.effects) {
    const original = m.order.find(e => e.dim === effect.dim);
    assert.equal(effect.q, Number.isFinite(original.q) ? original.q : null);
    assert.equal(effect.detectable, original.detectable);
  }
});

test("a returned state can be reused and its link restores the same UI question", () => {
  const state = { pocket: [{ dim: "use_calibration", keys: ["false"] }], edge: 150 };
  const r = agentQuery({ analysis: "pocket", state });
  const again = agentQuery({ analysis: "pocket", state: r.state, generation: r.snapshot.generation });
  assert.deepEqual(again.result, r.result);
  const decoded = decodeState(r.viewLink.slice(1));
  assert.deepEqual(decoded.pocket, state.pocket);
  assert.equal(decoded.edge, 150);
  assert.equal(decoded.target, r.target.id);
  assert.match(r.result.manifest.text, /use_calibration: \[false\]/);
  assert.equal(r.result.steps.length, 1);
  assert.ok(r.result.suggestions.every(x => x.dim !== "use_calibration"));
  assert.ok(r.result.blocks[0].kind);
});

test("invalid targets, levels, dimensions, edges and generations fail explicitly", () => {
  for (const args of [
    { state: { target: "missing" } }, { state: { edge: -1 } },
    { state: { context: [{ dim: "missing", keys: ["a"] }] } },
    { state: { pocket: [{ dim: "use_calibration", keys: ["missing"] }] } },
    { generation: 77 }, { state: { unexpected: true } }
  ]) assert.throws(() => agentQuery({ analysis: "board", ...args }));
});

test("unsupported estimates are withheld, and trials carry generation-bound references", () => {
  const r = agentQuery({ analysis: "board", state: { edge: 5 } });
  assert.equal(r.summary.n, 5);
  assert.equal(r.summary.mean, null);
  assert.equal(r.summary.withheld, true);
  const trials = agentQuery({ analysis: "trials", limit: 3 });
  assert.equal(trials.result.list.length, 3);
  assert.equal(trials.result.list[0].reference.instance, "test-instance");
  assert.equal(trials.result.list[0].reference.generation, 0);
  assert.ok(trials.result.list[0].parameters);
  assert.match(trials.result.list[0].replay, /from limen.inference import Trainer/);
});

test("first-half queries preserve the page's isolation and declared exceptions", () => {
  const out = join(agentTemp, "halves.json");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_cohort", "--out", out]);
  const pack = JSON.parse(readFileSync(out));
  const r = analyzePack(structuredClone(pack), { analysis: "board", state: { firstHalf: true, target: "backtest_pnl_per_bar_bps" } });
  const sweep = decodePack(structuredClone(pack));
  const m = createModel(sweep, { ...DEFAULT_STATE, firstHalf: true, target: "backtest_pnl_per_bar_bps" });
  assert.equal(r.summary.n, m.base.n);
  assert.equal(r.summary.mean, m.base.n < 30 ? null : m.base.mean);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.result.effects.every(e => !e.halves));
});

test("a run with no target returns a reusable question", () => {
  const pack = { grid: 1, runs: [{ id: "r0", generation: 0, rows: 0, columns: [] }] };
  const first = analyzePack(structuredClone(pack), { analysis: "schema" });
  assert.equal(first.state.target, null);
  const again = analyzePack(structuredClone(pack), { analysis: "schema", state: first.state });
  assert.deepEqual(again.state, first.state);
});

test("sparse recorded halves never use whole-window gate evidence", () => {
  const out = join(agentTemp, "sparse.json");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_cohort", "--out", out]);
  const original = JSON.parse(readFileSync(out));
  for (const [first, second] of [[3, null], [null, 3], [null, null]]) {
    const pack = structuredClone(original);
    for (const entry of pack.runs[0].rounds) {
      const summary = entry[4];
      summary.whole.tradeMean = 1;
      summary.halves[0].tradeMean = 1;
      summary.halves[1].tradeMean = 1;
      summary.whole.tradeT = 9;
      summary.halves[0].tradeT = first;
      summary.halves[1].tradeT = second;
    }
    const state = { firstHalf: true, target: "backtest_pnl_per_bar_bps", gates: [{ id: "t", target: "trade_t", op: ">=", value: 2 }] };
    const gates = analyzePack(structuredClone(pack), { analysis: "gates", state });
    const cohort = analyzePack(structuredClone(pack), { analysis: "cohort", state });
    assert.equal(cohort.result.gates[0].firstHalf, true);
    assert.equal(cohort.result.firstHalfSelection, true);
    if (first === null) {
      assert.equal(cohort.result.pool, 0);
      assert.deepEqual(cohort.result.members, []);
      assert.ok(gates.warnings.some(w => w.includes("no first-half measurements")));
    } else {
      assert.ok(cohort.result.pool > 0);
      assert.deepEqual(cohort.warnings, []);
    }
  }
  const mixed = analyzePack(structuredClone(original), { analysis: "cohort", state: {
    firstHalf: true, target: "backtest_pnl_per_bar_bps", gates: [{ id: "auc", target: "auc", op: ">", value: 0 }] } });
  assert.equal(mixed.result.firstHalfSelection, false);
  assert.ok(mixed.warnings.some(w => w.includes("selection is not isolated")));
});

test("walk-forward trials do not offer cohort selection", () => {
  const out = join(agentTemp, "walk-forward.json");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_walk_forward", "--out", out]);
  const r = analyzePack(JSON.parse(readFileSync(out)), { analysis: "cohort" });
  assert.equal(r.result.available, false);
  assert.match(r.result.reason, /walk-forward/);
});

test("trial parameters retain names that resemble engine internals", () => {
  const pack = structuredClone(agentFixture);
  const names = ["codes", "pass", "labelOf", "perRow", "rows", "n", "mean", "__proto__", "constructor", "toString"];
  for (const name of names) {
    Object.defineProperty(pack.runs[0].experiment.manifest.sfd.params, name,
      { value: ["a", "b"], enumerable: true });
    pack.runs[0].columns.push({ name, kind: "str", levelBase: 0,
      levels: ["a", "b"], data: Array.from({ length: 200 }, (_, i) => i % 2) });
  }
  const r = analyzePack(pack, { analysis: "trials", limit: 1 });
  const trial = r.result.list[0];
  for (const name of names) assert.equal(trial.parameters[name], trial.i % 2 ? "b" : "a", name);
});


test("first-half cohort membership is invariant to held-out masks and values", () => {
  const out = join(agentTemp, "isolated-cohort.json");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_cohort", "--out", out]);
  const original = JSON.parse(readFileSync(out));
  for (const [target, field] of [["trade_t", "tradeT"], ["trade_mean", "tradeMean"], ["backtest_pnl_per_bar_bps", "pnl"]]) {
    let expected;
    for (const held of [[null, null, null, null], [1000, -1, null, 999], [-100, 20, 40, null]]) {
      const pack = structuredClone(original);
      pack.runs[0].rounds.forEach((entry, i) => {
        entry[4].whole[field] = 4;
        entry[4].halves[0][field] = [3, 7, null, 1][i];
        entry[4].halves[1][field] = held[i];
      });
      const result = analyzePack(pack, { analysis: "cohort", members: 100, state: { firstHalf: true, target } });
      assert.equal(result.result.firstHalfSelection, true);
      assert.deepEqual(result.warnings, []);
      const selection = { pool: result.result.pool, ranked: result.result.ranked, members: result.result.members };
      assert.equal(selection.ranked, 3, target);
      if (expected) assert.deepEqual(selection, expected, target);
      expected = selection;
    }
  }
});


test("schema and selection models defer Board effects without changing evidence", () => {
  const sweep = decodePack(structuredClone(agentFixture));
  const state = { ...DEFAULT_STATE, run: sweep.runs[0].id };
  const cache = {};
  const lean = createModel(sweep, state, cache, { effects: false });
  assert.equal(lean.board, null);
  const full = createModel(sweep, state, cache);
  assert.ok(full.board);
  assert.deepEqual(lean.rows, full.rows);
  assert.deepEqual(lean.base, full.base);
  assert.equal(lean.schema, full.schema);
});
