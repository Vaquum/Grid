// The Experiment view's reading of a manifest as it is typed: where a
// problem's path is written, a plain value at a path, and the size of the
// search space, on the real manifest a Limen run kept
// (tests/fixtures/limen_run).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lineOf, valueOf, resumable } from "../../web/js/view-experiment.js";
import { searchSpace, fmtCount } from "../../web/js/manifest.js";

const FIX = new URL("../fixtures/limen_run/", import.meta.url);
const TEXT = readFileSync(new URL("lightgbm_binary_full.yaml", FIX), "utf8");
const PARAMS = JSON.parse(readFileSync(new URL("metadata.json", FIX), "utf8")).yaml_reference.sfd.params;

test("a problem's path finds its line, or as much of it as is written", () => {
  const lines = TEXT.split("\n");
  const at = (n) => lines[n - 1].trim();
  assert.equal(at(lineOf(TEXT, "uel.n_permutations")), "n_permutations: 500");
  assert.equal(at(lineOf(TEXT, "uel.search_strategy.type")), "type: random");
  // a key of the same name elsewhere is not it
  assert.equal(at(lineOf(TEXT, "sfd.manifest.type")), "type: ml");
  assert.equal(at(lineOf(TEXT, "sfd.manifest.split_dates.test_end")), 'test_end:    "2026-09-30"');
  assert.equal(at(lineOf(TEXT, "sfd.params.learning_rate")), "learning_rate: [0.01, 0.03, 0.05, 0.1]");
  // a path not written in full points at as much as is
  assert.equal(at(lineOf(TEXT, "uel.search_strategy.nothing")), "search_strategy:");
  assert.equal(at(lineOf(TEXT, "sfd.manifest.features[2].params")), "features:");
  assert.equal(lineOf(TEXT, "nothing.here"), null);
  assert.equal(lineOf(TEXT, ""), null);
});

test("a plain value at a path, as written, without its quotes or comment", () => {
  assert.equal(valueOf(TEXT, "uel.search_strategy.type"), "random");
  assert.equal(valueOf(TEXT, "uel.n_permutations"), "500");
  assert.equal(valueOf(TEXT, "metadata.limen_version"), "5.14.0");
  assert.equal(valueOf(TEXT, "uel.search_strategy"), null);
  assert.equal(valueOf(TEXT, "uel.search_strategy.nothing"), null);
  assert.equal(valueOf("a:\n  b: x  # a note\n  c: 'it'\n", "a.b"), "x");
  assert.equal(valueOf("a:\n  b: x  # a note\n  c: 'it'\n", "a.c"), "it");
});

test("the search space: the manifest's parameters and their combinations", () => {
  const space = searchSpace(TEXT);
  assert.equal(space.params, Object.keys(PARAMS).length);
  const all = Object.values(PARAMS).reduce((n, v) => n * BigInt(Array.isArray(v) ? v.length : 1), 1n);
  assert.equal(space.combinations, all);
  assert.equal(fmtCount(space.combinations), "3.76 × 10¹⁸");
  // as typed: a list cut short, a block list, a value of its own
  const small = "sfd:\n  params:\n    a: [1, 2, 3]\n    b:\n      - x\n      - y\n    c: 5\n";
  assert.deepEqual(searchSpace(small), { params: 3, combinations: 6n });
  assert.deepEqual(searchSpace("uel:\n  n_permutations: 5\n"), { params: 0, combinations: 1n });
});

test("Resume shows when a shard that stopped or failed has a checkpoint, whatever the run's rows", () => {
  const run = (state, shards, kind = "grid") => ({ kind, state, rows: shards.reduce((n, s) => n + (s.rows || 0), 0), shards });
  // one shard stopped before its first round with a checkpoint, one failed
  // without writing a round: the run reads failed with no rows, and resumes
  assert.equal(resumable(run("failed", [{ state: "stopped", checkpoint: true }, { state: "failed", checkpoint: false }])), true);
  assert.equal(resumable(run("stopped", [{ state: "stopped", rows: 3, checkpoint: true }])), true);
  assert.equal(resumable(run("failed", [{ state: "failed", checkpoint: false }])), false);
  assert.equal(resumable(run("finished", [{ state: "finished", rows: 5, checkpoint: true }])), false);
  assert.equal(resumable(run("running", [{ state: "running", checkpoint: false }, { state: "stopped", checkpoint: true }])), false);
  assert.equal(resumable(run("incomplete", [{ state: "incomplete", checkpoint: false }], "limen")), false);
});
