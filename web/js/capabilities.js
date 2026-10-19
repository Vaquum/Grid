// Evidence capabilities shared by live, exported and headless views. A new
// default never supplies a mode or a policy for an older run.
export function recordingCapabilities(ds) {
  const exp = ds.meta.experiment || {};
  const mode = ["sweep", "inspect"].includes(exp.recordingMode) ? exp.recordingMode : null;
  const policy = exp.recordingPolicy || exp.manifest?.uel || {};
  const state = exp.state || ds.meta.state;
  const failed = state === "failed" || exp.shards?.some(s => s && !Array.isArray(s) && s.state === "failed");
  const pending = ds.meta.live && !["finished", "failed", "stopped"].includes(state);
  const evidence = (observed, enabled, title) => {
    if (observed) return { available: true, status: "available", reason: null };
    if (enabled === false) return { available: false, status: "policy", reason: `${title} unavailable: this run's recording policy disabled the required evidence${mode === "sweep" ? " (Sweep mode)" : ""}. Run the selected pocket in Inspect mode to record a new run.` };
    if (failed) return { available: false, status: "failed", reason: `${title} unavailable: execution failed before the required evidence was ingested.` };
    if (pending) return { available: false, status: "pending", reason: `${title} pending: the required evidence has not been ingested yet.` };
    return { available: false, status: "missing", reason: `${title} unavailable: this run has no retained evidence for this diagnostic.` };
  };
  const execution = evidence(ds.execution?.size > 0, policy.record_execution, "Trade, timing and half diagnostics");
  const outputs = evidence(ds.outputs?.size > 0, policy.record_model_outputs, "Probability diagnostics");
  const cohort = execution.available && outputs.available ? { available: true, status: "available", reason: null }
    : { ...(execution.available ? outputs : execution), reason: `Cohort reconstruction requires recorded execution and model outputs. ${(execution.available ? outputs : execution).reason}` };
  return { mode, label: mode === "sweep" ? "Sweep" : mode === "inspect" ? "Inspect" : "Recorded policy", policy,
    scalar: { available: true, status: "available", reason: null }, execution, outputs, cohort };
}
