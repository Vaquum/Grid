"""A Limen result directory: the experiment's manifest and its rounds.

``limen run`` copies the manifest it runs into the directory (under its
own file name, or ``manifest.yaml`` for a committed manifest), writes
``metadata.json`` (the parsed manifest under ``yaml_reference``), then
appends one line to ``results.csv`` as each round finishes: the metrics,
then every parameter, then the round's own bookkeeping. The manifest says
which columns are parameters, so nothing is inferred about them; its copy
is kept as written, comments and all, for the page to show and narrow.
After a round that succeeded, it appends the round to ``round_data.jsonl``
(its parameters as the round used them, and its predictions); from it the
page learns which feature columns the round's ablation dropped.

CSV carries no types. Limen writes ``None`` as an empty field and Python
booleans as ``True``/``False``; numbers and JSON lists (``_warnings``) are
read back as such, and every other field stays text.

Several result directories of one manifest, run side by side with
different search seeds (``uel.search_strategy.seed``), read as one run:
their manifests must be the same but for the seed, and their draws must
differ (a grid search, or one seed twice, draws the same rounds again).
"""

from __future__ import annotations

import csv
import json
import os
import re
from collections.abc import Iterable
from typing import Any, cast

Json = dict[str, Any]
_INT = re.compile(r"[+-]?\d+\Z")
ROUND_LOG = "round_data.jsonl"


def manifest_copy(names: Iterable[str], directory: str) -> str:
    """The manifest copy among a result directory's file names: its only
    YAML file."""
    found = sorted(n for n in names if n.endswith((".yaml", ".yml")))
    if len(found) != 1:
        held = ("%d YAML files (%s)" % (len(found), ", ".join(found))
                if found else "no YAML file")
        raise ValueError("%s holds %s; a Limen result directory holds "
                         "exactly one, the copy of the manifest it ran"
                         % (directory, held))
    return found[0]


def read_experiment(text: str, path: str, manifest_file: str,
                    manifest_text: str) -> Json:
    """The experiment as the page needs it, from metadata.json's text and
    the manifest copy's."""
    raw: Any = json.loads(text)
    if not isinstance(raw, dict) or "yaml_reference" not in raw:
        raise ValueError("%s has no yaml_reference: not a Limen result "
                         "directory's metadata.json" % path)
    meta = cast(Json, raw)
    manifest: Any = meta["yaml_reference"]
    if not isinstance(manifest, dict):
        raise ValueError("%s: yaml_reference is not a mapping" % path)
    return {"kind": "limen", "manifest": cast(Json, manifest),
            "manifestFile": manifest_file, "manifestText": manifest_text,
            "limenVersion": meta.get("limen_version"),
            "createdAt": meta.get("created_at"),
            "manifestId": meta.get("manifest_id")}


def shard_labels(dirs: list[str]) -> list[str]:
    """Each directory's label among several: its name, or its whole path
    where two share a name."""
    names = [os.path.basename(d.rstrip("/")) for d in dirs]
    return names if len(set(names)) == len(names) else list(dirs)


def _search(manifest: Json) -> Json:
    uel: Any = manifest.get("uel")
    strategy: Any = cast(Json, uel).get("search_strategy") \
        if isinstance(uel, dict) else None
    return cast(Json, strategy) if isinstance(strategy, dict) else {}


def without_seed(manifest: Json) -> Json:
    """A manifest less its search seed, the one thing in which several runs
    of it side by side differ."""
    out = cast(Json, json.loads(json.dumps(manifest)))
    _search(out).pop("seed", None)
    return out


def differences(a: Any, b: Any, path: str = "") -> list[str]:
    """Where two JSON values differ: each place as a dotted path, with the
    first value and the second."""
    if isinstance(a, dict) and isinstance(b, dict):
        da, db = cast(Json, a), cast(Json, b)
        out: list[str] = []
        for k in sorted(set(da) | set(db)):
            here = "%s.%s" % (path, k) if path else k
            if k not in da or k not in db:
                out.append("%s %s" % (here, "only in the second" if k in db
                                      else "only in the first"))
            else:
                out.extend(differences(da[k], db[k], here))
        return out
    # as JSON text, so that true is not 1, nor 1 the same as 1.0
    if json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True):
        return []
    return ["%s %s, then %s" % (path or "the manifest", _short(a),
                                _short(b))]


def _short(v: Any) -> str:
    text = json.dumps(v)
    return text if len(text) <= 40 else text[:37] + "..."


def shards_problem(labels: list[str], experiments: list[Json]) -> str | None:
    """Why several result directories cannot be read as one run, or None:
    their manifests differ in more than the search seed, or their draws
    are the same."""
    first = cast(Json, experiments[0]["manifest"])
    base = without_seed(first)
    for label, exp in zip(labels[1:], experiments[1:], strict=True):
        diff = differences(base, without_seed(cast(Json, exp["manifest"])))
        if diff:
            more = " and %d more" % (len(diff) - 3) if len(diff) > 3 else ""
            return ("%s and %s ran different manifests, not one manifest "
                    "with different search seeds: %s%s"
                    % (labels[0], label, "; ".join(diff[:3]), more))
    if _search(first).get("type") == "grid":
        return ("%s: a grid search draws the same rounds in every directory; "
                "only a random search drawn with different seeds can be "
                "read as one run" % ", ".join(labels))
    seen: dict[str, str] = {}
    for label, exp in zip(labels, experiments, strict=True):
        seed: Any = _search(cast(Json, exp["manifest"])).get("seed")
        if seed is None:
            continue
        key = json.dumps(seed)
        if key in seen:
            return ("%s and %s share the search seed %s, so they drew the "
                    "same rounds" % (seen[key], label, key))
        seen[key] = label
    return None


def experiment_name(experiment: Json) -> str | None:
    manifest = cast(Json, experiment["manifest"])
    meta: Any = manifest.get("metadata")
    if not isinstance(meta, dict):
        return None
    name: Any = cast(Json, meta).get("name")
    return name if isinstance(name, str) else None


def csv_value(text: str) -> Any:
    """One CSV field as the value Limen wrote."""
    if text == "":
        return None
    if text == "True":
        return True
    if text == "False":
        return False
    if _INT.match(text):
        return int(text)
    try:
        return float(text)
    except ValueError:
        pass
    if text[0] in "[{":
        try:
            return json.loads(text)
        except ValueError:
            return text
    return text


class CsvRecords:
    """Records of a CSV file arriving line by line. A quoted field may hold
    a line break, so a record is complete only when its quotes are."""

    def __init__(self) -> None:
        self.header: list[str] | None = None
        self.pending: list[str] = []

    def feed(self, line: str) -> list[str] | None:
        """The record this line completes, or None while one is open."""
        self.pending.append(line)
        text = "\n".join(self.pending)
        if text.count('"') % 2:
            return None
        self.pending = []
        return next(csv.reader([text], strict=True))

    def row(self, fields: list[str]) -> Json:
        """A data record as a row; the header must have been read."""
        assert self.header is not None
        if len(fields) != len(self.header):
            raise ValueError("%d fields where the header names %d"
                             % (len(fields), len(self.header)))
        return {k: csv_value(v)
                for k, v in zip(self.header, fields, strict=True)}


def round_record(text: str) -> tuple[int, list[str]]:
    """One line of a Limen run's round_data.jsonl: the round's index and
    the feature columns its ablation dropped.

    ``limen run`` writes the line after the round's results.csv row, and
    only for a round that succeeded. Its ``round_params`` hold
    ``_dropped_features`` (sorted) when the round dropped any; results.csv
    cannot carry them, as its columns are fixed by the first round. The
    predictions on the line are not read.
    """
    raw: Any = json.loads(text)
    if not isinstance(raw, dict):
        raise ValueError("a round line is a JSON object")
    rec = cast(Json, raw)
    index: Any = rec.get("_round_index")
    params: Any = rec.get("round_params")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        raise ValueError("a round line needs a _round_index, got %r"
                         % (index,))
    if not isinstance(params, dict):
        raise ValueError("round %d has no round_params" % index)
    dropped: Any = cast(Json, params).get("_dropped_features")
    if dropped is None:
        return index, []
    if not isinstance(dropped, list) or not all(
            isinstance(c, str) for c in cast(list[Any], dropped)):
        raise ValueError("round %d: _dropped_features is not a list of "
                         "column names" % index)
    return index, sorted(cast(list[str], dropped))
