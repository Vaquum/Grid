// A Limen result directory as limen run writes it with uel.record_execution
// (Limen 5.16), and from 5.20 with each test bar's market return, made from
// the limen_run_200 fixture for the tests: each of its 200 rounds gets a
// line in round_data.jsonl with a made-up test window of 64 bars, not the
// round's own. Round k makes k % 33 one-bar trades, by turns in the first
// half (bars 1, 3, 5, …) and the second (33, 35, …); bar b's market return
// is ((7b + k) % 11 − 5) / 1000 (none on bar 0); a held bar's gross return
// is the market's and its net 2 bps less. With market: false no market
// returns are written, as Limen writes none before 5.20.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FX = fileURLToPath(new URL("./limen_run_200/", import.meta.url));
export const BARS = 64;

// Round k's test window: its bars' positions, gross and net returns, and
// the market's returns.
export function windowOf(k) {
  const pos = new Array(BARS).fill(0);
  for (let j = 0; j < k % 33; j++) pos[j % 2 ? 32 + j : j + 1] = 1;
  const ret = Array.from({ length: BARS }, (_, b) => (b ? (((7 * b + k) % 11) - 5) / 1000 : null));
  const gross = pos.map((p, b) => (p ? ret[b] : 0));
  const net = pos.map((p, b) => (p ? ret[b] - 0.0002 : 0));
  return { pos, gross, net, ret };
}

// The fields of a CSV record (quoted fields may hold commas and "").
function fields(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

export function limenExecutionRun(dir, { market = true } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const f of ["lightgbm_binary_full.yaml", "metadata.json", "results.csv"]) copyFileSync(join(FX, f), join(dir, f));
  const text = readFileSync(join(FX, "results.csv"), "utf8");
  const lines = text.trimEnd().split(text.includes("\r\n") ? "\r\n" : "\n");
  const at = fields(lines[0]).indexOf("_round_index");
  const rounds = lines.slice(1).map(line => {
    const k = Number(fields(line)[at]);
    const { pos, gross, net, ret } = windowOf(k);
    const rec = { _round_index: k, round_params: {}, execution: { pos, gross, net } };
    if (market) rec.market = { ret };
    return JSON.stringify(rec);
  });
  writeFileSync(join(dir, "round_data.jsonl"), rounds.join("\n") + "\n");
  return dir;
}
