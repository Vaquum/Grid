#!/usr/bin/env python3
"""Matched native Sweep/Inspect runs on the recorded BTC hourly source.

Run only after publishing the implementation. Work must be a new directory;
the source corpus is read-only. No synthetic or replayed outcomes are used.
"""

from __future__ import annotations

import argparse
import copy
import csv
import gzip
import hashlib
import importlib
import importlib.metadata
import io
import json
import math
import os
import platform
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SHA256 = (
    "a8e482179a7bf2b0a2a1d006a25298618e5a89cf501304baa0dac956211d01c4"
)
GROUPS = ("predictions", "alignment", "trade_ledger", "fold_details")
PAYLOADS = (
    "preds", "probs", "execution", "market", "market_ref", "trade_ledger",
    "folds", "net_returns",
)
Json = dict[str, Any]


def inventory(root: Path) -> Json:
    files = {
        str(p.relative_to(root)): p.stat().st_size
        for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()
    }
    return {"total_bytes": sum(files.values()), "files": files}


def peak_rss() -> int:
    status = Path("/proc/self/status")
    if status.exists():
        for line in status.read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) * 1024
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def head() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()


def config(kind: str, mode: str, source: Path, rounds: int) -> Json:
    saved = ROOT / "tests/fixtures/retention/ml/metadata.json"
    value = cast(Json, json.loads(saved.read_bytes())["yaml_reference"])
    value = copy.deepcopy(value)
    value["metadata"].update(
        name="recording_benchmark_" + kind, limen_version="5.30.2"
    )
    manifest = value["sfd"]["manifest"]
    manifest["data_source"]["params"]["file_path_or_url"] = str(source)
    if kind == "rule":
        value["sfd"] = {
            "manifest": {
                "type": "rule_based",
                "data_source": manifest["data_source"],
                "split_dates": manifest["split_dates"],
                "indicators": [{
                    "func": "limen.indicators.window_return",
                    "params": {"period": 24},
                }],
                "strategy": {
                    "conditions": [{
                        "id": "entry", "name": "positive_24h_return",
                        "type": "threshold", "column": "ret_24",
                        "operator": ">", "value": "{entry_return}",
                    }],
                    "entry": "entry",
                },
                "backtest": manifest["backtest"],
                "reference_architecture": (
                    "limen.sfd.reference_architecture.rule_based"
                ),
                "strict_mode": True,
            },
            "params": {
                "entry_return": [-0.01, -0.005, 0.0, 0.005, 0.01],
                "slip_bps": [5.0, 15.0],
                "stop_loss_bps": [None, 75.0, 150.0, 300.0, 600.0],
                "take_profit_bps": [None, 200.0, 600.0],
            },
        }
    enabled = mode == "inspect"
    value["uel"].update(
        n_permutations=rounds, workers=1, factorize=False,
        search_strategy={"type": "random", "seed": 133},
        record_execution=enabled, record_model_outputs=enabled,
        recording=dict.fromkeys(GROUPS, enabled),
        checkpoint_interval=1000,
    )
    return value


def arrays(value: Any, path: str = "") -> dict[str, int]:
    found: dict[str, int] = {}
    if isinstance(value, dict):
        for key, item in cast(Json, value).items():
            found.update(arrays(item, path + "." + key))
    elif isinstance(value, list):
        found[path] = len(cast(list[Any], value))
        for item in cast(list[Any], value):
            if isinstance(item, dict):
                found.update(arrays(item, path + "[]"))
    return found


def audit(folder: Path, mode: str, expected: int) -> Json:
    from grid.round_storage import frames, round_path

    path = Path(round_path(str(folder)))
    count = 0
    paths: dict[str, int] = {}
    parameters: list[Json] = []
    with path.open("rb") as stream:
        for raw, _, _ in frames(stream, compact=path.suffix == ".gz",
                                tail=False):
            record = cast(Json, json.loads(raw))
            count += 1
            parameters.append(record["round_params"])
            for key, length in arrays(record).items():
                paths[key] = max(paths.get(key, 0), length)
            if mode == "sweep":
                forbidden = [key for key in PAYLOADS
                             if record.get(key) is not None]
                alignment = record.get("alignment", {})
                forbidden.extend(
                    "alignment." + key for key in
                    ("missing_datetimes", "test_datetimes")
                    if key in alignment
                )
                if forbidden:
                    raise ValueError("Sweep emitted per-bar data: "
                                     + ", ".join(forbidden))
    if count != expected:
        raise ValueError("Expected %d successful rounds; received %d"
                         % (expected, count))
    return {"successful_rounds": count, "array_paths_max_lengths": paths,
            "parameters": parameters,
            "no_per_bar_result_payloads": mode == "sweep"}


def native(request: Json) -> Json:
    began = time.perf_counter()
    runner = importlib.import_module("limen.cli.commands.run")
    imported = time.perf_counter()
    succeeded = runner.run_experiment(
        Path(request["manifest"]), progress_bar=False
    )
    if not succeeded:
        raise ValueError("Native Limen execution failed; inspect worker log")
    return {"import_seconds": imported - began,
            "run_seconds": time.perf_counter() - imported,
            "seconds": time.perf_counter() - began,
            "peak_rss_bytes": peak_rss()}


def ingest(request: Json) -> Json:
    began = time.perf_counter()
    from grid.__main__ import main as grid_main

    imported = time.perf_counter()
    output = Path(request["pack"])
    grid_main(["pack", "--limen", request["run"], "--out", str(output)])
    with output.open("rb") as stream:
        os.fsync(stream.fileno())
    ended = time.perf_counter()
    memory = peak_rss()
    pack = json.loads(gzip.decompress(output.read_bytes()))
    return {"import_seconds": imported - began,
            "ingestion_and_pack_seconds": ended - imported,
            "seconds": ended - began, "peak_rss_bytes": memory,
            "pack_bytes": output.stat().st_size,
            "rows": sum(run["rows"] for run in pack["runs"])}


def identity() -> Json:
    limen = importlib.import_module("limen")
    polars = importlib.import_module("polars")
    source = ROOT / "tests/fixtures/retention/btc_spot_hourly.parquet"
    bars = polars.read_parquet(source)
    runtime_root = Path(sys.prefix)
    runtime = inventory(runtime_root)
    assert limen.__file__ is not None
    code_root = Path(limen.__file__).resolve().parent
    code_hash = hashlib.sha256()
    for path in sorted(code_root.rglob("*.py")):
        code_hash.update(str(path.relative_to(code_root)).encode() + b"\0")
        code_hash.update(path.read_bytes())
    return {
        "python": sys.version, "executable": str(Path(sys.executable)),
        "executable_realpath": str(Path(sys.executable).resolve()),
        "executable_bytes": Path(sys.executable).stat().st_size,
        "platform": platform.platform(), "machine": platform.machine(),
        "limen_source": str(code_root),
        "limen_code_bytes": inventory(code_root)["total_bytes"],
        "limen_python_source_sha256": code_hash.hexdigest(),
        "runtime_prefix": str(runtime_root),
        "runtime_files_bytes": runtime["total_bytes"],
        "base_runtime_prefix": sys.base_prefix,
        "base_runtime_files_bytes": inventory(
            Path(sys.base_prefix))["total_bytes"],
        "distributions": {
            dist.metadata["Name"]: dist.version
            for dist in importlib.metadata.distributions()
        },
        "source_rows": bars.height,
        "source_first_datetime": str(bars["datetime"].min()),
        "source_last_datetime": str(bars["datetime"].max()),
    }


def launch_overhead(request: Json) -> Json:
    """Measure actual source snapshots and portable launch identity bytes."""
    from grid.experiment import set_values
    from grid.provenance import launch_identity
    from grid.recording import mark_manifest

    yaml = importlib.import_module("ruamel.yaml").YAML()
    # Grid's manifest editing contract keeps scalar source paths on one line.
    yaml.width = 4096
    root = Path(request["root"])
    root.mkdir(parents=True)
    source = ROOT / "tests/fixtures/retention/btc_spot_hourly.parquet"
    modes: Json = {}
    for mode in ("sweep", "inspect"):
        stream = io.StringIO()
        yaml.dump(config("ml", mode, source, request["rounds"]), stream)
        original = mark_manifest(stream.getvalue(), mode)
        source_identity, runtime_identity = launch_identity(
            original, str(root), str(Path(sys.executable).with_name("limen")),
            sys.executable, "5.30.2",
        )
        data = source_identity["data"]
        if data.get("available") is not True or not runtime_identity.get(
                "verified"):
            raise ValueError("Grid launch identity is not verifiable: "
                             + json.dumps({"source": data,
                                           "runtime": runtime_identity}))
        if data["files"][0]["sha256"] != SOURCE_SHA256:
            raise ValueError("Grid launch snapshot differs from source")
        identities = {"sourceIdentity": source_identity,
                      "runtimeIdentity": runtime_identity}
        encoded = json.dumps(identities, separators=(",", ":"),
                             sort_keys=True, allow_nan=False)
        rewritten = set_values(original, {
            data["manifestKey"]: data["executionPath"]})
        launched = "# grid-launch-identity: " + encoded + "\n" + rewritten
        folder = root / mode
        folder.mkdir()
        (folder / "original.yaml").write_text(original)
        (folder / "launch.yaml").write_text(launched)
        (folder / "identity.json").write_text(encoded + "\n")
        modes[mode] = {
            "identity_json_bytes": (folder / "identity.json").stat().st_size,
            "original_manifest_bytes": len(original.encode()),
            "launched_manifest_bytes": len(launched.encode()),
            "manifest_increase_bytes": len(launched.encode())
            - len(original.encode()),
            "source_identity": source_identity,
            "runtime_identity": runtime_identity,
        }
    return {"modes": modes,
            "shared_source_snapshot": inventory(root / ".grid/sources"),
            "scope": (
                "Actual launch_identity helper, source snapshot, runtime "
                "identity JSON and portable manifest comment. No strategy "
                "execution or Project run journal is included in this "
                "overhead probe; native campaign run totals exclude these "
                "separately measured Grid wrapper artifacts."
            )}


def child(python: str, stage: str, request: Json, output: Path) -> Json:
    request["receipt"] = str(output)
    began = time.perf_counter()
    with output.with_suffix(".log").open("w") as log:
        completed = subprocess.run(
            [python, str(Path(__file__).resolve()), "--worker", stage,
             "--request", json.dumps(request)],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONPATH": str(ROOT),
                 "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
                 "MKL_NUM_THREADS": "1", "POLARS_MAX_THREADS": "1",
                 "PYTHONHASHSEED": "0"},
        )
    if completed.returncode:
        raise ValueError("Benchmark worker failed: "
                         + str(output.with_suffix(".log")))
    result = cast(Json, json.loads(output.read_bytes()))
    result["process_seconds"] = time.perf_counter() - began
    return result


def scalar_rows(folder: Path) -> list[dict[str, str]]:
    with (folder / "results.csv").open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    if any(row.get("strict_mode_error") for row in rows):
        raise ValueError("Strict-mode failure is not a successful benchmark")
    return [{key: value for key, value in row.items()
             if key not in ("execution_time", "id", "_id")} for row in rows]


def compare(left: Path, right: Path) -> Json:
    a, b = scalar_rows(left), scalar_rows(right)
    differences: list[Json] = []
    if len(a) != len(b):
        raise ValueError("Matched runs have different row counts")
    for index, (first, second) in enumerate(zip(a, b, strict=True)):
        for key in sorted(first.keys() | second.keys()):
            if first.get(key) == second.get(key):
                continue
            difference: Json = {"round": index, "field": key,
                                "left": first.get(key),
                                "right": second.get(key)}
            try:
                delta = abs(float(first[key]) - float(second[key]))
                difference["absolute_difference"] = (
                    delta if math.isfinite(delta) else None
                )
            except (KeyError, ValueError):
                difference["absolute_difference"] = None
            differences.append(difference)
    first_fields: set[str] = set(a[0]) if a else set[str]()
    second_fields: set[str] = set(b[0]) if b else set[str]()
    common: set[str] = first_fields & second_fields
    return {"rows": len(a), "exact_agreement": not differences,
            "scalar_result_sets_agree": not differences,
            "shared_scalar_values_exact_agreement": not any(
                d["field"] in common for d in differences),
            "missing_in_sweep": sorted(second_fields - first_fields),
            "missing_in_inspect": sorted(first_fields - second_fields),
            "excluded_bookkeeping": ["execution_time", "id", "_id"],
            "differences": differences}


def evidence_hashes(folder: Path) -> dict[str, str]:
    return {str(path.relative_to(folder)): digest(path)
            for path in sorted(folder.rglob("*")) if path.is_file()}


def grid_code_hash() -> str:
    return hashlib.sha256(json.dumps(
        {name: value for name, value in evidence_hashes(
            ROOT / "grid").items() if name.endswith(".py")},
        sort_keys=True).encode()).hexdigest()


def check_runtime(previous: Json, current: Json) -> None:
    for key in ("python", "executable_realpath", "limen_python_source_sha256",
                "distributions"):
        if previous[key] != current[key]:
            raise ValueError("Native runtime changed: " + key)


def check_native(work: Path, conditions: Json, original: Json,
                 *, require_hashes: bool = False) -> tuple[Path, Json, Json]:
    kind, repeat, mode = (original[key] for key in
                          ("workload", "repetition", "mode"))
    folder = work / ("%s-%d-%s" % (kind, repeat, mode))
    run_dir = folder / "run"
    source = ROOT / "tests/fixtures/retention/btc_spot_hourly.parquet"
    expected = config(kind, mode, source, conditions["rounds_per_run"])
    expected["uel"]["output_path"] = str(run_dir)
    text = (folder / "benchmark.yaml").read_text()
    declared = json.loads("\n".join(
        line for line in text.splitlines() if not line.startswith("#")))
    metadata = json.loads((run_dir / "metadata.json").read_bytes())
    for candidate in (declared, metadata["yaml_reference"]):
        if json.dumps(candidate, sort_keys=True) != json.dumps(
                expected, sort_keys=True):
            raise ValueError("Native scientific config changed")
    if (run_dir / "benchmark.yaml").read_text() != text:
        raise ValueError("Native manifest copy changed")
    hashes = evidence_hashes(run_dir)
    if require_hashes and "native_evidence_sha256" not in original:
        raise ValueError("Report lacks native scientific evidence hashes")
    if original.get("native_evidence_sha256", hashes) != hashes:
        raise ValueError("Native scientific output changed")
    for key, path in (
        ("native_manifest_sha256", folder / "benchmark.yaml"),
        ("native_receipt_sha256", folder / "native.json"),
    ):
        actual = digest(path)
        if original.get(key, actual) != actual:
            raise ValueError("Native generation receipt changed")
    return run_dir, audit(run_dir, mode, conditions["rounds_per_run"]), hashes


def verify_report(args: argparse.Namespace) -> None:
    report = cast(Json, json.loads(args.out.read_bytes()))
    conditions = report["conditions"]
    if conditions.get("ingestion_grid_python_sha256") != grid_code_hash():
        raise ValueError("Report did not ingest the current Grid Python code")
    source = ROOT / "tests/fixtures/retention/btc_spot_hourly.parquet"
    if digest(source) != SOURCE_SHA256 or conditions[
            "source_sha256"] != SOURCE_SHA256:
        raise ValueError("Benchmark source checksum differs")
    with tempfile.TemporaryDirectory(prefix="grid-benchmark-verify-") as temp:
        current = child(args.limen_python, "identity", {},
                        Path(temp) / "runtime.json")
    check_runtime(report["runtime"], current)
    work = args.verify_report.resolve()
    for measurement in report["measurements"]:
        _, proof, _ = check_native(work, conditions, measurement,
                                   require_hashes=True)
        if proof != measurement["audit"]:
            raise ValueError("Recorded round/parameter audit changed")
    for comparison in report["scalar_comparisons"]:
        label = "%s-%d-" % (comparison["workload"], comparison["repetition"])
        fresh = compare(work / (label + "sweep") / "run",
                        work / (label + "inspect") / "run")
        if fresh != {key: value for key, value in comparison.items()
                     if key not in ("workload", "repetition")}:
            raise ValueError("Recorded scalar comparison changed")
    for mode in report["grid_launch_overhead"]["modes"].values():
        for file in mode["source_identity"]["data"]["files"]:
            if digest(Path(file["path"])) != file["sha256"]:
                raise ValueError("Grid retained source snapshot changed")
    print(json.dumps({"verified_report": str(args.out),
                      "grid_code_sha256": grid_code_hash(),
                      "native_runs": len(report["measurements"])}), flush=True)


def remeasure(args: argparse.Namespace) -> None:
    """Reuse native science only after checking its exact recorded inputs."""
    work = args.remeasure_existing.resolve()
    raw = args.out.read_bytes()
    previous = cast(Json, json.loads(raw))
    conditions = previous["conditions"]
    source = ROOT / "tests/fixtures/retention/btc_spot_hourly.parquet"
    actual_source = digest(source)
    if (actual_source != conditions["source_sha256"]
            or actual_source != SOURCE_SHA256):
        raise ValueError("Benchmark source checksum differs")
    archived = work / "report-history" / (
        hashlib.sha256(raw).hexdigest() + ".json")
    archived.parent.mkdir(exist_ok=True)
    if archived.exists() and archived.read_bytes() != raw:
        raise ValueError("Benchmark report archive conflicts")
    archived.write_bytes(raw)
    receipts = work / "remeasure" / str(time.time_ns())
    receipts.mkdir(parents=True)
    runtime = child(args.limen_python, "identity", {}, receipts / "runtime.json")
    check_runtime(previous["runtime"], runtime)
    native_head = conditions.get("native_generation_grid_head") or \
        args.native_head
    if not native_head:
        raise ValueError("--native-head must identify original native receipts")
    native_head = subprocess.check_output(
        ["git", "rev-parse", "--verify", native_head + "^{commit}"],
        cwd=ROOT, text=True).strip()
    result = copy.deepcopy(previous)
    measurements: list[Json] = []
    comparisons: list[Json] = []
    for kind in ("ml", "rule"):
        for repeat in range(conditions["repetitions"]):
            pair: dict[str, Path] = {}
            parameters: list[Json] | None = None
            for mode in (("sweep", "inspect") if repeat % 2 == 0 else
                         ("inspect", "sweep")):
                label = "%s-%d-%s" % (kind, repeat, mode)
                folder = work / label
                original = next(m for m in previous["measurements"] if
                                (m["workload"], m["repetition"], m["mode"])
                                == (kind, repeat, mode))
                run_dir, proof, hashes = check_native(
                    work, conditions, original)
                if parameters is not None and proof["parameters"] != parameters:
                    raise ValueError("Matched native parameters differ")
                parameters = proof["parameters"]
                print("remeasure ingest " + label, flush=True)
                ingestion = child(
                    args.limen_python, "ingest",
                    {"run": str(run_dir),
                     "pack": str(receipts / (label + ".pack.json.gz"))},
                    receipts / (label + ".json"),
                )
                measurements.append({
                    **original, "ingestion": ingestion, "audit": proof,
                    "native_evidence_sha256": hashes,
                    "native_manifest_sha256": digest(folder / "benchmark.yaml"),
                    "native_receipt_sha256": digest(folder / "native.json"),
                })
                pair[mode] = run_dir
            comparisons.append({"workload": kind, "repetition": repeat,
                                **compare(pair["sweep"], pair["inspect"])})
    overhead = child(
        args.limen_python, "overhead",
        {"root": str(receipts / "grid-launch"),
         "rounds": conditions["rounds_per_run"]},
        receipts / "grid-launch.json",
    )
    result.update(measurements=measurements, scalar_comparisons=comparisons,
                  grid_launch_overhead=overhead, runtime_after=runtime)
    result["shared_bytes"].update(
        runtime_files_after=runtime["runtime_files_bytes"],
        runtime_files_growth=(runtime["runtime_files_bytes"]
                              - previous["runtime"]["runtime_files_bytes"]),
        grid_retained_source_snapshot=overhead[
            "shared_source_snapshot"]["total_bytes"],
    )
    result["conditions"].update(
        native_generation_grid_head=native_head,
        ingestion_grid_head=head(),
        ingestion_grid_python_sha256=grid_code_hash(),
        native_receipts_reused=True, previous_report_sha256=digest(archived),
        previous_report_archive=str(archived),
    )
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(str(args.out), flush=True)


def run(args: argparse.Namespace) -> None:
    native_head = head()
    source = ROOT / "tests/fixtures/retention/btc_spot_hourly.parquet"
    if digest(source) != SOURCE_SHA256:
        raise ValueError("Recorded BTC input checksum changed")
    work = args.work.resolve()
    if work.exists():
        raise ValueError("--work must be a new directory")
    work.mkdir(parents=True)
    cache = Path.home() / ".cache/limen/datasets"
    cache_before = inventory(cache)
    runtime = child(args.limen_python, "identity", {}, work / "runtime.json")
    if runtime["distributions"].get("vaquum-limen") != "5.30.2":
        raise ValueError("Use the native Limen 5.30.2 runtime")
    measurements: list[Json] = []
    comparisons: list[Json] = []
    for kind in ("ml", "rule"):
        for repeat in range(args.repeats):
            pair: dict[str, Path] = {}
            params: list[Json] | None = None
            order = ("sweep", "inspect") if repeat % 2 == 0 else (
                "inspect", "sweep")
            for mode in order:
                label = "%s-%d-%s" % (kind, repeat, mode)
                folder = work / label
                folder.mkdir()
                run_dir = folder / "run"
                value = config(kind, mode, source, args.rounds)
                value["uel"]["output_path"] = str(run_dir)
                manifest = folder / "benchmark.yaml"
                manifest.write_text("# grid-recording-mode: %s\n%s\n"
                                    % (mode, json.dumps(value, indent=2)))
                print("native " + label, flush=True)
                generation = child(
                    args.limen_python, "native", {"manifest": str(manifest)},
                    folder / "native.json",
                )
                proof = audit(run_dir, mode, args.rounds)
                if params is not None and params != proof["parameters"]:
                    raise ValueError("Recording mode changed sampled params")
                params = proof["parameters"]
                print("ingest " + label, flush=True)
                ingestion = child(
                    args.limen_python, "ingest",
                    {"run": str(run_dir),
                     "pack": str(folder / "result.pack.json.gz")},
                    folder / "ingestion.json",
                )
                measurements.append({
                    "workload": kind, "repetition": repeat, "mode": mode,
                    "generation": generation, "ingestion": ingestion,
                    "run_files": inventory(run_dir), "audit": proof,
                    "run_shared_market_bytes": inventory(
                        run_dir / "round_market")["total_bytes"],
                })
                pair[mode] = run_dir
            comparisons.append({
                "workload": kind, "repetition": repeat,
                **compare(pair["sweep"], pair["inspect"]),
            })
    cache_after = inventory(cache)
    result = {
        "conditions": {
            "native_generation_grid_head": native_head,
            "rounds_per_run": args.rounds, "repetitions": args.repeats,
            "order": "alternating fresh native and ingestion processes",
            "page_cache": "not flushed; no cold-I/O claim",
            "source": str(source), "source_sha256": SOURCE_SHA256,
            "search_seed": 133, "model_random_state": 42,
            "workers_and_numeric_threads": 1,
            "factorize": False,
            "interpretation": (
                "Observed workload totals; no campaign extrapolation. "
                "Scalar differences are reported, never rounded away. "
                "Runtime/import and generation memory differ from ingestion."
            ),
        },
        "runtime": runtime,
        "shared_bytes": {
            "source_market_input": source.stat().st_size,
            "runtime_files": runtime["runtime_files_bytes"],
            "base_runtime_files": runtime["base_runtime_files_bytes"],
            "native_code": runtime["limen_code_bytes"],
            "dataset_cache_before": cache_before["total_bytes"],
            "dataset_cache_after": cache_after["total_bytes"],
            "dataset_cache_growth": (cache_after["total_bytes"]
                                     - cache_before["total_bytes"]),
            "retention_store_created_by_benchmark": 0,
        },
        "overhead_accounting": (
            "Shared source and pre-existing runtime are counted once, "
            "separate from run totals. Native code may be inside the runtime; "
            "these inventories must not be summed without deduplication. "
            "Sizes are regular-file lengths, exclude symlinks, filesystem "
            "allocation and OS libraries. The executable target is separate. "
            "Native round_market blobs are included in each run total and "
            "also itemized. No retention migration or replay runtime is used."
        ),
        "measurements": measurements, "scalar_comparisons": comparisons,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(str(args.out), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limen-python")
    parser.add_argument("--work", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--remeasure-existing", type=Path)
    parser.add_argument("--verify-report", type=Path)
    parser.add_argument("--native-head")
    parser.add_argument("--rounds", type=int, default=60)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--worker", choices=(
        "native", "ingest", "identity", "overhead"))
    parser.add_argument("--request")
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT))
    if args.worker:
        request = cast(Json, json.loads(args.request))
        result = (identity() if args.worker == "identity" else
                  native(request) if args.worker == "native" else
                  ingest(request) if args.worker == "ingest" else
                  launch_overhead(request))
        Path(request["receipt"]).write_text(json.dumps(result) + "\n")
        return
    if args.remeasure_existing:
        if not args.limen_python or not args.out:
            parser.error("--remeasure-existing requires --limen-python --out")
        remeasure(args)
        return
    if args.verify_report:
        if not args.limen_python or not args.out:
            parser.error("--verify-report requires --limen-python --out")
        verify_report(args)
        return
    if (not args.limen_python or not args.work or not args.out
            or args.rounds < 24 or args.repeats < 3):
        parser.error("--limen-python, new --work, --out, >=24 rounds and "
                     ">=3 repeats required")
    run(args)


if __name__ == "__main__":
    main()
