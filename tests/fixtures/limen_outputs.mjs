// A Limen result directory as limen run writes it with
// uel.record_model_outputs (Limen 5.17), made from the limen_run fixture
// for the tests: each round's line in round_data.jsonl gains test
// probabilities (a short made-up series, not the round's own), the
// threshold applied (0.5) and its rule (>=), metadata.json the setting,
// and results.csv LightGBM's best_iteration (four values, so that only
// its role keeps it from reading as a parameter). Rounds 0, 3, 6, … never
// pass their threshold; of them, rounds 0, 6, 12, … come within 0.05 of it.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FX = fileURLToPath(new URL("./limen_run/", import.meta.url));

// Round k's 20 test probabilities.
export function probsOf(k) {
  const series = (top, step) => Array.from({ length: 20 }, (_, j) => Math.round((top + step * j) * 1000) / 1000);
  if (k % 3 !== 0) return series(0.3, 0.02);          // 0.3 to 0.68: half pass 0.5
  return k % 6 === 0 ? series(0.475, -0.01) : series(0.3, -0.01);
}

export function limenOutputsRun(dir) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FX, "lightgbm_binary_full.yaml"), join(dir, "lightgbm_binary_full.yaml"));
  const meta = JSON.parse(readFileSync(join(FX, "metadata.json"), "utf8"));
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({ ...meta, record_model_outputs: true }));
  const csv = readFileSync(join(FX, "results.csv"), "utf8").trimEnd().split("\n");
  writeFileSync(join(dir, "results.csv"), csv.map((line, i) => `${line},${i ? 100 * (1 + (i % 4)) : "best_iteration"}`).join("\n") + "\n");
  const rounds = readFileSync(join(FX, "round_data.jsonl"), "utf8").trimEnd().split("\n").map(line => {
    const r = JSON.parse(line);
    return JSON.stringify({ ...r, probs: probsOf(r._round_index), optimal_threshold: 0.5, threshold_rule: ">=" });
  });
  writeFileSync(join(dir, "round_data.jsonl"), rounds.join("\n") + "\n");
  return dir;
}
