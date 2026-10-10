"""Make a Limen cohort predictor, in Limen's own Python (the Cohort view's
Make predictor). Grid's server writes the cohort's folder and runs this
script with the Python Limen is installed in; nothing of Grid is imported
here, and Grid never imports this file.

    python limen_cohort.py COHORT_DIR

COHORT_DIR holds ``experiment/``, a Limen result directory with the
members' rounds (its ``metadata.json``, their lines of ``round_data.jsonl``
and rows of ``results.csv``), and ``cohort.json``, which names the members
(``permutation_ids``). Each member is trained again by Limen's ``Trainer``
on the data its round used, and checked by it against what the round
recorded; Limen's ``Cohort`` binds them, which gives the cohort its id.
Each member's sensor is pickled to ``experiment/sensors/<id>.pkl`` beside a
``<id>.json`` of the versions it was made with (the layout Furnace reads),
and ``cohort.json`` gets the cohort's id, manifest id, aggregation and
architecture. Progress is printed one JSON object a line.
"""

from __future__ import annotations

import importlib
import json
import os
import pickle
import sys
import time
from importlib import metadata
from typing import Any


def say(**fields: Any) -> None:
    print(json.dumps(fields), flush=True)


def version(*names: str) -> str | None:
    for name in names:
        try:
            return metadata.version(name)
        except metadata.PackageNotFoundError:
            continue
    return None


def write(path: str, obj: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def limen_package() -> Any:
    """Limen's own package. Run as a script, this file's folder (Grid's)
    comes first on the path, and Grid has a limen.py of its own: the path
    leaves it out before Limen is imported."""
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != here]
    sys.modules.pop("limen", None)
    return importlib.import_module("limen")


def main(folder: str) -> int:
    path = os.path.join(folder, "cohort.json")
    with open(path, encoding="utf-8") as f:
        spec: Any = json.load(f)
    ids: list[str] = list(spec["permutation_ids"])
    experiment = os.path.join(folder, "experiment")
    limen = limen_package()
    limen_version = version("vaquum_limen", "vaquum-limen", "limen") or \
        getattr(limen, "__version__", None)
    say(stage="data", limen=limen_version)
    trainer: Any = limen.Trainer(experiment)
    sensors: list[Any] = []
    for k, pid in enumerate(ids):
        say(stage="train", member=k + 1, of=len(ids), id=pid)
        sensors.extend(trainer.train([pid]))
    say(stage="bind", members=len(sensors))
    cohort: Any = limen.Cohort(experiment_log_path=experiment,
                               permutation_ids=ids)
    cohort.set_members(sensors)
    store = os.path.join(experiment, "sensors")
    os.makedirs(store, exist_ok=True)
    sklearn_version = version("scikit-learn")
    for sensor in sensors:
        pid = str(sensor.permutation_id)
        # a sensor pickles before its manifest is built (Furnace's way)
        sensor._manifest = None
        with open(os.path.join(store, pid + ".pkl"), "wb") as f:
            pickle.dump(sensor, f)
        write(os.path.join(store, pid + ".json"), {
            "limen_version": limen_version,
            "sklearn_version": sklearn_version,
            "manifest_id": getattr(sensor, "manifest_id", None),
            "permutation_id": pid})
    spec.update(state="made", cohort_id=cohort.cohort_id,
                manifest_id=cohort.manifest_id,
                aggregation_mode=cohort.aggregation_mode,
                architecture_id=cohort.architecture_id,
                limen_version=limen_version, made_at=round(time.time(), 3),
                permutation_ids=sorted(ids))
    write(path, spec)
    say(stage="done", cohort_id=cohort.cohort_id)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
