"""Reading a Limen result directory: typed CSV fields, records that span
lines, the manifest, the round log, and the CLI on a real run's first 40
rounds (tests/fixtures/limen_run, from lightgbm_binary_full on 1h
BTCUSDT; its round_data.jsonl keeps each round's id, index and
parameters, without the 5,000 predictions and the alignment a round's
line also holds)."""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import tempfile
import unittest
from typing import Any

from grid.__main__ import Wiring, main
from grid.limen import (
    CsvRecords,
    csv_value,
    manifest_copy,
    read_experiment,
    round_record,
)
from grid.sweep import Json, Run, Sweep

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "fixtures",
                       "limen_run")


class CsvValue(unittest.TestCase):
    def test_fields_read_back_as_limen_wrote_them(self) -> None:
        cases = [("", None), ("True", True), ("False", False), ("5", 5),
                 ("-12", -12), ("5.0", 5.0), ("-0.009", -0.009),
                 ("1e-05", 1e-05), ("gbdt", "gbdt"),
                 ('["a, b", "c"]', ["a, b", "c"]),
                 ("[not json", "[not json")]
        for text, want in cases:
            got = csv_value(text)
            self.assertEqual(got, want, text)
            self.assertIs(type(got), type(want), text)


class Records(unittest.TestCase):
    def test_a_quoted_field_may_span_lines(self) -> None:
        r = CsvRecords()
        self.assertEqual(r.feed("a,b"), ["a", "b"])
        self.assertIsNone(r.feed('1,"two'))
        self.assertEqual(r.feed('lines"'), ["1", "two\nlines"])

    def test_a_record_must_match_the_header(self) -> None:
        r = CsvRecords()
        r.header = ["a", "b"]
        self.assertEqual(r.row(["1", ""]), {"a": 1, "b": None})
        with self.assertRaisesRegex(ValueError, "3 fields where the header "
                                                "names 2"):
            r.row(["1", "2", "3"])


class CsvRun(unittest.TestCase):
    def test_header_rows_bad_records_and_a_restart(self) -> None:
        run = Run("r0", "x", "results.csv", None, True, fmt="csv")
        for line in ["auc,tp", "0.51,", "0.49,50.0", "0.5,1,2"]:
            run.add_line(line, None)
        self.assertEqual(run.store.rows, 2)
        self.assertEqual(run.bad_count, 1)
        self.assertEqual(run.bad[0]["line"], 4)
        self.assertEqual(run.store.row_object(0), {"auc": 0.51, "tp": None})
        run.restart()
        run.add_line("auc,tp", None)
        run.add_line("0.6,100.0", None)
        self.assertEqual(run.store.rows, 1)
        self.assertEqual(run.store.row_object(0), {"auc": 0.6, "tp": 100.0})

    def test_an_unknown_format_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "jsonl or csv"):
            Run("r0", "x", "results.tsv", None, True, fmt="tsv")


class RoundLog(unittest.TestCase):
    EMPTY = '{"_round_index": 0, "round_params": {}}'

    def test_a_round_line_gives_its_index_and_its_dropped_columns(
            self) -> None:
        line = json.dumps({
            "round_id": "x", "_round_index": 7, "preds": [1, 0],
            "round_params": {"feature_drop_count": 2,
                             "_dropped_features": ["roc_24", "minute_cos"]}})
        self.assertEqual(round_record(line), (7, ["minute_cos", "roc_24"]))
        # a round that dropped nothing has no _dropped_features at all
        self.assertEqual(round_record(self.EMPTY), (0, []))

    def test_a_line_that_is_not_a_round_is_refused(self) -> None:
        cases = [
            ("[1]", "a JSON object"),
            ('{"round_params": {}}', "_round_index"),
            ('{"_round_index": true, "round_params": {}}', "_round_index"),
            ('{"_round_index": -1, "round_params": {}}', "_round_index"),
            ('{"_round_index": 3}', "no round_params"),
            ('{"_round_index": 3, "round_params": '
             '{"_dropped_features": "a"}}', "not a list"),
            ("{", ""),
        ]
        for line, why in cases:
            with self.assertRaisesRegex(ValueError, why, msg=line):
                round_record(line)

    def test_the_run_keeps_its_rounds_and_counts_lines_that_are_not(
            self) -> None:
        run = Run("r0", "x", "results.csv", None, True, fmt="csv")
        for line in [self.EMPTY, "not json", "",
                     '{"_round_index": 1, "round_params": '
                     '{"_dropped_features": ["a"]}}']:
            run.add_round_line(line)
        self.assertEqual(run.rounds, [[0, []], [1, ["a"]]])
        self.assertEqual(run.rounds_bad_count, 1)
        self.assertEqual(run.rounds_bad[0]["line"], 2)
        run.rounds_restart()
        self.assertEqual((run.rounds, run.rounds_generation,
                          run.rounds_bad_count), ([], 1, 0))

    def test_rounds_reach_a_page_in_the_pack_and_as_they_arrive(
            self) -> None:
        sweep = Sweep("s")
        run = Run("r0", "x", "results.csv", None, True, fmt="csv")
        sweep.add_run(run)
        sweep.round_line(run, self.EMPTY, True)
        text, cursor = sweep.pack_text()
        self.assertEqual(json.loads(text)["runs"][0]["rounds"], [[0, []]])
        sweep.round_line(run, '{"_round_index": 1, "round_params": '
                              '{"_dropped_features": ["b", "a"]}}', False)

        def rounds() -> list[Json]:
            msgs = [json.loads(m) for m in sweep.delta_text(cursor)]
            return [m for m in msgs if m["type"] == "rounds"]

        self.assertEqual(rounds(), [{"type": "rounds", "run": "r0",
                                     "reset": False,
                                     "entries": [[1, ["a", "b"]]]}])
        # the round log starts over: the page starts its rounds over too
        sweep.round_reset(run, "was truncated")
        sweep.round_line(run, self.EMPTY, False)
        self.assertEqual(rounds(), [{"type": "rounds", "run": "r0",
                                     "reset": True, "entries": [[0, []]]}])
        self.assertEqual(sweep.delta_text(cursor), [])


class Experiment(unittest.TestCase):
    def test_the_manifest_comes_from_metadata_and_its_copy(self) -> None:
        with open(os.path.join(FIXTURE, "metadata.json"),
                  encoding="utf-8") as f:
            meta = f.read()
        exp = read_experiment(meta, "metadata.json", "run.yaml", "# as run\n")
        self.assertEqual(exp["kind"], "limen")
        self.assertEqual(exp["manifest"]["metadata"]["name"],
                         "lightgbm_binary_full")
        self.assertIn("take_profit_bps", exp["manifest"]["sfd"]["params"])
        self.assertEqual((exp["manifestFile"], exp["manifestText"]),
                         ("run.yaml", "# as run\n"))

    def test_other_json_is_not_an_experiment(self) -> None:
        with self.assertRaisesRegex(ValueError, "no yaml_reference"):
            read_experiment('{"a": 1}', "metadata.json", "m.yaml", "")

    def test_the_copy_is_the_only_yaml_file(self) -> None:
        self.assertEqual(manifest_copy(["results.csv", "metadata.json",
                                        "exp.yaml"], "d"), "exp.yaml")
        self.assertEqual(manifest_copy(["manifest.yaml", "audit.jsonl"],
                                       "d"), "manifest.yaml")
        with self.assertRaisesRegex(ValueError, "d holds no YAML file"):
            manifest_copy(["results.csv"], "d")
        with self.assertRaisesRegex(ValueError, r"2 YAML files \(a.yaml, "
                                                r"b.yml\)"):
            manifest_copy(["b.yml", "a.yaml"], "d")


class PackLimen(unittest.TestCase):
    def test_pack_reads_a_result_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "pack.json.gz")
            self.assertEqual(main(["pack", "--limen", FIXTURE,
                                   "--out", out]), 0)
            with gzip.open(out, "rt", encoding="utf-8") as f:
                pack = json.load(f)
        self.assertEqual(pack["name"], "lightgbm_binary_full")
        run = pack["runs"][0]
        self.assertEqual(run["label"], "limen_run")
        self.assertEqual(run["format"], "csv")
        self.assertEqual(run["rows"], 40)
        self.assertEqual(run["badCount"], 0)
        self.assertEqual(run["experiment"]["manifest"]["uel"]
                         ["n_permutations"], 500)
        self.assertEqual(run["experiment"]["manifestFile"],
                         "lightgbm_binary_full.yaml")
        # where the directory is, in full, for the command that replays a
        # round from anywhere
        self.assertEqual(run["experiment"]["dir"], os.path.abspath(FIXTURE))
        self.assertIsNone(run["experiment"]["host"])
        self.assertIn("n_permutations: 500",
                      run["experiment"]["manifestText"])
        kinds = {c["name"]: c["kind"] for c in run["columns"]}
        self.assertEqual(kinds["stop_loss_bps"], "num")
        self.assertEqual(kinds["use_calibration"], "bool")
        self.assertEqual(kinds["_warnings"], "set")
        # the round log: every round, the columns its ablation dropped
        self.assertTrue(run["experiment"]["roundLog"].endswith("round_data.jsonl"))
        self.assertEqual([r[0] for r in run["rounds"]], list(range(40)))
        self.assertEqual(sum(1 for r in run["rounds"] if r[1]), 33)
        self.assertEqual(run["roundsBadCount"], 0)

    def test_a_directory_without_a_round_log_says_so(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("metadata.json", "results.csv",
                         "lightgbm_binary_full.yaml"):
                with open(os.path.join(FIXTURE, name), "rb") as src, \
                        open(os.path.join(tmp, name), "wb") as dst:
                    dst.write(src.read())
            out = os.path.join(tmp, "pack.json.gz")
            self.assertEqual(main(["pack", "--limen", tmp, "--out", out]), 0)
            with gzip.open(out, "rt", encoding="utf-8") as f:
                run = json.load(f)["runs"][0]
        self.assertIsNone(run["experiment"]["roundLog"])
        self.assertEqual(run["rounds"], [])

    def test_a_directory_without_metadata_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(SystemExit, "not a Limen result"):
                main(["pack", "--limen", tmp, "--out",
                      os.path.join(tmp, "p.json")])

    def test_a_directory_without_its_manifest_copy_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("metadata.json", "results.csv"):
                with open(os.path.join(FIXTURE, name), "rb") as src, \
                        open(os.path.join(tmp, name), "wb") as dst:
                    dst.write(src.read())
            with self.assertRaisesRegex(SystemExit, "holds no YAML file"):
                main(["pack", "--limen", tmp, "--out",
                      os.path.join(tmp, "p.json")])


def shard(directory: str, rows: range, seed: Any,
          n_permutations: int = 500) -> None:
    """A result directory made from some of the fixture's rounds, as one of
    several ``limen run`` side by side writes it: its rounds counted from
    0, under its own search seed."""
    os.makedirs(directory)
    with open(os.path.join(FIXTURE, "results.csv"), encoding="utf-8") as f:
        records = list(csv.reader(f))
    at = records[0].index("_round_index")
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(records[0])
    for k, i in enumerate(rows):
        record = list(records[i + 1])
        record[at] = str(k)
        w.writerow(record)
    with open(os.path.join(directory, "results.csv"), "w",
              encoding="utf-8") as f:
        f.write(out.getvalue())
    with open(os.path.join(FIXTURE, "round_data.jsonl"),
              encoding="utf-8") as f:
        lines = f.read().splitlines()
    with open(os.path.join(directory, "round_data.jsonl"), "w",
              encoding="utf-8") as f:
        for k, i in enumerate(rows):
            rec = json.loads(lines[i])
            rec["_round_index"] = k
            f.write(json.dumps(rec) + "\n")
    with open(os.path.join(FIXTURE, "metadata.json"), encoding="utf-8") as f:
        meta = json.load(f)
    uel = meta["yaml_reference"]["uel"]
    uel["search_strategy"]["seed"] = seed
    uel["n_permutations"] = n_permutations
    with open(os.path.join(directory, "metadata.json"), "w",
              encoding="utf-8") as f:
        json.dump(meta, f)
    copy = "lightgbm_binary_full.yaml"
    with open(os.path.join(FIXTURE, copy), "rb") as src, \
            open(os.path.join(directory, copy), "wb") as dst:
        dst.write(src.read())


def read(*limen: str) -> Run:
    args = argparse.Namespace(limen=list(limen), ssh=None, name=None,
                              label=None, log=None, run=None, as_=None,
                              results=None)
    w = Wiring(args, follow=False)
    sweep = w.build()
    w.read_once()
    return sweep.runs[0]


class Shards(unittest.TestCase):
    """Several result directories of one manifest, run side by side with
    different search seeds, read as one run."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.a = os.path.join(self.tmp.name, "runs", "a")
        self.b = os.path.join(self.tmp.name, "runs", "b")
        shard(self.a, range(0, 20), 1)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_their_rows_are_one_run_joined_by_round_index(self) -> None:
        shard(self.b, range(20, 40), 2)
        run = read(self.a, self.b)
        self.assertEqual(run.label, "2 result directories")
        rows = [run.store.row_object(i) for i in range(run.store.rows)]
        self.assertEqual(len(rows), 40)
        # the history of each joined by round index, as they ran side by side
        self.assertEqual([r["shard"] for r in rows[:4]], ["a", "b", "a", "b"])
        self.assertEqual([r["_round_index"] for r in rows[:4]], [0, 0, 1, 1])
        assert run.experiment is not None
        self.assertIsNone(run.experiment["dir"])
        self.assertEqual(run.experiment["shards"],
                         {"a": os.path.abspath(self.a),
                          "b": os.path.abspath(self.b)})
        # each round is its directory's
        self.assertEqual(len(run.rounds), 40)
        self.assertEqual(sorted({r[2] for r in run.rounds}), ["a", "b"])
        self.assertEqual(run.rounds[0][:1] + run.rounds[0][2:], [0, "a"])

    def test_pack_takes_them_given_again(self) -> None:
        shard(self.b, range(20, 40), 2)
        out = os.path.join(self.tmp.name, "pack.json")
        self.assertEqual(main(["pack", "--limen", self.a, "--limen", self.b,
                               "--out", out]), 0)
        with open(out, encoding="utf-8") as f:
            run = json.load(f)["runs"][0]
        self.assertEqual(run["rows"], 40)
        self.assertEqual(sorted(run["experiment"]["shards"]), ["a", "b"])
        self.assertEqual(len(run["rounds"]), 40)

    def test_a_folder_of_them_reads_the_same(self) -> None:
        shard(self.b, range(20, 40), 2)
        run = read(os.path.join(self.tmp.name, "runs"))
        self.assertEqual(run.label, "runs")
        self.assertEqual(run.store.rows, 40)
        assert run.experiment is not None
        self.assertEqual(sorted(run.experiment["shards"]), ["a", "b"])

    def test_a_later_row_joins_as_it_arrives(self) -> None:
        shard(self.b, range(20, 40), 2)
        s = Sweep("t")
        run = Run("r0", "two", "x", None, True, None, "csv", {},
                  ["a", "b"])
        s.add_run(run)
        with open(os.path.join(self.a, "results.csv"), encoding="utf-8") as f:
            a = f.read().splitlines()
        with open(os.path.join(self.b, "results.csv"), encoding="utf-8") as f:
            b = f.read().splitlines()
        for line in a[:3]:
            s.run_line(run, line, True, 0)
        s.run_line(run, b[0], True, 1)
        s.run_line(run, a[3], False, 0)   # live before b's history is read
        s.run_line(run, b[1], True, 1)
        self.assertEqual(run.store.rows, 0)   # held until every file is read
        s.merge(run)
        got = [(run.store.row_object(i)["shard"],
                run.store.row_object(i)["_round_index"])
               for i in range(run.store.rows)]
        self.assertEqual(got, [("a", 0), ("b", 0), ("a", 1), ("a", 2)])
        s.run_line(run, b[2], False, 1)
        self.assertEqual(run.store.rows, 5)
        self.assertEqual(run.store.row_object(4)["shard"], "b")

    def test_another_manifest_is_refused_with_where_it_differs(self) -> None:
        shard(self.b, range(20, 40), 2, n_permutations=900)
        with self.assertRaisesRegex(SystemExit,
                                    "uel.n_permutations 500, then 900"):
            read(self.a, self.b)

    def test_one_seed_twice_is_refused(self) -> None:
        shard(self.b, range(20, 40), 1)
        with self.assertRaisesRegex(SystemExit, "share the search seed 1"):
            read(self.a, self.b)


if __name__ == "__main__":
    unittest.main()
