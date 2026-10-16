"""Final-image agent proof. Run inside the built image with /fixtures
mounted from tests/fixtures and this file mounted under /tmp.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

from grid.agent_client import Client
from grid.capacity import effective_cpus


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="grid-image-") as tmp:
        root = Path(tmp)
        project = root / "project"
        project.mkdir()
        (project / "limen.toml").write_text("[store]\n")
        shutil.copytree("/fixtures/limen_run", project / "results/dev/ml")
        connection = root / "agent.json"
        log = root / "server.log"
        with log.open("w") as stream:
            server = subprocess.Popen([
                "python", "-m", "grid", "serve", "--project", str(project),
                "--bind", "127.0.0.1",
                "--port", "8499", "--agent-file", str(connection)],
                stdout=stream, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 90
                while not connection.exists():
                    if server.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError(log.read_text())
                    time.sleep(0.1)
                client = Client(str(connection))

                def call(operation: str, **args: object) -> dict[str, Any]:
                    reply = client.call(operation, args)
                    assert reply["ok"], reply
                    return reply["result"]

                discover = call("grid_discover")
                assert discover["semantics"]["analysisRuntime"]
                status = call("grid_status")
                deadline = time.monotonic() + 30
                while not status["runs"] or not status["runs"][0]["rows"]:
                    assert time.monotonic() < deadline, status
                    time.sleep(0.1)
                    status = call("grid_status")
                cores = status["project"]["cores"]
                assert cores == effective_cpus() == int(
                    os.environ.get("GRID_EXPECT_CPUS", "2")), status
                assert status["project"]["limen"]["version"] == "5.27.0"
                analysis = call("grid_analyze", analysis="schema",
                                state={"run": status["runs"][0]["id"]})
                assert analysis["result"]["profile"] == "limen", analysis
                manifest = Path("/fixtures/limen_run/"
                                "lightgbm_binary_full.yaml").read_text()
                call("grid_create", name="cpu", text=manifest,
                     requestId="image-cpu-create")
                created = call("grid_manifest", name="cpu")
                rejected = client.call("grid_start", {
                    "name": "cpu", "version": created["version"],
                    "rounds": 10, "shards": cores + 1,
                    "execution": True, "outputs": True,
                    "requestId": "image-cpu-reject"})
                assert not rejected["ok"], rejected
                assert len(call("grid_status")["project"]["runs"]) == 1
                subprocess.run([
                    "python", "/fixtures/generate_rule_run.py", str(project)],
                    check=True)
                rule_text = (project / "rule_smoke.yaml").read_text()
                bad = rule_text.replace("workers: 1", "workers: 2")
                preflight = call("grid_validate", text=bad)
                assert preflight["schemaErrors"] == [], preflight
                assert preflight["executionErrors"][0]["path"] \
                    == "uel.factorize", preflight
                assert call("grid_validate", text=rule_text)["errors"] == []
                call("grid_create", name="rule", text=rule_text,
                     requestId="image-rule-create")
                rule = call("grid_manifest", name="rule")
                rid = call("grid_start", name="rule", version=rule["version"],
                           rounds=40, shards=1, execution=True, outputs=True,
                           requestId="image-rule-start")["run"]
                deadline = time.monotonic() + 120
                while True:
                    status = call("grid_status")
                    run = next(r for r in status["project"]["runs"]
                               if r["id"] == rid)
                    if run["state"] == "finished":
                        break
                    assert run["state"] != "failed", run
                    assert time.monotonic() < deadline, run
                    time.sleep(0.2)
                record = json.loads((project / rid / "grid-run.json")
                                    .read_text())
                assert record["threads"] == cores, record
                # Discovery must put the native run in the human pack
                # before any explicit agent Open operation.
                deadline = time.monotonic() + 30
                while not run.get("open"):
                    assert time.monotonic() < deadline, run
                    time.sleep(0.1)
                    run = next(r for r in call("grid_status")["project"][
                        "runs"] if r["id"] == rid)
                run_id = run["open"]
                with urllib.request.urlopen(
                        "http://127.0.0.1:8499/api/pack") as response:
                    visible = json.load(response)
                assert any(r["id"] == run_id and r["rows"] == 40
                           for r in visible["pack"]["runs"]), visible
                evidence = os.environ.get("GRID_RULE_EVIDENCE")
                if evidence:
                    shutil.copytree(project / rid / "s1", evidence,
                                    dirs_exist_ok=True)
                native = call("grid_analyze", analysis="schema",
                              state={"run": run_id, "firstHalf": True})
                assert native["target"]["id"] == "pnl_per_bar_bps_test", native
                assert not native["warnings"], native["warnings"]
                assert {d["id"] for d in native["result"]["dimensions"]} \
                    <= {"fee"}, native
                selected = call("grid_analyze", analysis="cohort",
                                state={"run": run_id, "firstHalf": True})
                assert selected["result"]["evaluation"]["available"], selected
                evaluated = call("grid_cohort_evaluate",
                                 members=selected["result"]["members"],
                                 fee=0, slip=0)
                assert evaluated["bars"] > 0 and \
                    evaluated["cohort"]["halves"][0]["bars"] > 0, evaluated
                assert evaluated["timestampSource"] \
                    == "original source through Limen", evaluated
                # The native Arrow loader has different kwargs and no
                # kline_size. Its source bars must also evaluate exactly.
                arrow_root = project / "arrow"
                subprocess.run([
                    "python", "/fixtures/generate_rule_run.py", str(arrow_root),
                    "arrow"], check=True)
                call("grid_create", name="arrow", text=(arrow_root /
                     "rule_smoke.yaml").read_text(), requestId="arrow-create")
                arrow = call("grid_manifest", name="arrow")
                arrow_rid = call(
                    "grid_start", name="arrow", version=arrow["version"],
                    rounds=4, shards=1, execution=True, outputs=True,
                    requestId="arrow-start")["run"]
                deadline = time.monotonic() + 120
                while True:
                    run = next(r for r in call("grid_status")["project"][
                        "runs"] if r["id"] == arrow_rid)
                    assert run["state"] != "failed", run
                    if run["state"] == "finished" and run.get("open"):
                        break
                    assert time.monotonic() < deadline, run
                    time.sleep(0.2)
                arrow_selected = call("grid_analyze", analysis="cohort",
                                      state={"run": run["open"],
                                             "firstHalf": True})
                assert arrow_selected["result"]["evaluation"]["available"], \
                    arrow_selected
                print(json.dumps({"imageAgent": "passed", "cores": cores,
                                  "node": subprocess.check_output([
                                      "node", "--version"], text=True).strip(),
                                  "limen": "5.27.0"}))
            finally:
                server.terminate()
                server.wait(timeout=15)


if __name__ == "__main__":
    main()
