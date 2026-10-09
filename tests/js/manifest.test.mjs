// The manifest at the foot of every view: a Limen manifest's text narrowed
// to a pocket or context, on the real copy a run kept
// (tests/fixtures/limen_run) and on the forms a list can take.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { narrowManifest, yamlValue, splitFlow, fmtCount, mergeConditions } from "../../web/js/manifest.js";

const FIX = new URL("../fixtures/limen_run/", import.meta.url);
const TEXT = readFileSync(new URL("lightgbm_binary_full.yaml", FIX), "utf8");
const PARAMS = JSON.parse(readFileSync(new URL("metadata.json", FIX), "utf8")).yaml_reference.sfd.params;

test("YAML values read as the values a run records", () => {
  assert.deepEqual(["null", "~", "true", "False", "5", "-1", "1.0", "1e-05", "0.25", '"lines|momentum"', "'it''s'", "gbdt", "[1, [2, 3]]"].map(yamlValue),
    [null, null, true, false, 5, -1, 1, 0.00001, 0.25, "lines|momentum", "it's", "gbdt", [1, [2, 3]]]);
  assert.deepEqual(splitFlow(`a, "b, c", [1, 2], 'd'`), ["a", '"b, c"', "[1, 2]", "'d'"]);
});

test("a narrowed list keeps its own spelling and says what it was", () => {
  const r = narrowManifest(TEXT, PARAMS, [
    { param: "colsample_bytree", values: [1] },
    { param: "take_profit_bps", values: [null, 400] },
    { param: "feature_groups", values: ["lines|momentum"] },
    { param: "use_calibration", values: [true] },
  ]);
  const changed = r.changedLines.map(j => r.lines[j].trim());
  assert.deepEqual(changed, [
    'feature_groups: ["lines|momentum"]  # was [all, lines, "lines|momentum", "lines|volatility", "momentum|volatility|position"]',
    "use_calibration: [true]  # was [true, false]",
    "take_profit_bps: [null, 400.0]  # was [null, 50.0, 100.0, 200.0, 400.0]",
    "colsample_bytree: [1.0]  # was [0.6, 0.8, 0.9, 1.0]",
  ]);
  assert.deepEqual(r.problems, []);
  // nothing else moved: every other line is as written
  const untouched = new Set(r.changedLines);
  const kept = r.lines.filter((_, j) => !untouched.has(j));
  // (only their lists: take_profit_bps is also the backtest's "{take_profit_bps}")
  const source = TEXT.split("\n").filter(l => !/^\s+(colsample_bytree|take_profit_bps|feature_groups|use_calibration):\s*\[/.test(l));
  assert.deepEqual(kept, source);
  // the space keeps 1 of 4, 2 of 5, 1 of 5 and 1 of 2: a hundredth
  assert.equal(r.after, r.before / 100n);
});

test("what cannot be narrowed is said, and left as written", () => {
  const r = narrowManifest(TEXT, PARAMS, [
    { param: "max_depth", values: [5] },
    { param: "not_a_param", values: [1] },
  ]);
  assert.deepEqual(r.changedLines, []);
  assert.deepEqual(r.lines, TEXT.split("\n"));
  assert.match(r.problems[0], /^max_depth: 5 is not in its list \[-1, 4, 6, 8\]/);
  assert.match(r.problems[1], /^not_a_param is not one of the manifest's parameters/);
});

test("block lists, lists over several lines and block scalars", () => {
  const text = [
    "metadata:",
    "  description: >",
    "    params: not a key here",
    "sfd:",
    "  params:",
    "    depth:  # the tree",
    "      - 4",
    "      - 6   # deep",
    "      - 8",
    "    rate: [0.01,",
    "           0.1]",
    "    kind: gbdt",
    "uel:",
    "  n_permutations: 10",
  ].join("\n");
  const params = { depth: [4, 6, 8], rate: [0.01, 0.1], kind: "gbdt" };
  const r = narrowManifest(text, params, [{ param: "depth", values: [6, 8] }, { param: "rate", values: [0.1] }, { param: "kind", values: ["gbdt"] }]);
  assert.deepEqual(r.lines.slice(5, 9), ["    depth:  # was [4, 6, 8]; the tree", "      - 6   # deep", "      - 8", "    rate: [0.1]  # was [0.01, 0.1]"]);
  assert.match(r.problems[0], /^kind is not written as a list/);
  assert.equal(r.before, 6n);
  assert.equal(r.after, 2n);
});

test("conditions on one parameter meet, and big counts read", () => {
  assert.deepEqual(mergeConditions([{ dim: "a", keys: ["1", "2"] }], [{ dim: "a", keys: ["2", "3"] }, { dim: "b", keys: ["x"] }]),
    [{ dim: "a", keys: ["2"] }, { dim: "b", keys: ["x"] }]);
  assert.equal(fmtCount(9999999n), "9,999,999");
  assert.equal(fmtCount(3760000000000000000n), "3.76 × 10¹⁸");
});
