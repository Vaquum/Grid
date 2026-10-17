#!/usr/bin/env python3
"""Matched, exact retention measurements on an existing recorded corpus.

Run in the native image when using replay. Never point --work at production.
The input corpus and original source files are only read. Runtime provisioning
is explicit and measured separately by pin_replay_runtime.py.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def size(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def rss() -> int:
    # Linux getrusage may retain a pre-exec fork high-water mark. VmHWM is
    # specific to this process's current address space after exec.
    status = Path("/proc/self/status")
    if status.exists():
        for line in status.read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) * 1024
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def worker(request: dict[str, Any]) -> dict[str, Any]:
    began = time.perf_counter()
    from grid.__main__ import main as grid_main

    root, output = Path(request["root"]), Path(request["output"])
    output.mkdir(parents=True)
    manifests = sorted(root.rglob("metadata.json"))
    readings: list[dict[str, Any]] = []
    for pass_number in range(2):
        started = time.perf_counter()
        identities: list[str] = []
        output_bytes = rows = 0
        for number, metadata in enumerate(manifests):
            target = output / ("%d-%d.json.gz" % (pass_number, number))
            grid_main(
                ["pack", "--limen", str(metadata.parent), "--out", str(target)]
            )
            with target.open("rb") as stream:
                os.fsync(stream.fileno())
            run = json.loads(gzip.decompress(target.read_bytes()))["runs"][0]
            identities.append(
                hashlib.sha256(
                    json.dumps(
                        {
                            k: run.get(k)
                            for k in (
                                "rows",
                                "columns",
                                "rounds",
                                "bad",
                                "badCount",
                                "roundsBad",
                                "roundsBadCount",
                            )
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode()
                ).hexdigest()
            )
            rows += run["rows"]
            output_bytes += target.stat().st_size
        readings.append(
            {
                "seconds": time.perf_counter() - started,
                "identities": identities,
                "rows": rows,
                "output_bytes": output_bytes,
            }
        )
    return {
        "passes": readings,
        "seconds": time.perf_counter() - began,
        "peak_rss_bytes": rss(),
    }


def child(root: Path, output: Path, package: Path) -> dict[str, Any]:
    output.parent.mkdir(parents=True, exist_ok=True)
    request = {"root": str(root), "output": str(output)}
    started = time.perf_counter()
    with output.with_suffix(".log").open("w") as log:
        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--worker",
                json.dumps(request),
            ],
            cwd=package,
            env={**os.environ, "PYTHONPATH": str(package)},
            stdout=log,
            stderr=subprocess.STDOUT,
            check=True,
        )
    result = json.loads(output.with_suffix(".json").read_bytes())
    result["end_to_end_seconds"] = time.perf_counter() - started
    return result



def recover_exports(native: Path, retained: Path, destination: Path
                    ) -> dict[str, Any]:
    from grid.cohort import RoundLines
    from grid.evidence import record_digest
    from grid.retention import materialize
    from grid.round_storage import frames, read_local, restore, round_path

    began = time.perf_counter()
    materialization = validation = 0.0
    occurrences = 0
    lines = RoundLines()
    for metadata in sorted(retained.rglob("metadata.json")):
        relative = metadata.parent.relative_to(retained)
        exported, original = destination / relative, native / relative
        started = time.perf_counter()
        materialize(metadata.parent, exported)
        materialization += time.perf_counter() - started
        started = time.perf_counter()
        if (exported / "results.csv").read_bytes() != (
                original / "results.csv").read_bytes():
            raise ValueError("Exported CSV differs from recorded bytes")
        identities: list[str] = []
        for folder in (original, exported):
            identity = hashlib.sha256()
            with Path(round_path(str(folder))).open("rb") as stream:
                for raw, _, _ in frames(stream, compact=str(stream.name).endswith(
                        ".gz"), tail=False):
                    record = restore(json.loads(raw), lambda name, folder=folder:
                                     read_local(str(folder), name))
                    identity.update(record_digest(record).encode() + b"\n")
                    if folder == exported:
                        actual = lines.get(str(metadata.parent), record["round_id"])
                        expected = lines.get(str(original), record["round_id"])
                        if record_digest(actual) != record_digest(expected):
                            raise ValueError("Indexed cohort/Trainer read differs")
                        occurrences += 1
            identities.append(identity.hexdigest())
        if identities[0] != identities[1]:
            raise ValueError("Exported typed round evidence differs")
        validation += time.perf_counter() - started
    return {"seconds": time.perf_counter() - began,
            "materialization_seconds": materialization,
            "validation_seconds": validation,
            "exact_occurrences": occurrences, "peak_rss_bytes": rss()}


def run(args: argparse.Namespace) -> None:
    from grid.retention import compact, verify

    corpus, work = args.corpus.resolve(), args.work.resolve()
    if work.exists() or work.is_relative_to(corpus):
        raise ValueError("--work must be a new directory outside the corpus")
    work.mkdir(parents=True)
    native = work / "native"
    setup = time.perf_counter()
    shutil.copytree(corpus, native)
    setup_seconds = time.perf_counter() - setup
    package = Path(__file__).resolve().parents[1]
    reference = (
        args.reference_root.resolve() if args.reference_root else package
    )
    store = (
        args.store.resolve() if args.store else work / "cas/evidence.sqlite3"
    )
    runtime_snapshots: dict[str, Any] = {}
    runtime_client: Any = None
    if args.runtime:
        from grid.replay import ReplayClient
        runtime_client = ReplayClient(store.parent, args.runtime)
        runtime_snapshots["before"] = runtime_client.call({"op": "identity"})
    retained = work / "retained"
    shutil.copytree(native, retained)
    descriptors: list[dict[str, Any]] = []
    migration_started = time.perf_counter()
    for metadata in sorted(retained.rglob("metadata.json")):
        started = time.perf_counter()
        desc = compact(
            metadata.parent,
            store,
            sealed=True,
            prune=True,
            runtime=args.runtime,
        )
        descriptors.append(
            {**desc, "migration_seconds": time.perf_counter() - started}
        )
    migration_seconds = time.perf_counter() - migration_started
    if runtime_client is not None:
        runtime_snapshots["after_migration"] = runtime_client.call(
            {"op": "identity"})
    verification_started = time.perf_counter()
    for metadata in sorted(retained.rglob("metadata.json")):
        verify(metadata.parent)
    verification_seconds = time.perf_counter() - verification_started
    if runtime_client is not None:
        runtime_snapshots["after_full_verification"] = runtime_client.call(
            {"op": "identity"})
    measurements: list[dict[str, Any]] = []
    identities: list[str] | None = None
    for repetition in range(args.repeats):
        order = (
            ("native", "retained")
            if repetition % 2 == 0
            else ("retained", "native")
        )
        for mode in order:
            result = child(
                native if mode == "native" else retained,
                work / "outputs" / ("%d-%s" % (repetition, mode)),
                reference if mode == "native" else package,
            )
            for reading in result["passes"]:
                if identities is None:
                    identities = reading["identities"]
                if reading["identities"] != identities:
                    raise ValueError("Differential analytical output mismatch")
            measurements.append(
                {"repetition": repetition, "mode": mode, **result}
            )
    exported = recover_exports(native, retained, work / "exports")
    export_seconds = exported["seconds"]
    occurrence_count = exported["exact_occurrences"]
    if runtime_client is not None:
        runtime_snapshots["after_export"] = runtime_client.call(
            {"op": "identity"})
    sources = {
        key: value for d in descriptors for key, value in d["sources"].items()
    }
    source_bytes = sum(v["bytes"] for v in sources.values())
    result = {
        "conditions": {
            "repeats": args.repeats,
            "order": "alternating matched fresh processes",
            "page_cache": "not flushed",
            "numeric_tolerance": 0,
            "timing": (
                "imports, setup, fsynced pack outputs; "
                "warm pass in same process"
            ),
            "runtime_provisioning": (
                "separate; include pin receipt and image layers"
            ),
            "reference_root": str(reference),
        },
        "setup_seconds": setup_seconds,
        "migration_seconds": migration_seconds,
        "verification_seconds": verification_seconds,
        "export_seconds": export_seconds,
        "export": exported,
        "exact_occurrences": occurrence_count,
        "peak_parent_rss_bytes": rss(),
        "descriptors": descriptors,
        "bytes": {
            "native_runs": size(native),
            "source_inputs": source_bytes,
            "retained_runs": size(retained),
            "store": store.stat().st_size,
            "assets": size(store.parent / "assets"),
            "runtime_pins": size(store.parent / "runtimes"),
            "temporary_exports": size(work / "exports"),
            "benchmark_outputs": size(work / "outputs"),
        },
        "measurements": measurements,
        "runtime_snapshots": runtime_snapshots,
    }
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {
                "result": str(args.out),
                "bytes": result["bytes"],
                "exact_occurrences": occurrence_count,
            }
        ),
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path)
    parser.add_argument("--work", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--store", type=Path)
    parser.add_argument("--runtime")
    parser.add_argument("--reference-root", type=Path)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--worker")
    args = parser.parse_args()
    if args.worker:
        request = json.loads(args.worker)
        result = worker(request)
        Path(request["output"]).with_suffix(".json").write_text(
            json.dumps(result) + "\n"
        )
        return
    if not args.corpus or not args.work or not args.out or args.repeats < 3:
        parser.error(
            "--corpus, new --work, --out and at least three repeats required"
        )
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    run(args)


if __name__ == "__main__":
    main()
