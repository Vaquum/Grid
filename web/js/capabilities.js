// Evidence capabilities shared by live, exported and headless views. A new
// default never supplies a mode or a policy for an older run.
export function inspectPreflight(exp) {
  const data = exp?.sourceIdentity?.data;
  if (data?.available !== true) return { available: false, status: "provenance", reason: `Inspect unavailable: this run has no verifiable source data fingerprint. ${data?.reason || "The source was historical, remote or recorded without content hashes."}` };
  const runtime = exp?.runtimeIdentity;
  if (runtime?.verified !== true) return { available: false, status: "runtime", reason: `Inspect unavailable: this run has no verified runtime fingerprint. ${runtime?.reason || "Runtime identity was not recorded or cannot be verified."}` };
  return { available: true, status: "server-check", reason: "Source data and runtime fingerprints are verified again before launch." };
}

export function recordingCapabilities(ds) {
  const exp = ds.meta.experiment || {};
  const mode = ["sweep", "inspect"].includes(exp.recordingMode) ? exp.recordingMode : null;
  const policy = exp.recordingPolicy || exp.manifest?.uel || {};
  const state = ds.meta.state || exp.state;
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
  // Cohorts also support architectures whose raw predictions have no
  // probability summary in a pack. The server validates member arrays.
  const cohortDisabled = policy.recording?.predictions === false || policy.recording?.alignment === false;
  const cohort = cohortDisabled ? evidence(false, false, "Cohort reconstruction")
    : execution.available ? { available: true, status: "server-check", reason: "The server verifies raw predictions and alignment for the selected members." }
      : { ...execution, reason: `Cohort reconstruction requires recorded execution, predictions and alignment. ${execution.reason}` };
  return { mode, label: mode === "sweep" ? "Sweep" : mode === "inspect" ? "Inspect" : "Recorded policy", policy,
    scalar: { available: true, status: "available", reason: null }, execution, outputs, cohort, inspect: inspectPreflight(exp) };
}
