"""Full JSON/MCP workflow, retry receipts, authentication and stale evidence."""

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

from grid.__main__ import Wiring
from grid.agent import Agent, TOOLS
from grid.agent_client import Client, mcp_reply, write_connection
from grid.experiment import Project
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

    def test_connection_is_private_and_cannot_be_overwritten(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.connection).st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            write_connection(self.connection, self.url, "other")

    def test_discovery_cli_and_real_stdio_mcp(self):
        discover = self.call("grid_discover")
        self.assertEqual(len(discover["tools"]), len(TOOLS))
        cli = subprocess.run([sys.executable, "-m", "grid", "agent",
                              "--connection", self.connection, "grid_status"],
                             cwd=ROOT, capture_output=True, text=True, check=True)
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
                                                  "application/json", **headers})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(req)
            self.assertEqual(caught.exception.code, 403)

    def test_snapshot_survives_arrivals_and_stale_rows_are_rejected(self):
        schema = self.call("grid_analyze", analysis="schema")
        pinned = self.call("grid_analyze", analysis="cohort",
                           snapshot=schema["snapshot"]["id"], state=schema["state"])
        ref = pinned["result"]["members"][0]
        self.call("grid_row", reference=ref)
        with self.sweep.lock:
            self.sweep.runs[0].generation += 1
        still = self.call("grid_analyze", analysis="schema",
                          snapshot=schema["snapshot"]["id"], state=schema["state"])
        self.assertEqual(still["snapshot"]["generation"], schema["snapshot"]["generation"])
        failed = self.client.call("grid_row", {"reference": ref})
        self.assertEqual(failed["error"]["code"], "STALE_REFERENCE")

    def test_create_edit_run_monitor_stop_resume_and_retry(self):
        self.call("grid_create", name="example", template="lightgbm_binary_full",
                  requestId="create-example")
        manifest = self.call("grid_manifest", name="example")
        self.assertEqual(self.call("grid_validate", text=manifest["text"])["errors"], [])
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
        self.call("grid_stop", run=run, requestId="stop")
        self.call("grid_resume", run=run, requestId="resume")
        self.call("grid_stop", run=run, requestId="stop-again")

    def test_receipts_survive_restart_and_unknown_outcomes_do_not_replay(self):
        assert self.agent is not None
        args = {"name": "durable", "template": "lightgbm_binary_full",
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
        self.call("grid_predictor_create", name="agent-cohort", members=members,
                  how={"query": query["state"], "snapshot": query["snapshot"]},
                  requestId="predictor")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            cohort = self.call("grid_status")["project"]["cohorts"][0]
            if cohort["state"] != "training":
                break
            time.sleep(0.05)
        self.assertEqual(cohort["state"], "made", cohort)
        self.assertTrue(cohort["cohortId"])

    def test_schema_validation_and_mcp_errors(self):
        for args in [{"analysis": "missing"}, {"analysis": "schema", "limit": True},
                     {"analysis": "schema", "state": {"unknown": 1}}]:
            result = self.client.call("grid_analyze", args)
            self.assertEqual(result["error"]["code"], "INVALID_ARGUMENT")
        reply = mcp_reply(self.client, {"jsonrpc": "2.0", "id": 1,
                                       "method": "tools/call", "params":
                                       {"name": "grid_manifest", "arguments": {}}})
        self.assertTrue(reply["result"]["isError"])
