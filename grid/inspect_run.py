"""Durable, explicitly scoped Inspect launches from frozen run evidence."""

from __future__ import annotations

import difflib
import gzip
import hashlib
import json
import os
import re
from typing import TYPE_CHECKING, Any, cast

from .experiment import (
    MAX_ROUNDS,
    NAME,
    _block_end,
    _find,
    _mapping,
    get_value,
    set_values,
)
from .recording import manifest_values, mark_manifest

if TYPE_CHECKING:
    from .server import Server

Json = dict[str, Any]


def typed(value: Any) -> str:
    return json.dumps(value, sort_keys=True, allow_nan=False,
                      separators=(",", ":"))


def narrow(text: str, manifest: Json, constraints: object
           ) -> tuple[str, int]:
    """Replace only named parameter lists; refuse any partial selection."""
    sfd = manifest.get("sfd", {})
    params = sfd.get("params", {}) if isinstance(sfd, dict) else {}
    if not isinstance(params, dict) or not params:
        raise ValueError("source has no typed parameter space")
    if not isinstance(constraints, list) or not constraints:
        raise ValueError("Inspect requires an explicit parameter region")
    chosen: Json = {}
    for condition in constraints:
        if not isinstance(condition, dict) or set(condition) != {
                "param", "values"}:
            raise ValueError("constraints contain param and typed values")
        name, values = condition["param"], condition["values"]
        if not isinstance(name, str) or name not in params or name in chosen:
            raise ValueError("unknown or duplicate parameter constraint")
        original = params[name]
        if not isinstance(original, list) or not isinstance(values, list) \
                or not values or len({typed(v) for v in values}) != len(values):
            raise ValueError("each parameter needs distinct typed values")
        if any(typed(v) not in {typed(x) for x in original} for v in values):
            raise ValueError("selection is outside source parameter space")
        chosen[name] = values
    lines = text.splitlines()
    for name, values in chosen.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", name):
            raise ValueError("parameter spelling cannot be rewritten safely")
        span = _mapping(lines, ["sfd", "params"], create=False)
        if span is None:
            raise ValueError("source parameters are not block mappings")
        lo, hi, indent = span
        index = _find(lines, lo, hi, indent, name)
        if index is None:
            raise ValueError("source parameter is absent from exact manifest")
        end = _block_end(lines, index, indent)
        lines[index:end] = [" " * indent + name + ": " + typed(values)]
    projected = 1
    for name, values in params.items():
        selected = chosen.get(name, values)
        if not isinstance(selected, list) or not selected:
            raise ValueError("source parameter space is not enumerable")
        projected *= len(selected)
    return "\n".join(lines) + "\n", projected


def launch(server: Server, body: Json) -> Json:
    """One native intent, shared by page and agent and durable on restart."""
    project = server.project
    if project is None:
        raise ValueError("Inspect launch needs a Limen project")
    request_id = body.get("requestId")
    name = body.get("name")
    source = body.get("source")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 200:
        raise ValueError("Inspect requires a stable requestId")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError("Inspect requires a new experiment name")
    if not isinstance(source, dict) or not isinstance(source.get("run"), str) \
            or not isinstance(source.get("generation"), int) \
            or isinstance(source.get("generation"), bool):
        raise ValueError("source requires run and integer generation")
    identity = hashlib.sha256(request_id.encode()).hexdigest()
    directory = os.path.join(project.root, ".grid", "inspect", identity)
    fingerprint = hashlib.sha256(typed(body).encode()).hexdigest()
    os.makedirs(os.path.dirname(directory), exist_ok=True)
    try:
        os.mkdir(directory)
    except FileExistsError:
        try:
            with open(os.path.join(directory, "receipt.json")) as stream:
                previous = json.load(stream)
        except (OSError, ValueError) as exc:
            raise ValueError("Inspect outcome unknown; inspect project status "
                             "before issuing a new intent") from exc
        if previous.get("fingerprint") != fingerprint:
            raise ValueError("requestId belongs to another Inspect intent")
        if previous.get("state") == "complete":
            return cast(Json, previous["result"])
        raise ValueError(str(previous.get("error") or
                             "Inspect outcome unknown; inspect project status"))

    def receipt(state: str, **extra: Any) -> None:
        path = os.path.join(directory, "receipt.json")
        with open(path + ".tmp", "w") as stream:
            json.dump({"fingerprint": fingerprint, "requestId": request_id,
                       "state": state, **extra}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(path + ".tmp", path)

    receipt("running")
    try:
        snapshot = source.get("snapshot")
        if snapshot:
            if server.agent is None or not isinstance(snapshot, str):
                raise ValueError("source snapshot is unavailable")
            pack = server.agent.snapshot_pack(snapshot)
        else:
            sweep = server.sweep
            with sweep.lock:
                run = next((r for r in sweep.runs
                            if r.id == source["run"]), None)
                if run is None or run.generation != source["generation"]:
                    raise ValueError("stale source generation; analyze again")
            pack, _ = sweep.pack_text(mode="recorded",
                                      run_ids={source["run"]})
        data = json.loads(pack)
        frozen = next((r for r in data["runs"] if r["id"] == source["run"]
                       and r["generation"] == source["generation"]), None)
        if frozen is None:
            raise ValueError("snapshot does not contain this source generation")
        exp = frozen.get("experiment") or {}
        if exp.get("kind") != "limen" or not exp.get("manifestText"):
            raise ValueError("source needs its exact Limen manifest")
        if exp.get("limenVersion") != project.version:
            raise ValueError("source runtime differs from project Limen; "
                             "retain the source runtime before inspection")
        if exp.get("host"):
            raise ValueError("SSH source data needs its original runtime host")
        text = exp["manifestText"]
        narrowed, projected = narrow(text, exp["manifest"],
                                     body.get("constraints"))
        rounds = body.get("rounds", min(projected, MAX_ROUNDS))
        if not isinstance(rounds, int) or isinstance(rounds, bool) or not \
                1 <= rounds <= min(projected, MAX_ROUNDS):
            raise ValueError("rounds must be within the projected region")
        shards = exp.get("shards")
        seeds = []
        if shards:
            for _, path in shards:
                with open(os.path.join(path, "metadata.json")) as stream:
                    metadata = json.load(stream)
                seeds.append(metadata["yaml_reference"]["uel"][
                    "search_strategy"].get("seed"))
        else:
            raw_seed = get_value(text, "uel.search_strategy.seed")
            seeds.append(int(raw_seed) if raw_seed is not None else None)
        if any(not isinstance(seed, int) or isinstance(seed, bool)
               for seed in seeds):
            raise ValueError("source has no reproducible search seed")
        if rounds < len(seeds) or rounds % len(seeds):
            raise ValueError("rounds must divide evenly across source seeds")
        snapshot_hash = hashlib.sha256(pack.encode()).hexdigest()
        with gzip.open(os.path.join(directory, "source.json.gz"), "wb") as out:
            out.write(pack.encode())
        with open(os.path.join(directory, "source.yaml"), "w") as out:
            out.write(text)
        narrowed = set_values(narrowed, {"metadata.name": name})
        narrowed = mark_manifest(set_values(narrowed,
                                             manifest_values("inspect")),
                                 "inspect")
        provenance = {
            "requestId": request_id, "source": source,
            "sourceSnapshot": os.path.relpath(directory, project.root),
            "sourceSnapshotSha256": snapshot_hash,
            "sourceManifestSha256": hashlib.sha256(text.encode()).hexdigest(),
            "sourceLimenVersion": exp.get("limenVersion"),
            "sourceSeeds": seeds,
            "constraints": body["constraints"],
            "projectedPermutations": projected, "requestedRounds": rounds,
            "manifestDifference": "".join(difflib.unified_diff(
                text.splitlines(True), narrowed.splitlines(True),
                fromfile="source.yaml", tofile="inspect.yaml")),
            "exploratory": True,
        }
        project.create(name, text=narrowed)
        version = project.manifest(name)["version"]
        rid = project.start(name, rounds, len(seeds), version=version,
                            recording_mode="inspect", provenance=provenance)
        result = {"run": rid, "name": name, "provenance": provenance}
        receipt("complete", result=result)
        return result
    except (ValueError, OSError) as exc:
        receipt("failed", error=str(exc))
        raise
