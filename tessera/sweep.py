"""A sweep: its runs (results files), its log and its documents.

A run holds one results file's rows. When the file starts over (a
relaunched sweep reopens it for writing), the rows read so far are kept as
an archived run and the run continues empty with a new generation, so the
page never loses rows it has shown.

Lines that are not JSON objects are not rows: they are counted per run
with their line number and the parser's message, and the page shows them.
"""

from __future__ import annotations

import json
import math
import threading
import time
from array import array
from typing import Any

from . import PACK_VERSION, __version__
from .columns import Store
from .logparse import LogParser

Json = dict[str, Any]
BAD_KEEP = 50


class Run:
    def __init__(self, run_id: str, label: str, source: str,
                 segment: int | None, live: bool) -> None:
        self.id = run_id
        self.label = label
        self.source = source
        self.segment = segment      # log segment these rows belong to
        self.live = live
        self.store = Store()
        self.generation = 0
        self.lines = 0              # lines read in this generation
        self.bad: list[Json] = []   # first BAD_KEEP bad lines
        self.bad_count = 0
        self.arrivals = array("d")  # wall time a row arrived; NaN = history
        self.archived_from: str | None = None
        self.resets: list[Json] = []

    def meta(self) -> Json:
        return {"id": self.id, "label": self.label, "source": self.source,
                "segment": self.segment, "live": self.live,
                "generation": self.generation, "rows": self.store.rows,
                "lines": self.lines, "badCount": self.bad_count,
                "bad": self.bad, "schemaEvents": self.store.events,
                "archivedFrom": self.archived_from, "resets": self.resets}

    def add_line(self, text: str, now: float | None) -> None:
        self.lines += 1
        if not text.strip():
            return
        try:
            row = json.loads(text)
            self.store.append(row)
        except ValueError as exc:
            self.bad_count += 1
            if len(self.bad) < BAD_KEEP:
                self.bad.append({"line": self.lines, "error": str(exc),
                                 "text": text[:300]})
            return
        self.arrivals.append(math.nan if now is None else now)


class Sweep:
    """Everything the page shows, guarded by one lock."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.runs: list[Run] = []
        self.log: LogParser | None = None
        self.log_source: str | None = None
        self.docs: dict[str, Json] = {}
        self.errors: list[Json] = []
        self.started = time.time()

    # -- mutations (called by followers) -----------------------------------
    def _bump(self) -> None:
        self.version += 1
        self.changed.notify_all()

    def add_run(self, run: Run) -> None:
        with self.lock:
            self.runs.append(run)
            self._bump()

    def run_line(self, run: Run, text: str, preload: bool) -> None:
        with self.lock:
            run.add_line(text, None if preload else time.time())
            self._bump()

    def run_reset(self, run: Run, reason: str) -> None:
        with self.lock:
            if run.store.rows or run.bad_count:
                old = Run("%s.g%d" % (run.id, run.generation),
                          "%s before %s at %s" % (
                              run.label, reason,
                              time.strftime("%H:%M:%S", time.gmtime())),
                          run.source, run.segment, False)
                old.store, old.lines = run.store, run.lines
                old.bad, old.bad_count = run.bad, run.bad_count
                old.arrivals, old.generation = run.arrivals, run.generation
                old.archived_from = run.id
                self.runs.insert(self.runs.index(run), old)
            run.resets.append({"at": time.time(), "reason": reason,
                               "rows": run.store.rows})
            run.store = Store()
            run.generation += 1
            run.lines = 0
            run.bad, run.bad_count = [], 0
            run.arrivals = array("d")
            self._bump()

    def set_log(self, source: str) -> None:
        with self.lock:
            self.log = LogParser()
            self.log_source = source

    def log_line(self, text: str, preload: bool) -> None:
        with self.lock:
            assert self.log is not None
            self.log.feed(text, None if preload else time.time())
            self._bump()

    def log_flush(self) -> None:
        with self.lock:
            if self.log is not None and self.log.tb is not None:
                self.log.flush()
                self._bump()

    def log_reset(self, reason: str) -> None:
        with self.lock:
            self.errors.append({"at": time.time(),
                                "message": "log %s; reading it again"
                                           % reason})
            self.log = LogParser()
            self._bump()

    def error(self, message: str) -> None:
        with self.lock:
            self.errors.append({"at": time.time(), "message": message})
            self._bump()

    # -- reads (called by the server) ----------------------------------------
    def meta(self) -> Json:
        return {"tessera": PACK_VERSION, "version": __version__,
                "name": self.name, "started": self.started,
                "now": time.time(), "logSource": self.log_source,
                "errors": self.errors[-50:]}

    def pack_text(self) -> tuple[str, Cursor]:
        """Everything as of now as JSON text, and its cursor.

        Serialised under the lock: followers keep appending to the same
        lists while a page is being served.
        """
        with self.lock:
            runs: list[Json] = []
            cursor = Cursor()
            for r in self.runs:
                m = r.meta()
                m["columns"] = r.store.export()
                m["arrivals"] = _arrivals(r.arrivals, 0)
                runs.append(m)
                cursor.runs[r.id] = (r.generation, r.store.rows)
            out = self.meta()
            out["mode"] = "live"
            out["runs"] = runs
            out["log"] = self.log.to_json() if self.log else None
            out["docs"] = self.docs
            if self.log is not None:
                cursor.progress = self.log.progress_cursor()
                cursor.log_lines = self.log.lines
            cursor.version = self.version
            return json.dumps(out, separators=(",", ":")), cursor

    def delta_text(self, cursor: Cursor) -> list[str]:
        """Messages (JSON text) that bring a page at ``cursor`` up to date;
        ``cursor`` is advanced in place."""
        msgs: list[Json] = []
        with self.lock:
            if cursor.version == self.version:
                return []
            for r in self.runs:
                gen, rows = cursor.runs.get(r.id, (-1, 0))
                if gen != r.generation:
                    msgs.append({"type": "run", "run": r.meta(),
                                 "known": gen != -1})
                    rows = 0
                if r.store.rows > rows:
                    msgs.append({"type": "rows", "run": r.id,
                                 "generation": r.generation,
                                 "lo": rows, "hi": r.store.rows,
                                 "columns": r.store.export(rows,
                                                           compact=False),
                                 "arrivals": _arrivals(r.arrivals, rows),
                                 "meta": r.meta()})
                cursor.runs[r.id] = (r.generation, r.store.rows)
            if self.log is not None and self.log.lines != cursor.log_lines:
                msgs.append({"type": "log",
                             "log": self.log.to_json(cursor.progress)})
                cursor.progress = self.log.progress_cursor()
                cursor.log_lines = self.log.lines
            msgs.append({"type": "meta", "meta": self.meta()})
            cursor.version = self.version
            return [json.dumps(m, separators=(",", ":")) for m in msgs]

    def wait_change(self, version: int, timeout: float) -> int:
        """Block until the sweep changes past ``version`` or time runs out."""
        with self.lock:
            if self.version == version:
                self.changed.wait(timeout)
            return self.version


class Cursor:
    """What one page holds: per run (generation, rows) and the log."""

    def __init__(self) -> None:
        self.runs: dict[str, tuple[int, int]] = {}
        self.progress: dict[int, int] = {}
        self.log_lines = 0
        self.version = -1


def _arrivals(arr: array[float], lo: int) -> list[float | None]:
    return [None if math.isnan(t) else round(t, 3) for t in arr[lo:]]
