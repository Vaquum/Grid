"""Reading a Limen result directory: typed CSV fields, records that span
lines, the manifest, and the CLI on a real run's first 40 rounds
(tests/fixtures/limen_run, from lightgbm_binary_full on 1h BTCUSDT)."""

from __future__ import annotations

import gzip
import json
import os
import tempfile
import unittest

from tessera.__main__ import main
from tessera.limen import CsvRecords, csv_value, read_experiment
from tessera.sweep import Run

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


class Experiment(unittest.TestCase):
    def test_the_manifest_comes_from_metadata(self) -> None:
        with open(os.path.join(FIXTURE, "metadata.json"),
                  encoding="utf-8") as f:
            exp = read_experiment(f.read(), "metadata.json")
        self.assertEqual(exp["kind"], "limen")
        self.assertEqual(exp["manifest"]["metadata"]["name"],
                         "lightgbm_binary_full")
        self.assertIn("take_profit_bps", exp["manifest"]["sfd"]["params"])

    def test_other_json_is_not_an_experiment(self) -> None:
        with self.assertRaisesRegex(ValueError, "no yaml_reference"):
            read_experiment('{"a": 1}', "metadata.json")


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
        kinds = {c["name"]: c["kind"] for c in run["columns"]}
        self.assertEqual(kinds["stop_loss_bps"], "num")
        self.assertEqual(kinds["use_calibration"], "bool")
        self.assertEqual(kinds["_warnings"], "set")

    def test_a_directory_without_metadata_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(SystemExit, "not a Limen result"):
                main(["pack", "--limen", tmp, "--out",
                      os.path.join(tmp, "p.json")])


if __name__ == "__main__":
    unittest.main()
