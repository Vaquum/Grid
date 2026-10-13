import { test } from "node:test";
import assert from "node:assert/strict";
import { targetContext, dimensionContext, labelContext } from "../../web/js/context.js";
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
  assert.match(labelContext("Recall", { ...m, state: { view: "pocket" } }), /kept by the pocket/);
});
