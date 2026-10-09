// A Limen run's columns get their roles from its own manifest: the first
// 40 rounds of a real lightgbm_binary_full run (tests/fixtures/limen_run),
// packed by the real command line.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodePack } from "../../web/js/pack.js";
import { buildSchema } from "../../web/js/schema.js";
import { limenProfile } from "../../web/js/profiles.js";

const ROOT = new URL("../../", import.meta.url).pathname;
let ds, schema, manifest;

before(() => {
  const out = join(mkdtempSync(join(tmpdir(), "grid-limen-")), "pack.json.gz");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_run", "--out", out], { cwd: ROOT });
  ds = decodePack(JSON.parse(gunzipSync(readFileSync(out)).toString("utf8"))).runs[0];
  manifest = ds.meta.experiment.manifest;
  schema = buildSchema(ds, { profile: limenProfile(ds.meta.experiment) });
});

test("every parameter the manifest samples is a parameter, the single-valued ones fixed", () => {
  const roles = new Map(schema.fields.map(f => [f.name, f.role]));
  for (const [name, values] of Object.entries(manifest.sfd.params)) {
    assert.equal(roles.get(name), values.length > 1 ? "param" : "fixed", name);
  }
  for (const f of schema.fields) assert.ok(!f.inferred, `${f.name} was inferred`);
});

test("the round's metrics are needles with Limen's names and directions", () => {
  const t = schema.targetById;
  assert.equal(schema.defaultTarget, "backtest_pnl_per_bar_bps");
  assert.deepEqual([t.get("backtest_pnl_per_bar_bps").label, t.get("backtest_pnl_per_bar_bps").unit, t.get("backtest_pnl_per_bar_bps").better], ["Net PnL per bar", "bps", 1]);
  assert.equal(t.get("fpr").better, -1);
  assert.equal(t.get("backtest_drawdown_bps_p50").better, 1, "drawdowns are at most zero");
  assert.equal(t.get("execution_time").diagnostic, true);
  assert.deepEqual(schema.objective, [["backtest_pnl_per_bar_bps", -1]]);
  assert.equal(schema.profile.planned, 500);
});

test("the round's bookkeeping is neither parameter nor needle", () => {
  const roles = new Map(schema.fields.map(f => [f.name, f.role]));
  assert.equal(roles.get("_round_index"), "id");
  for (const name of ["id", "_id", "_warnings", "_search_strategy", "strict_mode_error"]) assert.equal(roles.get(name), "text", name);
  const dims = new Set(schema.dims.map(d => d.id));
  for (const name of ["_round_index", "_warnings", "execution_time", "auc"]) assert.ok(!dims.has(name), name);
});

test("a disabled exit is a value of its own", () => {
  const sl = schema.dimById.get("stop_loss_bps");
  assert.deepEqual(sl.levels.map(l => l.label), ["none", "25", "50", "100", "200"]);
});
