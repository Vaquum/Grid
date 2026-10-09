// A board card's plot: one scale for every card, with room to print, and
// ticks in the decimals of their step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { plotDomain } from "../../web/js/main-effects.js";
import { tickText } from "../../web/js/ui.js";

const net = { kind: "cont", unit: "bps", digits: 3 };

test("nothing shown yet and a base a rounding error from zero: the scale has room to print", () => {
  // every value withheld; the base a mean of 0.1s and -0.1s, 1e-18
  const d = plotDomain([[{ n: 5, mean: 0.2, lo: NaN, hi: NaN, withheld: true }]], 1e-18, net);
  assert.ok(d.y1 - d.y0 >= 0.001, `span ${d.y1 - d.y0}`);
  const ticks = d.ticks.map(t => tickText(net, t, d.step));
  assert.ok(ticks.length >= 2, ticks.join(" "));
  assert.equal(new Set(ticks).size, ticks.length, `ticks print apart: ${ticks.join(" ")}`);
});

test("a scale that prints is left as it is", () => {
  const d = plotDomain([[{ n: 300, mean: -0.02, lo: -0.03, hi: -0.01 }, { n: 300, mean: 0.004, lo: -0.002, hi: 0.01 }]], -0.021, net);
  assert.ok(d.y0 <= -0.03 && d.y1 >= 0.01, `${d.y0} to ${d.y1}`);
  assert.ok(d.ticks.includes(0), "the scale holds zero");
});

test("a tick prints the decimals of its step, written with an exponent or not", () => {
  assert.equal(tickText(net, 0.025, 0.025), "0.025");
  assert.equal(tickText(net, 5e-7, 5e-7), "0.0000005");
  assert.equal(tickText(net, -1e-6, 5e-7), "−0.0000010");
  assert.equal(tickText({ kind: "binary" }, 0.25, 0.05), "25%");
  assert.equal(tickText({ kind: "cont", unit: "$" }, -1500, 500), "−$1,500");
});
