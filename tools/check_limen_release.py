"""Native Limen release contracts, invoked by the final-image agent proof."""
from __future__ import annotations

import csv
import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from grid.__main__ import main as grid_main
from grid.agent_client import Client
from grid.cohort import RoundLines
from grid.evidence import encoded, record_digest
from grid.experiment import set_values
from grid.limen import execution_summary
from grid.retention import Reader, compact, materialize, verify


def verify_release(client: Client, project: Path, text: str) -> None:
    def call(operation: str, **args: object) -> dict[str, Any]:
        reply = client.call(operation, args)
        assert reply["ok"], reply
        return reply["result"]

    capabilities = call("grid_discover")["execution"]
    assert capabilities["ruleTemporalReferences"], capabilities
    assert capabilities["recordingPolicy"], capabilities
    start = text.index("\n  params:\n") + 1
    end = text.index("\nuel:", start)
    text = text[:start] + ("  params:\n    fee: [0, 2]\n"
                          "    hold_bars: [1, 3]\n") + text[end:]
    text = set_values(text, {"uel.n_permutations": 4})

    def run(name: str, candidate: str
            ) -> tuple[Path, list[dict[str, Any]], str]:
        checked = call("grid_validate", text=candidate)
        assert checked["errors"] == [], checked
        call("grid_create", name=name, text=candidate, requestId=name)
        manifest = call("grid_manifest", name=name)
        rid = call("grid_start", name=name, version=manifest["version"],
                   rounds=4, shards=1, execution=True, outputs=True,
                   requestId=name + "-start")["run"]
        deadline = time.monotonic() + 120
        while True:
            status = call("grid_status")
            found = next(r for r in status["project"]["runs"]
                         if r["id"] == rid)
            assert found["state"] != "failed", found
            if found["state"] == "finished" and found.get("open"):
                break
            assert time.monotonic() < deadline, found
            time.sleep(0.2)
        directory = project / rid / "s1"
        with (directory / "results.csv").open() as stream:
            rows = list(csv.DictReader(stream))
        assert len(rows) == 4, rows
        reader = RoundLines()
        records = [reader.get(str(directory), row["id"]) for row in rows]
        assert len({r["round_params"]["hold_bars"] for r in records}) == 2
        return directory, records, found["open"]

    for field in ("recency_n", "persistence_n"):
        candidate = text.replace("      entry: enter", (
            "        %s: '{hold_bars}'\n      entry: enter" % field))
        checked = call("grid_validate", text=candidate)
        assert checked["errors"] == [], checked
        for domain in ("[0]", "[-1]", "[true]", "['2']", "[1.5]"):
            invalid = candidate.replace("hold_bars: [1, 3]",
                                        "hold_bars: " + domain)
            checked = call("grid_validate", text=set_values(invalid, {
                "uel.n_permutations": 1}))
            assert any(e["path"].endswith(field) for e in
                       checked["schemaErrors"]), checked
        condition = candidate.index("      - id: enter")
        entry = candidate.index("      entry: enter", condition)
        flow = candidate[:condition] + (
            "      - {id: enter, name: Up bar, type: relative, column: close, "
            "operator: '>', other_column: open, " + field +
            ": '{hold_bars}'}\n") + candidate[entry:]
        assert call("grid_validate", text=flow)["errors"] == []
        runs = [run(field + "_" + str(factorized), set_values(candidate, {
            "uel.factorize": factorized}))[1] for factorized in (False, True)]

        def outputs(records: list[dict[str, Any]]) -> dict[str, Any]:
            return {json.dumps(r["round_params"], sort_keys=True):
                    {k: r[k] for k in ("preds", "execution", "market")}
                    for r in records}

        assert outputs(runs[0]) == outputs(runs[1]), field
        assert len({json.dumps(r["preds"]) for r in runs[0]}) == 2, field

    full_dir, full, _ = run("recording_full", text)
    lean_text = set_values(text, {"uel.recording.predictions": False})
    lean_dir, lean, lean_id = run("recording_lean", lean_text)
    metadata = json.loads((lean_dir / "metadata.json").read_text())
    assert metadata["recording"] == {
        "predictions": False, "alignment": True,
        "trade_ledger": True, "fold_details": True}, metadata
    assert "recording" not in json.loads(
        (full_dir / "metadata.json").read_text())
    with (lean_dir.parent / "manifests/s1.yaml").open() as stream:
        assert "predictions: false" in stream.read()
    for before, after in zip(full, lean, strict=True):
        assert before["round_params"] == after["round_params"]
        assert "preds" in before and "preds" not in after
        assert before["execution"] == after["execution"]
        assert before["market"] == after["market"]
        assert execution_summary(before, 0) == execution_summary(after, 0)
    deadline = time.monotonic() + 30
    while True:
        analysis = call("grid_analyze", analysis="schema", state={
            "run": lean_id, "firstHalf": True, "target": "entries"})
        if analysis["summary"]["n"] == 4:
            break
        assert time.monotonic() < deadline, analysis
        time.sleep(0.2)
    trials = call("grid_analyze", analysis="trials", limit=1,
                  state={"run": lean_id, "firstHalf": True})
    reference = trials["result"]["list"][0]["reference"]
    unavailable = client.call("grid_cohort_evaluate", {"members": [reference]})
    assert not unavailable["ok"], unavailable
    assert "recording.predictions" in str(unavailable), unavailable
    # Native resume must fail before changing any persisted evidence.
    def snapshot() -> dict[str, str]:
        return {str(p.relative_to(lean_dir)): hashlib.sha256(
            p.read_bytes()).hexdigest() for p in lean_dir.rglob("*")
            if p.is_file()}

    before_resume = snapshot()
    resumed = subprocess.run(["limen", "run", "--no-progress-bar", "--resume",
                              str(lean_dir)], capture_output=True, text=True,
                             timeout=60)
    assert resumed.returncode != 0, resumed.stdout
    assert "recording" in resumed.stdout + resumed.stderr, resumed.stderr
    assert snapshot() == before_resume
    # Work on a sealed copy: the agent still holds read leases on live runs.
    retained = project.parent / "retention-lean"
    shutil.copytree(lean_dir, retained)
    original_csv = (retained / "results.csv").read_bytes()

    def science(directory: Path, name: str) -> bytes:
        output = project.parent / (name + ".json")
        grid_main(["pack", "--limen", str(directory), "--out", str(output)])
        result = json.loads(output.read_bytes())["runs"][0]
        return encoded({key: result.get(key) for key in (
            "rows", "columns", "rounds", "bad", "badCount",
            "roundsBad", "roundsBadCount")})

    original_science = science(retained, "lean-original")
    compact(retained, project.parent / "lean-cas/evidence.sqlite3",
            sealed=True, prune=True)
    assert verify(retained) == {"records": 4, "exact": True}
    reader = Reader(retained)
    try:
        entries = list(reader.entries())
        assert all("raw" not in entry["grid"] for entry in entries)
        restored = [reader.restore(entry) for entry in entries]
        assert all("preds" not in record for record in restored)
        assert [record_digest(r) for r in restored] == [
            record_digest(r) for r in lean]
    finally:
        reader.close()
    assert science(retained, "lean-retained") == original_science
    exported = project.parent / "lean-export"
    materialize(retained, exported)
    assert (exported / "results.csv").read_bytes() == original_csv
    assert science(exported, "lean-exported") == original_science
    lines = RoundLines()
    assert [record_digest(lines.get(str(exported), r["round_id"]))
            for r in lean] == [record_digest(r) for r in lean]
    print(json.dumps({"limenRelease": "5.30.2", "temporalParity": "exact",
                      "recordingExecutionParity": "exact",
                      "lighterRetentionExport": "exact, predictions absent",
                      "lighterResume": "rejected without artifact changes"}))
