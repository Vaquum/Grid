import { test } from "node:test";
import assert from "node:assert/strict";
import { targetContext, dimensionContext, labelContext, statisticContext } from "../../web/js/context.js";
import { PLATE, LIMEN_METRICS, LIMEN_EXECUTION, LIMEN_ROUND } from "../../web/js/profiles.js";

test("every known outcome has a plain definition instead of an unknown-field fallback", () => {
  const targets = [...Object.entries(PLATE.metrics), ...Object.entries(LIMEN_METRICS),
    ...[...PLATE.derived, ...LIMEN_EXECUTION.needles, ...LIMEN_ROUND].map(t => [t.id, t])];
  for (const [id, meta] of targets) {
    const text = targetContext({ id, ...meta });
    assert.ok(text.length > 20, id);
    assert.doesNotMatch(text, /no further definition|undefined/, id);
  }
});

test("unfamiliar outcomes preserve the runner's definition and do not invent one", () => {
  assert.equal(targetContext({ id: "custom", label: "Custom", definition: "The user's score." }), "The user's score.");
  assert.match(targetContext({ id: "custom", label: "Custom", unit: "widgets" }), /recorded as “Custom”, in widgets.*no further definition/);
  assert.doesNotThrow(() => targetContext({ kind: "cont", unit: "" }));
  assert.match(targetContext({ id: "total", label: "total", source: "inferred" }), /no further definition/);
  assert.doesNotMatch(targetContext({ id: "total", label: "total", source: "inferred" }), /dollars|profit/);
});

test("window and nested-parameter context use their real scope", () => {
  assert.match(targetContext({ id: "backtest_pnl_per_bar_bps~2", label: "Net PnL", half: 2 }), /after costs.*second half/);
  assert.match(targetContext({ id: "entries", label: "Entries, first half", base: {} }), /first half/);
  assert.match(dimensionContext({ label: "learning_rate", role: "param", scope: { label: "model = lgbm" } }), /only when model = lgbm/);
  assert.doesNotMatch(dimensionContext({ label: "learning_rate", scope: { label: "model = lgbm" } }), /undefined/);
});

test("metric names are distinct from section headings and pocket statistics", () => {
  const m = { schema: { dims: [], targets: [{ id: "recall", label: "Recall" }, { id: "gates", label: "Gates" }] }, state: { view: "trials" } };
  assert.match(labelContext("Recall", m), /positive examples/);
  assert.match(labelContext("Gates", m), /runner's checks/);
  assert.match(labelContext("Gates", m, true), /each card/);
  assert.match(labelContext("Recall", { ...m, state: { view: "pocket" } }), /positive examples/);
});

test("parenthesized metric scopes remain distinct while unit suffixes resolve", () => {
  const m = { schema: { targets: [
    { id: "precision", label: "Precision", unit: "" },
    { id: "confusion_precision", label: "Precision (test window)", unit: "" },
    { id: "recall", label: "Recall", unit: "" },
    { id: "confusion_recall", label: "Recall (test window)", unit: "" },
    { id: "mean_mo", label: "Mean month", unit: "%/mo" },
  ] } };
  assert.match(labelContext("Precision", m), /examples/);
  assert.match(labelContext("Precision (test window)", m), /test bars/);
  assert.match(labelContext("Recall", m), /examples/);
  assert.match(labelContext("Recall (test window)", m), /test bars/);
  assert.match(labelContext("Mean month (%/mo)", m), /monthly return/);
});

test("a gate named after a metric does not replace its definition", () => {
  const m = { schema: { targets: [{ id: "entries", label: "Entries" }], gates: [
    { id: "entries", label: "Entries ≥ 30", target: { id: "entries", label: "Entries" }, need: "≥ 30" },
  ] } };
  assert.doesNotMatch(labelContext("Entries", m), /To pass/);
  assert.match(labelContext("Entries ≥ 30", m), /To pass: ≥ 30/);
});

test("bare statistical readouts explain the measured link and uncertainty", () => {
  assert.match(statisticContext("V 0.32 · q < 0.0001"), /0 means no link.*all the comparisons/);
  assert.match(statisticContext("p = 0.01"), /if there were no real difference/);
  assert.equal(statisticContext("Limen 5.24"), null);
  assert.match(statisticContext("ω² 0.2%", "interaction"), /together.*beyond.*separate effects/);
  assert.doesNotMatch(statisticContext("ω² 0.2%", "interaction"), /on its own/);
});
