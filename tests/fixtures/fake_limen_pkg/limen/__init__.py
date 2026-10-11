"""A stand-in for Limen's Trainer and Cohort, for the cohort worker's tests
(grid/limen_cohort.py): what the worker calls of them, behaving as Limen
5.24's do (limen/inference/trainer.py, limen/cohort/cohort.py and
limen/cohort/_round_sources.py), without training anything.
``FAKE_TRAIN_FAIL`` (the start of a round id) makes that member's training
fail as a reconstruction that drifted does; ``FAKE_LIMEN_OLD`` makes it
Limen 5.20, whose Cohort takes one result directory; ``FAKE_FETCH_LOG``
names a file each Trainer that fetches its own data adds a line to."""

import hashlib
import json
import os

OLD = bool(os.environ.get("FAKE_LIMEN_OLD"))
__version__ = "5.20.0" if OLD else "5.24.0"


class Sensor:
    def __init__(self, permutation_id, manifest_id, round_params):
        self.permutation_id = permutation_id
        self.manifest_id = manifest_id
        self.round_params = round_params
        self.prediction_mode = "binary"
        self._manifest = None


def _metadata(directory):
    with open(os.path.join(directory, "metadata.json")) as f:
        return json.load(f)


class Trainer:
    def __init__(self, experiment_dir, data=None):
        meta = _metadata(experiment_dir)
        self.manifest_id = meta.get("manifest_id")
        if data is None:
            log = os.environ.get("FAKE_FETCH_LOG")
            if log:
                with open(log, "a") as f:
                    f.write(os.path.basename(os.path.normpath(experiment_dir))
                            + "\n")
            data = {"fetched_for": experiment_dir}
        self._data = data
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


def _id(payload):
    text = json.dumps(payload, sort_keys=True)
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


class Cohort520:
    def __init__(self, *, experiment_log_path, permutation_ids):
        self.manifest_id = _metadata(experiment_log_path).get("manifest_id")
        self.member_ids = [(self.manifest_id, p) for p in permutation_ids]
        self.architecture_id = "lightgbm_binary"
        self.aggregation_mode = "probability_weighted"
        self.cohort_id = None

    def set_members(self, members):
        if sorted(m.permutation_id for m in members) != sorted(
                p for _, p in self.member_ids):
            raise ValueError("Cohort Missing bound members")
        self.cohort_id = _id({"aggregation_mode": self.aggregation_mode,
                              "architecture_id": self.architecture_id,
                              "manifest_id": self.manifest_id,
                              "permutation_ids": sorted(
                                  p for _, p in self.member_ids)})


class Cohort524(Cohort520):
    def __init__(self, *, experiment_log_path=None, permutation_ids=None,
                 rounds=None):
        if rounds is None:
            super().__init__(experiment_log_path=experiment_log_path,
                             permutation_ids=permutation_ids)
            return
        if not rounds:
            raise ValueError("Cohort rounds must be a non-empty list.")
        self.member_ids = []
        for directory, pid in rounds:
            key = (_metadata(directory).get("manifest_id"), pid)
            if key in self.member_ids:
                raise ValueError("Cohort duplicate member %s" % (key,))
            self.member_ids.append(key)
        manifests = {m for m, _ in self.member_ids}
        self.manifest_id = next(iter(manifests)) if len(manifests) == 1 \
            else None
        self.architecture_id = "lightgbm_binary"
        self.aggregation_mode = "probability_weighted"
        self.cohort_id = None

    def set_members(self, members):
        if self.manifest_id is not None:
            super().set_members(members)
            return
        if sorted((m.manifest_id, m.permutation_id) for m in members) != \
                sorted(self.member_ids):
            raise ValueError("Cohort missing bound members")
        self.cohort_id = _id({"aggregation_mode": self.aggregation_mode,
                              "architecture_id": self.architecture_id,
                              "rounds": sorted(self.member_ids)})


Cohort = Cohort520 if OLD else Cohort524
