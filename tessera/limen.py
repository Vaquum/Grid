"""A Limen result directory: the experiment's manifest and its rounds.

``limen run`` writes ``metadata.json`` first (the parsed manifest under
``yaml_reference``), then appends one line to ``results.csv`` as each
round finishes: the metrics, then every parameter, then the round's own
bookkeeping. The manifest says which columns are parameters, so nothing
is inferred about them.

CSV carries no types. Limen writes ``None`` as an empty field and Python
booleans as ``True``/``False``; numbers and JSON lists (``_warnings``) are
read back as such, and every other field stays text.
"""

from __future__ import annotations

import csv
import json
import re
from typing import Any, cast

Json = dict[str, Any]
_INT = re.compile(r"[+-]?\d+\Z")


def read_experiment(text: str, path: str) -> Json:
    """The experiment as the page needs it, from metadata.json's text."""
    raw: Any = json.loads(text)
    if not isinstance(raw, dict) or "yaml_reference" not in raw:
        raise ValueError("%s has no yaml_reference: not a Limen result "
                         "directory's metadata.json" % path)
    meta = cast(Json, raw)
    manifest: Any = meta["yaml_reference"]
    if not isinstance(manifest, dict):
        raise ValueError("%s: yaml_reference is not a mapping" % path)
    return {"kind": "limen", "manifest": cast(Json, manifest),
            "limenVersion": meta.get("limen_version"),
            "createdAt": meta.get("created_at"),
            "manifestId": meta.get("manifest_id")}


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
