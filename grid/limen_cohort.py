"""Make a Limen cohort predictor, in Limen's own Python (the Cohort view's
Make predictor). Grid's server writes the cohort's folder and runs this
script with the Python Limen is installed in; nothing of Grid is imported
here, and Grid never imports this file.

    python limen_cohort.py COHORT_DIR

``cohort.json`` in COHORT_DIR names the members. Of one result directory
(``permutation_ids``), COHORT_DIR holds ``experiment/``, a Limen result
directory with the members' rounds (its ``metadata.json``, their lines of
``round_data.jsonl`` and rows of ``results.csv``), and Limen's Cohort binds
them as it always has. Of several (``rounds``, each a source's label and a
round id: shards of a run, each a manifest of its own), each source is such
a directory, ``experiments/<label>/``, and Limen's Cohort (5.24 or later)
binds the rounds of all of them. Each member is trained again by its own
source's ``Trainer`` on the data its round used, the data fetched once for
sources that fetch the same, and checked against what its round recorded;
the Cohort binds them, which gives the cohort its id. Each member's sensor
is pickled to ``sensors/<id>.pkl`` in its source's directory beside a
``<id>.json`` of the versions it was made with (the layout Furnace reads),
and ``cohort.json`` gets the cohort's id, its members as Limen keys them,
manifest id, aggregation and architecture. Progress is printed one JSON
object a line.
"""

from __future__ import annotations

import importlib
import inspect
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


def data_source(directory: str) -> str | None:
    """What a source's Trainer fetches, as its manifest declares it: its
    data source in full (date limits too), or None when it does not say."""
    try:
        with open(os.path.join(directory, "metadata.json"),
                  encoding="utf-8") as f:
            meta: Any = json.load(f)
        source = meta["yaml_reference"]["sfd"]["manifest"]["data_source"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return json.dumps(source, sort_keys=True)


def keep(directory: str, sensor: Any, limen_version: str | None,
         sklearn_version: str | None) -> None:
    """A member's sensor in its source's sensors/, beside its versions."""
    store = os.path.join(directory, "sensors")
    os.makedirs(store, exist_ok=True)
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


def main(folder: str) -> int:
    path = os.path.join(folder, "cohort.json")
    with open(path, encoding="utf-8") as f:
        spec: Any = json.load(f)
    rounds: list[list[str]] | None = spec.get("rounds")
    limen = limen_package()
    limen_version = version("vaquum_limen", "vaquum-limen", "limen") or \
        getattr(limen, "__version__", None)
    sklearn_version = version("scikit-learn")
    if rounds and "rounds" not in inspect.signature(
            limen.Cohort).parameters:
        say(stage="failed", limen=limen_version)
        print("A predictor of rounds from several result directories needs "
              "Limen 5.24 or later, whose Cohort binds the rounds of several "
              "manifests; this Python has Limen %s." % limen_version,
              file=sys.stderr, flush=True)
        return 1
    say(stage="data", limen=limen_version)
    if not rounds:
        ids: list[str] = list(spec["permutation_ids"])
        experiment = os.path.join(folder, "experiment")
        trainer: Any = limen.Trainer(experiment)
        sensors: list[Any] = []
        for k, pid in enumerate(ids):
            say(stage="train", member=k + 1, of=len(ids), id=pid)
            sensors.extend(trainer.train([pid]))
        say(stage="bind", members=len(sensors))
        cohort: Any = limen.Cohort(experiment_log_path=experiment,
                                   permutation_ids=ids)
        cohort.set_members(sensors)
        for sensor in sensors:
            keep(experiment, sensor, limen_version, sklearn_version)
        spec["permutation_ids"] = sorted(ids)
    else:
        sources: dict[str, list[str]] = {}
        for label, pid in rounds:
            sources.setdefault(label, []).append(pid)
        fetched: dict[str, Any] = {}
        sensors = []
        made: list[tuple[str, Any]] = []
        k = 0
        for label, pids in sources.items():
            directory = os.path.join(folder, "experiments", label)
            key = data_source(directory)
            # a source that fetches what one before it fetched is handed
            # that data, so it is fetched once
            trainer = limen.Trainer(
                directory, data=fetched.get(key) if key else None)
            if key and key not in fetched:
                fetched[key] = getattr(trainer, "_data", None)
            for pid in pids:
                k += 1
                say(stage="train", member=k, of=len(rounds), id=pid,
                    source=label)
                for sensor in trainer.train([pid]):
                    sensors.append(sensor)
                    made.append((directory, sensor))
        say(stage="bind", members=len(sensors), sources=len(sources))
        cohort = limen.Cohort(rounds=[
            (os.path.join(folder, "experiments", label), pid)
            for label, pid in rounds])
        cohort.set_members(sensors)
        for directory, sensor in made:
            keep(directory, sensor, limen_version, sklearn_version)
        spec["member_ids"] = [list(m) for m in cohort.member_ids]
    spec.update(state="made", cohort_id=cohort.cohort_id,
                manifest_id=cohort.manifest_id,
                aggregation_mode=cohort.aggregation_mode,
                architecture_id=cohort.architecture_id,
                limen_version=limen_version, made_at=round(time.time(), 3))
    write(path, spec)
    say(stage="done", cohort_id=cohort.cohort_id)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
