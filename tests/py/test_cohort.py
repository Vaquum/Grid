"""The Cohort view's server side (grid/cohort.py): a cohort of a Limen run's
rounds judged on what the run recorded. Limen's long-flat execution is
rebuilt from a round's recorded signal and checked against the execution
Limen recorded for it; the members' bars are aligned by time; their
probabilities are averaged as Limen's Cohort averages them; and the route
serves it for a run's rows.

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
import tempfile
import threading
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
from grid.server import serve
from grid.sweep import Json

HERE = os.path.dirname(os.path.abspath(__file__))
ROUNDS: list[Json] = json.load(gzip.open(os.path.join(
    HERE, "..", "fixtures", "limen_cohort_rounds.json.gz"), "rt"))
RUN = os.path.join(HERE, "..", "fixtures", "limen_cohort")
HOUR = 3600


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

    def test_members_meet_on_the_bars_they_share(self) -> None:
        # three bars more on one; a bar dropped by the other
        a = synthetic("a", [0.9] * 8)
        b = synthetic("b", [0.2] * 5, dropped=["1"])
        out = judge([a, b], HOUR, 0.0, 0.0)
        self.assertEqual(out["bars"], 5)
        self.assertEqual((out["last"] - out["first"]) // HOUR, 5)


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
        self.assertIn("calibrated and uncalibrated", out["notes"][0])
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
