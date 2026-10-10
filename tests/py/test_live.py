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

from grid.__main__ import main
from grid.follow import FileFollower
from grid.logparse import parse_text
from grid.server import serve
from grid.sweep import Cursor, Run, Sweep

LIMEN_FIXTURE = os.path.join(os.path.dirname(__file__), "..", "fixtures",
                             "limen_run")
TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "tools")


class Collect:
    def __init__(self):
        self.lines = []
        self.resets = []
        self.errors = []

    def line(self, text, preload):
        self.lines.append((text, preload))

    def reset(self, reason):
        self.resets.append(reason)

    def error(self, msg):
        self.errors.append(msg)


class FollowerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "results.jsonl")
        self.c = Collect()

    def tearDown(self):
        self.dir.cleanup()

    def write(self, text, mode="a"):
        with open(self.path, mode) as f:
            f.write(text)

    def follower(self):
        return FileFollower(self.path, self.c.line, self.c.reset,
                            self.c.error)

    def test_preloaded_lines_then_live_lines_and_partial_line(self):
        self.write('{"a":1}\n{"a":2}\n', "w")
        f = self.follower()
        f.read_available()
        self.assertEqual(self.c.lines, [('{"a":1}', True), ('{"a":2}', True)])
        self.write('{"a":')
        f.read_available()
        self.assertEqual(len(self.c.lines), 2)  # the half line waits
        self.write('3}\n')
        f.read_available()
        self.assertEqual(self.c.lines[-1], ('{"a":3}', False))

    def test_the_look_that_bounds_the_history_gives_its_time(self):
        # the file's time comes from the same look that decides which
        # lines are history, so a line written after it is live, never an
        # old line with a stale time
        self.write('{"a":1}\n', "w")
        hour_ago = time.time() - 3600
        os.utime(self.path, (hour_ago, hour_ago))
        seen = []
        f = FileFollower(self.path, self.c.line, self.c.reset, self.c.error,
                         on_history=seen.append)
        f.read_available()
        self.write('{"a":2}\n')
        f.read_available()
        self.assertEqual(len(seen), 1)
        self.assertAlmostEqual(seen[0], hour_ago, places=3)
        self.assertEqual(self.c.lines, [('{"a":1}', True), ('{"a":2}', False)])

    def test_truncation_starts_over(self):
        self.write('{"a":1}\n{"a":2}\n', "w")
        f = self.follower()
        f.read_available()
        self.write('{"b":1}\n', "w")
        f.read_available()
        self.assertEqual(self.c.resets, ["truncated"])
        self.assertEqual(self.c.lines[-1], ('{"b":1}', False))

    def test_replacement_starts_over(self):
        self.write('{"a":1}\n', "w")
        f = self.follower()
        f.read_available()
        other = self.path + ".new"
        with open(other, "w") as g:
            g.write('{"c":1}\n{"c":2}\n')
        os.replace(other, self.path)
        f.read_available()
        self.assertEqual(self.c.resets, ["replaced"])
        self.assertEqual([t for t, _ in self.c.lines[-2:]],
                         ['{"c":1}', '{"c":2}'])

    def test_missing_file_is_an_error(self):
        f = FileFollower(os.path.join(self.dir.name, "none.jsonl"),
                         self.c.line, self.c.reset, self.c.error,
                         follow=False)
        with self.assertRaises(FileNotFoundError):
            f.run()
        self.assertTrue(self.c.errors)


class SweepTest(unittest.TestCase):
    def test_bad_lines_are_counted_and_kept(self):
        s = Sweep("t")
        run = Run("r0", "current", "x", None, True)
        s.add_run(run)
        s.run_line(run, '{"a":1}', True)
        s.run_line(run, '{"a":', False)
        s.run_line(run, '[1,2]', False)
        s.run_line(run, '', False)
        self.assertEqual(run.store.rows, 1)
        self.assertEqual(run.bad_count, 2)
        self.assertEqual([b["line"] for b in run.bad], [2, 3])

    def test_reset_archives_rows_and_deltas_follow(self):
        s = Sweep("t")
        run = Run("r0", "current", "x", None, True)
        s.add_run(run)
        for i in range(3):
            s.run_line(run, json.dumps({"i": i, "m": "a"}), True)
        text, cursor = s.pack_text()
        pack = json.loads(text)
        self.assertEqual(pack["runs"][0]["rows"], 3)
        self.assertEqual(pack["runs"][0]["arrivals"], [None, None, None])
        s.run_line(run, json.dumps({"i": 3, "m": "b"}), False)
        msgs = [json.loads(m) for m in s.delta_text(cursor)]
        rows = [m for m in msgs if m["type"] == "rows"]
        self.assertEqual((rows[0]["lo"], rows[0]["hi"]), (3, 4))
        m = {c["name"]: c for c in rows[0]["columns"]}["m"]
        self.assertEqual((m["levelBase"], m["levels"], m["data"]),
                         (1, ["b"], [1]))
        self.assertIsNotNone(rows[0]["arrivals"][0])
        s.run_reset(run, "truncated")
        s.run_line(run, json.dumps({"i": 0, "m": "c"}), False)
        self.assertEqual([r.id for r in s.runs], ["r0.g0", "r0"])
        self.assertEqual(s.runs[0].store.rows, 4)
        msgs = [json.loads(m) for m in s.delta_text(cursor)]
        kinds = [(m["type"], m.get("run", {}).get("id")
                  if m["type"] == "run" else m.get("run")) for m in msgs]
        self.assertIn(("run", "r0.g0"), kinds)
        self.assertIn(("run", "r0"), kinds)
        fresh = [m for m in msgs if m["type"] == "rows" and m["run"] == "r0"]
        self.assertEqual((fresh[0]["lo"], fresh[0]["hi"]), (0, 1))
        self.assertEqual(s.delta_text(cursor), [])

    def test_an_archived_run_keeps_its_log_and_its_segment(self):
        s = Sweep("t")
        s.add_log("l0", "sweep.log")
        run = Run("r0", "current", "x", None, True, "l0")
        s.add_run(run)
        # read at startup: the first start and its rows
        s.log_line("l0", "sampling 100 A-perms...", True)
        for i in range(3):
            s.run_line(run, json.dumps({"i": i}), True)
        # live: a relaunch's start line read before the results file
        # starts over; the rows kept came from the first segment
        s.log_line("l0", "--- 20261009_154104 relaunch ---", False)
        s.log_line("l0", "sampling 100 A-perms...", False)
        s.run_reset(run, "truncated")
        old = s.runs[0].meta()
        self.assertEqual((old["id"], old["logId"], old["segment"]),
                         ("r0.g0", "l0", 0))
        # it keeps the run's name; when and why it was kept are its own,
        # for the page to say on the reader's clock
        self.assertEqual((old["label"], old["archivedReason"]),
                         ("current", "truncated"))
        self.assertIsInstance(old["archivedAt"], float)
        # rows of the relaunch, then the file starts over again before
        # any start line: those came from the second segment
        time.sleep(0.01)
        for i in range(2):
            s.run_line(run, json.dumps({"i": i}), False)
        s.run_reset(run, "truncated")
        self.assertEqual([r.id for r in s.runs], ["r0.g0", "r0.g1", "r0"])
        self.assertEqual((s.runs[1].log_id, s.runs[1].segment), ("l0", 1))
        # the run being written follows the latest segment
        self.assertIsNone(run.segment)


class ServerTest(unittest.TestCase):
    def test_pack_stream_and_row(self):
        s = Sweep("t")
        run = Run("r0", "current", "x", None, True)
        s.add_run(run)
        s.run_line(run, json.dumps({"a": 1, "hp": {"d": 2}}), True)
        httpd = serve(s, lambda: b"<html>page</html>", "127.0.0.1", 0)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % httpd.server_address[1]
        try:
            self.assertEqual(urllib.request.urlopen(base + "/").read(),
                             b"<html>page</html>")
            req = urllib.request.Request(base + "/api/pack",
                                         headers={"Accept-Encoding": "gzip"})
            raw = urllib.request.urlopen(req).read()
            body = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b"
                              else raw)
            self.assertEqual(body["pack"]["runs"][0]["rows"], 1)
            row = json.loads(urllib.request.urlopen(
                base + "/api/row?run=r0&i=0").read())
            self.assertEqual(row["row"], {"a": 1, "hp": {"d": 2}})
            stream = urllib.request.urlopen(
                base + "/api/stream?cursor=" + body["cursor"], timeout=10)

            def later():
                time.sleep(0.3)
                s.run_line(run, json.dumps({"a": 2}), False)
            threading.Thread(target=later, daemon=True).start()
            got = None
            while got is None:
                line = stream.readline().decode().strip()
                if line.startswith("data: "):
                    msg = json.loads(line[6:])
                    if msg["type"] == "rows":
                        got = msg
            self.assertEqual((got["lo"], got["hi"]), (1, 2))
            stream.close()
            with self.assertRaises(urllib.error.HTTPError) as err:
                urllib.request.urlopen(
                    base + "/api/stream?cursor=" + body["cursor"])
            self.assertEqual(err.exception.code, 410)
            err.exception.close()
        finally:
            httpd.shutdown()

    def test_cursor_type(self):
        self.assertEqual(Cursor().version, -1)


class WrittenAtTest(unittest.TestCase):
    """Rows read when the server starts have no arrival time; the run says
    when its files were last written instead."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.hour_ago = time.time() - 3600

    def tearDown(self):
        self.dir.cleanup()

    def pack(self, *args):
        out = os.path.join(self.dir.name, "pack.json")
        self.assertEqual(main(["pack", *args, "--out", out]), 0)
        with open(out, encoding="utf-8") as f:
            return json.load(f)["runs"][0]

    def test_a_results_file_gives_its_modification_time(self):
        path = os.path.join(self.dir.name, "results.jsonl")
        with open(path, "w") as f:
            f.write('{"a": 1}\n{"a": 2}\n')
        os.utime(path, (self.hour_ago, self.hour_ago))
        run = self.pack("--results", path)
        self.assertAlmostEqual(run["writtenAt"], self.hour_ago, places=3)
        self.assertEqual(run["arrivals"], [None, None])

    def test_a_limen_run_gives_the_latest_of_its_files(self):
        d = os.path.join(self.dir.name, "run")
        shutil.copytree(LIMEN_FIXTURE, d)
        for name, ago in (("results.csv", 7200), ("round_data.jsonl", 3600)):
            t = time.time() - ago
            os.utime(os.path.join(d, name), (t, t))
        # the feedback audit was written last; there is no checkpoint, and
        # the metadata and the manifest's copy are not the run's writing
        audit = os.path.join(d, "audit.jsonl")
        with open(audit, "w") as f:
            f.write('{"round": 100}\n')
        last = time.time() - 60
        os.utime(audit, (last, last))
        run = self.pack("--limen", d)
        self.assertAlmostEqual(run["writtenAt"], last, places=3)

    def test_a_file_that_starts_over_drops_its_time(self):
        s = Sweep("t")
        run = Run("r0", "current", "x", None, True)
        run.written_at = self.hour_ago
        s.add_run(run)
        s.run_line(run, json.dumps({"a": 1}), True)
        s.run_reset(run, "truncated")
        self.assertIsNone(run.written_at)
        # the rows kept keep it
        self.assertEqual(s.runs[0].written_at, self.hour_ago)


class DemoTest(unittest.TestCase):
    def test_the_demo_s_clock_carries_on_from_its_history(self):
        sys.path.insert(0, TOOLS)
        try:
            import live_demo
            import synth
        finally:
            sys.path.remove(TOOLS)
        with tempfile.TemporaryDirectory() as d:
            synth.write(300, d, 3, 500000)
            log = os.path.join(d, "sweep.log")
            stop = threading.Event()
            play = threading.Thread(target=live_demo.play_append,
                                    args=(d, 400.0, stop))
            play.start()
            try:
                deadline = time.time() + 20
                while time.time() < deadline:
                    with open(log) as f:
                        if "\n500/500000 " in f.read():
                            break
                    time.sleep(0.05)
            finally:
                stop.set()
                play.join(10)
            with open(log) as f:
                seg = parse_text(f.read()).segments[-1]
            # the rows the demo appends carry on the segment's clock
            seconds = [p[2] for p in seg.progress]
            self.assertGreaterEqual(len(seconds), 5, seconds)
            self.assertEqual(seconds, sorted(seconds))


if __name__ == "__main__":
    unittest.main()
