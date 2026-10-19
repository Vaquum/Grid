"""Recording policies retain historical semantics and explicit mode identity."""

from __future__ import annotations

import unittest

from grid.__main__ import freeze_shard_identities
from grid.recording import (
    GROUPS,
    infer_recording,
    manifest_values,
    mark_manifest,
    policy,
)
from grid.sweep import Json


class Recording(unittest.TestCase):
    def test_named_policies_explicitly_control_every_native_switch(self):
        for mode, enabled in (("sweep", False), ("inspect", True)):
            chosen = policy(mode)
            self.assertEqual(chosen["record_execution"], enabled)
            self.assertEqual(chosen["record_model_outputs"], enabled)
            self.assertEqual(chosen["recording"],
                             dict.fromkeys(GROUPS, enabled))
            self.assertEqual(len(manifest_values(mode)), 6)
        with self.assertRaises(ValueError):
            policy("light")

    def test_historical_native_defaults_never_become_a_new_named_mode(self):
        summary = infer_recording({"uel": {"record_execution": True}})
        self.assertEqual(summary["recordingMode"], "legacy")
        chosen = summary["recordingPolicy"]
        self.assertTrue(chosen["record_execution"])
        self.assertFalse(chosen["record_model_outputs"])
        self.assertTrue(all(chosen["recording"].values()))

    def test_partial_policy_and_runtime_metadata_remain_truthful(self):
        manifest = {"uel": {"record_execution": True,
                            "recording": {"predictions": False}}}
        summary = infer_recording(manifest, {
            "record_execution": False, "recording": {"predictions": False}})
        self.assertFalse(summary["recordingPolicy"]["record_execution"])
        self.assertFalse(summary["recordingPolicy"]["recording"][
            "predictions"])
        self.assertTrue(summary["recordingPolicy"]["recording"]["alignment"])
        self.assertEqual(summary["recordingMode"], "legacy")

    def test_native_omitted_metadata_switches_mean_native_defaults(self):
        manifest = {"uel": policy("sweep")}
        manifest["uel"]["record_execution"] = True
        summary = infer_recording(manifest, {"yaml_reference": manifest})
        self.assertFalse(summary["recordingPolicy"]["record_execution"])
        self.assertTrue(all(summary["recordingPolicy"]["recording"].values()))

    def test_explicit_mode_requires_matching_switches(self):
        manifest = {"uel": policy("sweep")}
        text = mark_manifest("uel:\n", "sweep")
        self.assertEqual(infer_recording(manifest, manifest_text=text)[
            "recordingMode"], "sweep")
        manifest["uel"]["record_execution"] = True
        summary = infer_recording(manifest, manifest_text=text)
        self.assertEqual(summary["recordingMode"], "legacy")
        self.assertIn("disagree", summary["recordingReason"])

    def test_saved_mode_and_policy_work_without_native_metadata(self):
        saved = {"recordingMode": "inspect",
                 "recordingPolicy": policy("inspect")}
        self.assertEqual(infer_recording({}, record=saved)["recordingMode"],
                         "inspect")
        legacy = {"record": {"execution": False, "outputs": True}}
        self.assertEqual(infer_recording({}, record=legacy)["recordingMode"],
                         "legacy")

    def test_marker_replacement_preserves_manifest_text_and_native_schema(self):
        original = "schema_version: '1.0'\nuel:\n  n_permutations: 4\n"
        marked = mark_manifest(mark_manifest(original, "sweep"), "inspect")
        self.assertEqual(marked, "# grid-recording-mode: inspect\n" + original)

    def test_frozen_native_seeds_and_hashes_do_not_follow_source_mutation(self):
        experiments: list[Json] = [
            {"manifest": {"uel": {"search_strategy": {"seed": seed}}},
             "manifestText": "seed: %d\n" % seed, "limenVersion": version}
            for seed, version in ((91, "5.30.2"), (4, "5.30.1"))]
        freeze_shard_identities(experiments, ["s1", "s2"])
        first_hash = experiments[0]["shardIdentities"][0]["manifestSha256"]
        experiments[0]["manifest"]["uel"]["search_strategy"]["seed"] = 999
        experiments[0]["manifestText"] = "changed"
        self.assertEqual(experiments[0]["shardSeeds"], [91, 4])
        self.assertEqual(experiments[0]["shardIdentities"][0]["manifestSha256"],
                         first_hash)
        self.assertEqual(experiments[0]["shardIdentities"][1]["limenVersion"],
                         "5.30.1")


if __name__ == "__main__":
    unittest.main()
