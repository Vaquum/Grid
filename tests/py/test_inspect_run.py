"""Inspect intent replay, immutable source binding and typed scope safety."""

from __future__ import annotations

import gzip
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import Mock, patch

from grid.inspect_run import launch, narrow
from grid.server import Server
from grid.sweep import Json

TEXT = """metadata:
  name: source
sfd:
  params:
    threshold: [0.25, 0.5]
    enabled: [true, false]
uel:
  search_strategy:
    type: random
    seed: 42
"""
MANIFEST = {"sfd": {"params": {"threshold": [0.25, 0.5],
                               "enabled": [True, False]}}}


class InspectLaunch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = SimpleNamespace(
            root=self.temp.name, version="5.30.2", create=Mock(),
            cli="/native/limen", python="/native/python",
            manifest=Mock(return_value={"version": "exact"}),
            start=Mock(return_value="results/dev/inspect/1"))
        identity_patch = patch("grid.inspect_run.verify_identity")
        self.identity_check = identity_patch.start()
        self.addCleanup(identity_patch.stop)
        self.source_run = SimpleNamespace(id="source", generation=4)
        self.pack = json.dumps({"runs": [{
            "id": "source", "generation": 4,
            "experiment": {"kind": "limen", "manifestText": TEXT,
                           "manifest": MANIFEST, "limenVersion": "5.30.2"},
        }]})
        self.sweep = SimpleNamespace(
            lock=threading.Lock(), runs=[self.source_run],
            pack_text=Mock(return_value=(self.pack, None)))
        self.server = SimpleNamespace(project=self.project, sweep=self.sweep,
                                      agent=None)
        self.body: Json = {"name": "inspect", "requestId": "intent-1",
                     "source": {"run": "source", "generation": 4},
                     "constraints": [{"param": "threshold", "values": [0.5]}],
                     "rounds": 2}

    def test_retry_after_restart_returns_one_launch_and_frozen_source(self):
        result = launch(cast(Server, self.server), self.body)
        self.source_run.generation = 5
        self.sweep.pack_text.return_value = ('{"runs": []}', None)
        self.assertEqual(launch(cast(Server, self.server), self.body), result)
        self.project.start.assert_called_once()
        self.project.create.assert_called_once()
        path = Path(self.temp.name, result["provenance"]["sourceSnapshot"],
                    "source.json.gz")
        self.assertEqual(gzip.decompress(path.read_bytes()).decode(), self.pack)
        kwargs = self.project.start.call_args.kwargs
        self.assertEqual(kwargs["recording_mode"], "inspect")
        self.assertEqual(kwargs["provenance"]["sourceSeeds"], [42])
        self.assertIn("threshold: [0.5]", self.project.create.call_args.kwargs[
            "text"])

    def test_reused_identity_cannot_change_the_region(self):
        launch(cast(Server, self.server), self.body)
        changed = {**self.body, "constraints": [
            {"param": "threshold", "values": [0.25]}]}
        with self.assertRaisesRegex(ValueError, "another Inspect intent"):
            launch(cast(Server, self.server), changed)
        self.project.start.assert_called_once()

    def test_stale_generation_has_no_launch_side_effect(self):
        self.source_run.generation = 5
        with self.assertRaisesRegex(ValueError, "stale source"):
            launch(cast(Server, self.server), self.body)
        self.project.create.assert_not_called()
        self.project.start.assert_not_called()

    def test_full_space_and_untyped_substitution_are_refused(self):
        for constraints in ([], [{"param": "enabled", "values": [1]}],
                            [{"param": "enabled", "values": [True, False]}],
                            [{"param": "threshold", "values": ["0.5"]}],
                            [{"param": "missing", "values": [1]}]):
            with self.subTest(constraints=constraints):
                with self.assertRaises(ValueError):
                    narrow(TEXT, MANIFEST, constraints)

    def test_failed_intent_is_not_reexecuted_on_retry(self):
        self.project.start.side_effect = ValueError("data unavailable")
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "data unavailable"):
                launch(cast(Server, self.server), self.body)
        self.project.start.assert_called_once()

    def test_single_combination_retains_all_frozen_shard_seeds(self):
        data = json.loads(self.pack)
        experiment = data["runs"][0]["experiment"]
        experiment["shards"] = [["s1", "/moved/s1"], ["s2", "/moved/s2"]]
        experiment["shardSeeds"] = [42, 9]
        experiment["shardIdentities"] = [
            {"label": label, "seed": seed, "limenVersion": "5.30.2",
             "manifestSha256": str(seed)}
            for label, seed in (("s1", 42), ("s2", 9))]
        self.sweep.pack_text.return_value = (json.dumps(data), None)
        self.body["constraints"].append({"param": "enabled", "values": [True]})
        result = launch(cast(Server, self.server), self.body)
        self.assertEqual(result["provenance"]["projectedPermutations"], 1)
        self.assertEqual(result["provenance"]["sourceSeeds"], [42, 9])
        self.assertEqual(self.project.start.call_args.args[1:3], (2, 2))

    def test_pinned_source_uses_its_generation_after_live_source_changes(self):
        self.source_run.generation = 100
        self.server.agent = SimpleNamespace(
            snapshot_pack=Mock(return_value=self.pack))
        self.body["source"]["snapshot"] = "pinned-source"
        launch(cast(Server, self.server), self.body)
        self.server.agent.snapshot_pack.assert_called_once_with("pinned-source")
        self.sweep.pack_text.assert_not_called()
        self.project.start.assert_called_once()

    def test_mixed_source_runtime_versions_are_refused(self):
        data = json.loads(self.pack)
        experiment = data["runs"][0]["experiment"]
        experiment["shards"] = [["s1", "/moved/s1"], ["s2", "/moved/s2"]]
        experiment["shardSeeds"] = [42, 9]
        experiment["shardIdentities"] = [
            {"label": "s1", "seed": 42, "limenVersion": "5.30.2"},
            {"label": "s2", "seed": 9, "limenVersion": "5.30.1"}]
        self.sweep.pack_text.return_value = (json.dumps(data), None)
        with self.assertRaisesRegex(ValueError, "runtime"):
            launch(cast(Server, self.server), self.body)
        self.project.create.assert_not_called()
        self.project.start.assert_not_called()

    def test_browser_integer_value_retains_unique_source_float_type(self):
        manifest: Json = {"sfd": {"params": {"size": [1.0, 2.0]}}}
        text = "sfd:\n  params:\n    size: [1.0, 2.0]\n"
        narrowed, count = narrow(text, manifest,
                                 [{"param": "size", "values": [1]}])
        self.assertEqual(count, 1)
        self.assertIn("size: [1.0]", narrowed)
        manifest["sfd"]["params"]["size"] = [1, 1.0, 2]
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            narrow(text, manifest, [{"param": "size", "values": [1]}])

    def test_unverifiable_source_stops_before_experiment_creation(self):
        self.identity_check.side_effect = ValueError("source content unavailable")
        with self.assertRaisesRegex(ValueError, "source content unavailable"):
            launch(cast(Server, self.server), self.body)
        self.project.create.assert_not_called()
        self.project.start.assert_not_called()
