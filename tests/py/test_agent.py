"""JSON/MCP workflow, retry receipts, authentication and stale evidence."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from grid.__main__ import Wiring
from grid.agent import TOOLS, Agent
from grid.agent_client import Client, mcp_reply, write_connection
from grid.experiment import Project, set_values
from grid.server import Server, serve

ROOT = Path(__file__).resolve().parents[2]
FAKE = str(ROOT / "tests/fixtures/fake_limen.py")
FIXTURE = str(ROOT / "tests/fixtures/limen_cohort")


class TestAgent(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.mkdtemp(prefix="grid-agent-")
        self.project_root = os.path.join(self.temp, "project")
        os.mkdir(self.project_root)
        Path(self.project_root, "limen.toml").write_text("[store]\n")
        self.project = Project(self.project_root, FAKE)
        self.project.python = sys.executable
        args = argparse.Namespace(limen=[FIXTURE], results=None, name=None,
                                  ssh=None, as_=None, log=None, run=None,
                                  label=None, project=None)
        wiring = Wiring(args, follow=False)
        self.wiring = wiring
        self.sweep = wiring.build()
        wiring.read_once()
        self.server = Server(self.sweep, lambda: b"page", self.project,
                             "page-token", "agent-token")
        self.agent = self.server.agent
        assert self.agent is not None
        self.httpd = serve(self.sweep, lambda: b"page", "127.0.0.1", 0,
                           self.project, "page-token", "agent-token")
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.connection = os.path.join(self.temp, "connection.json")
        write_connection(self.connection, self.url, "agent-token")
        self.client = Client(self.connection)
        self.old_path = os.environ.get("PYTHONPATH")
        os.environ["PYTHONPATH"] = str(ROOT / "tests/fixtures/fake_limen_pkg")

    def tearDown(self) -> None:
        for run in self.project.runs():
            if run["state"] == "running":
                self.project.stop(run["id"])
        for proc in self.project.procs.values():
            proc.wait(timeout=10)
        for watcher in self.project.watchers.values():
            watcher.join(20)
        self.httpd.shutdown()
        self.httpd.server_close()
        if self.old_path is None:
            os.environ.pop("PYTHONPATH", None)
        else:
            os.environ["PYTHONPATH"] = self.old_path
        shutil.rmtree(self.temp)

    def call(self, operation: str, **args):
        response = self.client.call(operation, args)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def example(self, *arguments):
        proc = subprocess.run([
            sys.executable, "tools/agent_workflow.py", "--connection",
            self.connection, "--journal", os.path.join(self.temp, "intents"),
            "--timeout", "30", *arguments], cwd=ROOT,
            capture_output=True, text=True, check=False)
        result = json.loads(proc.stdout)
        self.assertEqual(proc.returncode, 0, result)
        self.assertTrue(result["ok"], result)
        return result["result"]

    def test_parallel_factorize_preflight_and_capabilities(self):
        self.project.version = "5.27.0"
        self.project.cores = 8
        text = (ROOT / "tests/fixtures/limen_run/"
                "lightgbm_binary_full.yaml").read_text()
        text = set_values(text, {"uel.workers": 2, "uel.factorize": True,
                                 "uel.search_strategy.type": "grid"})
        checked = self.call("grid_validate", text=text)
        self.assertEqual(checked["schemaErrors"], [])
        self.assertTrue(checked["executionChecked"])
        self.assertEqual(checked["errors"][0]["path"], "uel.factorize")
        self.assertIn("workers: 1", checked["executionErrors"][0]["message"])
        self.call("grid_create", name="factor", text=text, requestId="factor")
        manifest = self.call("grid_manifest", name="factor")
        with patch.object(self.project, "_spawn") as spawn:
            result = self.client.call("grid_start", {
                "name": "factor", "version": manifest["version"],
                "rounds": 108, "shards": 1, "execution": True,
                "outputs": True, "requestId": "factor-start"})
        self.assertFalse(result["ok"])
        self.assertIn("uel.factorize", result["error"]["message"])
        spawn.assert_not_called()
        self.assertEqual(self.project.runs(), [])
        self.assertFalse(os.path.exists(os.path.join(
            self.project_root, "results")))
        serial = set_values(text, {"uel.workers": 1})
        self.assertEqual(self.call("grid_validate", text=serial)["errors"], [])
        capabilities = self.call("grid_discover")["execution"]
        self.assertTrue(capabilities["parallelRounds"])
        self.assertFalse(capabilities["parallelFactorize"])
        self.assertEqual(capabilities["cpuBudget"], 8)
        self.assertEqual(self.call("grid_status")["project"]["cores"], 8)

    def test_workers_share_cpu_budget_with_shards(self):
        self.project.version = "5.27.0"
        self.project.cores = 8
        text = (ROOT / "tests/fixtures/limen_run/"
                "lightgbm_binary_full.yaml").read_text()
        text = set_values(text, {"uel.workers": 4,
                                 "uel.prep_each_round": True})
        self.project.create("workers", text=text)
        with self.assertRaisesRegex(ValueError, "shards.*uel.workers"):
            self.project.start("workers", 12, 3, True, True)
        self.assertEqual(self.project.runs(), [])
        with patch.object(self.project, "_spawn", side_effect=OSError("test")), \
                self.assertRaisesRegex(ValueError, "could not be started"):
            self.project.start("workers", 12, 2, True, True)
        run = self.project.runs()[0]
        record = json.loads(Path(self.project_root, run["id"],
                                 "grid-run.json").read_text())
        self.assertEqual(record["threads"], 1)
        self.assertEqual(record["workers"], 4)

    def test_preflight_distinguishes_schema_and_execution_errors(self):
        self.project.version = "5.27.0"
        self.project.cores = 8
        for text, path in (("uel:\n  workers: 2\n", "uel.prep_each_round"),
                           ("uel:\n  workers: 9\n", "uel.workers"),
                           ("uel: {workers: 2, factorize: true}\n", "uel")):
            checked = self.call("grid_validate", text=text)
            self.assertEqual(checked["schemaErrors"], [])
            self.assertEqual(checked["executionErrors"][0]["path"], path)
        bad = self.call("grid_validate", text="BAD_VALUE")
        self.assertTrue(bad["schemaErrors"])
        self.assertFalse(bad["executionChecked"])

    def test_worker_diagnostics_stay_in_private_logs(self):
        proc = subprocess.CompletedProcess([], 1, "", "private worker detail")
        with patch("grid.agent.subprocess.run", return_value=proc), \
                self.assertLogs("grid.agent", level="ERROR") as logs:
            result = self.agent.call("grid_analyze", {"analysis": "schema"})
        self.assertIn("private worker detail", logs.output[0])
        self.assertFalse(result["ok"])
        self.assertNotIn("private worker detail", json.dumps(result))

    def test_documented_inspection_and_predictor_workflow(self):
        inspected = self.example("inspect", "--run", "r0")
        ids = {q["snapshot"]["id"] for q in inspected.values()}
        self.assertEqual(len(ids), 1)
        self.assertLessEqual(len(inspected["trials"]["result"]["list"]), 5)
        trained = self.example("cohort", "--run", "r0", "--name",
                               "documented", "--members", "2")
        self.assertTrue(trained["selection"]["result"]["firstHalfSelection"])
        self.assertIsNotNone(trained["evaluation"]["cohort"]["halves"])
        self.assertEqual(trained["predictor"]["state"], "made")
        self.assertIsNotNone(trained["predictor"]["cohortId"])

    def test_documented_experiment_workflow(self):
        def open_run(key, dirs, planned):
            run_id = self.wiring.open_limen(key, dirs, planned)
            self.wiring.read_once()
            return run_id

        self.project.opener = open_run
        result = self.example("experiment", "--name", "documented",
                              "--template", "lightgbm_binary",
                              "--rounds", "40")
        self.assertEqual(result["job"]["state"], "finished")
        self.assertEqual(result["job"]["rows"], 40)
        self.assertEqual(result["analysisRun"], result["analysis"]["schema"][
            "snapshot"]["run"])
        journal = Path(self.temp, "intents")
        entries = [json.loads(line)
                   for line in journal.read_text().splitlines()]
        self.assertEqual([e["operation"] for e in entries],
                         ["grid_create", "grid_save", "grid_start"])
        self.assertEqual(stat.S_IMODE(journal.stat().st_mode), 0o600)
        original = entries[-1]
        recovered = self.example("recover", "--request-id",
                                 original["arguments"]["requestId"])
        self.assertEqual(recovered["response"]["result"]["run"],
                         result["projectRun"])
        # Replaying the exact documented journal entry returns its old run.
        retried = self.client.call(original["operation"],
                                   original["arguments"])
        self.assertEqual(retried, recovered["response"])
        self.assertEqual(len(self.project.runs()), 1)

    def test_documented_stop_and_resume_wait_for_observed_state(self):
        self.call("grid_create", name="control", template="lightgbm_binary",
                  requestId="control-create")
        manifest = self.call("grid_manifest", name="control")
        run = self.call("grid_start", name="control", rounds=200, shards=1,
                        execution=True, outputs=True,
                        version=manifest["version"],
                        requestId="control-start")["run"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.project.runs()[0]["rows"] > 0:
                break
            time.sleep(0.01)
        stopped = self.example("control", "stop", "--run", run)
        self.assertEqual(stopped["state"], "stopped")
        self.assertTrue(stopped["shards"][0]["checkpoint"])
        resumed = self.example("control", "resume", "--run", run)
        self.assertIn(resumed["state"], {"running", "finished"})

    def test_connection_is_private_and_cannot_be_overwritten(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.connection).st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            write_connection(self.connection, self.url, "other")

    def test_malformed_connections_return_json_without_tracebacks(self):
        for config in (None, [], {}, {"url": None, "token": "t"},
                       {"url": self.url, "token": None},
                       {"url": self.url, "token": 123}):
            Path(self.connection).write_text(json.dumps(config))
            result = subprocess.run([
                sys.executable, "-m", "grid", "agent", "--connection",
                self.connection, "grid_status"], cwd=ROOT,
                capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["error"]["code"],
                             "INVALID_INPUT")
            self.assertNotIn("Traceback", result.stderr)

    def test_discovery_cli_and_real_stdio_mcp(self):
        discover = self.call("grid_discover")
        self.assertEqual(len(discover["tools"]), len(TOOLS))
        cli = subprocess.run([sys.executable, "-m", "grid", "agent",
                              "--connection", self.connection, "grid_status"],
                             cwd=ROOT, capture_output=True, text=True,
                             check=True)
        self.assertTrue(json.loads(cli.stdout)["ok"])
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-11-25"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "grid_status", "arguments": {}}}]
        mcp = subprocess.run([sys.executable, "-m", "grid", "mcp",
                              "--connection", self.connection], cwd=ROOT,
                             input="\n".join(json.dumps(r) for r in requests),
                             capture_output=True, text=True, check=True)
        replies = [json.loads(line) for line in mcp.stdout.splitlines()]
        self.assertEqual([r["id"] for r in replies], [1, 2, 3])
        self.assertEqual(len(replies[1]["result"]["tools"]), len(TOOLS))
        self.assertFalse(replies[2]["result"]["isError"])

    def test_agent_auth_is_separate_and_rejects_cross_origin(self):
        for headers in [{}, {"X-Grid-Token": "page-token"},
                        {"Authorization": "Bearer agent-token",
                         "Origin": "https://untrusted.example"},
                        {"Authorization": "Bearer agent-token",
                         "Sec-Fetch-Site": "cross-site"}]:
            req = urllib.request.Request(self.url + "/api/agent", data=b"{}",
                                         headers={"Content-Type":
                                                  "application/json",
                                                  **headers})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(req)
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()

    def test_snapshot_survives_arrivals_and_stale_rows_are_rejected(self):
        schema = self.call("grid_analyze", analysis="schema")
        pinned = self.call("grid_analyze", analysis="cohort",
                           snapshot=schema["snapshot"]["id"],
                           state=schema["state"])
        ref = pinned["result"]["members"][0]
        self.call("grid_row", reference=ref)
        with self.sweep.lock:
            self.sweep.runs[0].generation += 1
        still = self.call("grid_analyze", analysis="schema",
                          snapshot=schema["snapshot"]["id"],
                          state=schema["state"])
        self.assertEqual(still["snapshot"]["generation"],
                         schema["snapshot"]["generation"])
        failed = self.client.call("grid_row", {"reference": ref})
        self.assertEqual(failed["error"]["code"], "STALE_REFERENCE")

    def test_create_edit_run_monitor_stop_resume_and_retry(self):
        self.call("grid_create", name="example", template="lightgbm_binary",
                  requestId="create-example")
        manifest = self.call("grid_manifest", name="example")
        validated = self.call("grid_validate", text=manifest["text"])
        self.assertEqual(validated["errors"], [])
        save = dict(name="example", text=manifest["text"] + "\n# agent edit\n",
                    version=manifest["version"], requestId="save-example")
        saved = self.call("grid_save", **save)
        self.assertEqual(self.call("grid_save", **save), saved)
        self.assertFalse(self.client.call("grid_save", {**save, "requestId":
                                                       "stale-save"})["ok"])
        start = dict(name="example", rounds=40, shards=1, execution=True,
                     outputs=True, version=saved["version"], requestId="start")
        run = self.call("grid_start", **start)["run"]
        self.assertEqual(self.call("grid_start", **start)["run"], run)
        self.assertFalse(self.client.call("grid_start", {**start,
                                                        "rounds": 41})["ok"])
        self.call("grid_status")
        deadline = time.monotonic() + 10
        results = Path(self.project_root, run, "s1", "results.csv")
        while time.monotonic() < deadline:
            if results.exists() and len(results.read_text().splitlines()) > 1:
                break
            time.sleep(0.01)
        self.assertTrue(results.exists())
        self.call("grid_stop", run=run, requestId="stop")
        checkpoint = results.with_name("checkpoint.json")
        deadline = time.monotonic() + 10
        stopped = False
        while time.monotonic() < deadline:
            status = self.call("grid_status")["project"]["runs"]
            stopped = any(r["id"] == run and r["state"] == "stopped"
                          for r in status)
            if checkpoint.exists() and stopped:
                break
            time.sleep(0.01)
        self.assertTrue(checkpoint.exists())
        # A checkpoint is written before the process exits and its watcher
        # records stopped. Resume requires both, not just the file.
        self.assertTrue(stopped)
        self.call("grid_resume", run=run, requestId="resume")
        self.call("grid_stop", run=run, requestId="stop-again")

    def test_receipts_survive_restart_and_unknown_outcomes_do_not_replay(self):
        assert self.agent is not None
        args = {"name": "durable", "template": "lightgbm_binary",
                "requestId": "durable-create"}
        response = self.agent.call("grid_create", args)
        restarted = Agent(self.server)
        self.assertEqual(restarted.call("grid_create", args), response)
        receipt = restarted.receipt("durable-create")
        receipt["state"] = "running"
        Path(restarted.receipt_path("durable-create")).write_text(json.dumps(receipt))
        self.assertEqual(restarted.call("grid_create", args)["error"]["code"],
                         "OUTCOME_UNKNOWN")

    def test_cohort_judging_and_predictor_progress(self):
        query = self.call("grid_analyze", analysis="cohort", members=2)
        members = query["result"]["members"]
        self.call("grid_cohort_evaluate", members=members)
        self.call("grid_predictor_create", name="agent-cohort",
                  members=members,
                  how={"query": query["state"], "snapshot": query["snapshot"]},
                  requestId="predictor")
        deadline = time.monotonic() + 20
        cohort = {"state": "training"}
        while time.monotonic() < deadline:
            cohort = self.call("grid_status")["project"]["cohorts"][0]
            if cohort["state"] != "training":
                break
            time.sleep(0.05)
        self.assertEqual(cohort["state"], "made", cohort)
        self.assertTrue(cohort["cohortId"])

    def test_schema_validation_and_mcp_errors(self):
        for args in [{"analysis": "missing"},
                     {"analysis": "schema", "limit": True},
                     {"analysis": "schema", "state": {"unknown": 1}}]:
            result = self.client.call("grid_analyze", args)
            self.assertEqual(result["error"]["code"], "INVALID_ARGUMENT")
        reply = mcp_reply(self.client, {"jsonrpc": "2.0", "id": 1,
                                       "method": "tools/call", "params":
                                       {"name": "grid_manifest",
                                        "arguments": {}}})
        assert reply is not None
        self.assertTrue(reply["result"]["isError"])

    def test_huge_integer_is_a_structured_error(self):
        result = self.client.call("grid_analyze", {"analysis": "schema",
                                                  "limit": 10 ** 400})
        self.assertEqual(result["error"]["code"], "INVALID_ARGUMENT")

    def test_receipt_is_atomic_during_active_write(self):
        assert self.agent is not None
        entered, release = threading.Event(), threading.Event()
        original = self.agent.dispatch

        def paused(operation, arguments):
            entered.set()
            release.wait(5)
            return original(operation, arguments)

        args = {"name": "atomic", "template": "lightgbm_binary",
                "requestId": "atomic"}
        with patch.object(self.agent, "dispatch", side_effect=paused):
            worker = threading.Thread(target=self.agent.call,
                                      args=("grid_create", args))
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                receipt = self.agent.receipt("atomic")
                self.assertEqual(receipt["state"], "running")
            finally:
                release.set()
                worker.join(10)
        self.assertEqual(self.agent.receipt("atomic")["state"], "complete")

    def test_snapshot_page_uses_the_pinned_pack(self):
        result = self.call("grid_analyze", analysis="schema")
        snapshot = result["snapshot"]["id"]
        with urllib.request.urlopen(self.url + "/api/agent/snapshot?id=" +
                                    snapshot) as response:
            pack = json.load(response)["pack"]
        self.assertEqual(pack["mode"], "recorded")
        self.assertEqual(pack["runs"][0]["generation"],
                         result["snapshot"]["generation"])
