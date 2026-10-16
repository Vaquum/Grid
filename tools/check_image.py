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
        connection = root / "agent.json"
        log = root / "server.log"
        with log.open("w") as stream:
            server = subprocess.Popen([
                "python", "-m", "grid", "serve", "--project", str(project),
                "--limen", "/fixtures/limen_run", "--bind", "127.0.0.1",
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
                cores = status["project"]["cores"]
                assert cores == effective_cpus() == int(
                    os.environ.get("GRID_EXPECT_CPUS", "2")), status
                assert status["project"]["limen"]["version"] == "5.27.0"
                analysis = call("grid_analyze", analysis="schema",
                                state={"run": "r0"})
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
                assert not call("grid_status")["project"]["runs"]
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
                run_id = call("grid_open", run=rid)["sweepRun"]
                native = call("grid_analyze", analysis="schema",
                              state={"run": run_id, "firstHalf": True})
                assert native["target"]["id"] == "pnl_per_bar_bps_test", native
                assert not native["warnings"], native["warnings"]
                assert {d["id"] for d in native["result"]["dimensions"]} \
                    <= {"fee"}, native
                evidence = os.environ.get("GRID_RULE_EVIDENCE")
                if evidence:
                    shutil.copytree(project / rid / "s1", evidence,
                                    dirs_exist_ok=True)
                print(json.dumps({"imageAgent": "passed", "cores": cores,
                                  "node": subprocess.check_output([
                                      "node", "--version"], text=True).strip(),
                                  "limen": "5.27.0"}))
            finally:
                server.terminate()
                server.wait(timeout=15)


if __name__ == "__main__":
    main()
