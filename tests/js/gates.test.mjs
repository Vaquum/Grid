// Gates set here: a need on a needle becomes a gate and a needle of its
// own; every gate together, two more; a gate that cannot be read says why;
// the gates the best rows fail together, however many there are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGates, gateLabel, needText, nextGateId } from "../../web/js/gates.js";
import { coFailure } from "../../web/js/engine.js";

// A schema with two measured needles and a rate, over six rows.
function schemaOf() {
  const t = (id, label, unit, values, kind = "cont", better = 1) => ({ id, label, unit, kind, better, digits: 1, values: Float64Array.from(values) });
  const targets = [
    t("pnl", "Net PnL per bar", "bps", [0.7, 0.0, -0.1, 0.0, NaN, 0.2]),
    t("entries", "Entries", "", [88, 0, 3, 40, 12, 30]),
    t("rate", "Tradeable", "share of rows", [1, 0, 0, 1, 0, 1], "binary"),
  ];
  return { n: 6, gates: [], targets, targetById: new Map(targets.map(x => [x.id, x])) };
}

test("a need on a needle passes the rows that meet it, strictly or not, and leaves a row without a value undecided", () => {
  const sc = applyGates(schemaOf(), [{ id: "g1", target: "pnl", op: ">", value: 0 }, { id: "g2", target: "pnl", op: ">=", value: 0 }]);
  const [strict, loose] = sc.gatesSet;
  assert.deepEqual([...strict.pass].map(String), ["1", "0", "0", "0", "NaN", "1"]);
  assert.deepEqual([...loose.pass].map(String), ["1", "1", "0", "1", "NaN", "1"]);
  assert.equal(strict.label, "Net PnL per bar > 0 bps");
  assert.equal(strict.need, "above 0 bps");
  // each is a needle, a rate of rows passing
  const t = sc.targetById.get("gate:g1");
  assert.deepEqual([t.kind, t.better, t.gateSet], ["binary", 1, true]);
  assert.equal(sc.targets.length, 3 + 2 + 2);
});

test("every gate together: a row fails all it fails, passes all only when each is decided", () => {
  const sc = applyGates(schemaOf(), [{ id: "g1", target: "pnl", op: ">=", value: 0 }, { id: "g2", target: "entries", op: ">=", value: 30 }]);
  const all = sc.targetById.get("gates:all"), count = sc.targetById.get("gates:count");
  // rows: pnl>=0 [1,1,0,1,?,1]; entries>=30 [1,0,0,1,0,1]
  assert.deepEqual([...all.values].map(String), ["1", "0", "0", "1", "0", "1"]);
  assert.deepEqual([...count.values], [2, 1, 0, 2, 0, 2]);
  assert.deepEqual([all.label, count.label, count.unit], ["Passes every gate", "Gates passed", "of 2"]);
  // undecided only when nothing failed: drop the entries gate
  const one = applyGates(schemaOf(), [{ id: "g1", target: "pnl", op: ">=", value: 0 }]).targetById.get("gates:all");
  assert.ok(Number.isNaN(one.values[4]));
});

test("beside the runner's gates, the ones set here say so", () => {
  const base = schemaOf();
  base.gates = [{ id: "m_avg", label: "Mean month ≥ 5%", pass: new Float64Array(6), value: new Float64Array(6) }];
  const sc = applyGates(base, [{ id: "g1", target: "entries", op: ">=", value: 30 }]);
  assert.deepEqual(sc.gates.map(g => g.id), ["m_avg", "g1"]);
  assert.equal(sc.targetById.get("gates:all").label, "Passes every gate set here");
  assert.equal(nextGateId([{ id: "g1" }], { gates: [{ id: "g2" }] }), "g3");
});

test("a gate that cannot be read is kept with its reason, never dropped", () => {
  const defs = [
    { id: "g1", target: "nope", op: ">=", value: 1 },
    { id: "g2", target: "rate", op: ">=", value: 0.5 },
    { id: "g3", target: "pnl", op: "~", value: 1 },
    { id: "g4", target: "pnl", op: ">=", value: "x" },
  ];
  const sc = applyGates(schemaOf(), defs);
  assert.equal(sc.gatesSet.length, 0);
  assert.deepEqual(sc.gateProblems.map(p => p.why), [
    "this run has no needle nope", "Tradeable is a rate, not a value to set a need on", "no comparison ~", "its need is not a number"]);
  assert.equal(sc.targetById.has("gates:all"), false, "no gate, no gates together");
});

test("a need is written as it was given, in its needle's unit, as every number is", () => {
  const t = { label: "Drawdown p5", unit: "bps" };
  assert.equal(needText(t, -1000), "−1,000 bps");
  assert.equal(needText(t, 0.55), "0.55 bps");
  assert.equal(needText({ unit: "%" }, -0.5), "−0.5%");
  assert.equal(needText({ unit: "$" }, 3000), "$3,000");
  assert.equal(needText({ unit: "$" }, -2500.5), "−$2,500.5");
  assert.equal(gateLabel({ label: "AUC", unit: "" }, { op: "<=", value: 0.5 }), "AUC ≤ 0.5");
});

test("the gates the best rows fail together are counted for any number of gates", () => {
  // 40 gates: more than a 32-bit mask holds
  const n = 4, G = [];
  for (let g = 0; g < 40; g++) G.push({ id: `g${g}`, pass: Float64Array.from([1, g === 35 ? 0 : 1, g === 39 || g === 0 ? 0 : 1, 1]) });
  const cf = coFailure({ gates: G }, Uint32Array.from([0, 1, 2, 3]), 38);
  assert.equal(cf.total, 4);
  assert.deepEqual(cf.combos.map(c => [c.failing, c.count]), [[[], 2], [["g35"], 1], [["g0", "g39"], 1]]);
});
