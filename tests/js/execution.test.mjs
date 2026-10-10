// A Limen run recorded with uel.record_execution: what each round's test
// window did, as needles (the mean trade, per-trade t and timing) with each
// half of the window, and Grid's gates on its trades. Made-up windows on the
// first 200 rounds of a real run (tests/fixtures/limen_execution.mjs),
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
import { applyGates } from "../../web/js/gates.js";
import { limenExecutionRun, windowOf, BARS } from "../fixtures/limen_execution.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let tmp, ds, schema;

function packed(dir) {
  const out = join(tmp, `${dir.split("/").pop()}.pack.json.gz`);
  execFileSync("python3", ["-m", "grid", "pack", "--limen", dir, "--out", out], { cwd: ROOT });
  const run = decodePack(JSON.parse(gunzipSync(readFileSync(out)).toString("utf8"))).runs[0];
  return { ds: run, schema: buildSchema(run, { profile: limenProfile(run.meta.experiment) }) };
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "grid-execution-"));
  ({ ds, schema } = packed(limenExecutionRun(join(tmp, "run"))));
});

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
// the server keeps six significant digits
const close = (got, want, what) => assert.ok(Number.isNaN(want) ? Number.isNaN(got) : Math.abs(got - want) <= 1e-5 * Math.max(1, Math.abs(want)), `${what}: ${got} for ${want}`);

// What bars [lo, hi) of round k's window give, worked out here from the bars.
function expected(k, lo = 0, hi = BARS) {
  const w = windowOf(k), bars = [];
  for (let b = lo; b < hi; b++) bars.push(b);
  const held = bars.filter(b => w.pos[b]).map(b => w.net[b]);
  const valued = bars.filter(b => w.ret[b] !== null);
  return {
    trades: held.length, tradeMean: held.length ? mean(held) * 1e4 : NaN, pnl: mean(bars.map(b => w.net[b])) * 1e4,
    timing: (mean(valued.map(b => w.gross[b])) - mean(valued.map(b => w.pos[b])) * mean(valued.map(b => w.ret[b]))) * 1e4,
  };
}

test("each round's trades and timing are needles, with each half of the window, row by row", () => {
  const t = id => schema.targetById.get(id);
  assert.deepEqual(["trade_mean", "trade_t", "timing"].map(id => [t(id).label, t(id).unit, t(id).better]),
    [["Mean trade", "bps", 1], ["Per-trade t", "", 1], ["Timing per bar", "bps", 1]]);
  assert.equal(t("trade_t").group, "activity");
  assert.equal(t("timing").group, "skill");
  const round = ds.col("_round_index");
  for (let i = 0; i < ds.n; i++) {
    const k = round.vals[i];
    const whole = expected(k), halves = [expected(k, 0, BARS / 2), expected(k, BARS / 2, BARS)];
    close(t("trade_mean").values[i], whole.tradeMean, `round ${k} mean trade`);
    close(t("timing").values[i], whole.timing, `round ${k} timing`);
    // a per-trade t only from 30 trades
    assert.equal(Number.isFinite(t("trade_t").values[i]), k % 33 >= 30, `round ${k} t`);
    halves.forEach((h, j) => {
      // entries come from results.csv; their halves from the round's bars
      assert.equal(t("entries").halves[j][i], h.trades, `round ${k} half ${j + 1} entries`);
      close(t("backtest_pnl_per_bar_bps").halves[j][i], h.pnl, `round ${k} half ${j + 1} net`);
      close(t("timing").halves[j][i], h.timing, `round ${k} half ${j + 1} timing`);
      close(t("trade_mean").halves[j][i], h.tradeMean, `round ${k} half ${j + 1} mean trade`);
    });
  }
  // the needles results.csv gives and the round's bars split in two; no
  // half holds 30 trades here, so per-trade t has none
  assert.deepEqual(schema.targets.filter(x => x.halves).map(x => x.id).sort(),
    ["backtest_cost_per_bar_bps", "backtest_inventory_per_bar", "backtest_pnl_per_bar_bps", "backtest_trades_per_bar", "backtest_wins_per_bar", "entries", "timing", "trade_mean"]);
});

test("Grid's gates stand on the trades: 30 entries and a per-trade t of 2", () => {
  const g = applyGates(schema, []);
  assert.deepEqual(g.gatesStanding.map(x => [x.id, x.label, x.need]), [["entries", "Entries ≥ 30", "at least 30"], ["trade_t", "Per-trade t ≥ 2", "at least 2"]]);
  assert.deepEqual(g.gatesSet, []);
  assert.ok(g.gates.every(x => x.standing && !x.set));
  const t = schema.targetById.get("trade_t"), pass = g.targetById.get("gate:trade_t").values;
  for (let i = 0; i < ds.n; i++) {
    const v = t.values[i];
    if (Number.isFinite(v)) assert.equal(pass[i], v >= 2 ? 1 : 0);
    else assert.ok(Number.isNaN(pass[i]));
  }
  // gates set here sit beside them; one named like Grid's cannot be read
  const both = applyGates(schema, [{ id: "g1", target: "trade_mean", op: ">", value: 0 }, { id: "entries", target: "auc", op: ">=", value: 0.5 }]);
  assert.deepEqual(both.gates.map(x => x.id), ["entries", "trade_t", "g1"]);
  assert.match(both.gateProblems[0].why, /names a gate this run has/);
  // with a gate set here, the runner-like gates are Grid's: Passes every gate set here
  assert.equal(both.targetById.get("gates:all").label, "Passes every gate set here");
});

test("without market returns (Limen before 5.20) there is no timing, and the rest reads as with them", () => {
  const plain = packed(limenExecutionRun(join(tmp, "plain"), { market: false })).schema;
  assert.ok(!plain.targetById.has("timing"));
  assert.ok(plain.targetById.has("trade_mean") && plain.targetById.has("trade_t"));
  assert.ok(plain.targetById.get("backtest_pnl_per_bar_bps").halves);
  assert.equal(plain.standingGates.length, 2);
});

test("a run recorded without its execution reads as before: no halves, no Grid's gates", () => {
  const { schema: old } = packed(join(ROOT, "tests/fixtures/limen_run"));
  assert.ok(!old.targets.some(x => x.halves));
  assert.ok(!old.targetById.has("trade_mean"));
  assert.deepEqual(old.standingGates, []);
  assert.deepEqual(applyGates(old, []).gates, []);
});
