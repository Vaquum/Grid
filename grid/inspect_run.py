"""Durable, explicitly scoped Inspect launches from frozen run evidence."""

from __future__ import annotations

import difflib
import gzip
import hashlib
import json
import os
from typing import TYPE_CHECKING, Any, cast

from .experiment import (
    MAX_ROUNDS,
    NAME,
    get_value,
    set_parameter_values,
    set_values,
)
from .provenance import verify_identity
from .recording import manifest_values, mark_manifest

if TYPE_CHECKING:
    from .server import Server

Json = dict[str, Any]


def typed(value: Any) -> str:
    return json.dumps(value, sort_keys=True, allow_nan=False,
                      separators=(",", ":"))


def same_value(a: Any, b: Any) -> bool:
    # Browser JSON cannot distinguish 1.0 from 1; retain the source spelling
    # and type after matching, while keeping booleans separate from numbers.
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return typed(a) == typed(b)


def narrow(text: str, manifest: Json, constraints: object
           ) -> tuple[str, int]:
    """Replace only named parameter lists; refuse any partial selection."""
    sfd: Any = manifest.get("sfd", {})
    raw_params: Any = cast(Json, sfd).get("params", {}) \
        if isinstance(sfd, dict) else {}
    if not isinstance(raw_params, dict) or not raw_params:
        raise ValueError("source has no typed parameter space")
    params = cast(Json, raw_params)
    if not isinstance(constraints, list) or not constraints:
        raise ValueError("Inspect requires an explicit parameter region")
    chosen: Json = {}
    for raw_condition in cast(list[Any], constraints):
        if not isinstance(raw_condition, dict) or \
                set(cast(Json, raw_condition)) != {"param", "values"}:
            raise ValueError("constraints contain param and typed values")
        condition = cast(Json, raw_condition)
        name, values = condition["param"], condition["values"]
        if not isinstance(name, str) or name not in params or name in chosen:
            raise ValueError("unknown or duplicate parameter constraint")
        original = params[name]
        if not isinstance(original, list) or not isinstance(values, list) \
                or not values:
            raise ValueError("each parameter needs distinct typed values")
        if len({typed(v) for v in cast(list[Any], values)}) != \
                len(cast(list[Any], values)):
            raise ValueError("each parameter needs distinct typed values")
        matched: list[Any] = []
        for value in cast(list[Any], values):
            found = [item for item in cast(list[Any], original)
                     if same_value(item, value)]
            if len(found) != 1:
                raise ValueError("selection is outside source parameter space "
                                 "or its numeric type is ambiguous")
            matched.append(found[0])
        if len({typed(value) for value in matched}) != len(matched):
            raise ValueError("parameter values select duplicate source values")
        chosen[name] = matched
    projected = 1
    original_count = 1
    for name, values in params.items():
        selected = chosen.get(name, values)
        if not isinstance(selected, list) or not selected:
            raise ValueError("source parameter space is not enumerable")
        projected *= len(cast(list[Any], selected))
        original_count *= len(values)
    if projected >= original_count:
        raise ValueError("Inspect region must narrow the source search space")
    return set_parameter_values(text, chosen), projected


def launch(server: Server, body: Json) -> Json:
    """One native intent, shared by page and agent and durable on restart."""
    project = server.project
    if project is None:
        raise ValueError("Inspect launch needs a Limen project")
    request_id = body.get("requestId")
    name = body.get("name")
    raw_source: Any = body.get("source")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 200:
        raise ValueError("Inspect requires a stable requestId")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError("Inspect requires a new experiment name")
    if not isinstance(raw_source, dict):
        raise ValueError("source requires run and integer generation")
    source = cast(Json, raw_source)
    if not isinstance(source.get("instance"), str) or \
            not isinstance(source.get("run"), str) \
            or not isinstance(source.get("generation"), int) \
            or isinstance(source.get("generation"), bool):
        raise ValueError("source requires instance, run and integer "
                         "generation")
    identity = hashlib.sha256(request_id.encode()).hexdigest()
    directory = os.path.join(project.root, ".grid", "inspect", identity)
    fingerprint = hashlib.sha256(typed(body).encode()).hexdigest()
    os.makedirs(os.path.dirname(directory), exist_ok=True)
    try:
        os.mkdir(directory)
    except FileExistsError:
        try:
            with open(os.path.join(directory, "receipt.json")) as stream:
                previous: Json = json.load(stream)
        except (OSError, ValueError) as exc:
            raise ValueError("Inspect outcome unknown; inspect project status "
                             "before issuing a new intent") from exc
        if previous.get("fingerprint") != fingerprint:
            raise ValueError(
                "requestId belongs to another Inspect intent") from None
        if previous.get("state") == "complete":
            return cast(Json, previous["result"])
        raise ValueError(str(previous.get("error") or
                             "Inspect outcome unknown; inspect project "
                             "status")) from None

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
        if source["instance"] != server.instance:
            raise ValueError("source instance changed; analyze again before "
                             "creating a new Inspect intent")
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
        data: Json = json.loads(pack)
        frozen = next((r for r in data["runs"] if r["id"] == source["run"]
                       and r["generation"] == source["generation"]), None)
        if frozen is None:
            raise ValueError("snapshot does not contain this source "
                             "generation")
        exp = cast(Json, frozen.get("experiment") or {})
        if exp.get("kind") != "limen" or not exp.get("manifestText"):
            raise ValueError("source needs its exact Limen manifest")
        if exp.get("limenVersion") != project.version:
            raise ValueError("source runtime differs from project Limen; "
                             "retain the source runtime before inspection")
        identities = cast(list[Json], exp.get("shardIdentities", []))
        if any(identity.get("limenVersion") != project.version
               for identity in identities):
            raise ValueError("source shards require different Limen runtimes")
        if exp.get("host"):
            raise ValueError("SSH source data needs its original runtime host")
        verify_identity(exp.get("sourceIdentity"), exp.get("runtimeIdentity"),
                        project.cli, project.python, project.version,
                        project.root)
        runtime = cast(Json, exp.get("runtimeIdentity") or {})
        for identity in identities:
            shard_runtime = cast(Json, identity.get("runtimeIdentity") or {})
            if shard_runtime.get("verified") is not True or \
                    shard_runtime.get("fingerprint") != runtime.get(
                        "fingerprint"):
                raise ValueError("source shard runtime identity differs")
        text = exp["manifestText"]
        narrowed, projected = narrow(text, exp["manifest"],
                                     body.get("constraints"))
        shards = exp.get("shards")
        seeds: list[Any]
        if shards:
            seeds = exp.get("shardSeeds") or []
            if len(seeds) != len(shards):
                raise ValueError("source snapshot has no frozen shard seeds; "
                                 "reload source evidence before inspection")
        else:
            raw_seed = get_value(text, "uel.search_strategy.seed")
            seeds = [int(raw_seed) if raw_seed is not None else None]
        if any(not isinstance(seed, int) or isinstance(seed, bool)
               for seed in seeds):
            raise ValueError("source has no reproducible search seed")
        maximum = min(projected * len(seeds), MAX_ROUNDS)
        maximum -= maximum % len(seeds)
        rounds = body.get("rounds", maximum)
        if not isinstance(rounds, int) or isinstance(rounds, bool) or not \
                len(seeds) <= rounds <= maximum:
            raise ValueError("rounds must be within the projected region "
                             "evaluated across the retained source seeds")
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
        provenance: Json = {
            "requestId": request_id, "source": source,
            "sourceSnapshot": os.path.relpath(directory, project.root),
            "sourceSnapshotSha256": snapshot_hash,
            "sourceManifestSha256": hashlib.sha256(text.encode()).hexdigest(),
            "sourceLimenVersion": exp.get("limenVersion"),
            "sourceSeeds": seeds,
            "sourceShardIdentities": exp.get("shardIdentities"),
            "sourceRuntimeIdentity": exp.get("runtimeIdentity"),
            "constraints": body["constraints"],
            "projectedPermutations": projected, "requestedRounds": rounds,
            "manifestDifference": "".join(difflib.unified_diff(
                text.splitlines(True), narrowed.splitlines(True),
                fromfile="source.yaml", tofile="inspect.yaml")),
            "exploratory": True,
        }
        # Native exact manifest copies keep this small link in offline exports.
        narrowed = "# grid-inspect-provenance: " + typed(provenance) + "\n" \
            + narrowed
        project.create(name, text=narrowed)
        version = project.manifest(name)["version"]
        rid = project.start(name, rounds, len(seeds), version=version,
                            recording_mode="inspect", provenance=provenance)
        result: Json = {"run": rid, "name": name, "provenance": provenance}
        receipt("complete", result=result)
        return result
    except (ValueError, OSError) as exc:
        receipt("failed", error=str(exc))
        raise
