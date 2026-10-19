"""Inspect intent replay, immutable source binding and typed scope safety."""

from __future__ import annotations

import gzip
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from grid.inspect_run import launch, narrow

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
            manifest=Mock(return_value={"version": "exact"}),
            start=Mock(return_value="results/dev/inspect/1"))
        self.run = SimpleNamespace(id="source", generation=4)
        self.pack = json.dumps({"runs": [{
            "id": "source", "generation": 4,
            "experiment": {"kind": "limen", "manifestText": TEXT,
                           "manifest": MANIFEST, "limenVersion": "5.30.2"},
        }]})
        self.sweep = SimpleNamespace(
            lock=threading.Lock(), runs=[self.run],
            pack_text=Mock(return_value=(self.pack, None)))
        self.server = SimpleNamespace(project=self.project, sweep=self.sweep,
                                      agent=None)
        self.body = {"name": "inspect", "requestId": "intent-1",
                     "source": {"run": "source", "generation": 4},
                     "constraints": [{"param": "threshold", "values": [0.5]}],
                     "rounds": 2}

    def test_retry_after_restart_returns_one_launch_and_frozen_source(self):
        result = launch(self.server, self.body)
        self.run.generation = 5
        self.sweep.pack_text.return_value = ('{"runs": []}', None)
        self.assertEqual(launch(self.server, self.body), result)
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
        launch(self.server, self.body)
        changed = {**self.body, "constraints": [
            {"param": "threshold", "values": [0.25]}]}
        with self.assertRaisesRegex(ValueError, "another Inspect intent"):
            launch(self.server, changed)
        self.project.start.assert_called_once()

    def test_stale_generation_has_no_launch_side_effect(self):
        self.run.generation = 5
        with self.assertRaisesRegex(ValueError, "stale source"):
            launch(self.server, self.body)
        self.project.create.assert_not_called()
        self.project.start.assert_not_called()

    def test_full_space_and_untyped_substitution_are_refused(self):
        for constraints in ([], [{"param": "enabled", "values": [1]}],
                            [{"param": "threshold", "values": ["0.5"]}],
                            [{"param": "missing", "values": [1]}]):
            with self.subTest(constraints=constraints):
                with self.assertRaises(ValueError):
                    narrow(TEXT, MANIFEST, constraints)

    def test_failed_intent_is_not_reexecuted_on_retry(self):
        self.project.start.side_effect = ValueError("data unavailable")
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "data unavailable"):
                launch(self.server, self.body)
        self.project.start.assert_called_once()
