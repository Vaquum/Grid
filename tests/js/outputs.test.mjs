// A Limen run recorded with uel.record_model_outputs: what each round's
// test probabilities say of its threshold, as needles, and the rounds that
// never traded set apart into those the threshold held back and those that
// found nothing; best_iteration a fit diagnostic, never a parameter.

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
import { aucAbove, heldBack } from "../../web/js/outputs.js";
import { limenOutputsRun } from "../fixtures/limen_outputs.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let ds, schema;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), "grid-outputs-"));
  const out = join(dir, "pack.json.gz");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", limenOutputsRun(join(dir, "run")), "--out", out], { cwd: ROOT });
  ds = decodePack(JSON.parse(gunzipSync(readFileSync(out)).toString("utf8"))).runs[0];
  schema = buildSchema(ds, { profile: limenProfile(ds.meta.experiment) });
});

const at = (id, i) => schema.targets.find(t => t.id === id).values[i];
const roundOf = i => ds.col("_round_index").vals[i];

test("each round's probabilities against its threshold are fit diagnostics, row by row", () => {
  for (const id of ["probs_margin", "probs_reach"]) assert.equal(schema.targets.find(t => t.id === id).diagnostic, true, id);
  for (let i = 0; i < ds.n; i++) {
    const k = roundOf(i);
    // passing rounds reach 0.68; the others 0.475 (within reach) or 0.3
    const [margin, reach] = k % 3 ? [0.18, 0.6] : k % 6 === 0 ? [-0.025, 0.15] : [-0.2, 0];
    assert.ok(Math.abs(at("probs_margin", i) - margin) < 1e-9, `round ${k}: ${at("probs_margin", i)}`);
    assert.ok(Math.abs(at("probs_reach", i) - reach) < 1e-9, `round ${k}: ${at("probs_reach", i)}`);
  }
});

test("best_iteration is a fit diagnostic, never a parameter, though it takes four values", () => {
  assert.equal(schema.fields.find(f => f.name === "best_iteration").role, "diagnostic");
  assert.ok(!schema.dims.some(d => d.column === "best_iteration"));
  const t = schema.targets.find(x => x.id === "best_iteration");
  assert.equal(t.label, "Boosting iterations used");
  assert.equal(t.diagnostic, true);
});

test("the rounds that never traded: held back by the threshold where the model still ranks the bars, else found nothing", () => {
  const rows = Uint32Array.from({ length: ds.n }, (_, i) => i);
  const hb = heldBack(ds, rows);
  assert.equal(hb.rounds, 40);
  assert.equal(hb.never, 14);   // rounds 0, 3, …, 39
  assert.equal(hb.reach, 7);    // rounds 0, 6, …, 36
  assert.ok(Math.abs(hb.shortMedian - 0.025) < 1e-9, `${hb.shortMedian}`);
  // the split follows each round's AUC over its positive and negative test bars
  const num = (name, i) => ds.col(name).vals[i];
  let held = 0;
  for (let i = 0; i < ds.n; i++) {
    if (roundOf(i) % 3) continue;
    if (aucAbove(num("auc", i), num("confusion_tp", i) + num("confusion_fn", i), num("confusion_tn", i) + num("confusion_fp", i))) held++;
  }
  assert.equal(hb.held, held);
  assert.equal(hb.held + hb.nothing + hb.unknown, 14);
  assert.equal(hb.unknown, 0);
});

test("an AUC is above 0.5 only beyond chance, by its positive and negative bars", () => {
  assert.equal(aucAbove(0.56, 1000, 4000), true);
  assert.equal(aucAbove(0.56, 20, 30), false);
  assert.equal(aucAbove(0.5, 1000, 4000), false);
  assert.equal(aucAbove(0.7, 0, 100), null);
  assert.equal(aucAbove(NaN, 10, 10), null);
});

test("a run recorded without model outputs has none of it", () => {
  const plain = { ...ds, outputs: new Map(), col: n => ds.col(n), meta: ds.meta };
  assert.equal(heldBack(plain, Uint32Array.of(0, 1)), null);
});
