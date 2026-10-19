import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingCapabilities } from "../../web/js/capabilities.js";
import { inspectScope } from "../../web/js/inspect.js";
import { analyzePack } from "../../web/js/agent-query.js";

const recordingDataset = (experiment, extra = {}) => ({ meta: { experiment, ...extra }, outputs: new Map(), execution: new Map() });

test("recording capabilities preserve historical policy and distinguish policy, pending, failure and missing evidence", () => {
  const sweep = { kind: "limen", recordingMode: "sweep", recordingPolicy: { record_execution: false, record_model_outputs: false } };
  const ds = recordingDataset(sweep, { live: true });
  assert.equal(recordingCapabilities(ds).execution.status, "policy");
  assert.equal(recordingCapabilities(ds).cohort.available, false);
  assert.match(recordingCapabilities(ds).execution.reason, /Sweep mode/);
  const historic = recordingCapabilities(recordingDataset({ kind: "limen", manifest: { uel: { record_execution: false } } }));
  assert.equal(historic.mode, null);
  assert.equal(historic.label, "Recorded policy");
  assert.equal(historic.execution.status, "policy");
  assert.equal(recordingCapabilities(recordingDataset({ kind: "limen" }, { live: true })).execution.status, "pending");
  assert.equal(recordingCapabilities(recordingDataset({ kind: "limen", state: "failed" })).execution.status, "failed");
  assert.equal(recordingCapabilities(recordingDataset({ kind: "limen" })).execution.status, "missing");
  ds.execution.set(0, {});
  assert.equal(recordingCapabilities(ds).execution.status, "available", "observed retained evidence wins over an inconsistent policy label");
});

function scopeModel(pocket, context = [], gates = []) {
  const dims = [
    { id: "flag", column: "flag", label: "Flag", levels: [{ key: "false", value: false }, { key: "true", value: true }] },
    { id: "depth", column: "depth", label: "Depth", levels: [{ key: "1", value: 1 }, { key: "2", value: 2 }, { key: "string", value: "1" }] },
    { id: "shard", column: "shard", label: "Shard", levels: [{ key: "one", value: "one" }] },
  ];
  return { ds: { meta: { experiment: { manifest: { sfd: { params: { flag: [false, true], depth: [1, 2, "1"] } } } } } },
    schema: { dimById: new Map(dims.map(d => [d.id, d])) }, state: { pocket, context, gates } };
}

test("Inspect scope projects exact typed parameter constraints and intersects the context", () => {
  const plan = inspectScope(scopeModel([{ dim: "flag", keys: ["false"] }, { dim: "depth", keys: ["1", "string"] }], [{ dim: "depth", keys: ["string"] }]));
  assert.deepEqual(plan.constraints, [{ param: "depth", values: ["1"] }, { param: "flag", values: [false] }]);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.before, 6n);
  assert.equal(plan.after, 1n);
});

test("Inspect refuses empty, broadened, nonparameter and outcome-gated selections", () => {
  for (const model of [scopeModel([]), scopeModel([{ dim: "flag", keys: ["false", "true"] }]),
    scopeModel([{ dim: "shard", keys: ["one"] }]), scopeModel([{ dim: "flag", keys: ["false"] }], [{ dim: "flag", keys: ["true"] }]),
    scopeModel([{ dim: "flag", keys: ["false"] }], [], [{ id: "profit" }])]) assert.ok(inspectScope(model).problems.length);
});

test("offline agent queries expose the same capabilities and never substitute whole-window first-half evidence", () => {
  const pack = { grid: 1, runs: [{ id: "sweep", generation: 0, rows: 0, columns: [], experiment: {
    kind: "limen", recordingMode: "sweep", recordingPolicy: { record_execution: false, record_model_outputs: false }, manifest: { sfd: { params: {} } } } }] };
  const schema = analyzePack(structuredClone(pack), { analysis: "schema", state: { firstHalf: true } });
  assert.equal(schema.capabilities.mode, "sweep");
  assert.equal(schema.result.capabilities.outputs.status, "policy");
  const cohort = analyzePack(structuredClone(pack), { analysis: "cohort" });
  assert.equal(cohort.result.available, false);
  assert.equal(cohort.result.status, "policy");
});
