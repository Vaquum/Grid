"""The Cohort view's server side (grid/cohort.py): a cohort of a Limen run's
rounds judged on what the run recorded. Limen's long-flat execution is
rebuilt from a round's recorded signal and checked against the execution
Limen recorded for it; the members' bars are aligned by time; their
probabilities are averaged as Limen's Cohort averages them; and the route
serves it for a run's rows. On a Limen project, a predictor is made of a
run's rows: cohorts/<name>/ written and Limen's Trainer and Cohort run by
grid/limen_cohort.py, here with a stand-in limen package
(tests/fixtures/fake_limen_pkg) that trains nothing.

tests/fixtures/limen_cohort_rounds.json.gz holds three rounds of a Limen
5.20 run (lightgbm_binary_full_market) that traded, without take-profit or
stop-loss exits, cut to their first 1,011 bars where all three are flat.
tests/fixtures/limen_cohort is a two-shard run of Limen 5.20's
lightgbm_binary template, as Grid's Experiment view ran it."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from typing import Any

from grid.__main__ import Wiring
from grid.cohort import (
    RoundLines,
    bar_step,
    bar_times,
    costs_of,
    judge,
    long_flat,
)
from grid.experiment import Project
from grid.server import serve
from grid.sweep import Json

HERE = os.path.dirname(os.path.abspath(__file__))
ROUNDS: list[Json] = json.load(gzip.open(os.path.join(
    HERE, "..", "fixtures", "limen_cohort_rounds.json.gz"), "rt"))
RUN = os.path.join(HERE, "..", "fixtures", "limen_cohort")
FAKE_PKG = os.path.join(HERE, "..", "fixtures", "fake_limen_pkg")
FAKE_CLI = os.path.join(HERE, "..", "fixtures", "fake_limen.py")
HOUR = 3600


def wait(check: Any, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting")
        time.sleep(0.05)


def records_of(directory: str) -> list[Json]:
    with open(os.path.join(directory, "round_data.jsonl")) as f:
        return [json.loads(line) for line in f if line.strip()]


class LimenProject(unittest.TestCase):
    """A Limen project whose predictors are made with the stand-in limen
    package."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="grid-cohort-")
        self.root = os.path.join(self.tmp, "lab")
        os.makedirs(os.path.join(self.root, "manifests"))
        with open(os.path.join(self.root, "limen.toml"), "w") as f:
            f.write("[store]\n")
        self.p = Project(self.root, FAKE_CLI)
        self.p.python = sys.executable
        self.saved = {k: os.environ.get(k) for k in ("PYTHONPATH",
                                                     "FAKE_TRAIN_FAIL")}
        os.environ["PYTHONPATH"] = FAKE_PKG

    def tearDown(self) -> None:
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp)

    def made(self, name: str) -> Json:
        wait(lambda: next(c for c in self.p.cohorts()
                          if c["name"] == name)["state"] != "training")
        return next(c for c in self.p.cohorts() if c["name"] == name)


def signal(rec: Json) -> list[int]:
    return [1 if p > 0.5 else 0 for p in rec["preds"]]


def synthetic(rid: str, probs: list[float], first: str = "2026-03-01",
              dropped: list[str] | None = None, threshold: float = 0.5,
              ret: list[float | None] | None = None) -> Json:
    """A round line with hourly bars from `first`, less `dropped`."""
    n = len(probs)
    start = first + "T00:00:00+00:00"
    from datetime import datetime, timedelta
    t0 = datetime.fromisoformat(start)
    gone = [t0 + timedelta(hours=int(h)) for h in (dropped or [])]
    times = []
    t = t0
    while len(times) < n:
        if t not in gone:
            times.append(t)
        t += timedelta(hours=1)
    return {"round_id": rid, "round_params": {"fee_bps": 1.0,
                                              "slip_bps": 2.0},
            "preds": [1 if p >= threshold else 0 for p in probs],
            "probs": probs, "optimal_threshold": threshold,
            "threshold_rule": ">=",
            "alignment": {"first_test_datetime": start,
                          "last_test_datetime": times[-1].isoformat(),
                          "missing_datetimes": [g.isoformat()
                                                for g in gone]},
            "market": {"ret": ret if ret is not None
                       else [None] + [0.001] * (n - 1)}}


class Execution(unittest.TestCase):
    def test_limens_execution_is_rebuilt_from_the_recorded_signal(
            self) -> None:
        for rec in ROUNDS:
            p = rec["round_params"]
            pos, gross, net = long_flat(signal(rec), rec["market"]["ret"],
                                        p["fee_bps"], p["slip_bps"])
            size = p["notional_rate"] or 1.0
            self.assertGreater(sum(pos), 100)
            for name, mine in (("pos", pos), ("gross", gross),
                               ("net", net)):
                recorded = rec["execution"][name]
                self.assertEqual(len(mine), len(recorded))
                worst = max(abs(a * size - b)
                            for a, b in zip(mine, recorded, strict=True))
                self.assertLess(worst, 1e-12, (rec["round_id"][:8], name))

    def test_a_bar_that_cannot_be_traded_holds_no_position(self) -> None:
        pos, gross, net = long_flat([1, 1, 1, 1, 0], [None, 0.01, None,
                                                      0.02, 0.03], 0.0, 0.0)
        self.assertEqual(pos, [0.0, 1.0, 0.0, 1.0, 1.0])
        self.assertEqual(gross, [0.0, 0.01, 0.0, 0.02, 0.03])
        self.assertAlmostEqual(net[1], 0.01, places=12)
        # a one-bar trade in a flat market pays the slippage in and out
        # and the fee on entry and on exit
        _, _, net = long_flat([1, 0], [None, 0.0], 10.0, 5.0)
        self.assertEqual(net[0], 0.0)
        self.assertAlmostEqual(net[1], (1 / 1.0005) * 0.999 * 0.9995
                               - 0.001 - 1, places=12)


class Alignment(unittest.TestCase):
    def test_bars_are_rebuilt_from_the_window_less_what_it_dropped(
            self) -> None:
        for rec in ROUNDS:
            times = bar_times(rec, HOUR)
            self.assertEqual(len(times), len(rec["preds"]))
            self.assertEqual(times, sorted(set(times)))
        rec = synthetic("a", [0.6] * 5, dropped=["2"])
        times = bar_times(rec, HOUR)
        self.assertEqual([(t - times[0]) // HOUR for t in times],
                         [0, 1, 3, 4, 5])
        # a window whose bars the arrays do not number is refused
        rec["preds"] = rec["preds"][:4]
        with self.assertRaisesRegex(ValueError, "a gap in the data"):
            bar_times(rec, HOUR)
        # a round of a run that did not record its model outputs (before
        # Limen 5.17, or with uel.record_model_outputs off) says so
        bare = {"round_id": "9bbfc39e316c", "round_params": {}}
        with self.assertRaisesRegex(ValueError, "round 9bbfc39e316c recorded "
                                    "no model outputs .*record_model_outputs"):
            bar_times(bare, HOUR)
        with self.assertRaisesRegex(ValueError, "recorded no alignment"):
            bar_times({**bare, "preds": [1, 0]}, HOUR)

    def test_members_meet_on_the_bars_they_share(self) -> None:
        # three bars more on one; a bar dropped by the other
        a = synthetic("a", [0.9] * 8)
        b = synthetic("b", [0.2] * 5, dropped=["1"])
        out = judge([a, b], HOUR, 0.0, 0.0)
        self.assertEqual(out["bars"], 5)
        self.assertEqual((out["last"] - out["first"]) // HOUR, 5)

    def test_the_second_half_holds_no_bar_that_chose_a_member(
            self) -> None:
        # a's own halves split at its 5th hour, b's (four hours dropped) at
        # its 3rd: the bars they share are hours 0-4 and 9, and hours 3
        # and 4, in b's second half but a's first, are in neither half
        a = synthetic("a", [0.9] * 10)
        b = synthetic("b", [0.9] * 6, dropped=["5", "6", "7", "8"])
        out = judge([a, b], HOUR, 0.0, 0.0)
        self.assertEqual((out["bars"], out["between"]), (6, 2))
        for part in [out["cohort"], *out["members"]]:
            self.assertEqual([h["bars"] for h in part["halves"]], [3, 1])
        self.assertIn("2 bars, in the first half of some members and the "
                      "second of others, are in neither half", out["notes"][0])
        # members alike in their windows: Limen's ordinal halves
        same = judge([synthetic("c", [0.9] * 10), a], HOUR, 0.0, 0.0)
        self.assertEqual(same["between"], 0)
        self.assertEqual([h["bars"] for h in same["cohort"]["halves"]],
                         [5, 5])
        self.assertEqual(same["notes"], [])


class Aggregation(unittest.TestCase):
    def test_probabilities_average_and_ties_fall_to_no(self) -> None:
        ret: list[float | None] = [None, 0.01, 0.01, 0.01]
        a = synthetic("a", [0.9, 0.9, 0.2, 0.2], ret=ret)
        b = synthetic("b", [0.3, 0.1, 0.8, 0.6], ret=ret)
        out = judge([a, b], HOUR, 0.0, 0.0)
        self.assertEqual(out["aggregation"], "probability_weighted")
        # means 0.6, 0.5, 0.5, 0.4: only the first is over 0.5, so the
        # cohort holds the second bar alone
        self.assertEqual(out["fired"], 0.25)
        self.assertEqual(out["cohort"]["whole"]["trades"], 1)
        self.assertAlmostEqual(out["cohort"]["whole"]["pnl"],
                               0.01 / 4 * 10_000, places=6)

    def test_without_probabilities_the_votes_decide(self) -> None:
        ret: list[float | None] = [None, 0.01, 0.01]
        a = synthetic("a", [0.9, 0.9, 0.9], ret=ret)
        b = synthetic("b", [0.9, 0.1, 0.1], ret=ret)
        c = synthetic("c", [0.1, 0.1, 0.9], ret=ret)
        for rec in (a, b, c):
            rec["probs"] = None
        out = judge([a, b, c], HOUR, 0.0, 0.0)
        self.assertEqual(out["aggregation"], "majority_vote")
        self.assertAlmostEqual(out["fired"], 2 / 3)

    def test_a_member_alone_is_itself_at_a_threshold_of_one_half(
            self) -> None:
        alone = [r for r in ROUNDS if r["threshold_rule"] == ">"
                 and r["optimal_threshold"] == 0.5]
        self.assertTrue(alone)
        for rec in alone:
            out = judge([rec], HOUR, 1.0, 5.0)
            self.assertEqual(out["cohort"]["whole"],
                             out["members"][0]["whole"])

    def test_the_rounds_judged_together(self) -> None:
        fee, slip = costs_of(ROUNDS)
        self.assertEqual((fee, slip), (1.0, 5.0))
        out = judge(ROUNDS, HOUR, fee, slip)
        self.assertEqual(out["bars"], 1011)
        self.assertEqual([m["id"] for m in out["members"]],
                         [r["round_id"] for r in ROUNDS])
        for part in [out["cohort"], *out["members"]]:
            self.assertEqual([h["bars"] for h in part["halves"]], [505, 506])
        self.assertEqual(len(out["notes"]), 1)
        self.assertIn("Calibrated and uncalibrated", out["notes"][0])
        with self.assertRaisesRegex(ValueError, "basis points"):
            judge(ROUNDS, HOUR, -1.0, 5.0)

    def test_exits_the_run_cannot_rebuild_are_said(self) -> None:
        a = synthetic("a", [0.9] * 4)
        a["round_params"]["stop_loss_bps"] = 50.0
        out = judge([a, synthetic("b", [0.9] * 4)], HOUR, 0.0, 0.0)
        self.assertIn("1 of the 2 members exit by take-profit or stop-loss",
                      out["notes"][0])


class Lines(unittest.TestCase):
    def test_a_rounds_line_is_found_by_its_id_as_the_file_grows(
            self) -> None:
        tmp = tempfile.mkdtemp(prefix="grid-lines-")
        try:
            path = os.path.join(tmp, "round_data.jsonl")
            with open(path, "w") as f:
                f.write(json.dumps({"round_id": "a", "n": 1}) + "\n")
                f.write(json.dumps({"round_id": "b", "n": 2}))
            lines = RoundLines()
            self.assertEqual(lines.get(tmp, "a")["n"], 1)
            # a line still being written is not read yet
            with self.assertRaisesRegex(ValueError, "round b is not in"):
                lines.get(tmp, "b")
            with open(path, "a") as f:
                f.write("\n" + json.dumps({"n": 3, "round_id": "c"}) + "\n")
            self.assertEqual(lines.get(tmp, "b")["n"], 2)
            self.assertEqual(lines.get(tmp, "c")["n"], 3)
            # written again from the start: read again
            with open(path, "w") as f:
                f.write(json.dumps({"round_id": "c", "n": 4}) + "\n")
            self.assertEqual(lines.get(tmp, "c")["n"], 4)
        finally:
            shutil.rmtree(tmp)


class Route(unittest.TestCase):
    def setUp(self) -> None:
        args = argparse.Namespace(limen=[RUN], results=None, name=None,
                                  ssh=None, as_=None, log=None, run=None,
                                  label=None, project=None)
        w = Wiring(args, follow=False)
        self.sweep = w.build()
        w.read_once()
        self.httpd = serve(self.sweep, lambda: b"page", "127.0.0.1", 0)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        host, port = self.httpd.server_address[:2]
        self.base = "http://%s:%d" % (host, port)

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def get(self, query: str) -> tuple[int, Any]:
        try:
            with urllib.request.urlopen(self.base + "/api/cohort?" +
                                        query) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read())

    def test_a_runs_rows_are_judged_from_their_directories(self) -> None:
        run = self.sweep.runs[0]
        assert run.experiment is not None
        self.assertEqual(bar_step(run.experiment), HOUR)
        code, out = self.get("run=%s&rows=0,1" % run.id)
        self.assertEqual(code, 200, out)
        self.assertEqual((out["bars"], out["rows"]), (696, [0, 1]))
        self.assertEqual(len(out["members"]), 2)
        # the members' own costs, unless the page sets them
        self.assertEqual((out["fee"], out["slip"]), (1.0, 2.0))
        code, out = self.get("run=%s&rows=0,2,3&fee=4&slip=0" % run.id)
        self.assertEqual((code, out["fee"], out["slip"]), (200, 4.0, 0.0))
        self.assertEqual(out["dirs"], ["s1", "s2"])
        for query, why in (("run=%s&rows=" % run.id, "names its rows"),
                           ("run=%s&rows=0,0" % run.id, "each once"),
                           ("run=%s&rows=x" % run.id, "row numbers"),
                           ("run=%s&rows=9" % run.id, "outside"),
                           ("run=nope&rows=0", "no run")):
            code, out = self.get(query)
            self.assertEqual(code, 400, query)
            self.assertIn(why, out["error"])


if __name__ == "__main__":
    unittest.main()


class Make(LimenProject):
    def test_a_predictor_is_trained_bound_and_written(self) -> None:
        src = os.path.join(RUN, "s1")
        records = records_of(src)
        ids = sorted(r["round_id"] for r in records)
        self.assertEqual(self.p.make_cohort("pair", src, records,
                                            {"rows": [0, 1]}), "pair")
        c = self.made("pair")
        self.assertEqual((c["state"], c["members"]), ("made", 2))
        folder = os.path.join(self.root, "cohorts", "pair")
        with open(os.path.join(folder, "cohort.json")) as f:
            spec = json.load(f)
        with open(os.path.join(src, "metadata.json")) as f:
            manifest_id = json.load(f)["manifest_id"]
        self.assertEqual(spec["permutation_ids"], ids)
        self.assertEqual(spec["manifest_id"], manifest_id)
        self.assertEqual(c["cohortId"], spec["cohort_id"])
        self.assertTrue(spec["cohort_id"].startswith("sha256:"))
        self.assertEqual((c["startedAt"], c["madeAt"]),
                         (spec["started_at"], spec["made_at"]))
        self.assertLessEqual(c["startedAt"], c["madeAt"])
        self.assertEqual((spec["aggregation_mode"], spec["limen_version"],
                          spec["chosen"]), ("probability_weighted", "5.20.0",
                                            {"rows": [0, 1]}))
        # the slim result directory: the members' metadata, lines, rows
        # and manifest copy, and their sensors in Furnace's layout
        exp = os.path.join(folder, "experiment")
        self.assertEqual(sorted(os.listdir(exp)),
                         ["metadata.json", "results.csv", "round_data.jsonl",
                          "s1.yaml", "sensors"])
        self.assertEqual(sorted(r["round_id"] for r in records_of(exp)), ids)
        with open(os.path.join(exp, "results.csv")) as f:
            self.assertEqual(len(f.read().strip().splitlines()), 3)
        self.assertEqual(sorted(os.listdir(os.path.join(exp, "sensors"))),
                         sorted([i + ".json" for i in ids]
                                + [i + ".pkl" for i in ids]))
        with open(os.path.join(exp, "sensors", ids[0] + ".json")) as f:
            side = json.load(f)
        self.assertEqual((side["permutation_id"], side["manifest_id"],
                          side["limen_version"]), (ids[0], manifest_id,
                                                   "5.20.0"))

    def test_a_member_that_does_not_train_fails_the_predictor(
            self) -> None:
        src = os.path.join(RUN, "s1")
        records = records_of(src)
        os.environ["FAKE_TRAIN_FAIL"] = records[1]["round_id"][:8]
        self.p.make_cohort("drift", src, records, {})
        c = self.made("drift")
        self.assertEqual(c["state"], "failed")
        self.assertIn("ReconstructionError", c["tail"])
        self.assertIsNone(c["madeAt"])

    def test_what_is_not_made(self) -> None:
        src = os.path.join(RUN, "s1")
        records = records_of(src)
        self.p.make_cohort("once", src, records, {})
        with self.assertRaisesRegex(ValueError, "cohorts/once exists"):
            self.p.make_cohort("once", src, records, {})
        with self.assertRaisesRegex(ValueError, "letters, digits"):
            self.p.make_cohort("../up", src, records, {})
        with self.assertRaisesRegex(ValueError, "members, each once"):
            self.p.make_cohort("twice", src, records + records[:1], {})
        self.p.python = None
        with self.assertRaisesRegex(ValueError, "limen-python"):
            self.p.make_cohort("none", src, records, {})
        self.made("once")


class MakeRoute(LimenProject):
    def setUp(self) -> None:
        super().setUp()
        args = argparse.Namespace(limen=[RUN], results=None, name=None,
                                  ssh=None, as_=None, log=None, run=None,
                                  label=None, project=None)
        w = Wiring(args, follow=False)
        self.sweep = w.build()
        w.read_once()
        self.httpd = serve(self.sweep, lambda: b"page", "127.0.0.1", 0,
                           self.p, "t0ken")
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        host, port = self.httpd.server_address[:2]
        self.base = "http://%s:%d" % (host, port)

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def post(self, body: Json) -> tuple[int, Any]:
        req = urllib.request.Request(
            self.base + "/api/experiment/cohort", method="POST",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     "X-Grid-Token": "t0ken", "Origin": self.base})
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read())

    def test_a_runs_rows_are_made_a_predictor_from_one_directory(
            self) -> None:
        run = self.sweep.runs[0]
        shard = [run.store.row_object(i).get("shard")
                 for i in range(run.store.rows)]
        s1 = [i for i, d in enumerate(shard) if d == "s1"]
        how = {"needle": "Net PnL per bar", "on": "the first half",
               "best": 2, "pocket": [], "gates": []}
        code, out = self.post({"run": run.id, "rows": s1, "name": "s1pair",
                               "how": how})
        self.assertEqual((code, out), (200, {"cohort": "s1pair"}), out)
        made = self.made("s1pair")
        self.assertEqual((made["state"], made["chosen"]), ("made", how))
        # how the members were chosen is kept as the page says it, within
        # bounds; the page's row numbers and run id are not
        with open(os.path.join(self.root, "cohorts", "s1pair",
                               "cohort.json")) as f:
            self.assertEqual(json.load(f)["chosen"], how)
        code, out = self.post({"run": run.id, "rows": s1, "name": "long",
                               "how": {"note": "x" * (70 << 10)}})
        self.assertEqual(code, 400)
        self.assertIn("too long to keep", out["error"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "cohorts",
                                                     "long")))
        code, out = self.post({"run": run.id, "rows": [0, 1, 2, 3],
                               "name": "both"})
        self.assertEqual(code, 400)
        self.assertIn("one result directory", out["error"])
        code, out = self.post({"run": run.id, "rows": "0", "name": "x"})
        self.assertEqual((code, out["error"]), (400, "rows are row numbers"))
        with urllib.request.urlopen(self.base + "/api/experiment") as res:
            listed = json.loads(res.read())["cohorts"]
        self.assertEqual([c["name"] for c in listed], ["s1pair"])
