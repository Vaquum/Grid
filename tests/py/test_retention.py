"""Exact retention against recorded inputs and interrupted publication."""

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
from grid.evidence import (
    Evidence, Reducer, encoded, record_digest, wire_vector,
)
from grid.experiment import Project, _slim
from grid.limen import round_object
from grid.replay import ReplayClient
from grid.retention import (
    CSV,
    Reader,
    compact,
    descriptor,
    materialize,
    materialize_in_place,
    verify,
)
from grid.round_storage import (
    COMPACT,
    DESCRIPTOR,
    PLAIN,
    RETAINED,
    frames,
    read_local,
    restore,
)
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
    def test_replay_proofs_survive_cache_loss_and_reject_bad_transport(
        self,
    ) -> None:
        record = {
            "preds": [0, 1], "probs": [0.2, 0.8],
            "round_params": {"deterministic": True, "n_jobs": 1,
                             "random_state": 42},
            "alignment": {}, "execution": {"pos": [0, 1],
                                              "gross": [0.0, 0.1],
                                              "net": [-0.0, 0.09]},
            "market": {"ret": [0.0, 0.1]},
        }
        for bad_transport in (False, True):
            with self.subTest(bad_transport=bad_transport), \
                    tempfile.TemporaryDirectory() as tmp:
                store = Evidence(Path(tmp) / "store.sqlite3", writable=True)
                client = ReplayClient.__new__(ReplayClient)
                client.evidence, client.runtime = store, "a" * 64

                def call(request):
                    if request["op"] == "verify":
                        return {
                            "model": {"expected": request["expected"]["model"]},
                            "execution": {
                                "expected": request["expected"]["execution"]},
                        }
                    vectors = {"probs": wire_vector(
                        [0.3, 0.8] if bad_transport else record["probs"])}
                    for name in ("execution", "market"):
                        vectors.update({name + "." + key: wire_vector(values)
                                        for key, values in record[name].items()})
                    return {"vectors": vectors}

                with patch.object(client, "definition", return_value=(
                    "definition", {"execution": True, "model": True,
                                   "family": "family", "axes": []})), \
                        patch.object(client, "call", side_effect=call) as rpc:
                    if bad_transport:
                        with self.assertRaisesRegex(ValueError, "transport"):
                            client.verify({}, record, {})
                        self.assertEqual(store.db.execute(
                            "SELECT count(*) FROM artifact_recipes"
                        ).fetchone()[0], 0)
                        store.close()
                        continue
                    recipe = client.verify({}, record, {})
                    self.assertIsNotNone(recipe)
                    self.assertEqual(rpc.call_count, 2)
                    # No native cache or worker is consulted on a repeated
                    # occurrence once source values bind to a durable proof.
                    rpc.side_effect = AssertionError("unexpected native work")
                    self.assertEqual(client.verify({}, record, {}), recipe)
                    fields = client.proven_fields(recipe, record)
                    self.assertEqual(record_digest(fields), record_digest(
                        {key: record[key] for key in fields}))
                    with self.assertRaisesRegex(ValueError, "probabilities"):
                        client.proven_fields(recipe, {**record,
                                                    "probs": [0.1, 0.8]})
                    for name in ("model", "execution"):
                        saved = client._get_recipe(recipe[name])
                        saved["_grid_proof"] = ["b" * 64, 1]
                        key = client._recipe(saved)
                        store.db.execute(
                            "UPDATE artifact_recipes SET recipe=? WHERE kind=?",
                            (key, name))
                        if name == "model":
                            store.db.execute("UPDATE model_jobs SET recipe=?",
                                             (key,))
                    rpc.side_effect = call
                    self.assertIsNotNone(client.verify({}, record, {}))
                    self.assertEqual(rpc.call_count, 4)
                store.close()

    def test_nested_materialization_refused_before_creating_destination(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            compact(run, root / "store.sqlite3", sealed=True, prune=True)
            alias = root / "alias"
            alias.symlink_to(run, target_is_directory=True)
            for path in (run / "exports/native", alias / "exports/native"):
                with self.assertRaisesRegex(ValueError, "outside the run"):
                    materialize(run, path)
            self.assertFalse((run / "exports").exists())
            self.assertTrue(verify(run)["exact"])

    def test_new_shared_store_directory_is_durable(self) -> None:
        from grid import evidence

        with tempfile.TemporaryDirectory() as tmp:
            anchor = Path(tmp).resolve()
            directory = anchor / "new/nested/store"
            with patch.object(evidence, "sync_parents",
                              wraps=evidence.sync_parents) as syncing:
                store = Evidence(directory / "evidence.sqlite3", writable=True)
                store.close()
                syncing.assert_called_once_with(directory, anchor)

    def test_runtime_code_is_durable_before_pin_publication(self) -> None:
        from tools import pin_replay_runtime as runtime

        with tempfile.TemporaryDirectory() as tmp:
            anchor = Path(tmp)
            root = anchor / "store/runtimes/identity"
            code = root / "code/grid"
            code.mkdir(parents=True)
            (code / "native.py").write_text("PROTOCOL = 1\n")
            events = []
            syncing_tree, syncing = runtime.sync_tree, runtime.sync_dir
            atomic = runtime.atomic_json

            def tree(path: Path) -> None:
                syncing_tree(path)
                events.append(("code", path))

            def directory(path: Path) -> None:
                syncing(path)
                events.append(("directory", path))

            def publish(path: Path, value: object) -> None:
                self.assertIn(("code", root / "code"), events)
                self.assertEqual(events[-1], ("directory", anchor))
                atomic(path, value)

            with patch.object(runtime, "sync_tree", tree), \
                    patch.object(runtime, "sync_dir", directory), \
                    patch.object(runtime, "atomic_json", publish):
                runtime.publish_pin(root, anchor, {"runtime": "identity"})
            self.assertTrue((root / "pin.json").is_file())

    def test_published_staging_history_survives_recompaction(self) -> None:
        from grid import retention

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            atomic = retention.atomic_json

            def publish_then_interrupt(path: Path, value: object) -> None:
                atomic(path, value)
                if path.name == DESCRIPTOR:
                    raise OSError("after publication, before state commit")

            with patch("grid.retention.atomic_json", publish_then_interrupt), \
                    self.assertRaisesRegex(OSError, "after publication"):
                compact(run, root / "store.sqlite3", sealed=True)
            desc = descriptor(run)
            assert desc is not None
            reader = Reader(run)
            try:
                first = next(reader.entries())
                expected = reader.restore(first)
            finally:
                reader.close()
            materialize_in_place(run)
            compact(run, root / "store.sqlite3", sealed=True, prune=True)
            history = run / ".grid-history" / desc["id"]
            reader = Reader(history)
            try:
                self.assertEqual(record_digest(reader.get(first["round_id"])),
                                 record_digest(expected))
            finally:
                reader.close()
            self.assertTrue(verify(history)["exact"])

    def test_complete_member_truncation_refuses_native_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            compact(run, root / "store.sqlite3", sealed=True, prune=True)
            archive = run / RETAINED
            with archive.open("rb") as stream:
                _, _, boundary = next(frames(stream, compact=True, tail=False))
            archive.write_bytes(archive.read_bytes()[:boundary])
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                materialize(run, root / "export")
            self.assertFalse((root / "export").exists())
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                materialize_in_place(run)
            self.assertTrue((run / DESCRIPTOR).exists())

    def test_restored_market_directory_is_durable_before_publication(
        self,
    ) -> None:
        from grid import retention

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            run = root / "run"
            shutil.copytree(FIXTURES / "limen_rule", run)
            compress(run)
            compact(run, root / "store.sqlite3", sealed=True, prune=True)
            events = []
            syncing, replacing = retention.sync_dir, os.replace

            def sync(path: Path) -> None:
                events.append(("sync", str(path)))
                syncing(path)

            def replace(source: str | Path, destination: str | Path) -> None:
                events.append(("replace", str(destination)))
                replacing(source, destination)

            with patch("grid.retention.sync_dir", sync), \
                    patch("grid.retention.os.replace", replace):
                materialize_in_place(run)
            synced = events.index(("sync", str(run / "round_market")))
            published = events.index(("replace", str(
                run / (DESCRIPTOR + ".history"))))
            self.assertLess(synced, published)
            self.assertTrue((run / "round_market").is_dir())

    def test_current_native_vectors_crlf_and_reconstruction(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            shutil.copytree(FIXTURES / "retention/ml", run)
            meta = run / "metadata.json"
            meta.write_bytes(meta.read_bytes().replace(b"\n", b"\r\n"))
            records = []
            with (run / COMPACT).open("rb") as stream:
                for raw, _, _ in frames(stream, compact=True, tail=False):
                    records.append(
                        restore(
                            json.loads(raw),
                            lambda name: read_local(str(run), name),
                        )
                    )
            expected = science(run, root / "before.json")
            compact(run, root / "evidence.sqlite3", sealed=True, prune=True)
            reader = Reader(run)
            try:
                for entry, original in zip(
                    reader.entries(), records, strict=True
                ):
                    self.assertNotIn("raw", entry["grid"])
                    self.assertEqual(
                        set(entry["grid"]["vectors"]),
                        {
                            "preds",
                            "probs",
                            "market.ret",
                            "execution.pos",
                            "execution.gross",
                            "execution.net",
                        },
                    )
                    self.assertEqual(
                        record_digest(reader.restore(entry)),
                        record_digest(original),
                    )
            finally:
                reader.close()
            self.assertEqual(expected, science(run, root / "after.json"))
            materialize(run, root / "export/native")
            with gzip.open(root / "export/native" / COMPACT, "rt") as stream:
                exported = json.loads(next(stream))
            self.assertIn("market_ref", exported)
            self.assertNotIn("market", exported)
            self.assertEqual(
                expected, science(root / "export/native", root / "native.json")
            )

    def test_refused_resume_keeps_retained_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shard = root / "s1"
            shutil.copytree(FIXTURES / "limen_run", shard)
            compact(shard, root / "evidence.sqlite3", sealed=True, prune=True)
            (shard / "checkpoint.json").write_text("{}")
            (root / "grid-run.json").write_text(
                json.dumps({"shards": [{"label": "s1", "state": "stopped"}]})
            )
            (root / "experiment.yaml").write_text("uel:\n  workers: 2\n")
            project = Project.__new__(Project)
            project.root, project.cores = str(root), 1
            project.lock = threading.Lock()
            with (
                patch.object(project, "_folder", return_value=str(root)),
                patch("grid.experiment.materialize_in_place") as recover,
            ):
                with self.assertRaisesRegex(ValueError, "CPU budget"):
                    project.resume("run")
                recover.assert_not_called()
            self.assertTrue((shard / DESCRIPTOR).is_file())
            self.assertFalse((shard / PLAIN).exists())

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
                materialize(run, root / "export/native")
                self.assertEqual(
                    (root / "export/native/results.csv").read_bytes(),
                    original_csv,
                )
                self.assertEqual(
                    (root / "export/native" / PLAIN).read_bytes(),
                    original_rounds,
                )
                self.assertEqual(
                    expected,
                    science(root / "export/native", root / "native.json"),
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
            materialize(run, root / "export/native")
            self.assertEqual(
                expected, science(root / "export/native", root / "native.json")
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

            def slow(
                text: str,
                entered: threading.Event = entered,
                release: threading.Event = release,
            ) -> str:
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
