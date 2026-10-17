"""Native retention/replay/resume proof using the recorded market fixture."""

from __future__ import annotations

import gzip
import importlib
import io
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from grid.__main__ import main as grid_main
from grid.cohort import RoundLines
from grid.evidence import encoded, record_digest
from grid.experiment import (
    Project,
    _slim,  # pyright: ignore[reportPrivateUsage]
)
from grid.replay import ReplayClient
from grid.retention import (
    Reader,
    compact,
    materialize,
    materialize_in_place,
    verify,
)
from grid.round_storage import COMPACT, frames, read_local, restore


def science(run: Path, out: Path) -> bytes:
    grid_main(["pack", "--limen", str(run), "--out", str(out)])
    result = json.loads(out.read_bytes())["runs"][0]
    return encoded(
        {
            key: result.get(key)
            for key in (
                "rows",
                "columns",
                "rounds",
                "bad",
                "badCount",
                "roundsBad",
                "roundsBadCount",
            )
        }
    )


def records(run: Path) -> list[dict[str, Any]]:
    with (run / COMPACT).open("rb") as stream:
        return [
            restore(json.loads(raw), lambda name: read_local(str(run), name))
            for raw, _, _ in frames(stream, compact=True, tail=False)
        ]


def main() -> None:
    evidence = Path("/evidence")
    pin = json.loads((evidence / "replay-pin.json").read_bytes())
    store = evidence / "cas/evidence.sqlite3"
    if (evidence / "restart-ready").exists():
        run = evidence / "cold-recompaction"
        shutil.copytree(evidence / "resumed-native", run)
        client = ReplayClient(store.parent, pin["runtime"])
        before = client.call({"op": "identity"})["statistics"]
        assert before["fit_attempts"] == 0, before
        assert before["execution_evaluations"] == 0, before
        desc = compact(
            run, store, sealed=True, prune=True, runtime=pin["runtime"]
        )
        assert desc["replayed_execution_records"] == 6, desc
        assert desc["replayed_probability_records"] == 6, desc
        after = client.call({"op": "identity"})["statistics"]
        assert after["fit_attempts"] == 0, after
        assert after["execution_evaluations"] == 0, after
        assert science(run, evidence / "cold-science.json") == science(
            evidence / "resumed-native", evidence / "resumed-science.json"
        )
        (evidence / "cold-recompaction.json").write_text(
            json.dumps({"descriptor": desc, "statistics": after}, indent=2)
        )
        return
    yaml: Any = importlib.import_module("ruamel.yaml").YAML()
    fixture = Path("/fixtures/retention/ml")
    with gzip.open(fixture / COMPACT, "rt") as stream:
        point = json.loads(next(stream))["round_params"]
    document: Any = yaml.load((fixture / "s1.yaml").read_text())
    document["metadata"]["name"] = "retention_control"
    document["sfd"]["manifest"]["data_source"]["params"][
        "file_path_or_url"
    ] = "/fixtures/retention/btc_spot_hourly.parquet"
    document["sfd"]["params"] = {key: [value] for key, value in point.items()}
    document["sfd"]["params"]["slip_bps"] = [5.0, 15.0, 25.0, 35.0, 45.0, 55.0]
    document["uel"].update(
        checkpoint_interval=1, n_permutations=6, post_processing=False
    )
    stream = io.StringIO()
    yaml.dump(document, stream)
    with tempfile.TemporaryDirectory(prefix="retention-proof-") as tmp:
        project_root = Path(tmp)
        (project_root / "limen.toml").write_text("[store]\n")
        project = Project(str(project_root), "/usr/local/bin/limen")
        project.create("retention_control", text=stream.getvalue())
        manifest = project.manifest("retention_control")
        rid = project.start(
            "retention_control", 6, 1, True, True, version=manifest["version"]
        )
        proc = project.procs[(rid, "s1")]
        assert proc.wait(timeout=180) == 0, (
            project_root / rid / "logs/s1.log"
        ).read_text()
        deadline = time.monotonic() + 10
        while (
            next(r for r in project.catalog() if r["projectRun"] == rid)[
                "state"
            ]
            != "finished"
        ):
            assert time.monotonic() < deadline
            time.sleep(0.05)
        run = project_root / rid / "s1"
        original_csv = (run / "results.csv").read_bytes()
        original_records = records(run)
        assert len(original_records) == 6
        assert (run / "checkpoint.json").is_file()
        control = project_root / "resume-control"
        shutil.copytree(run, control)
        subprocess.run(
            ["limen", "run", "--no-progress-bar", "--resume", str(control)],
            check=True, timeout=180,
        )
        control_csv = (control / "results.csv").read_bytes()
        control_records = records(control)
        before = science(run, evidence / "before.json")
        started = time.perf_counter()
        desc = compact(
            run, store, sealed=True, prune=True, runtime=pin["runtime"]
        )
        assert desc["replayed_execution_records"] == 6, desc
        assert desc["replayed_probability_records"] == 6, desc
        assert verify(run) == {"records": 6, "exact": True}
        assert science(run, evidence / "retained.json") == before
        lines = RoundLines()
        for original in original_records:
            retained = lines.get(str(run), original["round_id"])
            assert record_digest(retained) == record_digest(original)
        _slim(str(run), str(evidence / "selected"), original_records[:2])
        selected = [
            json.loads(line)
            for line in (evidence / "selected/round_data.jsonl")
            .read_text()
            .splitlines()
        ]
        assert encoded(selected) == encoded(original_records[:2])
        materialize(run, evidence / "native/export")
        assert (
            evidence / "native/export/results.csv"
        ).read_bytes() == original_csv
        assert [
            record_digest(r) for r in records(evidence / "native/export")
        ] == [record_digest(r) for r in original_records]
        reader = Reader(run)
        recipes = [entry["grid"]["replay"] for entry in reader.entries()]
        reader.close()
        assert len({r["model"] for r in recipes}) == 1
        materialize_in_place(run)
        assert (run / "results.csv").read_bytes() == original_csv
        subprocess.run(
            ["limen", "run", "--no-progress-bar", "--resume", str(run)],
            check=True,
            timeout=180,
        )
        # Native resume rewrites CSV serialization. Compare with an untouched
        # native control resumed by the same Limen, rather than its old bytes.
        assert (run / "results.csv").read_bytes() == control_csv
        assert [record_digest(r) for r in records(run)] == [
            record_digest(r) for r in control_records
        ]
        # Keep fully materialized evidence after this disposable runtime exits.
        shutil.copytree(
            run,
            evidence / "resumed-native",
            ignore=shutil.ignore_patterns(".grid-*"),
        )
        elapsed = time.perf_counter() - started
        (evidence / "result.json").write_text(
            json.dumps(
                {
                    "exact_rounds": 6,
                    "model_recipes": 1,
                    "execution_replay": True,
                    "probability_replay": True,
                    "pack_cohort_trainer_export_resume": "exact",
                    "seconds_including_retention_and_recovery": elapsed,
                    "descriptor": desc,
                },
                indent=2,
            )
        )
        for path in evidence.rglob("*"):
            if path.is_file() and path.name != "worker.sock":
                try:
                    path.chmod(0o644)
                except PermissionError:
                    pass


if __name__ == "__main__":
    main()
