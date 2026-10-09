import unittest

from grid.logparse import LogParser, parse_text

LOG = '''sampling 500 A-perms...
100/500 16s top: gates=6 mean=+3.85 logreg
200/500 29s top: gates=6 mean=+4.88 lgbm_hp
--- 20261008_182937 P0-P2 relaunch (grand on hold) ---
sampling 500 A-perms...
/srv/x/research/eval/harness.py:38: FutureWarning: adfuller returns a tuple
  return float(adfuller(x, maxlag=1, regression="c")[1])
100/500 17s top: gates=6 mean=+3.95 xgb_tuned
/srv/x/research/eval/harness.py:38: FutureWarning: adfuller returns a tuple
  return float(adfuller(x, maxlag=1, regression="c")[1])
multiprocessing.pool.RemoteTraceback:
"""
Traceback (most recent call last):
  File "/usr/lib/python3.14/multiprocessing/pool.py", line 125, in worker
    result = (True, func(*args, **kwds))
                    ~~~~^^^^^^^^^^^^^^^
  File "/srv/x/research/pocket_a.py", line 269, in oos_pf
    Dtr, Dte = post(Xc, tr, te)
               ~~~~^^^^^^^^^^^^
  File "/srv/x/research/pocket_a.py", line 419, in post_meta
    Dtr = expand(Xc[tr], KI, RI)
                         ^^
NameError: cannot access free variable 'KI'
"""

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/srv/x/research/pocket_a.py", line 979, in <module>
    sweep(a.n, a.workers, a.seed)
  File "/usr/lib/python3.14/multiprocessing/pool.py", line 873, in next
    raise value
NameError: cannot access free variable 'KI'
--- 20261008_183539 relaunch post stack-pf fix ---
sampling 500 A-perms...
/v/sklearn/linear_model/_sag.py:348: ConvergenceWarning: The max_iter was reached
  warnings.warn(
100/500 23s top: gates=6 mean=+2.30 xgb_tuned
something unexpected
500/500 90s top: gates=7 mean=+5.84 lgbm_hp
-- top 5 / 500 --
  gates=7 mean=+5.84% maxDD=2378 TP=0.4 SL=None
logged
'''


class LogParseTest(unittest.TestCase):
    def setUp(self):
        self.p = parse_text(LOG)
        self.j = self.p.to_json()

    def test_segments_markers_and_status(self):
        segs = self.j["segments"]
        self.assertEqual([s["status"] for s in segs],
                         ["ended without a closing line", "crashed",
                          "finished"])
        self.assertIsNone(segs[0]["marker"])
        self.assertEqual(segs[1]["marker"]["stamp"], "20261008_182937")
        self.assertEqual(segs[2]["marker"]["label"],
                         "relaunch post stack-pf fix")
        self.assertEqual(segs[0]["endLine"], 3)
        self.assertEqual(segs[2]["total"], 500)

    def test_progress_lines(self):
        prog = self.j["segments"][0]["progress"]
        self.assertEqual(prog[0][1:4], [100, 16.0, {"gates": 6,
                                                    "mean": 3.85}])
        self.assertEqual(prog[1][4], "top: lgbm_hp")
        self.assertEqual(self.j["segments"][2]["progress"][-1][1], 500)

    def test_crash_names_the_innermost_own_frame(self):
        crash = self.j["segments"][1]["crash"]
        self.assertEqual(crash["exception"], "NameError")
        self.assertEqual(crash["message"], "cannot access free variable 'KI'")
        self.assertEqual(crash["where"]["func"], "post_meta")
        self.assertEqual(crash["where"]["line"], 419)
        self.assertEqual(crash["where"]["code"], "Dtr = expand(Xc[tr], KI, RI)")
        self.assertEqual(crash["row"], 100)
        self.assertEqual(len(self.j["crashes"]), 1)

    def test_warnings_are_counted_once_per_kind(self):
        w = {x["category"]: x for x in self.j["warnings"]}
        self.assertEqual(w["FutureWarning"]["count"], 2)
        self.assertEqual(w["FutureWarning"]["first"]["row"], 0)
        self.assertEqual(w["FutureWarning"]["last"]["row"], 100)
        self.assertEqual(w["ConvergenceWarning"]["segments"], [2])

    def test_unknown_lines_are_counted_not_dropped(self):
        self.assertEqual(self.j["other"]["count"], 1)
        self.assertEqual(self.j["other"]["samples"][0]["text"],
                         "something unexpected")

    def test_incremental_feed_matches_whole_parse(self):
        p = LogParser()
        for line in LOG.splitlines():
            p.feed(line)
        p.flush()
        self.assertEqual(p.to_json(), self.j)

    def test_start_line_without_dots_and_a_log_picked_up_mid_run(self):
        p = parse_text("sampling 500000 A-perms models=logreg -> data/x\n"
                       "100/500000 21s top: gates=6 mean=+3.10 logreg\n")
        seg = p.to_json()["segments"][0]
        self.assertEqual(seg["what"], "A-perms models=logreg -> data/x")
        self.assertEqual(seg["progress"][0][1], 100)
        q = parse_text("4100/500000 615s top: gates=7 mean=+5.84 lgbm_hp\n")
        seg = q.to_json()["segments"][0]
        self.assertEqual(seg["total"], 500000)
        self.assertEqual(seg["what"], "(the start is not in the log)")
        self.assertEqual(q.to_json()["other"]["count"], 0)

    def test_open_traceback_waits_for_flush(self):
        p = LogParser()
        p.feed("sampling 10 perms...")
        p.feed("Traceback (most recent call last):")
        p.feed('  File "/a/run.py", line 3, in main')
        p.feed("ValueError: bad")
        self.assertTrue(p.to_json()["openTraceback"])
        p.flush()
        j = p.to_json()
        self.assertEqual(j["segments"][0]["status"], "crashed")
        self.assertEqual(j["crashes"][0]["where"]["path"], "/a/run.py")


if __name__ == "__main__":
    unittest.main()
