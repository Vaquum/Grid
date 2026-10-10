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

A run can be read from several Limen result directories of one manifest
(shards: ``limen run`` side by side with different search seeds). Each
file's rows are tagged with their directory's label in ``shard``, and
their rounds too. Their history waits until every file's is read, then
joins the run interleaved by round index, as the shards ran side by
side; rows that arrive after it join as they arrive.

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
SHARD = "shard"     # the field naming a sharded run's directory


class Run:
    def __init__(self, run_id: str, label: str, source: str,
                 segment: int | None, live: bool,
                 log_id: str | None = None, fmt: str = "jsonl",
                 experiment: Json | None = None,
                 shards: list[str] | None = None) -> None:
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
        # a run read from several files: their labels, each file's own
        # records (its own header) and line count, and the rows waiting
        # until every file's history is read (row, arrival, place in file)
        self.shards = shards
        self.shard_records: dict[int, CsvRecords] = {}
        self.shard_lines: dict[int, int] = {}
        self.pending: dict[int, list[tuple[Json, float | None, int]]] | None
        self.pending = {k: [] for k in range(len(shards))} if shards else None
        self.store = Store()
        self.generation = 0
        self.lines = 0              # lines read in this generation
        self.bad: list[Json] = []   # first BAD_KEEP bad lines
        self.bad_count = 0
        self.arrivals = array("d")  # wall time a row arrived; NaN = history
        # when the run's files were last written, as they said when the
        # server began reading them: the rows read then have no arrival
        self.written_at: float | None = None
        self.archived_from: str | None = None
        self.archived_at: float | None = None    # wall time it was kept
        self.archived_reason: str | None = None  # truncated or replaced
        self.resets: list[Json] = []
        self.rounds: list[list[Any]] = []   # [round index, dropped columns]
        self.rounds_generation = 0
        self.rounds_lines = 0
        self.rounds_bad: list[Json] = []
        self.rounds_bad_count = 0
        self.rounds_shard_lines: dict[int, int] = {}
        self.archived_shard: str | None = None  # the file that started over

    def meta(self) -> Json:
        return {"id": self.id, "label": self.label, "source": self.source,
                "logId": self.log_id, "segment": self.segment,
                "live": self.live, "writtenAt": self.written_at,
                "generation": self.generation, "rows": self.store.rows,
                "lines": self.lines, "badCount": self.bad_count,
                "bad": self.bad, "schemaEvents": self.store.events,
                "archivedFrom": self.archived_from,
                "archivedAt": self.archived_at,
                "archivedReason": self.archived_reason,
                "archivedShard": self.archived_shard, "resets": self.resets,
                "format": self.fmt, "experiment": self.experiment,
                "roundsBadCount": self.rounds_bad_count,
                "roundsBad": self.rounds_bad}

    def add_line(self, text: str, now: float | None,
                 shard: int | None = None) -> None:
        """A line of the run's results file (of its shard-th file, for a
        run read from several)."""
        self.lines += 1
        line = self.lines
        if shard is not None:
            line = self.shard_lines[shard] = self.shard_lines.get(shard, 0) + 1
        if self.records is None and not text.strip():
            return
        try:
            row = self._row(text, shard)
            if row is None:
                return
            if shard is not None and self.shards is not None:
                if SHARD in row:
                    raise ValueError("the row has a field named %s, the name "
                                     "Grid gives each row's directory" % SHARD)
                row[SHARD] = self.shards[shard]
                if self.pending is not None:
                    self.pending[shard].append(
                        (row, now, len(self.pending[shard])))
                    return
            self.store.append(row)
        except ValueError as exc:
            self._bad(line, str(exc), text, shard)
            return
        self.arrivals.append(math.nan if now is None else now)

    def _bad(self, line: int, error: str, text: str,
             shard: int | None) -> None:
        self.bad_count += 1
        if len(self.bad) < BAD_KEEP:
            bad: Json = {"line": line, "error": error, "text": text[:300]}
            if shard is not None and self.shards is not None:
                bad[SHARD] = self.shards[shard]
            self.bad.append(bad)

    def merge_pending(self) -> None:
        """Every file's history is read: it joins the run interleaved by
        round index (the files were written side by side), then the rows
        that arrived meanwhile, as they arrived."""
        if self.pending is None:
            return
        held = [(row, now, place, k) for k, rows in self.pending.items()
                for row, now, place in rows]
        self.pending = None

        def order(item: tuple[Json, float | None, int, int]) -> tuple[
                float, float, int]:
            row, now, place, k = item
            index: Any = row.get("_round_index")
            at = index if isinstance(index, int) else place
            return (now if now is not None else -math.inf, at, k)
        for row, now, _, _ in sorted(held, key=order):
            try:
                self.store.append(row)
            except ValueError as exc:
                self._bad(-1, str(exc), json.dumps(row), None)
                continue
            self.arrivals.append(math.nan if now is None else now)

    def _row(self, text: str, shard: int | None = None) -> Json | None:
        """The row a line completes; None for the header or a line of a
        record still open."""
        records = self.records
        if shard is not None and records is not None:
            records = self.shard_records.setdefault(shard, CsvRecords())
        if records is None:
            return json.loads(text)
        fields = records.feed(text)
        if fields is None:
            return None
        if records.header is None:
            records.header = fields
            return None
        return records.row(fields)

    def add_round_line(self, text: str, shard: int | None = None) -> None:
        """A line of the run's round log (of its shard-th, for a run read
        from several, whose rounds carry their shard's label); one that is
        not a round is counted with its reason, as a bad results line
        is."""
        self.rounds_lines += 1
        line = self.rounds_lines
        if shard is not None:
            line = self.rounds_shard_lines[shard] = \
                self.rounds_shard_lines.get(shard, 0) + 1
        if not text.strip():
            return
        try:
            index, dropped = round_record(text)
        except ValueError as exc:
            self.rounds_bad_count += 1
            if len(self.rounds_bad) < BAD_KEEP:
                bad: Json = {"line": line, "error": str(exc),
                             "text": text[:300]}
                if shard is not None and self.shards is not None:
                    bad[SHARD] = self.shards[shard]
                self.rounds_bad.append(bad)
            return
        if shard is not None and self.shards is not None:
            self.rounds.append([index, dropped, self.shards[shard]])
        else:
            self.rounds.append([index, dropped])

    def rounds_restart(self, shard: int | None = None) -> None:
        """Empty (of the shard-th round log's rounds only, for a run read
        from several), for the next generation of the round log."""
        if shard is not None and self.shards is not None:
            label = self.shards[shard]
            self.rounds = [r for r in self.rounds
                           if len(r) < 3 or r[2] != label]
            self.rounds_shard_lines.pop(shard, None)
        else:
            self.rounds = []
            self.rounds_lines = 0
            self.rounds_bad, self.rounds_bad_count = [], 0
        self.rounds_generation += 1

    def restart(self) -> None:
        """Empty, for the next generation of the same file."""
        self.store = Store()
        self.records = CsvRecords() if self.fmt == "csv" else None
        self.generation += 1
        self.lines = 0
        self.bad, self.bad_count = [], 0
        self.arrivals = array("d")
        self.written_at = None   # the new generation's rows all arrive


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

    def run_line(self, run: Run, text: str, preload: bool,
                 shard: int | None = None) -> None:
        with self.lock:
            run.add_line(text, None if preload else time.time(), shard)
            self._bump()

    def run_written(self, run: Run, mtime: float) -> None:
        """One of the run's files was last written at ``mtime``, as the
        look that bounded its history saw it."""
        with self.lock:
            run.written_at = mtime if run.written_at is None \
                else max(run.written_at, mtime)
            self._bump()

    def merge(self, run: Run) -> None:
        """A run read from several files has read every file's history."""
        with self.lock:
            if run.pending is not None:
                run.merge_pending()
                self._bump()

    def run_reset(self, run: Run, reason: str,
                  shard: int | None = None) -> None:
        with self.lock:
            if shard is not None and run.pending is not None:
                # its file started over before the history was joined
                run.pending[shard] = []
                run.shard_records.pop(shard, None)
                return
            if run.store.rows or run.bad_count:
                # the rows kept keep their log, and the segment they came
                # from; when and why they were kept is the page's to say,
                # on the reader's clock
                old = Run("%s.g%d" % (run.id, run.generation), run.label,
                          run.source, self._segment_of(run), False,
                          run.log_id, run.fmt, run.experiment, run.shards)
                old.pending = None
                if shard is not None and run.shards is not None:
                    old.archived_shard = run.shards[shard]
                old.archived_at, old.archived_reason = time.time(), reason
                old.store, old.lines = run.store, run.lines
                old.bad, old.bad_count = run.bad, run.bad_count
                old.arrivals, old.generation = run.arrivals, run.generation
                old.written_at = run.written_at
                old.archived_from = run.id
                # the rounds are the experiment's, read again only when
                # the round log itself starts over
                old.rounds = list(run.rounds)
                self.runs.insert(self.runs.index(run), old)
            reset: Json = {"at": time.time(), "reason": reason,
                           "rows": run.store.rows}
            kept = run.store
            arrivals = run.arrivals
            written = run.written_at
            run.restart()
            if shard is not None and run.shards is not None:
                # one file started over: the run goes on with the other
                # files' rows (the archive keeps them all), and that file
                # reads its header again
                label = run.shards[shard]
                reset[SHARD] = label
                col = kept.columns.get(SHARD)
                keep = [i for i in range(kept.rows) if col is None
                        or col.value_at(i) != label]
                run.store = kept.take(keep)
                run.arrivals = array("d", (arrivals[i] for i in keep))
                run.written_at = written
                run.shard_records.pop(shard, None)
                run.shard_lines.pop(shard, None)
            run.resets.append(reset)
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

    def round_line(self, run: Run, text: str, preload: bool,
                   shard: int | None = None) -> None:
        with self.lock:
            run.add_round_line(text, shard)
            self._bump()

    def round_reset(self, run: Run, reason: str,
                    shard: int | None = None) -> None:
        with self.lock:
            which = run.label if shard is None or run.shards is None else \
                "%s (%s)" % (run.label, run.shards[shard])
            self.errors.append({"at": time.time(),
                                "message": "round log of %s %s; reading it "
                                           "again" % (which, reason)})
            run.rounds_restart(shard)
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
