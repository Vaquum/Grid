"""A sweep: its runs (results files) and their logs.

A run holds one results file's rows: JSON lines, or a CSV whose first
record names the columns (a Limen result directory's results.csv, with
the experiment's manifest beside it). When the file starts over (a
relaunched sweep reopens it for writing), the rows read so far are kept as
an archived run and the run continues empty with a new generation, so the
page never loses rows it has shown.

A Limen run also keeps its rounds as round_data.jsonl records them: each
round's index and the feature columns its ablation dropped, joined to the
rows by ``_round_index`` on the page (a round's line comes after its row,
and never for a round that failed).

Lines that are not rows (not a JSON object, or a CSV record whose fields
do not match the header) are counted per run with their line number and
the parser's message, and the page shows them.
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
from .limen import CsvRecords, round_record
from .logparse import LogParser

Json = dict[str, Any]
BAD_KEEP = 50


class Run:
    def __init__(self, run_id: str, label: str, source: str,
                 segment: int | None, live: bool,
                 log_id: str | None = None, fmt: str = "jsonl",
                 experiment: Json | None = None) -> None:
        if fmt not in ("jsonl", "csv"):
            raise ValueError("results format %r: jsonl or csv" % fmt)
        self.id = run_id
        self.label = label
        self.source = source
        self.log_id = log_id        # the log this run's runner writes
        self.segment = segment      # its segment in that log (None: latest)
        self.live = live
        self.fmt = fmt
        self.experiment = experiment  # what wrote the rows (Limen manifest)
        self.records = CsvRecords() if fmt == "csv" else None
        self.store = Store()
        self.generation = 0
        self.lines = 0              # lines read in this generation
        self.bad: list[Json] = []   # first BAD_KEEP bad lines
        self.bad_count = 0
        self.arrivals = array("d")  # wall time a row arrived; NaN = history
        self.archived_from: str | None = None
        self.resets: list[Json] = []
        self.rounds: list[list[Any]] = []   # [round index, dropped columns]
        self.rounds_generation = 0
        self.rounds_lines = 0
        self.rounds_bad: list[Json] = []
        self.rounds_bad_count = 0

    def meta(self) -> Json:
        return {"id": self.id, "label": self.label, "source": self.source,
                "logId": self.log_id, "segment": self.segment,
                "live": self.live,
                "generation": self.generation, "rows": self.store.rows,
                "lines": self.lines, "badCount": self.bad_count,
                "bad": self.bad, "schemaEvents": self.store.events,
                "archivedFrom": self.archived_from, "resets": self.resets,
                "format": self.fmt, "experiment": self.experiment,
                "roundsBadCount": self.rounds_bad_count,
                "roundsBad": self.rounds_bad}

    def add_line(self, text: str, now: float | None) -> None:
        self.lines += 1
        if self.records is None and not text.strip():
            return
        try:
            row = self._row(text)
            if row is None:
                return
            self.store.append(row)
        except ValueError as exc:
            self.bad_count += 1
            if len(self.bad) < BAD_KEEP:
                self.bad.append({"line": self.lines, "error": str(exc),
                                 "text": text[:300]})
            return
        self.arrivals.append(math.nan if now is None else now)

    def _row(self, text: str) -> Json | None:
        """The row a line completes; None for the header or a line of a
        record still open."""
        if self.records is None:
            return json.loads(text)
        fields = self.records.feed(text)
        if fields is None:
            return None
        if self.records.header is None:
            self.records.header = fields
            return None
        return self.records.row(fields)

    def add_round_line(self, text: str) -> None:
        """A line of the run's round log; one that is not a round is
        counted with its reason, as a bad results line is."""
        self.rounds_lines += 1
        if not text.strip():
            return
        try:
            index, dropped = round_record(text)
        except ValueError as exc:
            self.rounds_bad_count += 1
            if len(self.rounds_bad) < BAD_KEEP:
                self.rounds_bad.append({"line": self.rounds_lines,
                                        "error": str(exc),
                                        "text": text[:300]})
            return
        self.rounds.append([index, dropped])

    def rounds_restart(self) -> None:
        """Empty, for the next generation of the round log."""
        self.rounds = []
        self.rounds_generation += 1
        self.rounds_lines = 0
        self.rounds_bad, self.rounds_bad_count = [], 0

    def restart(self) -> None:
        """Empty, for the next generation of the same file."""
        self.store = Store()
        self.records = CsvRecords() if self.fmt == "csv" else None
        self.generation += 1
        self.lines = 0
        self.bad, self.bad_count = [], 0
        self.arrivals = array("d")


class Sweep:
    """Everything the page shows, guarded by one lock."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.runs: list[Run] = []
        self.logs: dict[str, LogParser] = {}
        self.log_sources: dict[str, str] = {}
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
                # the rows kept keep their log, and the segment they came from
                old = Run("%s.g%d" % (run.id, run.generation),
                          "%s before %s at %s" % (
                              run.label, reason,
                              time.strftime("%H:%M:%S", time.gmtime())),
                          run.source, self._segment_of(run), False,
                          run.log_id, run.fmt, run.experiment)
                old.store, old.lines = run.store, run.lines
                old.bad, old.bad_count = run.bad, run.bad_count
                old.arrivals, old.generation = run.arrivals, run.generation
                old.archived_from = run.id
                # the rounds are the experiment's, read again only when
                # the round log itself starts over
                old.rounds = list(run.rounds)
                self.runs.insert(self.runs.index(run), old)
            run.resets.append({"at": time.time(), "reason": reason,
                               "rows": run.store.rows})
            run.restart()
            self._bump()

    def _segment_of(self, run: Run) -> int | None:
        """The log segment a run's rows so far came from: the one it names,
        else the latest that started before its last row arrived (a
        relaunch's start line can be read before the results file starts
        over); for rows read at startup, the latest started by then."""
        if run.segment is not None or run.log_id is None:
            return run.segment
        log = self.logs.get(run.log_id)
        if log is None or not log.segments:
            return None
        last = run.arrivals[-1] if len(run.arrivals) else math.nan
        started = [s for s in log.segments if s.wall is None
                   or (not math.isnan(last) and s.wall <= last)]
        return (started or log.segments)[-1].index

    def add_log(self, log_id: str, source: str) -> None:
        with self.lock:
            self.logs[log_id] = LogParser()
            self.log_sources[log_id] = source

    def log_line(self, log_id: str, text: str, preload: bool) -> None:
        with self.lock:
            self.logs[log_id].feed(text, None if preload else time.time())
            self._bump()

    def log_flush(self) -> None:
        """Close tracebacks left open in quiet logs."""
        with self.lock:
            for log in self.logs.values():
                if log.tb is not None:
                    log.flush()
                    self._bump()

    def round_line(self, run: Run, text: str, preload: bool) -> None:
        with self.lock:
            run.add_round_line(text)
            self._bump()

    def round_reset(self, run: Run, reason: str) -> None:
        with self.lock:
            self.errors.append({"at": time.time(),
                                "message": "round log of %s %s; reading it "
                                           "again" % (run.label, reason)})
            run.rounds_restart()
            self._bump()

    def log_reset(self, log_id: str, reason: str) -> None:
        with self.lock:
            self.errors.append({"at": time.time(),
                                "message": "log %s %s; reading it again"
                                           % (self.log_sources[log_id],
                                              reason)})
            self.logs[log_id] = LogParser()
            self._bump()

    def error(self, message: str) -> None:
        with self.lock:
            self.errors.append({"at": time.time(), "message": message})
            self._bump()

    # -- reads (called by the server) ----------------------------------------
    def meta(self) -> Json:
        return {"grid": PACK_VERSION, "version": __version__,
                "name": self.name, "started": self.started,
                "now": time.time(), "logSources": self.log_sources,
                "errors": self.errors[-50:]}

    def pack_parts(self, mode: str = "live") -> tuple[list[str], Cursor]:
        """Everything as of now as JSON text in parts (joined, they are
        one JSON document), and its cursor.

        Serialised under the lock (followers keep appending to the same
        arrays), one column at a time to keep memory to one column's worth.
        """
        with self.lock:
            parts: list[str] = []
            cursor = Cursor()
            top = self.meta()
            top["mode"] = mode
            parts.append(json.dumps(top, separators=(",", ":"))[:-1] +
                         ',"runs":[')
            for k, r in enumerate(self.runs):
                head = json.dumps(r.meta(), separators=(",", ":"))[:-1]
                parts.append(("," if k else "") + head + ',"columns":[')
                for j, col in enumerate(r.store.export_iter()):
                    parts.append(("," if j else "") + col)
                parts.append('],"arrivals":' +
                             json.dumps(_arrivals(r.arrivals, 0)) +
                             ',"rounds":' +
                             json.dumps(r.rounds, separators=(",", ":")) +
                             "}")
                cursor.runs[r.id] = (r.generation, r.store.rows)
                cursor.rounds[r.id] = (r.rounds_generation, len(r.rounds))
            for k, v in self.logs.items():
                cursor.progress[k] = v.progress_cursor()
                cursor.log_lines[k] = v.lines
            cursor.version = self.version
            parts.append('],"logs":' +
                         json.dumps({k: v.to_json()
                                     for k, v in self.logs.items()},
                                    separators=(",", ":")) + "}")
            return parts, cursor

    def pack_text(self, mode: str = "live") -> tuple[str, Cursor]:
        parts, cursor = self.pack_parts(mode)
        return "".join(parts), cursor

    def delta_text(self, cursor: Cursor) -> list[str]:
        """Messages (JSON text) that bring a page at ``cursor`` up to date;
        ``cursor`` is advanced in place."""
        msgs: list[Json] = []
        with self.lock:
            if cursor.version == self.version:
                return []
            for r in self.runs:
                gen, rows = cursor.runs.get(r.id, (-1, 0))
                rgen, sent = cursor.rounds.get(r.id, (-1, 0))
                if gen != r.generation:
                    msgs.append({"type": "run", "run": r.meta(),
                                 "known": gen != -1})
                    rows = 0
                    # a page starts that run afresh, rounds and all
                    rgen, sent = -1, 0
                if r.store.rows > rows:
                    msgs.append({"type": "rows", "run": r.id,
                                 "generation": r.generation,
                                 "lo": rows, "hi": r.store.rows,
                                 "columns": r.store.export(rows,
                                                           compact=False),
                                 "arrivals": _arrivals(r.arrivals, rows),
                                 "meta": r.meta()})
                cursor.runs[r.id] = (r.generation, r.store.rows)
                reset = rgen not in (-1, r.rounds_generation)
                if reset:
                    sent = 0
                if reset or len(r.rounds) > sent:
                    msgs.append({"type": "rounds", "run": r.id,
                                 "reset": reset, "entries": r.rounds[sent:]})
                cursor.rounds[r.id] = (r.rounds_generation, len(r.rounds))
            for k, log in self.logs.items():
                if log.lines == cursor.log_lines.get(k, -1):
                    continue
                msgs.append({"type": "log", "logId": k,
                             "log": log.to_json(cursor.progress.get(k))})
                cursor.progress[k] = log.progress_cursor()
                cursor.log_lines[k] = log.lines
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
    """What one page holds: per run (generation, rows) and (round log
    generation, rounds), per log what it has read."""

    def __init__(self) -> None:
        self.runs: dict[str, tuple[int, int]] = {}
        self.rounds: dict[str, tuple[int, int]] = {}
        self.progress: dict[str, dict[int, int]] = {}
        self.log_lines: dict[str, int] = {}
        self.version = -1


def _arrivals(arr: array[float], lo: int) -> list[float | None]:
    return [None if math.isnan(t) else round(t, 3) for t in arr[lo:]]
