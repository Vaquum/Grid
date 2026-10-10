// What a Limen run's recorded test probabilities say of the rounds that
// never traded (uel.record_model_outputs, Limen 5.17). A round never
// traded when no test bar passed its threshold. Its model may still rank
// the test bars, its AUC above 0.5 beyond chance: then the threshold held
// it back; or its model found nothing to rank them by.

import { rowRounds } from "./pack.js";
import { rankAt } from "./stats.js";

const AUC_Z95 = 1.959963984540054;

// Whether an AUC's 95% interval lies above 0.5, by the standard error of
// Hanley and McNeil (1982) over its positive and negative test bars; null
// when the counts are missing.
export function aucAbove(auc, pos, neg) {
  if (!Number.isFinite(auc) || !(pos > 0) || !(neg > 0)) return null;
  const q1 = auc / (2 - auc), q2 = 2 * auc * auc / (1 + auc);
  const v = (auc * (1 - auc) + (pos - 1) * (q1 - auc * auc) + (neg - 1) * (q2 - auc * auc)) / (pos * neg);
  return auc - 0.5 > AUC_Z95 * Math.sqrt(Math.max(v, 0));
}

// The rounds of `rows` with recorded outputs, and of them those that never
// traded: held back by the threshold, found nothing, or unknown (no AUC or
// counts to tell); with how far the never-traded ones' highest
// probability fell short of the threshold. null for a run that recorded no
// outputs.
export function heldBack(ds, rows) {
  const keyOf = rowRounds(ds);
  if (!keyOf || !ds.outputs || !ds.outputs.size) return null;
  const num = (name, i) => { const c = ds.col(name); return c && c.kind === "num" && c.state[i] === 0 ? c.vals[i] : NaN; };
  const out = { rounds: 0, never: 0, held: 0, nothing: 0, unknown: 0, short: [], reach: 0 };
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r], o = ds.outputs.get(keyOf(i));
    if (!o) continue;
    out.rounds++;
    if (o.fired > 0) continue;
    out.never++;
    out.short.push(-o.margin);
    if (o.reach > 0) out.reach++;
    const above = aucAbove(num("auc", i), num("confusion_tp", i) + num("confusion_fn", i), num("confusion_tn", i) + num("confusion_fp", i));
    if (above === null) out.unknown++;
    else if (above) out.held++;
    else out.nothing++;
  }
  out.shortMedian = rankAt(Float64Array.from(out.short).sort(), 0.5);
  return out;
}
