"""Report contracts with mocked workers; these timings are not evidence."""

from __future__ import annotations

import argparse
import copy
import csv
import gzip
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from tools import benchmark_recording as benchmark


class RecordingBenchmark(unittest.TestCase):
    def worker(self, python: str, stage: str, request: benchmark.Json,
               output: Path) -> benchmark.Json:
        self.stages.append(stage)
        result: benchmark.Json
        source = benchmark.ROOT / (
            "tests/fixtures/retention/btc_spot_hourly.parquet")
        if stage == "identity":
            result = {
                "python": "mock-runtime", "executable_realpath": python,
                "limen_python_source_sha256": "mock-native-code",
                "distributions": {"vaquum-limen": "5.30.2"},
                "runtime_files_bytes": 100, "base_runtime_files_bytes": 20,
                "limen_code_bytes": 10,
            }
        elif stage == "native":
            manifest = Path(request["manifest"])
            config = json.loads("\n".join(
                line for line in manifest.read_text().splitlines()
                if not line.startswith("#")))
            folder = Path(config["uel"]["output_path"])
            folder.mkdir()
            shutil.copyfile(manifest, folder / "benchmark.yaml")
            (folder / "metadata.json").write_text(json.dumps({
                "round_storage": "gzip-jsonl-v1", "yaml_reference": config,
            }))
            fixture = benchmark.ROOT / "tests/fixtures/retention/ml"
            with gzip.open(fixture / "round_data.jsonl.gz", "rt") as stream:
                record = json.loads(stream.readline())
            if not config["uel"]["record_execution"]:
                record = {key: value for key, value in record.items()
                          if key not in benchmark.PAYLOADS}
                record["alignment"] = {
                    key: value for key, value in record["alignment"].items()
                    if key not in ("missing_datetimes", "test_datetimes")}
            else:
                shutil.copytree(fixture / "round_market",
                                folder / "round_market")
            (folder / "round_data.jsonl.gz").write_bytes(gzip.compress(
                (json.dumps(record) + "\n").encode()))
            with (fixture / "results.csv").open(newline="") as stream:
                reader = csv.reader(stream)
                rows = [next(reader), next(reader)]
            with (folder / "results.csv").open("w", newline="") as stream:
                csv.writer(stream).writerows(rows)
            result = {"import_seconds": 0, "run_seconds": 0, "seconds": 0,
                      "peak_rss_bytes": 1}
        elif stage == "ingest":
            result = {"import_seconds": 0, "ingestion_and_pack_seconds": 0,
                      "seconds": 0, "peak_rss_bytes": 1,
                      "pack_bytes": 1, "rows": 1}
        elif stage == "overhead":
            # Mock only helper execution; verify against the real source bytes.
            data = {"source_identity": {"data": {"files": [{
                "path": str(source), "sha256": benchmark.SOURCE_SHA256,
            }]}}}
            result = {
                "modes": {mode: copy.deepcopy(data)
                          for mode in ("sweep", "inspect")},
                "shared_source_snapshot": {
                    "total_bytes": source.stat().st_size},
            }
        else:
            self.fail("Unexpected benchmark worker: " + stage)
        output.write_text(json.dumps(result) + "\n")
        return result

    def test_fresh_report_verifies_directly_and_rejects_output_tampering(self):
        self.stages: list[str] = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work = root / "campaign"
            args = argparse.Namespace(
                limen_python="mock-runtime", work=work,
                out=root / "report.json", rounds=1, repeats=1,
                verify_report=work,
            )
            with patch.object(benchmark, "child", side_effect=self.worker), \
                    redirect_stdout(io.StringIO()):
                benchmark.run(args)
                report = json.loads(args.out.read_bytes())
                self.assertEqual(report["conditions"][
                    "ingestion_grid_python_sha256"],
                    benchmark.grid_code_hash())
                self.assertIn("grid_launch_overhead", report)
                self.assertIn("runtime_after", report)
                for measurement in report["measurements"]:
                    for key in ("native_evidence_sha256",
                                "native_manifest_sha256",
                                "native_receipt_sha256"):
                        self.assertTrue(measurement[key])
                benchmark.verify_report(args)
                self.assertEqual(self.stages.count("native"), 4)
                changed = work / "ml-0-sweep/run/results.csv"
                changed.write_bytes(changed.read_bytes() + b"\n")
                with self.assertRaisesRegex(
                        ValueError, "Native scientific output changed"):
                    benchmark.verify_report(args)
