// Native Limen 5.27.0 results, captured by the final-image agent smoke.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodePack, rowRounds } from "../../web/js/pack.js";
import { buildSchema } from "../../web/js/schema.js";
import { limenProfile } from "../../web/js/profiles.js";
import { analyzePack } from "../../web/js/agent-query.js";

let temp, pack;
before(() => {
  temp = mkdtempSync(join(tmpdir(), "grid-native-rule-"));
  const output = join(temp, "pack.json");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_rule", "--out", output]);
  pack = JSON.parse(readFileSync(output));
});
after(() => rmSync(temp, { recursive: true, force: true }));

test("native rule outcomes never become inputs, even at low cardinality", () => {
  const query = analyzePack(structuredClone(pack), { analysis: "schema", state: { firstHalf: true } });
  assert.equal(query.result.profile, "limen");
  assert.equal(query.target.id, "pnl_per_bar_bps_test");
  assert.equal(query.target.better, 1);
  assert.deepEqual(query.warnings, []);
  assert.deepEqual(query.result.dimensions.map(d => d.id), ["fee"]);
  for (const id of ["num_trades_train", "num_executed_trades_test", "trades_per_bar_test", "inventory_per_bar_test"]) {
    assert.equal(query.result.fields.find(f => f.name === id).role, "metric", id);
  }
  assert.equal(query.result.targets.find(t => t.id === "pnl_per_trade_bps_test").better, 1);
  const board = analyzePack(structuredClone(pack), { analysis: "board", state: { firstHalf: true } });
  assert.ok(board.result.effects.every(effect => effect.dim === "fee"));
  assert.ok(board.result.tests > 0);
});

test("rule PnL and activity read actual recorded first halves", () => {
  const ds = decodePack(structuredClone(pack)).runs[0];
  const schema = buildSchema(ds, { profile: limenProfile(ds.meta.experiment) });
  const roundOf = rowRounds(ds);
  for (const [id, key] of [["pnl_per_bar_bps_test", "pnl"], ["pnl_per_trade_bps_test", "tradeMean"],
    ["num_executed_trades_test", "trades"], ["inventory_per_bar_test", "inventory"]]) {
    const target = schema.targetById.get(id);
    assert.ok(target.halves, id);
    for (let i = 0; i < ds.n; i++) {
      assert.equal(target.halves[0][i], ds.execution.get(roundOf(i)).halves[0][key], `${id} row ${i}`);
    }
  }
  const first = analyzePack(structuredClone(pack), { analysis: "schema", state: { firstHalf: true } });
  const changed = structuredClone(pack);
  for (const column of changed.runs[0].columns) {
    if (column.name.endsWith("_test")) column.data = column.data.map(() => 99999);
  }
  // Full-test CSV outcomes cannot change input levels or a recorded-half needle.
  const again = analyzePack(changed, { analysis: "schema", state: { firstHalf: true } });
  assert.deepEqual(again.result.dimensions, first.result.dimensions);
  assert.deepEqual(again.summary, first.summary);
});

test("new undeclared outcomes and nested declared inputs keep their identity", () => {
  const unknown = structuredClone(pack), run = unknown.runs[0];
  for (const name of ["future_activity_test", "constructor"]) {
    run.columns.push({ name, kind: "num", data: Array.from({ length: run.rows }, (_, i) => i % 2) });
  }
  run.experiment.manifest.sfd.params.settings = [{ threshold: 1 }, { threshold: 2 }];
  run.columns.push({ name: "settings.threshold", kind: "num", data: Array.from({ length: run.rows }, (_, i) => i % 2) });
  const query = analyzePack(unknown, { analysis: "schema" });
  assert.deepEqual(query.result.dimensions.map(d => d.id).sort(), ["fee", "settings.threshold"]);
  for (const id of ["future_activity_test", "constructor"]) {
    assert.equal(query.result.fields.find(f => f.name === id).role, "metric");
  }
});
