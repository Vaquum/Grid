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
import json
import math
import os
import platform
import resource
import subprocess
import sys
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
    return {"rows": len(a), "exact_agreement": not differences,
            "excluded_bookkeeping": ["execution_time", "id", "_id"],
            "differences": differences}


def run(args: argparse.Namespace) -> None:
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
    parser.add_argument("--rounds", type=int, default=60)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--worker", choices=("native", "ingest", "identity"))
    parser.add_argument("--request")
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT))
    if args.worker:
        request = cast(Json, json.loads(args.request))
        result = (identity() if args.worker == "identity" else
                  native(request) if args.worker == "native" else
                  ingest(request))
        Path(request["receipt"]).write_text(json.dumps(result) + "\n")
        return
    if (not args.limen_python or not args.work or not args.out
            or args.rounds < 24 or args.repeats < 3):
        parser.error("--limen-python, new --work, --out, >=24 rounds and "
                     ">=3 repeats required")
    run(args)


if __name__ == "__main__":
    main()
