"""A stand-in for Limen's Trainer and Cohort, for the cohort worker's tests
(grid/limen_cohort.py): what the worker calls of them, behaving as Limen
5.20's do (limen/inference/trainer.py, limen/cohort/cohort.py), without
training anything. ``FAKE_TRAIN_FAIL`` (the start of a round id) makes that
member's training fail as a reconstruction that drifted does."""

import hashlib
import json
import os

__version__ = "5.20.0"


class Sensor:
    def __init__(self, permutation_id, manifest_id, round_params):
        self.permutation_id = permutation_id
        self.manifest_id = manifest_id
        self.round_params = round_params
        self.prediction_mode = "binary"
        self._manifest = None


class Trainer:
    def __init__(self, experiment_dir):
        with open(os.path.join(experiment_dir, "metadata.json")) as f:
            self.manifest_id = json.load(f).get("manifest_id")
        self.rounds = {}
        with open(os.path.join(experiment_dir, "round_data.jsonl")) as f:
            for line in f:
                if line.strip():
                    rec = json.loads(line)
                    self.rounds[rec["round_id"]] = rec["round_params"]

    def train(self, permutation_ids):
        out = []
        fail = os.environ.get("FAKE_TRAIN_FAIL")
        for pid in permutation_ids:
            if pid not in self.rounds:
                raise ValueError("Unknown permutation_ids requested: %s" % pid)
            if fail and pid.startswith(fail):
                raise RuntimeError("ReconstructionError: %s's metrics drifted "
                                   "from results.csv" % pid[:12])
            out.append(Sensor(pid, self.manifest_id, self.rounds[pid]))
        return out


class Cohort:
    def __init__(self, *, experiment_log_path, permutation_ids):
        with open(os.path.join(experiment_log_path, "metadata.json")) as f:
            meta = json.load(f)
        self.manifest_id = meta.get("manifest_id")
        self.permutation_ids = list(permutation_ids)
        self.architecture_id = "lightgbm_binary"
        self.aggregation_mode = "probability_weighted"
        self.cohort_id = None

    def set_members(self, members):
        if sorted(m.permutation_id for m in members) != sorted(
                self.permutation_ids):
            raise ValueError("Cohort Missing bound members")
        payload = json.dumps({"aggregation_mode": self.aggregation_mode,
                              "architecture_id": self.architecture_id,
                              "manifest_id": self.manifest_id,
                              "permutation_ids": sorted(self.permutation_ids)},
                             sort_keys=True)
        self.cohort_id = "sha256:" + hashlib.sha256(payload.encode()).hexdigest()
