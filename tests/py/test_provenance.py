"""Content snapshots prevent linked reruns from following mutable data paths."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from grid.provenance import digest, snapshot_source, verify_identity

TEXT = """sfd:
  manifest:
    data_source:
      method: limen.data.HistoricalData.get_any_file
      params:
        file_path_or_url: source.csv
"""


class SourceIdentity(unittest.TestCase):
    def test_snapshot_survives_original_change_and_is_shared_by_content(self):
        with tempfile.TemporaryDirectory() as root:
            original = Path(root, "source.csv")
            original.write_text("price\n1\n2\n")
            first = snapshot_source(TEXT, root)
            second = snapshot_source(TEXT, root)
            self.assertEqual(first, second)
            retained = Path(first["executionPath"])
            original.write_text("price\n900\n")
            self.assertEqual(retained.read_text(), "price\n1\n2\n")
            self.assertEqual(digest(retained), first["files"][0]["sha256"])
            self.assertEqual(len(list(retained.parent.glob("*.csv"))), 1)
            self.assertFalse(retained.stat().st_mode & 0o222)

    def test_mutated_snapshot_and_changed_runtime_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "source.csv").write_text("price\n1\n")
            data = snapshot_source(TEXT, root)
            source = {"data": data}
            runtime = {"verified": True, "fingerprint": "original"}
            with patch("grid.provenance.runtime_identity", return_value=runtime):
                verify_identity(source, runtime, "limen", "python", "5.30.2")
            with patch("grid.provenance.runtime_identity", return_value={
                    "verified": True, "fingerprint": "different"}):
                with self.assertRaisesRegex(ValueError, "runtime identity"):
                    verify_identity(source, runtime, "limen", "python",
                                    "5.30.2")
            retained = Path(data["executionPath"])
            retained.chmod(0o644)
            retained.write_text("corrupt")
            with self.assertRaisesRegex(ValueError, "source content"):
                verify_identity(source, runtime, "limen", "python", "5.30.2")

    def test_remote_and_unrecorded_source_identity_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as root:
            remote = snapshot_source(TEXT.replace(
                "source.csv", "https://example.invalid/prices.csv"), root)
            self.assertFalse(remote["available"])
            with self.assertRaisesRegex(ValueError, "no retained"):
                verify_identity({"data": remote}, None, "limen", None,
                                "5.30.2")

    def test_custom_provider_file_parameter_does_not_prove_source_identity(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "source.csv").write_text("price\n1\n")
            custom = snapshot_source(TEXT.replace(
                "limen.data.HistoricalData.get_any_file", "custom.fetch"), root)
            self.assertFalse(custom["available"])
