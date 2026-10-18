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
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

from grid.__main__ import Wiring
from grid.agent import TOOLS, Agent
from grid.agent_client import Client, mcp_reply, write_connection
from grid.experiment import Project, set_values
from grid.server import Server, serve
from grid.sweep import Run

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
        with patch.object(self.project, "_spawn",
                          side_effect=OSError("test")), \
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

    def test_factorized_random_and_shuffled_grids_report_dependency(self):
        text = (ROOT / "tests/fixtures/limen_run/"
                "lightgbm_binary_full.yaml").read_text()
        for strategy, shuffle in (("random", False), ("grid", True)):
            candidate = set_values(text, {"uel.factorize": True,
                "uel.search_strategy.type": strategy,
                "uel.search_strategy.shuffle": shuffle})
            checked = self.call("grid_validate", text=candidate)
            self.assertIn("upstream Limen support",
                          checked["executionErrors"][0]["message"])
        self.assertFalse(self.call("grid_discover")["execution"][
            "factorizedRandom"])

    def test_rule_temporal_references_fail_before_run_creation(self):
        text = (ROOT / "tests/fixtures/limen_rule/s1.yaml").read_text()
        self.project.version = "5.27.0"
        for field in ("recency_n", "persistence_n"):
            candidate = text.replace("      entry: enter", (
                "        %s: '{hold_bars}'\n      entry: enter" % field))
            candidate = candidate.replace("\n  params:\n", (
                "\n  params:\n    hold_bars: [1, 3, 6, 12]\n"))
            checked = self.call("grid_validate", text=candidate)
            self.assertEqual(checked["schemaErrors"], [])
            error = checked["executionErrors"][0]
            self.assertTrue(error["path"].endswith(field))
            self.assertIsNotNone(error["line"])
            self.assertIn("constant positive integer", error["message"])
            for quote in ("'", '"'):
                quoted = candidate.replace(field + ":", quote + field +
                                           quote + ":")
                # Quoted mapping keys must not bypass the path lookup either.
                quoted = quoted.replace("  manifest:", '  "manifest":')
                checked = self.call("grid_validate", text=quoted)
                self.assertTrue(any(e["path"].endswith(field) for e in
                                    checked["executionErrors"]))
            self.call("grid_create", name=field, text=candidate,
                      requestId=field)
            manifest = self.call("grid_manifest", name=field)
            with patch.object(self.project, "_spawn") as spawn:
                rejected = self.client.call("grid_start", {
                    "name": field, "rounds": 40, "shards": 1,
                    "version": manifest["version"], "execution": True,
                    "outputs": True, "requestId": field + "-start"})
            self.assertFalse(rejected["ok"])
            spawn.assert_not_called()
            self.assertEqual(self.project.runs(), [])
            for value in ("0", "-1", "true", "1.5"):
                invalid = candidate.replace("'{hold_bars}'", value)
                self.assertTrue(self.call("grid_validate", text=invalid)[
                    "executionErrors"])
            constant = candidate.replace("'{hold_bars}'", "6")
            self.assertEqual(self.call("grid_validate", text=constant)[
                "errors"], [])

    def test_flow_temporal_references_reject_whitespace_variants(self):
        text = (ROOT / "tests/fixtures/limen_rule/s1.yaml").read_text()
        start = text.index("      - id: enter")
        end = text.index("      entry: enter", start)
        for field in ("recency_n", "persistence_n"):
            for j, space in enumerate((" ", "  ", "\t", " &condition ",
                                       "\n        ")):
                flow = ("      -" + space + "{id: enter, name: Up bar, "
                        "type: relative, column: close, operator: '>', "
                        "other_column: open, " + field +
                        ": '{hold_bars}'}\n")
                candidate = (text[:start] + flow + text[end:]).replace(
                    "\n  params:\n", "\n  params:\n    hold_bars: [1, 3]\n")
                checked = self.call("grid_validate", text=candidate)
                self.assertTrue(checked["executionErrors"])
                self.assertEqual(checked["executionErrors"][0]["path"],
                                 "sfd.manifest.strategy.conditions")
                name = field + "_flow_" + str(j)
                self.call("grid_create", name=name, text=candidate,
                          requestId=name)
                manifest = self.call("grid_manifest", name=name)
                with patch.object(self.project, "_spawn") as spawn:
                    rejected = self.client.call("grid_start", {
                        "name": name, "version": manifest["version"],
                        "rounds": 4, "shards": 1, "execution": True,
                        "outputs": True, "requestId": name + "-start"})
                self.assertFalse(rejected["ok"])
                spawn.assert_not_called()
        self.assertEqual(self.project.runs(), [])

    def test_native_temporal_capability_tracks_the_patch_release(self):
        text = (ROOT / "tests/fixtures/limen_rule/s1.yaml").read_text()
        for version, supported, recording in (
                ("5.29.0", False, False), ("5.29.1", True, False),
                ("5.30.2", True, True), ("5.30.2.post1", True, True),
                ("5.31.0.dev3+gabc", True, True), ("5.29.2rc1", True, False),
                ("5.29.0.dev1", False, False), ("unknown", False, False)):
            self.project.version = version
            execution = self.call("grid_discover")["execution"]
            self.assertEqual(execution["ruleTemporalReferences"], supported)
            self.assertEqual(execution["recordingPolicy"], recording)
            self.assertEqual(execution["parallelRounds"], version != "unknown")
            for field in ("recency_n", "persistence_n"):
                candidate = text.replace("      entry: enter", (
                    "        %s: '{hold_bars}'\n      entry: enter" % field))
                checked = self.call("grid_validate", text=candidate)
                self.assertEqual(checked["executionErrors"] == [], supported)
        # Modern domains are validated by Limen, not Grid's text parser.
        self.project.version = "5.30.2"
        with patch.object(self.project, "schema_errors", return_value=[
                {"path": "temporal", "message": "invalid domain"}]):
            checked = self.call("grid_validate", text=text)
        self.assertFalse(checked["executionChecked"])
        self.assertEqual(checked["schemaErrors"][0]["message"],
                         "invalid domain")

    def test_worker_diagnostics_stay_in_private_logs(self):
        assert self.agent is not None
        proc = subprocess.CompletedProcess([], 1, "", "private worker detail")
        with patch("grid.agent.subprocess.run", return_value=proc), \
                self.assertLogs("grid.agent", level="ERROR") as logs:
            result = self.agent.call("grid_analyze", {"analysis": "schema"})
        self.assertIn("private worker detail", logs.output[0])
        self.assertFalse(result["ok"])
        self.assertNotIn("private worker detail", json.dumps(result))

    def test_missing_file_alignment_is_an_operation_error(self):
        assert self.agent is not None
        refs = self.agent.call("grid_analyze", {
            "analysis": "trials", "limit": 1})["result"]["result"]["list"]
        members = [r["reference"] for r in refs]
        exp = {"manifest": {"sfd": {"manifest": {"data_source": {
            "method": "limen.data.HistoricalData.get_any_file",
            "params": {"file_path_or_url": "missing.parquet"}}}}}}
        with patch.object(self.server, "members", return_value=(
                exp, [{"round_id": "bad", "alignment": None}], [])):
            result = self.agent.call("grid_cohort_evaluate", {
                "members": members, "fee": 0, "slip": 0})
        self.assertFalse(result["ok"])
        self.assertIn("no alignment", result["error"]["message"])

    def test_native_rule_and_ml_profiles_through_public_analysis(self):
        run_id = self.wiring.open_limen("native-rule", [
            str(ROOT / "tests/fixtures/limen_rule")], 40)
        self.wiring.read_once()
        native = self.call("grid_analyze", analysis="schema",
                           state={"run": run_id, "firstHalf": True})
        self.assertEqual(native["target"]["id"], "pnl_per_bar_bps_test")
        self.assertEqual(native["warnings"], [])
        self.assertEqual([d["id"] for d in native["result"]["dimensions"]],
                         ["fee"])
        board = self.call("grid_analyze", analysis="board",
                          state={"run": run_id, "firstHalf": True})
        self.assertTrue(all(e["dim"] == "fee"
                            for e in board["result"]["effects"]))
        ml = self.call("grid_analyze", analysis="schema",
                       state={"run": "r0", "firstHalf": True})
        self.assertEqual(ml["target"]["id"], "backtest_pnl_per_bar_bps")
        self.assertTrue(all(d["id"] not in ("num_trades_train", "auc")
                            for d in ml["result"]["dimensions"]))

    def test_sparse_halves_gate_and_cohort_through_public_api(self):
        original = json.dumps(self.sweep.runs[0].rounds)
        for first, second in ((3, None), (None, 3), (None, None)):
            with self.sweep.lock:
                self.sweep.runs[0].rounds = json.loads(original)
                for entry in self.sweep.runs[0].rounds:
                    summary = entry[4]
                    summary["whole"]["tradeT"] = 9
                    summary["halves"][0]["tradeT"] = first
                    summary["halves"][1]["tradeT"] = second
            state = {"run": "r0", "firstHalf": True,
                     "target": "backtest_pnl_per_bar_bps", "gates": [{
                         "id": "t", "target": "trade_t", "op": ">=",
                         "value": 2}]}
            gates = self.call("grid_analyze", analysis="gates", state=state)
            cohort = self.call("grid_analyze", analysis="cohort", state=state)
            self.assertTrue(cohort["result"]["firstHalfSelection"])
            self.assertTrue(cohort["result"]["gates"][0]["firstHalf"])
            if first is None:
                self.assertEqual(cohort["result"]["pool"], 0)
                self.assertTrue(any("no first-half measurements" in w
                                    for w in gates["warnings"]))
            else:
                self.assertGreater(cohort["result"]["pool"], 0)
                self.assertEqual(cohort["warnings"], [])

    def test_project_initial_pack_is_a_catalog_without_historical_reads(self):
        folder = Path(self.project_root, "results/dev/history")
        shutil.copytree(ROOT / "tests/fixtures/limen_run", folder)
        with patch.object(self.project, "_rows", side_effect=AssertionError(
                "catalog counted historical CSV rows")):
            # This server owns a different Project object with the same root.
            with urllib.request.urlopen(self.url + "/api/pack") as response:
                raw = response.read()
            body = json.loads(raw)
            self.assertTrue(all(r["deferred"]
                                for r in body["pack"]["runs"]))
            self.assertEqual(body["pack"]["catalog"][0]["projectRun"],
                             "results/dev/history")
            self.assertLess(len(raw), 10000)
            state = self.project.state(light=True)
            self.assertIsNone(state["runs"][0]["rows"])
        with urllib.request.urlopen(self.url + "/api/pack?run=r0") as response:
            selected = json.load(response)["pack"]
        self.assertEqual([r["id"] for r in selected["runs"]
                          if not r.get("deferred")], ["r0"])
        self.assertGreater(selected["runs"][0]["rows"], 0)

    def test_agent_run_is_visible_live_to_shared_human_service(self):
        args = argparse.Namespace(limen=None, results=None, name=None,
                                  ssh=None, as_=None, log=None, run=None,
                                  label=None, project=self.project_root)

        def human_service():
            project = Project(self.project_root, FAKE)
            wiring = Wiring(args, follow=True)
            sweep = wiring.build()
            project.opener = wiring.open_limen
            wiring.start()
            project.follow()
            httpd = serve(sweep, lambda: b"human", "127.0.0.1", 0,
                          project, "human-token", public_origin=
                          "https://grid.vaquum.fi")
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            return project, wiring, httpd

        def visible(httpd, selected=None):
            url = "http://127.0.0.1:%d/api/pack" % httpd.server_address[1]
            if selected:
                url += "?run=" + urllib.parse.quote(selected, safe="")
            request = urllib.request.Request(url, headers={
                "Host": "grid.vaquum.fi"})
            try:
                with urllib.request.urlopen(request) as response:
                    return json.load(response)["pack"]
            except urllib.error.HTTPError as exc:
                message = json.load(exc)["error"]
                if exc.code == 400 and ("first round" in message or
                                        "no round" in message):
                    return {"runs": []}
                raise

        def close(service):
            project, wiring, httpd = service
            project.discovery_stop.set()
            for follower in wiring.followers:
                follower.stop()
            httpd.shutdown()
            httpd.server_close()

        service = human_service()
        old_pace = os.environ.get("FAKE_LIMEN_PACE")
        os.environ["FAKE_LIMEN_PACE"] = "0.1"
        try:
            self.call("grid_create", name="shared", template="lightgbm_binary",
                      requestId="shared-create")
            manifest = self.call("grid_manifest", name="shared")
            rid = self.call("grid_start", name="shared", rounds=100, shards=1,
                            execution=True, outputs=True,
                            version=manifest["version"],
                            requestId="shared-start")["run"]
            deadline = time.monotonic() + 15
            while not any(r["rows"] and r["rows"] > 0
                          for r in visible(service[2], "project:" + rid)[
                              "runs"]):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.05)
            self.assertEqual(next(r for r in self.project.runs()
                                  if r["id"] == rid)["state"], "running")
            self.call("grid_stop", run=rid, requestId="shared-stop")
            close(service)
            service = human_service()
            deadline = time.monotonic() + 15
            while not any(r["rows"] and r["rows"] > 0
                          for r in visible(service[2], "project:" + rid)[
                              "runs"]):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.05)
        finally:
            close(service)
            if old_pace is None:
                os.environ.pop("FAKE_LIMEN_PACE", None)
            else:
                os.environ["FAKE_LIMEN_PACE"] = old_pace

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

    def test_capture_cost_and_evidence_are_scoped_to_selected_run(self):
        state = {"run": "r0", "firstHalf": True}
        analyses = ("schema", "cohort", "gates")
        baseline = {a: self.call("grid_analyze", analysis=a, state=state)
                    for a in analyses}
        unrelated = Run("large", "unrelated telemetry", "other.jsonl",
                        None, True)
        self.sweep.add_run(unrelated)
        for i in range(5000):
            self.sweep.run_line(unrelated, json.dumps({
                "sequence": i, "message": str(i) + ":" + "x" * 1024}), True)
        with patch.object(unrelated.store, "export_iter",
                          side_effect=AssertionError("unrelated export")):
            after = {a: self.call("grid_analyze", analysis=a, state=state)
                     for a in analyses}
        for analysis in analyses:
            before, current = baseline[analysis], after[analysis]
            self.assertEqual(current["result"], before["result"])
            self.assertEqual(current["summary"], before["summary"])
            self.assertEqual(current["snapshot"]["generation"],
                             before["snapshot"]["generation"])
            self.assertLess(current["performance"]["snapshotBytes"], 50000)
            self.assertLess(abs(current["performance"]["snapshotBytes"] -
                                before["performance"]["snapshotBytes"]), 128)
            print("run-scoped profile", analysis, json.dumps({
                "before": before["performance"],
                "withUnrelated5000Rows": current["performance"]}))
        captured = after["cohort"]
        snapshot = captured["snapshot"]["id"]
        with urllib.request.urlopen(self.url +
                                    "/api/agent/snapshot?id=" + snapshot) as r:
            pack = json.load(r)["pack"]
        self.assertEqual([r["id"] for r in pack["runs"]], ["r0"])
        self.assertTrue(all(m["run"] == "r0" for m in
                            captured["result"]["members"]))
        self.sweep.run_reset(self.sweep.runs[0], "truncated")
        pinned = self.call("grid_analyze", analysis="cohort", state=state,
                           snapshot=snapshot)
        self.assertEqual(pinned["result"], captured["result"] | {
            "evaluation": pinned["result"]["evaluation"]})
        self.assertFalse(pinned["performance"]["captured"])
        expired = self.client.call("grid_analyze", {
            "analysis": "schema", "snapshot": baseline["schema"][
                "snapshot"]["id"]})
        self.assertEqual(expired["error"]["code"], "SNAPSHOT_EXPIRED")

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
