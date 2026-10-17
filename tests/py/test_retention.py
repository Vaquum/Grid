"""Exact retention against recorded inputs, including interrupted publication."""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from grid.__main__ import Wiring, main
from grid.cohort import RoundLines
from grid.evidence import Evidence, Reducer, encoded, record_digest
from grid.experiment import Project, _slim
from grid.limen import round_object
from grid.retention import (
    CSV,
    Reader,
    compact,
    descriptor,
    materialize,
    materialize_in_place,
    verify,
)
from grid.round_storage import COMPACT, DESCRIPTOR, PLAIN, RETAINED
from grid.sweep import Run, Sweep
from tests.py.test_round_storage import compress

FIXTURES = Path(__file__).parents[1] / "fixtures"


def science(path: Path, output: Path) -> dict:
    main(["pack", "--limen", str(path), "--out", str(output)])
    run = json.loads(output.read_text())["runs"][0]
    return {
        k: run.get(k)
        for k in (
            "rows",
            "columns",
            "rounds",
            "bad",
            "badCount",
            "roundsBad",
            "roundsBadCount",
        )
    }


class Retention(unittest.TestCase):
    def test_lossless_numeric_types_nulls_and_float64_bits(self) -> None:
        recorded = json.loads(
            gzip.decompress(
                (FIXTURES / "limen_execution_round.json.gz").read_bytes()
            )
        )
        values = [
            recorded["execution"][key] for key in ("pos", "gross", "net")
        ]
        values += [
            recorded["market"]["ret"],
            [0, 1, 1, 0],
            [-0.0, 0.0, None, 1.0],
            [1, 1.0, True, None, 2**80],
        ]
        with tempfile.TemporaryDirectory() as tmp:
            store = Evidence(Path(tmp) / "evidence.sqlite3", writable=True)
            try:
                for vector in values:
                    key = store.put_vector(vector)
                    self.assertEqual(
                        encoded(vector), encoded(store.vector(key))
                    )
                    self.assertEqual(key, store.put_vector(vector))
                self.assertNotEqual(
                    store.put_vector([1]), store.put_vector([1.0])
                )
                self.assertNotEqual(
                    store.put_vector([0.0]), store.put_vector([-0.0])
                )
                key = store.put_vector(values[0])
                copy = store.vector(key)
                copy.clear()
                self.assertEqual(store.vector(key), values[0])
                with self.assertRaises(ValueError):
                    store.get("../not-a-digest")
            finally:
                store.close()

    def test_pack_cohort_training_and_full_materialization(self) -> None:
        for fixture in ("limen_run", "limen_rule", "limen_walk_forward"):
            with (
                self.subTest(fixture=fixture),
                tempfile.TemporaryDirectory() as tmp,
            ):
                root = Path(tmp)
                run = root / "run"
                shutil.copytree(FIXTURES / fixture, run)
                original_csv = (run / "results.csv").read_bytes()
                original_rounds = (run / PLAIN).read_bytes()
                records = [
                    json.loads(line) for line in original_rounds.splitlines()
                ]
                expected = science(run, root / "before.json")
                compact(run, root / "shared.sqlite3", sealed=True, prune=True)
                self.assertFalse((run / PLAIN).exists())
                self.assertFalse((run / "results.csv").exists())
                self.assertEqual(expected, science(run, root / "after.json"))
                project = Project.__new__(Project)
                project.counts = {}
                count = (
                    len(list(csv.reader(io.StringIO(original_csv.decode()))))
                    - 1
                )
                self.assertEqual(
                    project._rows(str(run / "results.csv")), count
                )
                self.assertEqual(
                    project._rows(str(run / "results.csv")), count
                )
                self.assertEqual(verify(run)["records"], len(records))
                for record in records:
                    actual = RoundLines().get(str(run), record["round_id"])
                    self.assertEqual(encoded(actual), encoded(record))
                _slim(str(run), str(root / "selected"), records[:2])
                selected = (root / "selected" / PLAIN).read_text().splitlines()
                self.assertEqual(
                    [json.loads(line) for line in selected], records[:2]
                )
                materialize(run, root / "native")
                self.assertEqual(
                    (root / "native/results.csv").read_bytes(), original_csv
                )
                self.assertEqual(
                    (root / "native" / PLAIN).read_bytes(), original_rounds
                )
                self.assertEqual(
                    expected, science(root / "native", root / "native.json")
                )

    def test_compressed_market_refs_and_duplicate_occurrences_survive(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_run", run)
            records = compress(run)
            with gzip.open(run / COMPACT, "rb") as stream:
                repeated = stream.readline()
            with (run / COMPACT).open("ab") as stream:
                stream.write(gzip.compress(repeated, mtime=0))
            records.append(records[0])
            expected = science(run, root / "before.json")
            desc = compact(
                run, root / "shared.sqlite3", sealed=True, prune=True
            )
            self.assertEqual(expected, science(run, root / "after.json"))
            self.assertFalse((run / "round_market").exists())
            reader = Reader(run)
            try:
                for record in records:
                    self.assertEqual(
                        encoded(reader.get(record["round_id"])),
                        encoded(record),
                    )
            finally:
                reader.close()
            again = compact(
                run, root / "shared.sqlite3", sealed=True, prune=True
            )
            self.assertEqual(again["id"], desc["id"])

    def test_changed_sources_and_interrupted_publication_keep_originals(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            original = (run / "results.csv").read_bytes()
            from grid import retention

            copy_csv = retention._gzip_copy

            def change(source: Path, destination: Path) -> None:
                copy_csv(source, destination)
                source.write_bytes(original + b"\n")

            with (
                patch("grid.retention._gzip_copy", change),
                self.assertRaisesRegex(ValueError, "changed"),
            ):
                compact(run, root / "shared.sqlite3", sealed=True, prune=True)
            self.assertTrue((run / PLAIN).is_file())
            self.assertFalse((run / DESCRIPTOR).exists())
            (run / "results.csv").write_bytes(original)
            atomic = retention.atomic_json

            def interrupt(path: Path, value: object) -> None:
                if path.name == DESCRIPTOR:
                    raise OSError("interrupted publication")
                atomic(path, value)

            with (
                patch("grid.retention.atomic_json", interrupt),
                self.assertRaisesRegex(OSError, "interrupted"),
            ):
                compact(run, root / "shared.sqlite3", sealed=True, prune=True)
            self.assertTrue((run / PLAIN).is_file())
            self.assertEqual((run / "results.csv").read_bytes(), original)
            self.assertFalse((run / DESCRIPTOR).exists())
            compact(run, root / "shared.sqlite3", sealed=True, prune=True)
            self.assertTrue(verify(run)["exact"])

    def test_refuses_unsealed_active_reader_and_partial_round(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            with self.assertRaisesRegex(ValueError, "sealed"):
                compact(run, root / "shared.sqlite3", sealed=False, prune=True)
            from grid.retention import read_lease

            lease = read_lease(run)
            assert lease is not None
            try:
                with self.assertRaisesRegex(ValueError, "open in Grid"):
                    compact(
                        run, root / "shared.sqlite3", sealed=True, prune=True
                    )
            finally:
                os.close(lease)
            if Path("/proc").is_dir():
                with (
                    (run / PLAIN).open("ab"),
                    self.assertRaisesRegex(ValueError, "producer write FD"),
                ):
                    compact(
                        run, root / "shared.sqlite3", sealed=True, prune=True
                    )
            with (run / PLAIN).open("ab") as stream:
                stream.write(b'{"round_id":')
            with self.assertRaisesRegex(ValueError, "Unterminated"):
                compact(run, root / "shared.sqlite3", sealed=True, prune=True)
            self.assertTrue((run / PLAIN).is_file())

    def test_bad_lines_blank_lines_and_unpaired_csv_are_preserved(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            with (run / PLAIN).open("ab") as stream:
                stream.write(b'\n{"broken":true}\nnot-json\n')
            expected = science(run, root / "before.json")
            compact(run, root / "shared.sqlite3", sealed=True, prune=True)
            self.assertEqual(expected, science(run, root / "after.json"))
            materialize(run, root / "native")
            self.assertEqual(
                expected, science(root / "native", root / "native.json")
            )

    def test_native_restore_requires_closed_readers_and_keeps_history(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            compact(run, root / "shared.sqlite3", sealed=True, prune=True)
            args = argparse.Namespace(
                name=None,
                limen=[str(run)],
                ssh=None,
                project=None,
                as_=None,
                log=None,
                run=None,
                label=None,
            )
            wiring = Wiring(args, follow=False)
            try:
                sweep = wiring.build()
                wiring.read_once()
                rows, rounds = (
                    sweep.runs[0].store.rows,
                    len(sweep.runs[0].rounds),
                )
                with self.assertRaisesRegex(ValueError, "open in Grid"):
                    materialize_in_place(run)
            finally:
                wiring.close()
            desc = descriptor(run)
            assert desc is not None
            materialize_in_place(run)
            self.assertIsNone(descriptor(run))
            history = run / ".grid-history" / desc["id"]
            self.assertTrue(verify(history)["exact"])
            restored = science(run, root / "native.json")
            self.assertEqual(restored["rows"], rows)
            self.assertEqual(len(restored["rounds"]), rounds)

    def test_reducer_matches_native_and_invalidates_each_dependency(
        self,
    ) -> None:
        records = json.loads(
            gzip.decompress(
                (FIXTURES / "limen_cohort_rounds.json.gz").read_bytes()
            )
        )
        reducer = Reducer()
        for record in records:
            self.assertEqual(
                encoded(reducer.reduce(record)), encoded(round_object(record))
            )
            self.assertEqual(
                encoded(reducer.reduce(record)), encoded(round_object(record))
            )
            changed = json.loads(json.dumps(record))
            changed["optimal_threshold"] = record["optimal_threshold"] / 2
            self.assertEqual(
                encoded(reducer.reduce(changed)),
                encoded(round_object(changed)),
            )
            changed["execution"]["net"][0] = (
                changed["execution"]["net"][0] - 0.01
            )
            self.assertEqual(
                encoded(reducer.reduce(changed)),
                encoded(round_object(changed)),
            )
            self.assertNotEqual(record_digest(record), record_digest(changed))

    def test_reductions_release_sweep_lock_and_reset_discards_stale_work(
        self,
    ) -> None:
        record = (FIXTURES / "limen_rule" / PLAIN).read_text().splitlines()[0]
        for resetting, expected in ((0, 0), (1, 1)):
            sweep = Sweep("retention")
            run = Run(
                "r", "recorded", "source", None, False, shards=["a", "b"]
            )
            sweep.add_run(run)
            entered, release = threading.Event(), threading.Event()

            def slow(text: str) -> str:
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("test reduction did not resume")
                return text

            worker = threading.Thread(
                target=sweep.round_line, args=(run, record, False, 0, slow)
            )
            worker.start()
            self.assertTrue(entered.wait(2))
            self.assertTrue(sweep.lock.acquire(timeout=0.2))
            sweep.lock.release()
            sweep.round_reset(run, "replaced", resetting)
            release.set()
            worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(len(run.rounds), expected)

    def test_missing_corrupt_objects_and_metadata_fail_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            compact(run, root / "shared.sqlite3", sealed=True, prune=True)
            store = Evidence(root / "shared.sqlite3", writable=True)
            store.db.execute("UPDATE objects SET data=?", (b"corrupt",))
            store.close()
            with self.assertRaisesRegex(ValueError, "Corrupt"):
                verify(run)
            self.assertTrue((run / RETAINED).is_file())
            self.assertTrue((run / CSV).is_file())


if __name__ == "__main__":
    unittest.main()
