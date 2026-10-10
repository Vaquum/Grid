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
import { fileURLToPath } from "node:url";
import { decodePack } from "../../web/js/pack.js";
import { buildSchema } from "../../web/js/schema.js";
import { limenProfile } from "../../web/js/profiles.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
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

test("entries are Limen's entries per bar times the test window's bars, a whole count", () => {
  const e = schema.targetById.get("entries");
  assert.equal(e.group, "activity");
  const rate = ds.col("backtest_trades_per_bar");
  const bars = ["confusion_tp", "confusion_fp", "confusion_tn", "confusion_fn"].map(c => ds.col(c));
  let seen = 0;
  for (let i = 0; i < ds.n; i++) {
    if (rate.state[i] !== 0 || bars.some(c => c.state[i] !== 0)) continue;
    const raw = rate.vals[i] * bars.reduce((s, c) => s + c.vals[i], 0);
    // the premise: the two count the same bars, so the product is whole
    assert.ok(Math.abs(raw - Math.round(raw)) < 0.03, `row ${i}: ${raw} is not a whole count`);
    assert.equal(e.values[i], Math.round(raw));
    seen++;
  }
  assert.equal(seen, ds.n);
  assert.equal(e.decimals, 0);
});

test("net PnL per bar is written to 0.1 bps, so a round shows 0.7, not 0.700", () => {
  assert.equal(schema.targetById.get("backtest_pnl_per_bar_bps").decimals, 1);
});

test("a run read from several result directories has its directory as a parameter, plans their rounds together and replays each from its own", () => {
  const exp = { manifest: { sfd: { params: { a: [1, 2] } }, uel: { n_permutations: 500 } }, dir: null, host: null,
    shards: { s1: "/runs/s1", s2: "/runs/s2" } };
  const p = limenProfile(exp);
  assert.deepEqual(Object.keys(p.params), ["a", "shard"]);
  assert.equal(p.planned, 1000);
  assert.match(p.replay.python({ id: "abc", shard: "s2" }), /^from limen\.inference import Trainer\n\ntrainer = Trainer\("\/runs\/s2"\)/);
  assert.equal(p.replay.python({ id: "abc", shard: "s3" }), null);
  // one directory: no such parameter
  const one = limenProfile({ ...exp, dir: "/runs/s1", shards: undefined });
  assert.deepEqual(Object.keys(one.params), ["a"]);
  assert.equal(one.planned, 500);
  assert.match(one.replay.python({ id: "abc" }), /Trainer\("\/runs\/s1"\)/);
});

test("what a score rests on: activity, risk, model skill and the time it took", () => {
  const ids = g => schema.targets.filter(t => t.group === g).map(t => t.id).sort();
  assert.deepEqual(ids("activity"), ["backtest_inventory_per_bar", "entries"]);
  assert.deepEqual(ids("risk"), ["backtest_avg_loss_bps", "backtest_cvar_95_pnl_bps", "backtest_drawdown_bps_p5"]);
  assert.deepEqual(ids("skill"), ["auc", "precision", "recall"]);
  assert.deepEqual(schema.targets.filter(t => t.cost).map(t => t.id), ["execution_time"]);
});
