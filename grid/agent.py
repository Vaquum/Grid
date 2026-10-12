"""Versioned agent operations; analysis reuses the page's JavaScript engine.

The write journal records intent before side effects. A repeated request
returns its original receipt, including after server restart. An interrupted
write is reported as unknown, never silently executed a second time.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import threading
import time
import uuid
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from .server import Server

Json = dict[str, Any]
WORKER = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                      "tools", "agent_query.mjs")
ANALYSES = ["schema", "board", "pocket", "pairs", "features", "trials",
            "gates", "run", "cohort", "manifest"]


def obj(properties: Json, required: list[str] | None = None) -> Json:
    return {"type": "object", "properties": properties,
            "required": required or [], "additionalProperties": False}


def integer(minimum: int = 0, maximum: int = 1000000) -> Json:
    return {"type": "integer", "minimum": minimum, "maximum": maximum}


TEXT: Json = {"type": "string", "minLength": 1}
BOOL: Json = {"type": "boolean"}
CONDITION = obj({"dim": TEXT, "keys": {"type": "array", "minItems": 1}},
                ["dim", "keys"])
CONDITIONS: Json = {"type": "array", "items": CONDITION}
STATE = obj({
    "run": TEXT, "view": TEXT, "target": TEXT, "context": CONDITIONS,
    "pocket": CONDITIONS, "pocketB": {"type": ["array", "null"],
                                       "items": CONDITION},
    "edge": {"type": ["integer", "null"], "minimum": 0},
    "gates": {"type": "array", "items": obj({
        "id": TEXT, "target": TEXT, "op": {"enum": [">", ">=", "<", "<="]},
        "value": {"type": "number"}}, ["id", "target", "op", "value"])},
    "firstHalf": BOOL, "found": {"enum": ["first", "whole", None]},
    "clusters": {"type": "array", "items": TEXT}, "compare": BOOL,
    "clusterK": {"type": ["integer", "null"], "minimum": 2, "maximum": 7},
    "pair": {"type": ["array", "null"], "items": TEXT},
    "order": integer(2, 6)})
REFERENCE = obj({"run": TEXT, "generation": integer(), "i": integer(),
                 "instance": TEXT,
                 "roundId": {"type": ["string", "null"]},
                 "shard": {"type": ["string", "null"]}},
                ["run", "generation", "instance", "i"])
REFERENCES: Json = {"type": "array", "minItems": 1, "maxItems": 100,
                    "items": REFERENCE}
QUERY = obj({"analysis": {"enum": ANALYSES}, "state": STATE,
             "snapshot": TEXT,
             "generation": integer(), "limit": integer(1, 1000),
             "offset": integer(), "members": integer(1, 100)}, ["analysis"])
RECEIPT = obj({"requestId": TEXT}, ["requestId"])


def tool(name: str, description: str, schema: Json,
         write: bool = False) -> Json:
    return {"name": name, "description": description, "inputSchema": schema,
            "outputSchema": obj({"apiVersion": {"const": 1}, "ok": BOOL,
                                 "result": {"type": ["object", "null"]},
                                 "error": {"type": ["object", "null"]}},
                                ["apiVersion", "ok", "result", "error"]),
            "annotations": {"readOnlyHint": not write,
                            "idempotentHint": True,
                            "destructiveHint": write,
                            "openWorldHint": False}}


TOOLS = [
    tool("grid_discover", "Discover Grid operations and analysis semantics.",
         obj({})),
    tool("grid_status", "Project, experiments, jobs, cohorts and live runs. "
         "Optionally wait up to 30 seconds for new sweep evidence.",
         obj({"afterVersion": integer(), "timeout": integer(0, 30)})),
    tool("grid_analyze", "Query any analytical view on explicit state. "
         "Returns a pinned snapshot, equivalent UI link and uncertainty. "
         "Use schema to discover targets, dimensions and level keys.", QUERY),
    tool("grid_row", "Read a row using its generation-bound reference.",
         obj({"reference": REFERENCE}, ["reference"])),
    tool("grid_reports", "Read Limen's latest convergence/selection reports.",
         obj({"run": TEXT}, ["run"])),
    tool("grid_manifest", "Read a working manifest and its version.",
         obj({"name": TEXT}, ["name"])),
    tool("grid_validate", "Validate manifest text using the project's Limen.",
         obj({"text": TEXT}, ["text"])),
    tool("grid_diff", "Compare manifest text with its last run's copy.",
         obj({"name": TEXT, "text": TEXT}, ["name", "text"])),
    tool("grid_create", "Create an experiment from template or manifest text.",
         obj({"name": TEXT, "template": TEXT, "text": TEXT,
              "requestId": TEXT}, ["name", "requestId"]), True),
    tool("grid_save", "Save the manifest version read; stale writes fail.",
         obj({"name": TEXT, "text": TEXT, "version": TEXT,
              "requestId": TEXT}, ["name", "text", "version", "requestId"]),
         True),
    tool("grid_start", "Run the exact manifest version read, sharing rounds "
         "across shards. Reuse requestId when retrying this same intent.",
         obj({"name": TEXT, "rounds": integer(1), "shards": integer(1),
              "execution": BOOL, "outputs": BOOL, "version": TEXT,
              "requestId": TEXT}, ["name", "rounds", "shards", "execution",
                                   "outputs", "version", "requestId"]), True),
    tool("grid_stop", "Stop a project run with Limen's stop operation.",
         obj({"run": TEXT, "requestId": TEXT}, ["run", "requestId"]), True),
    tool("grid_resume", "Resume a stopped project run.",
         obj({"run": TEXT, "requestId": TEXT}, ["run", "requestId"]), True),
    tool("grid_open", "Open a project's result directories for analysis.",
         obj({"run": TEXT}, ["run"])),
    tool("grid_cohort_evaluate", "Judge selected rounds against their best "
         "member and mean on the held-out half using recorded execution.",
         obj({"members": REFERENCES, "fee": {"type": "number"},
              "slip": {"type": "number"}}, ["members"])),
    tool("grid_predictor_create", "Train and bind a cohort predictor. "
         "Monitor grid_status for training, made or failed state.",
         obj({"name": TEXT, "members": REFERENCES,
              "how": {"type": "object"}, "requestId": TEXT},
             ["name", "members", "how", "requestId"]), True),
    tool("grid_receipt", "Read the durable outcome of a write request.",
         RECEIPT),
]
TOOL_BY_NAME = {str(t["name"]): t for t in TOOLS}


class AgentError(ValueError):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code, self.retryable = code, retryable


def failure(code: str, message: str, retryable: bool = False) -> Json:
    return {"apiVersion": 1, "ok": False, "result": None,
            "error": {"code": code, "message": message,
                      "retryable": retryable}}


def success(result: Any) -> Json:
    return {"apiVersion": 1, "ok": True, "result": json_safe(result),
            "error": None}


def json_safe(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in cast(Json, value).items()}
    if isinstance(value, list):
        return [json_safe(v) for v in cast(list[Any], value)]
    return value


def validate_input(value: Any, schema: Json, path: str = "arguments") -> None:
    """Validate the small schema subset used by the public tool contract."""
    kinds: dict[str, bool] = {
        "object": isinstance(value, dict), "array": isinstance(value, list),
        "string": isinstance(value, str), "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float))
        and not isinstance(value, bool), "null": value is None}
    wanted: Any = schema.get("type")
    types: list[Any] = cast(list[Any], wanted) if isinstance(wanted, list) \
        else [wanted]
    if wanted and not any(kinds.get(str(t), False) for t in types):
        raise AgentError("INVALID_ARGUMENT", "%s has the wrong type" % path)
    if "enum" in schema and value not in schema["enum"]:
        raise AgentError("INVALID_ARGUMENT", "%s is not an allowed value"
                         % path)
    if isinstance(value, dict):
        properties: Json = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                raise AgentError("INVALID_ARGUMENT", "%s.%s is required"
                                 % (path, key))
        for key, part in cast(Json, value).items():
            if key not in properties and not schema.get(
                    "additionalProperties", True):
                raise AgentError("INVALID_ARGUMENT", "%s.%s is unknown"
                                 % (path, key))
            if key in properties:
                validate_input(part, properties[key], "%s.%s" % (path, key))
    if isinstance(value, list):
        if not schema.get("minItems", 0) <= len(cast(list[Any], value)) <= \
                schema.get("maxItems", 1000000):
            raise AgentError("INVALID_ARGUMENT", "%s has the wrong length"
                             % path)
        for i, part in enumerate(cast(list[Any], value)):
            validate_input(part, schema.get("items", {}), "%s[%d]" % (path, i))
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        raise AgentError("INVALID_ARGUMENT", "%s is empty" % path)
    if value is not None and isinstance(value, (int, float)):
        if not math.isfinite(value) or \
                value < schema.get("minimum", float("-inf")) or value > \
                schema.get("maximum", float("inf")):
            raise AgentError("INVALID_ARGUMENT", "%s is outside its bounds"
                             % path)


class Agent:
    def __init__(self, server: Server) -> None:
        self.server = server
        self.instance = str(uuid.uuid4())
        self.lock = threading.Lock()
        self.snapshot_lock = threading.Lock()
        self.snapshots: dict[str, tuple[float, str]] = {}

    def discovery(self) -> Json:
        return {"apiVersion": 1, "tools": TOOLS, "analyses": ANALYSES,
                "project": self.server.project is not None,
                "semantics": {"confidence": 0.95, "minimumSupport": 30,
                              "missing": None, "writes": "requestId",
                              "references": ["run", "generation", "i"],
                              "analysisRuntime": "Node.js >= 18"}}

    def call(self, operation: Any, arguments: Any) -> Json:
        try:
            if not isinstance(operation, str) or operation not in TOOL_BY_NAME:
                raise AgentError("UNKNOWN_OPERATION", "unknown Grid operation")
            validate_input(arguments, TOOL_BY_NAME[operation]["inputSchema"])
            args = cast(Json, arguments)
            if TOOL_BY_NAME[operation]["annotations"]["readOnlyHint"]:
                return success(self.dispatch(operation, args))
            return self.write(operation, args)
        except AgentError as exc:
            return failure(exc.code, str(exc), exc.retryable)
        except (ValueError, OSError) as exc:
            return failure("OPERATION_FAILED", str(exc))

    def project(self) -> Any:
        if self.server.project is None:
            raise AgentError("PROJECT_REQUIRED", "serve --project is required")
        return self.server.project

    def reference(self, ref: Json) -> Json:
        sweep = self.server.sweep
        with sweep.lock:
            run = next((r for r in sweep.runs if r.id == ref["run"]), None)
            if ref["instance"] != self.instance or run is None or \
                    run.generation != ref["generation"]:
                raise AgentError("STALE_REFERENCE", "run generation changed "
                                 "or is unavailable; analyze it again")
            try:
                row = run.store.row_object(ref["i"])
            except IndexError as exc:
                raise AgentError("STALE_REFERENCE", str(exc)) from exc
            for key, field in (("roundId", "id"), ("shard", "shard")):
                if key in ref and ref[key] != row.get(field):
                    raise AgentError("STALE_REFERENCE", "row identity changed")
            return row

    def members(self, refs: list[Json]) -> Json:
        for ref in refs:
            self.reference(ref)
        first = refs[0]
        if any(r["run"] != first["run"] or r["generation"] !=
               first["generation"] for r in refs):
            raise AgentError("INVALID_ARGUMENT", "members share one run "
                             "and generation")
        return {"run": first["run"], "generation": first["generation"],
                "rows": [r["i"] for r in refs]}

    def dispatch(self, operation: str, args: Json) -> Any:
        if operation == "grid_discover":
            return self.discovery()
        if operation == "grid_status":
            s = self.server.sweep
            if "afterVersion" in args:
                s.wait_change(args["afterVersion"], args.get("timeout", 0))
            with s.lock:
                state: Json = {"instance": self.instance, "version": s.version,
                               "runs": [r.meta() for r in s.runs],
                               "errors": s.errors[-10:]}
            state["project"] = self.server.project.state() \
                if self.server.project else None
            return state
        if operation == "grid_analyze":
            node = shutil.which("node")
            if node is None:
                raise AgentError("ANALYSIS_RUNTIME_MISSING",
                                 "headless analysis needs Node.js >= 18")
            with self.snapshot_lock:
                now = time.monotonic()
                self.snapshots = {k: v for k, v in self.snapshots.items()
                                  if now - v[0] < 600}
                snapshot = args.get("snapshot")
                if snapshot:
                    if snapshot not in self.snapshots:
                        raise AgentError("SNAPSHOT_EXPIRED", "snapshot is "
                                         "unavailable; take a new snapshot")
                    pack = self.snapshots[snapshot][1]
                    created = self.snapshots[snapshot][0]
                else:
                    pack, _ = self.server.sweep.pack_text()
                    data: Json = json.loads(pack)
                    data["agentInstance"] = self.instance
                    pack = json.dumps(data)
                    snapshot = str(uuid.uuid4())
                    if len(self.snapshots) >= 4:
                        del self.snapshots[next(iter(self.snapshots))]
                    self.snapshots[snapshot] = (now, pack)
                    created = now
            payload = '{"pack":%s,"args":%s}' % (pack, json.dumps(args))
            try:
                proc = subprocess.run([node, WORKER], input=payload,
                                      text=True, capture_output=True,
                                      timeout=120, check=False)
            except subprocess.TimeoutExpired as exc:
                raise AgentError("ANALYSIS_TIMEOUT", "analysis exceeded "
                                 "120 seconds; narrow the context", True) \
                    from exc
            try:
                result: Json = json.loads(proc.stdout)
            except ValueError as exc:
                raise AgentError("ANALYSIS_FAILED", "analysis worker failed") \
                    from exc
            if not result.get("ok"):
                error: Json = result.get("error", {})
                raise AgentError(str(error.get("code", "ANALYSIS_FAILED")),
                                 str(error.get("message", "query failed")))
            result["result"]["snapshot"]["id"] = snapshot
            result["result"]["snapshot"]["instance"] = self.instance
            result["result"]["snapshot"]["expiresIn"] = max(
                0, int(600 - (time.monotonic() - created)))
            return result["result"]
        if operation == "grid_row":
            return {"reference": args["reference"],
                    "row": self.reference(args["reference"])}
        if operation == "grid_reports":
            return self.server.reports(args)
        if operation == "grid_cohort_evaluate":
            body = self.members(args["members"])
            query = {k: str(v) for k, v in body.items() if k != "rows"}
            query["rows"] = ",".join(str(i) for i in body["rows"])
            query.update({k: str(args[k]) for k in ("fee", "slip")
                          if k in args})
            return self.server.cohort(query)
        if operation == "grid_receipt":
            return self.receipt(args["requestId"])
        if operation == "grid_predictor_create":
            body = {**args, **self.members(args["members"])}
            return self.server.make_cohort(self.project(), body)
        if operation == "grid_manifest":
            return self.project().manifest(args["name"])
        from .server import act
        return act(self.project(), operation.removeprefix("grid_"), args)

    def receipt_path(self, request_id: str) -> str:
        folder = os.path.join(self.project().root, ".grid", "agent-requests")
        os.makedirs(folder, mode=0o700, exist_ok=True)
        name = hashlib.sha256(request_id.encode()).hexdigest() + ".json"
        return os.path.join(folder, name)

    def receipt(self, request_id: str) -> Json:
        try:
            with open(self.receipt_path(request_id), encoding="utf-8") as f:
                return cast(Json, json.load(f))
        except FileNotFoundError as exc:
            raise AgentError("UNKNOWN_REQUEST", "no receipt for requestId") \
                from exc

    def write(self, operation: str, args: Json) -> Json:
        fingerprint = hashlib.sha256(json.dumps(
            [operation, args], sort_keys=True).encode()).hexdigest()
        path = self.receipt_path(args["requestId"])
        with self.lock:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                receipt = self.receipt(args["requestId"])
                if receipt["fingerprint"] != fingerprint:
                    raise AgentError("REQUEST_CONFLICT", "requestId already "
                                     "belongs to different arguments") from None
                if receipt["state"] != "complete":
                    raise AgentError("OUTCOME_UNKNOWN", "write was recorded "
                                     "without a final receipt; inspect status "
                                     "before issuing a new intent") from None
                return receipt["response"]
            receipt = {"requestId": args["requestId"], "operation": operation,
                       "fingerprint": fingerprint, "state": "running"}
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(receipt, f)
                f.flush()
                os.fsync(f.fileno())
            try:
                response = success(self.dispatch(operation, args))
            except AgentError as exc:
                response = failure(exc.code, str(exc), exc.retryable)
            except (ValueError, OSError) as exc:
                response = failure("OPERATION_FAILED", str(exc))
            receipt.update(state="complete", response=response)
            temp = path + "." + self.instance
            with open(temp, "w", encoding="utf-8") as f:
                json.dump(receipt, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, path)
            return response
