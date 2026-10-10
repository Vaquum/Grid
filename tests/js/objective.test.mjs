// What Limen 5.17.4 and 5.18 add to a run's results: a declared objective
// (on Limen's own example of it, docs/examples/logreg_return.yaml, run for
// 40 rounds with Limen 5.19.0: tests/fixtures/limen_objective, its round
// log keeping each round's id, index and parameters), and the ablation's
// dropped features in results.csv (here written into a copy of limen_run
// from its round log, as Limen 5.17.4 writes them).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { decodePack } from "../../web/js/pack.js";
import { buildSchema } from "../../web/js/schema.js";
import { limenProfile, LIMEN_METRICS } from "../../web/js/profiles.js";
import { limenDesign, ablationMembers } from "../../web/js/ablation.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const pack = (dir, out) => {
  execFileSync("python3", ["-m", "grid", "pack", "--limen", dir, "--out", out], { cwd: ROOT });
  return decodePack(JSON.parse(gunzipSync(readFileSync(out)).toString("utf8"))).runs[0];
};
const schemaOf = ds => buildSchema(ds, { profile: limenProfile(ds.meta.experiment) });
let objective, plain, dropped;

before(() => {
  const tmp = mkdtempSync(join(tmpdir(), "grid-objective-"));
  objective = pack("tests/fixtures/limen_objective", join(tmp, "objective.json.gz"));
  plain = pack("tests/fixtures/limen_run", join(tmp, "plain.json.gz"));
  // limen_run with each row's dropped columns in results.csv, as JSON text
  // (Limen 5.17.4), and no round log
  const fx = join(ROOT, "tests/fixtures/limen_run"), dir = join(tmp, "dropped");
  mkdirSync(dir);
  for (const name of ["metadata.json", "lightgbm_binary_full.yaml"]) copyFileSync(join(fx, name), join(dir, name));
  const text = readFileSync(join(fx, "results.csv"), "utf8");
  const lines = text.trimEnd().split("\r\n");
  const rounds = readFileSync(join(fx, "round_data.jsonl"), "utf8").trimEnd().split("\n").map(l => JSON.parse(l));
  assert.equal(rounds.length, lines.length - 1);
  const cell = r => `"${JSON.stringify((r.round_params._dropped_features || []).slice().sort()).replace(/"/g, '""')}"`;
  writeFileSync(join(dir, "results.csv"), [`${lines[0]},_dropped_features`, ...lines.slice(1).map((l, k) => `${l},${cell(rounds[k])}`)].join("\r\n") + "\r\n");
  dropped = pack(dir, join(tmp, "dropped.json.gz"));
});

test("a run that declares its objective is ranked as it selects, and measured on the test window by the metric it declared", () => {
  const sc = schemaOf(objective);
  assert.deepEqual(objective.meta.experiment.objective, { metric: "backtest_total_return", direction: "maximize" });
  assert.deepEqual(sc.objective, [["val_backtest_total_return", -1]]);
  assert.equal(sc.objectiveLabel, "validation total return");
  assert.equal(sc.defaultTarget, "backtest_total_return");
  assert.equal(sc.targetById.get("val_backtest_total_return").better, 1);
  // every column of the event ledger has its name and direction
  for (const name of objective.order.filter(n => n.startsWith("backtest_") || n.startsWith("val_"))) {
    const t = sc.targetById.get(name);
    assert.ok(t && t.source === "profile", name);
    assert.equal(t.label, LIMEN_METRICS[name].label);
  }
  assert.equal(sc.targetById.get("backtest_max_drawdown").label, "Deepest drawdown");
});

test("a minimized objective is best low, and a run without one reads as before", () => {
  const exp = objective.meta.experiment;
  const low = limenProfile({ ...exp, objective: { metric: "backtest_total_return", direction: "minimize" } });
  assert.deepEqual(low.objective, [["val_backtest_total_return", 1]]);
  assert.equal(low.metrics.val_backtest_total_return.better, -1);
  const none = limenProfile({ ...exp, objective: null, manifest: { ...exp.manifest, sfd: { ...exp.manifest.sfd, manifest: { ...exp.manifest.sfd.manifest, objective: undefined } } } });
  assert.deepEqual(none.objective, [["backtest_pnl_per_bar_bps", -1]]);
  assert.equal(none.defaultTarget, "backtest_pnl_per_bar_bps");
  const sc = schemaOf(plain);
  assert.equal(plain.meta.experiment.objective, null);
  assert.deepEqual(sc.objective, [["backtest_pnl_per_bar_bps", -1]]);
  assert.equal(sc.defaultTarget, "backtest_pnl_per_bar_bps");
});

test("the dropped features in results.csv are no parameter, and Features reads them without a round log", () => {
  const sc = schemaOf(dropped);
  assert.equal(sc.fields.find(f => f.name === "_dropped_features").role, "text");
  assert.ok(!sc.dims.some(d => d.column === "_dropped_features" || (d.set && d.set.column === "_dropped_features")));
  assert.equal(dropped.rounds.size, 0);
  const design = limenDesign(dropped.meta.experiment);
  const rows = Uint32Array.from({ length: dropped.n }, (_, i) => i);
  const fromCsv = ablationMembers(dropped, sc, design, rows);
  const fromLog = ablationMembers(plain, schemaOf(plain), design, rows);
  assert.deepEqual(fromCsv.perRow, fromLog.perRow);
  assert.ok(fromCsv.perRow.every(l => Array.isArray(l)));
});
