// Profiles say what a known sweep's fields mean. Fields a profile does not
// name are classified by inference (schema.js), and the page says so.

// The nine monthly plate gates, from vaquum-run/bundles/mplate/monthly.py
// (verdict()). Rows carry each gate's value and pass flag, not its need.
const PLATE_GATES = [
  { id: "m_green", label: "Every month green", need: "all months ≥ −0.5%",
    parse: v => { const m = /^(\d+)\/(\d+)/.exec(v); return m ? { value: +m[1], of: +m[2] } : null; },
    unit: "green months", margin: p => p.value - p.of, marginLabel: "months short of all" },
  { id: "m_avg", label: "Mean month ≥ 5%", need: "≥ 5.0 %/mo", unit: "%/mo",
    margin: v => v - 5, marginLabel: "%/mo above the need" },
  { id: "m_min", label: "Worst month ≥ −0.5%", need: "≥ −0.5%", unit: "%",
    parse: v => { const m = /^(\S+)\s+([+-]?\d+(?:\.\d+)?)%\s*$/.exec(v); return m ? { value: +m[2], month: m[1] } : null; },
    margin: p => p.value + 0.5, marginLabel: "% above the need" },
  { id: "wr", label: "Win days > 50%", need: "> 50% of days", unit: "% of days",
    margin: v => v - 50, marginLabel: "points above the need" },
  { id: "skew", label: "Average win > average loss", need: "avg win > avg loss",
    pair: true, unit: "win/loss ratio", margin: r => r - 1, marginLabel: "ratio above 1" },
  { id: "top5", label: "Top 5 days < 30% of total", need: "< 0.30 of total", unit: "share of total",
    margin: v => 0.30 - v, marginLabel: "below the need" },
  { id: "dynsize", label: "Position sizes vary", need: "sizes vary",
    parse: v => { const m = /vary=(True|False)/.exec(v); return m ? { value: m[1] === "True" ? 1 : 0 } : null; },
    unit: "varies (1) or not (0)" },
  { id: "dynexit", label: "Holds vary, with mid exits", need: "several holds and a mid exit",
    parse: v => { const m = /holds=\[([^\]]*)\]\s+midexits=(\d+)/.exec(v); return m ? { value: +m[2], holds: m[1] ? m[1].split(",").length : 0 } : null; },
    unit: "mid exits" },
  { id: "dd", label: "Drawdown < 20% of peak", need: "< 20% of peak equity", unit: "$" },
];

export const PLATE = {
  id: "plate",
  name: "Plate sweep",
  describes: "grand and PocketA (research/grand.py, research/pocket_a.py)",
  matches: cols => cols.has("gates") && cols.has("mean_mo") && cols.has("total") && cols.has("model"),
  families: [
    { id: "backtest", label: "Backtest" },
    { id: "labels", label: "Labels" },
    { id: "model", label: "Model" },
    { id: "features", label: "Features" },
    { id: "sizing", label: "Sizing and meta" },
    { id: "logreg", label: "Logreg track" },
    { id: "hp", label: "Hyperparameters" },
  ],
  params: {
    tp: "backtest", sl: "backtest",
    label_q: "labels", label_mode: "labels", vol_k: "labels",
    model: "model",
    feats: "features", nfeats: "features",
    sizing: "sizing", fsize: "sizing", meta: "sizing", mthr: "sizing", sizem: "sizing",
    lr_w: "logreg", C_dir: "logreg", C_meta: "logreg", l1r_dir: "logreg", l1r_meta: "logreg",
    cw_dir: "logreg", cw_meta: "logreg", cal_meta: "logreg", preg: "logreg", pf_frac: "logreg",
  },
  // A dict of params whose keys vary only under some values of another param.
  nested: { hpcfg: { family: "hp", scopeBy: "model" } },
  // Params the runner resolved from others: shown, never read as sampled.
  effective: { cal_applied: "logreg", pf_applied: "logreg" },
  alias: { bt: "the backtest index: one value per (tp, sl) pair" },
  setSize: { feats: "nfeats" },
  ids: ["seed"],
  diagnostic: ["cal_fb", "pf_fb", "lr_nit_dir", "lr_nit_meta"],
  text: ["green", "min_mo", "verdict"],
  gatesPrefix: "gates_detail.",
  gates: PLATE_GATES,
  metrics: {
    gates: { label: "Gates passed", unit: "of 9", better: 1, kind: "ordinal", digits: 2 },
    mean_mo: { label: "Mean month", unit: "%/mo", better: 1, digits: 2 },
    total: { label: "Total PnL", unit: "$", better: 1, digits: 0 },
    maxDD: { label: "Max drawdown", unit: "$", better: -1, digits: 0 },
    auc: { label: "Direction AUC", unit: "", better: 1, digits: 3 },
    ll_dir: { label: "Log-loss, direction", unit: "", better: -1, digits: 3 },
    ll_meta: { label: "Log-loss, meta", unit: "", better: -1, digits: 3 },
    winday: { label: "Win days", unit: "% of days", better: 1, digits: 1 },
    avgwin: { label: "Average win", unit: "$", better: 1, digits: 0 },
    avgloss: { label: "Average loss", unit: "$", better: -1, digits: 0 },
    nsig: { label: "Signal days", unit: "days", better: 0, digits: 0 },
    meansz: { label: "Mean position", unit: "$", better: 0, digits: 0 },
    sec: { label: "Seconds per row", unit: "s", better: -1, digits: 2, cost: true },
    lr_nit_dir: { label: "Logreg iterations, direction", unit: "", better: 0, digits: 0 },
    lr_nit_meta: { label: "Logreg iterations, meta", unit: "", better: 0, digits: 0 },
    cal_fb: { label: "Calibration fallbacks", unit: "folds", better: -1, digits: 2 },
  },
  derived: [
    { id: "tradeable", label: "Tradeable", unit: "share of rows", kind: "binary", better: 1,
      needs: ["gates", "total"], fn: (g, t) => (g >= 6 && t >= 3000 ? 1 : 0),
      definition: "gates ≥ 6 and total ≥ $3,000",
      note: "The definition used to mine Pocket A from the grand sweep." },
    { id: "gates7", label: "Gates ≥ 7", unit: "share of rows", kind: "binary", better: 1,
      needs: ["gates"], fn: g => (g >= 7 ? 1 : 0), definition: "gates ≥ 7" },
  ],
  defaultTarget: "tradeable",
  // The runner's own ranking (pocket_a.py sweep: gates desc, mean_mo desc).
  objective: [["gates", -1], ["mean_mo", -1]],
  objectiveLabel: "gates, then mean %/mo",
  // Rules the runner promises; each row is checked (pocket_a.py notes).
  invariants: [
    { id: "pf-wins-cal", label: "Per-fold fracdiff and calibration never both apply",
      cols: ["pf_applied", "cal_applied"], bad: (pf, cal) => pf === 1 && cal !== "raw" },
    { id: "stack-no-pf", label: "stack_dir never runs per-fold fracdiff",
      cols: ["model", "pf_applied"], bad: (m, pf) => m === "stack_dir" && pf === 1 },
    { id: "lr-converged-dir", label: "Logreg direction fits stop before max_iter (10,000)",
      cols: ["lr_nit_dir"], bad: n => n !== null && n !== undefined && n >= 10000 },
    { id: "lr-converged-meta", label: "Logreg meta fits stop before max_iter (10,000)",
      cols: ["lr_nit_meta"], bad: n => n !== null && n !== undefined && n >= 10000 },
  ],
  replay: {
    // How a row is replayed exactly (pocket_a.py perm_from_rec / replay).
    python: (row) => `import json, pocket_a\npocket_a.loadall()\nrec = json.loads(${JSON.stringify(JSON.stringify(row))})\nprint(pocket_a.replay(rec))`,
  },
};

export const PROFILES = [PLATE];

export function matchProfile(cols) {
  return PROFILES.find(p => p.matches(cols)) || null;
}
