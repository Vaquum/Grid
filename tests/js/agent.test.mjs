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
