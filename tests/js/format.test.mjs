// One way to write a number: a true minus, thousands grouped, one way to
// write a range and a unit, "–" for a missing figure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtFixed, fmtNum, fmtInt, fmtPct, fmtT, fmtDelta, fmtPace, rangeText, pctRange, deltaRange, spanText, tickText, unitSuffix } from "../../web/js/ui.js";

const bps = { kind: "cont", unit: "bps", digits: 3 };
const pct = { kind: "cont", unit: "%", digits: 2 };
const mo = { kind: "cont", unit: "%/mo", digits: 2 };
const usd = { kind: "cont", unit: "$", digits: 0 };
const rate = { kind: "binary" };

test("a negative number has a true minus, and one that rounds to zero no sign", () => {
  assert.equal(fmtNum(-0.021, 3), "−0.021");
  assert.equal(fmtNum(-0.0004, 3), "0.000");
  assert.equal(fmtPct(-0.0213, 1), "−2.1%");
  assert.equal(fmtPct(-0.0001, 1), "0.0%");
  assert.equal(fmtNum(-2.5e6), "−2.50M");
  assert.equal(fmtT(bps, -0.0213), "−0.021 bps");
  assert.equal(fmtT(usd, -1500), "−$1,500");
  assert.equal(fmtT(usd, -0.4), "$0");
});

test("thousands are grouped from a thousand up, with or without decimals", () => {
  assert.equal(fmtNum(8000, 0), "8,000");
  assert.equal(fmtNum(10000, 0), "10,000");
  assert.equal(fmtNum(1234.5, 1), "1,234.5");
  assert.equal(fmtNum(999.5, 0), "1,000");
  assert.equal(fmtFixed(-1234567.891, 2), "−1,234,567.89");
  assert.equal(fmtInt(1060), "1,060");
  assert.equal(fmtInt(-1060), "−1,060");
  assert.equal(fmtPct(12.345, 1), "1,234.5%");
  assert.equal(tickText(bps, 8000, 2000), "8,000");
  assert.equal(tickText(bps, -0.05, 0.025), "−0.050");
});

test("a range has an en dash between ends that are not negative, and to when one is", () => {
  assert.equal(rangeText(rate, 0.216, 0.245), "21.6–24.5%");
  assert.equal(pctRange(0.0012, 0.005, 2), "0.12–0.50%");
  assert.equal(rangeText(bps, -0.025, -0.013), "−0.025 to −0.013 bps");
  assert.equal(rangeText(bps, -0.025, 0.013), "−0.025 to 0.013 bps");
  assert.equal(rangeText(bps, 0.0001, 0.013), "0.000–0.013 bps");
  assert.equal(rangeText(pct, 1.5, 2.25), "1.50–2.25%");
  assert.equal(rangeText(mo, 1.5, 2.25), "1.50–2.25 %/mo");
  assert.equal(rangeText(usd, 1500, 3000), "$1,500–$3,000");
  assert.equal(rangeText(usd, -1500, 3000), "−$1,500 to $3,000");
  assert.equal(deltaRange(bps, -0.03, 0.01), "−0.030 to +0.010 bps");
  assert.equal(deltaRange(rate, 0.01, 0.03), "+1.0 to +3.0 pts");
  assert.equal(spanText("3", "12 rows"), "3–12 rows");
});

test("% is attached and every other unit spaced", () => {
  assert.equal(unitSuffix("%"), "%");
  assert.equal(unitSuffix("%/mo"), " %/mo");
  assert.equal(unitSuffix("bps"), " bps");
  assert.equal(unitSuffix(""), "");
  assert.equal(fmtT(pct, -2.1734), "−2.17%");
  assert.equal(fmtT(mo, 5), "5.00 %/mo");
  assert.equal(fmtDelta(pct, -0.5), "−0.50%");
  assert.equal(fmtDelta(bps, 0.01, { unit: false }), "+0.010");
});

test("a missing figure is a dash", () => {
  for (const f of [fmtNum, fmtInt, fmtPct, fmtFixed]) assert.equal(f(NaN), "–");
  assert.equal(fmtT(bps, NaN), "–");
  assert.equal(fmtPace(NaN), "–");
});

test("the pace is written one way wherever it shows", () => {
  assert.equal(fmtPace(4.837), "4.84 rows/s");
  assert.equal(fmtPace(14.12), "14.1 rows/s");
});
