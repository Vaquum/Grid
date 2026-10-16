"""Resolve exact test timestamps through Limen, in Limen's own Python.

Uses the recorded manifest and round parameters, without fitting a model.
Input/output are private JSON on stdin/stdout; diagnostics go to stderr.
"""

from __future__ import annotations

import contextlib
import importlib
import json
import os
import sys
from typing import Any


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != here]
    request: Any = json.load(sys.stdin)
    compiler: Any = importlib.import_module("limen.yaml.compiler")
    with contextlib.redirect_stdout(sys.stderr):
        manifest: Any = compiler.build_manifest(request["manifest"])
        raw: Any = manifest.fetch_data()
        out: dict[str, list[str]] = {}
        for record in request["records"]:
            bars: Any = manifest.compute_test_bars(raw, record["round_params"])
            out[record["round_id"]] = [t.isoformat()
                                       for t in bars["datetime"].to_list()]
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
