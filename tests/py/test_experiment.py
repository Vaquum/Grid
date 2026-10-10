"""The Experiment view's server side (grid/experiment.py): a manifest's
values edited as text, what ``limen validate`` says, and a Limen project's
experiments and runs, with a stand-in ``limen`` command
(tests/fixtures/fake_limen.py) that writes rounds and stops as Limen does;
and the routes that write, refused without the page's token."""

from __future__ import annotations

import argparse
import difflib
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from typing import Any

from grid.__main__ import Wiring
from grid.experiment import (
    Project,
    get_value,
    remove_value,
    set_values,
    validation_errors,
)
from grid.server import serve
from grid.sweep import Json, Sweep

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(HERE, "..", "fixtures", "fake_limen.py")
MANIFEST = os.path.join(HERE, "..", "fixtures", "limen_run",
                        "lightgbm_binary_full.yaml")


def manifest_text() -> str:
    with open(MANIFEST, encoding="utf-8") as f:
        return f.read()


def wait(check: Any, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting")
        time.sleep(0.05)


class ManifestText(unittest.TestCase):
    def test_plain_values_read_at_their_dotted_paths(self) -> None:
        text = manifest_text()
        self.assertEqual(get_value(text, "metadata.mode"), "development")
        self.assertEqual(get_value(text, "metadata.limen_version"), "5.14.0")
        self.assertEqual(get_value(text, "uel.search_strategy.seed"),
                         "20261009")
        self.assertEqual(get_value(text, "uel.n_permutations"), "500")
        self.assertIsNone(get_value(text, "uel.output_path"))
        self.assertIsNone(get_value(text, "nothing.here"))

    def test_values_set_in_place_and_nothing_else_changes(self) -> None:
        text = manifest_text()
        out = set_values(text, {"uel.n_permutations": 2500,
                                "uel.search_strategy.seed": 7,
                                "uel.record_execution": True,
                                "uel.output_path": "exp/1/s1"})
        self.assertEqual(get_value(out, "uel.n_permutations"), "2500")
        self.assertEqual(get_value(out, "uel.search_strategy.seed"), "7")
        self.assertEqual(get_value(out, "uel.record_execution"), "true")
        self.assertEqual(get_value(out, "uel.output_path"), "exp/1/s1")
        changed = [d for d in difflib.ndiff(text.splitlines(),
                                            out.splitlines())
                   if d[:2] in ("- ", "+ ")]
        self.assertEqual(changed, [
            "-   n_permutations: 500", "+   n_permutations: 2500",
            "-     seed: 20261009", "+     seed: 7",
            "+   record_execution: true", '+   output_path: "exp/1/s1"'])
        self.assertTrue(out.endswith("\n"))
        self.assertEqual(remove_value(out, "uel.output_path").count(
            "output_path"), 0)

    def test_comments_stay_and_a_missing_mapping_is_added(self) -> None:
        text = ("metadata:\n  name: a  # its name\n"
                "uel:\n  n_permutations: 5 # five\n")
        out = set_values(text, {"uel.n_permutations": 9,
                                "uel.search_strategy.seed": 3,
                                "metadata.name": "b"})
        self.assertIn("  n_permutations: 9  # five\n", out)
        self.assertIn("  name: \"b\"  # its name\n", out)
        self.assertIn("uel:\n  n_permutations: 9  # five\n  search_strategy:\n"
                      "    seed: 3\n", out)

    def test_a_mapping_written_inline_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "uel is written inline"):
            set_values("uel: {n_permutations: 5}\n",
                       {"uel.n_permutations": 6})
        self.assertIsNone(get_value("uel: {n_permutations: 5}\n",
                                    "uel.n_permutations"))
        with self.assertRaisesRegex(ValueError, "holds a mapping"):
            set_values(manifest_text(), {"uel.search_strategy": 1})


class Validation(unittest.TestCase):
    def test_limens_problems_with_their_paths_and_lines(self) -> None:
        # as limen validate (5.20.0) prints them
        errors = validation_errors(
            "Validating bad.yaml ...\n"
            "  ERROR  [uel.n_permutations]: 'n_permutations' must be a int\n"
            "  ✗ 1 error(s) found\n")
        self.assertEqual(errors, [{"line": None, "path": "uel.n_permutations",
                                   "message": "'n_permutations' must be a "
                                              "int"}])
        parse = validation_errors(
            "Validating parse.yaml ...\n"
            "  PARSE ERROR (line 5): while parsing a flow sequence\n"
            '  in "<unicode string>", line 4, column 8:\n'
            "      bad: [1, 2\n"
            "           ^ (line: 4)\n"
            "expected ',' or ']', but got ':'\n"
            "  ✗ 1 error(s) found\n")
        self.assertEqual(len(parse), 1)
        self.assertEqual((parse[0]["line"], parse[0]["path"]), (5, ""))
        self.assertTrue(parse[0]["message"].startswith(
            "while parsing a flow sequence\n"))
        self.assertIn("but got ':'", parse[0]["message"])


class ProjectRuns(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="grid-project-")
        self.root = os.path.join(self.tmp, "lab")
        os.makedirs(os.path.join(self.root, "manifests"))
        with open(os.path.join(self.root, "limen.toml"), "w") as f:
            f.write("[store]\n")
        self.pace = os.environ.get("FAKE_LIMEN_PACE")
        os.environ["FAKE_LIMEN_PACE"] = "0.03"
        self.p = Project(self.root, FAKE)
        self.opened: list[str] = []
        self.p.opener = lambda folder, key: (self.opened.append(key),
                                             "p%d" % len(self.opened))[1]

    def tearDown(self) -> None:
        for proc in self.p.procs.values():
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        if self.pace is None:
            os.environ.pop("FAKE_LIMEN_PACE", None)
        else:
            os.environ["FAKE_LIMEN_PACE"] = self.pace
        shutil.rmtree(self.tmp)

    def run_of(self, rid: str) -> Json:
        return next(r for r in self.p.runs() if r["id"] == rid)

    def test_a_project_needs_its_limen_toml(self) -> None:
        with self.assertRaisesRegex(ValueError, "no limen.toml"):
            Project(self.tmp, FAKE)

    def test_limens_version_templates_and_validation(self) -> None:
        self.assertEqual(self.p.version, "5.20.0")
        self.assertEqual([t["name"] for t in self.p.templates],
                         ["lightgbm_binary", "logreg_binary"])
        self.assertEqual(self.p.validate(manifest_text()), [])
        bad = self.p.validate(manifest_text().replace(
            "prep_each_round", "BAD_VALUE: 1\n  prep_each_round"))
        self.assertEqual(bad[0]["path"], "uel.n_permutations")
        parse = self.p.validate("a: 1\nb: PARSE_ME\n")
        self.assertEqual(parse[0]["line"], 2)

    def test_an_experiment_from_a_template_or_a_manifest(self) -> None:
        self.p.create("first", template="lightgbm_binary")
        self.assertEqual(get_value(self.p.manifest("first")["text"],
                                   "metadata.name"), "first")
        text = set_values(manifest_text(), {"uel.output_path": "x/1/s1"})
        self.p.create("second", text=text)
        made = self.p.manifest("second")["text"]
        self.assertEqual(get_value(made, "metadata.name"), "second")
        self.assertIsNone(get_value(made, "uel.output_path"))
        with self.assertRaisesRegex(ValueError, "exists already"):
            self.p.create("first", template="lightgbm_binary")
        with self.assertRaisesRegex(ValueError, "letters, digits"):
            self.p.create("../up", text=text)
        with self.assertRaisesRegex(ValueError, "no template"):
            self.p.create("third", template="nothing")
        names = [e["name"] for e in self.p.experiments(self.p.runs())]
        self.assertEqual(names, ["first", "second"])

    def test_a_manifest_changed_on_disk_is_not_overwritten(self) -> None:
        self.p.create("first", template="lightgbm_binary")
        m = self.p.manifest("first")
        mtime = self.p.save("first", m["text"] + "# one\n", m["mtime"])
        path = os.path.join(self.root, "manifests", "first.yaml")
        os.utime(path, (mtime + 5, mtime + 5))
        with self.assertRaisesRegex(ValueError, "changed on disk"):
            self.p.save("first", m["text"], mtime)

    def test_a_run_in_shards_stops_and_resumes(self) -> None:
        self.p.create("exp", template="lightgbm_binary")
        # slow enough to stop half way
        os.environ["FAKE_LIMEN_PACE"] = "0.2"
        rid = self.p.start("exp", 39, 2, True, True)
        folder = os.path.join(self.root, rid)
        self.assertTrue(rid.startswith("results/dev/exp/"))
        with open(os.path.join(folder, "grid-run.json")) as f:
            record = json.load(f)
        # two shards of 20 rounds (39 rounded up), their seeds apart
        self.assertEqual([(s["label"], s["rounds"], s["seed"])
                          for s in record["shards"]],
                         [("s1", 20, 20261009), ("s2", 20, 20261010)])
        self.assertEqual(record["threads"], max(1, (os.cpu_count() or 1)
                                                 // 2))
        with open(os.path.join(folder, "manifests", "s2.yaml")) as f:
            copy = f.read()
        self.assertEqual(get_value(copy, "uel.output_path"),
                         rid.removeprefix("results/dev/") + "/s2")
        self.assertEqual(get_value(copy, "uel.record_model_outputs"), "true")
        # it opens in the sweep once each shard has written a round
        wait(lambda: self.opened == [rid])
        wait(lambda: all(s["rows"] >= 3 for s in self.run_of(rid)["shards"]))
        self.p.stop(rid)
        wait(lambda: self.run_of(rid)["state"] == "stopped")
        stopped = self.run_of(rid)
        self.assertLess(stopped["rows"], 40)
        for label in ("s1", "s2"):
            self.assertTrue(os.path.isfile(os.path.join(
                folder, label, "checkpoint.json")))
        with self.assertRaisesRegex(ValueError, "no shard .* is running"):
            self.p.stop(rid)
        self.p.resume(rid)
        wait(lambda: self.run_of(rid)["state"] == "finished")
        done = self.run_of(rid)
        self.assertEqual((done["rows"], done["planned"]), (40, 40))
        self.assertEqual(done["open"], "p1")
        self.assertEqual(self.p.open(rid), "p1")
        with open(os.path.join(folder, "logs", "s1.log")) as f:
            self.assertIn("Resuming", f.read())

    def test_what_is_not_run(self) -> None:
        text = manifest_text()
        self.p.create("grid", text=text.replace("type: random",
                                                "type: grid"))
        with self.assertRaisesRegex(ValueError, "random search"):
            self.p.start("grid", 10, 2, True, True)
        self.p.create("bad", text=text.replace(
            "prep_each_round", "BAD_VALUE: 1\n  prep_each_round"))
        with self.assertRaisesRegex(ValueError, "1 problem in the manifest"):
            self.p.start("bad", 10, 1, True, True)
        for rounds, shards in ((0, 1), (10, 0), (3, 4), (True, 1)):
            with self.assertRaises(ValueError):
                self.p.start("grid", rounds, shards, True, True)
        with self.assertRaisesRegex(ValueError, "no run"):
            self.p.stop("results/dev/../../etc")

    def test_the_manifest_against_its_last_run(self) -> None:
        self.p.create("exp", template="lightgbm_binary")
        self.assertEqual(self.p.diff("exp", "x")["against"], None)
        rid = self.p.start("exp", 4, 1, False, False)
        wait(lambda: self.run_of(rid)["state"] == "finished")
        text = self.p.manifest("exp")["text"]
        d = self.p.diff("exp", text.replace("n_permutations: 500",
                                            "n_permutations: 800"))
        self.assertEqual(d["against"], rid)
        self.assertIn("-  n_permutations: 500\n+  n_permutations: 800",
                      d["diff"])

    def test_a_run_made_outside_grid_is_listed(self) -> None:
        d = os.path.join(self.root, "results", "dev", "other_20260101_000000")
        os.makedirs(d)
        fixture = os.path.dirname(MANIFEST)
        for name in ("metadata.json", "results.csv",
                     "lightgbm_binary_full.yaml"):
            shutil.copy(os.path.join(fixture, name), d)
        run = self.p.runs()[0]
        self.assertEqual((run["kind"], run["experiment"], run["rows"],
                          run["planned"], run["state"]),
                         ("limen", "lightgbm_binary_full", 40, 500,
                          "incomplete"))
        with self.assertRaisesRegex(ValueError, "not a run Grid started"):
            self.p.stop(run["id"])


class Routes(unittest.TestCase):
    """The project's routes: what writes is refused without the page's
    token, from another origin, or not as JSON."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="grid-routes-")
        with open(os.path.join(self.tmp, "limen.toml"), "w") as f:
            f.write("[store]\n")
        self.httpd = serve(Sweep("s"), lambda: b"page", "127.0.0.1", 0,
                           Project(self.tmp, FAKE), "t0ken")
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        host, port = self.httpd.server_address[:2]
        self.base = "http://%s:%d" % (host, port)

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.tmp)

    def post(self, path: str, body: Any, **headers: str) -> tuple[int, Any]:
        req = urllib.request.Request(self.base + path, method="POST",
                                     data=json.dumps(body).encode())
        sent = {"Content-Type": "application/json", "X-Grid-Token": "t0ken",
                "Origin": self.base}
        sent.update(headers)
        for k, v in sent.items():
            if v:
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read())

    def test_a_write_needs_the_token_the_origin_and_json(self) -> None:
        ok = {"text": manifest_text()}
        self.assertEqual(self.post("/api/experiment/validate", ok),
                         (200, {"errors": []}))
        for headers, why in (({"X-Grid-Token": ""}, "token"),
                             ({"X-Grid-Token": "nope"}, "token"),
                             ({"Origin": "http://evil.example"}, "origin"),
                             ({"Sec-Fetch-Site": "cross-site"}, "site"),
                             ({"Content-Type": "text/plain"}, "JSON")):
            code, body = self.post("/api/experiment/validate", ok, **headers)
            self.assertEqual(code, 403, headers)
            self.assertIn(why, body["error"])
        self.assertEqual(self.post("/api/experiment/nothing", ok)[0], 404)
        code, body = self.post("/api/experiment/create",
                               {"name": "x", "template": "nothing"})
        self.assertEqual((code, body["error"]), (400,
                                                 "Limen has no template "
                                                 "'nothing'"))

    def test_the_project_reads_without_a_token(self) -> None:
        with urllib.request.urlopen(self.base + "/api/experiment") as res:
            state = json.loads(res.read())
        self.assertEqual(state["limen"]["version"], "5.20.0")
        self.assertEqual(state["experiments"], [])


class OpenedWhileServing(unittest.TestCase):
    def test_a_run_folder_of_shards_opens_as_one_run(self) -> None:
        tmp = tempfile.mkdtemp(prefix="grid-open-")
        try:
            os.makedirs(os.path.join(tmp, "manifests"))
            with open(os.path.join(tmp, "limen.toml"), "w") as f:
                f.write("[store]\n")
            os.environ["FAKE_LIMEN_PACE"] = "0"
            p = Project(tmp, FAKE)
            p.create("exp", template="lightgbm_binary")
            rid = p.start("exp", 10, 2, True, True)
            wait(lambda: all(s["state"] == "finished" for s in next(
                r for r in p.runs() if r["id"] == rid)["shards"]))
            args = argparse.Namespace(project=tmp, limen=None, results=None,
                                      name=None, ssh=None, as_=None, log=None,
                                      run=None, label=None)
            w = Wiring(args, follow=False)
            sweep = w.build()
            self.assertEqual((sweep.name, sweep.runs),
                             (os.path.basename(tmp), []))
            run_id = w.open_limen(os.path.join(tmp, rid), rid)
            w.read_once()
            run = sweep.runs[0]
            self.assertEqual((run_id, run.id, run.shards), ("p1", "p1",
                                                            ["s1", "s2"]))
            self.assertEqual(run.label, rid.removeprefix("results/dev/"))
            self.assertEqual(run.store.rows, 10)
            assert run.experiment is not None
            self.assertEqual([lb for lb, _ in run.experiment["shards"]],
                             ["s1", "s2"])
            with self.assertRaisesRegex(ValueError, "no metadata.json"):
                w.open_limen(os.path.join(tmp, "manifests"), "manifests")
        finally:
            os.environ.pop("FAKE_LIMEN_PACE", None)
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
