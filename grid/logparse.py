"""Parse a sweep runner's stdout log, line by line.

The log is read as it grows. Every line is classified; nothing is dropped
silently: lines that match no rule are counted under ``other`` with the
first few kept as samples.

Recognised:

- a run start, ``sampling 500000 A-perms...`` or
  ``sampling 500000 A-perms models=logreg -> data/logregone``;
- a relaunch marker written before a start, ``--- 20261008_183539 label ---``;
- a progress line, ``4100/500000 615s top: gates=7 mean=+5.84 lgbm_hp``
  (the count, the total, the first ``<number>s`` as elapsed seconds, every
  ``key=number`` pair, and the remaining words);
- a Python warning, ``path:line: Category: message`` and the source line
  under it, counted per (category, path, line, message);
- a traceback, including chained and multiprocessing remote tracebacks,
  grouped into one crash with its exception, message and the innermost
  frame in the sweep's own code;
- the closing summary, ``-- top 5 / 500000 --`` and ``logged``.

A segment is one run of the sweep: it opens at a start line and closes at
the next marker or start, a crash, or the closing summary.
"""

from __future__ import annotations

import re
from typing import Any

RE_START = re.compile(r"^sampling (?P<n>\d+)\s+(?P<what>.*?)(?:\.\.\.)?\s*$")
RE_MARKER = re.compile(r"^--- (?P<stamp>\S+) (?P<label>.*?) ---\s*$")
RE_PROGRESS = re.compile(r"^(?P<i>\d+)/(?P<n>\d+)(?P<rest>(?:\s.*)?)$")
RE_ELAPSED = re.compile(r"(?<![\w.])(?P<s>\d+(?:\.\d+)?)s\b")
RE_KV = re.compile(r"(?P<k>[A-Za-z_][\w.]*)=(?P<v>[+-]?\d+(?:\.\d+)?)")
RE_WARNING = re.compile(r"^(?P<path>.+?):(?P<lineno>\d+): "
                        r"(?P<cat>[A-Za-z_]\w*Warning): (?P<msg>.*)$")
RE_TB_START = re.compile(r"^(Traceback \(most recent call last\):|"
                         r"\S*RemoteTraceback:\s*)$")
RE_FRAME = re.compile(r'^\s+File "(?P<path>[^"]+)", line (?P<lineno>\d+), '
                      r"in (?P<func>.+)$")
RE_EXC = re.compile(r"^(?P<exc>[A-Za-z_][\w.]*(?:Error|Exception|Exit|"
                    r"Interrupt|Warning|Failure))(?::\s?(?P<msg>.*))?$")
RE_DONE = re.compile(r"^-- top \d+ / \d+ --\s*$")
CHAIN_LINES = ("The above exception was the direct cause of the following "
               "exception:",
               "During handling of the above exception, another exception "
               "occurred:")
LIBRARY_PATHS = ("/usr/lib/python", "/site-packages/", "/multiprocessing/",
                 "/lib/python3", "<frozen ")
OTHER_SAMPLES = 20

Json = dict[str, Any]


def _num(s: str) -> float | int:
    return float(s) if "." in s else int(s)


class Segment:
    def __init__(self, index: int, line: int) -> None:
        self.index = index
        self.line = line                  # line number of the start (1-based)
        self.marker: Json | None = None   # {"line", "stamp", "label"}
        self.total: int | None = None
        self.what: str | None = None
        # [line, rows done, elapsed s or None, {key: number}, words,
        #  wall time the line was read or None]
        self.progress: list[list[Any]] = []
        self.wall: float | None = None    # wall time the start line was read
        self.crash: Json | None = None
        self.done: int | None = None      # line of the closing summary
        self.end_line: int | None = None

    @property
    def rows(self) -> int:
        return int(self.progress[-1][1]) if self.progress else 0

    def status(self) -> str:
        if self.crash is not None:
            return "crashed"
        if self.done is not None:
            return "finished"
        if self.end_line is None:
            return "open"
        return "ended without a closing line"

    def to_json(self, progress_from: int = 0) -> Json:
        return {"index": self.index, "line": self.line,
                "marker": self.marker, "total": self.total,
                "what": self.what, "wall": self.wall,
                "progressBase": progress_from,
                "progress": self.progress[progress_from:],
                "crash": self.crash, "done": self.done,
                "endLine": self.end_line, "status": self.status()}


class LogParser:
    """Feed complete lines with ``feed``; read the state with ``to_json``."""

    def __init__(self) -> None:
        self.lines = 0
        self.segments: list[Segment] = []
        self.pending_marker: Json | None = None
        self.warnings: dict[tuple[str, str, int, str], Json] = {}
        self.warning_order: list[tuple[str, str, int, str]] = []
        self.crashes: list[Json] = []
        self.other = 0
        self.other_samples: list[Json] = []
        self.tb: Json | None = None       # open traceback group
        self.after_warning = False
        self.final_lines: list[str] = []

    # -- state helpers ------------------------------------------------------
    def _segment(self) -> Segment | None:
        return self.segments[-1] if self.segments else None

    def _row(self) -> int:
        seg = self._segment()
        return seg.rows if seg else 0

    def _close_segment(self, line: int) -> None:
        seg = self._segment()
        if seg is not None and seg.end_line is None:
            seg.end_line = line

    # -- tracebacks ---------------------------------------------------------
    def _tb_open(self, line_no: int, text: str) -> None:
        self.tb = {"line": line_no, "lines": [text], "exceptions": [],
                   "frames": [[]], "expect_more": True}

    def _tb_close(self) -> None:
        tb = self.tb
        assert tb is not None
        self.tb = None
        exceptions: list[Json] = tb["exceptions"]
        first = exceptions[0] if exceptions else None
        where: Json | None = None
        sections: list[list[Json]] = tb["frames"]
        for frames in sections:
            own = [f for f in frames
                   if not any(p in str(f["path"]) for p in LIBRARY_PATHS)]
            if own:
                where = own[-1]
                break
        seg = self._segment()
        lines: list[str] = tb["lines"]
        crash: Json = {"line": tb["line"], "row": self._row(),
                       "exception": first["exc"] if first else None,
                       "message": first["msg"] if first else None,
                       "where": where, "text": lines,
                       "segment": seg.index if seg else None}
        self.crashes.append(crash)
        if seg is not None and seg.crash is None and seg.end_line is None:
            seg.crash = crash
            seg.end_line = int(tb["line"]) + len(lines) - 1

    def _tb_feed(self, text: str) -> bool:
        """Return True when the line belongs to the open traceback."""
        tb = self.tb
        assert tb is not None
        lines: list[str] = tb["lines"]
        sections: list[list[Json]] = tb["frames"]
        stripped = text.strip()
        m = RE_FRAME.match(text)
        if m:
            sections[-1].append({"path": m["path"], "line": int(m["lineno"]),
                                 "func": m["func"], "code": None})
            lines.append(text)
            tb["expect_more"] = True
            return True
        starts = RE_TB_START.match(text) is not None
        if starts or stripped in ('"""', "") or stripped in CHAIN_LINES:
            if starts and sections[-1]:
                sections.append([])
            lines.append(text)
            tb["expect_more"] = True
            return True
        if text.startswith(" ") and tb["expect_more"]:
            frames = sections[-1]
            if frames and frames[-1]["code"] is None and \
                    not set(stripped) <= set("~^ "):
                frames[-1]["code"] = stripped
            lines.append(text)
            return True
        m = RE_EXC.match(text)
        if m:
            exceptions: list[Json] = tb["exceptions"]
            exceptions.append({"exc": m["exc"], "msg": m["msg"]})
            lines.append(text)
            tb["expect_more"] = False
            return True
        return False

    # -- main entry ---------------------------------------------------------
    def feed(self, raw: str, now: float | None = None) -> None:
        """Classify one complete line (without its newline).

        ``now`` is the wall time the line was read, when it is known (a live
        log); progress lines and starts keep it.
        """
        self.lines += 1
        n = self.lines
        text = raw.rstrip("\r")
        if self.tb is not None:
            if self._tb_feed(text):
                return
            self._tb_close()
        if self.after_warning:
            self.after_warning = False
            if text.startswith("  "):
                return  # the source line Python prints under a warning
        if RE_TB_START.match(text):
            self._tb_open(n, text)
            return
        seg = self._segment()
        m = RE_PROGRESS.match(text)
        if m and seg is None and not text.startswith(" "):
            # progress before any start line: the log was picked up mid-run
            seg = Segment(0, n)
            seg.what = "(the start is not in the log)"
            self.segments.append(seg)
        if m and seg is not None:
            rest = m["rest"].strip()
            e = RE_ELAPSED.search(rest)
            kv = {k: _num(v) for k, v in RE_KV.findall(rest)}
            words = RE_KV.sub("", RE_ELAPSED.sub("", rest, count=1))
            words = " ".join(w for w in words.split() if w.rstrip(":"))
            seg.progress.append([n, int(m["i"]),
                                 float(e["s"]) if e else None, kv, words,
                                 now])
            if seg.total is None:
                seg.total = int(m["n"])
            return
        m = RE_WARNING.match(text)
        if m:
            key = (m["cat"], m["path"], int(m["lineno"]), m["msg"])
            if key not in self.warnings:
                fresh: Json = {"category": m["cat"], "path": m["path"],
                               "line": int(m["lineno"]), "message": m["msg"],
                               "count": 0, "first": None, "last": None,
                               "segments": []}
                self.warnings[key] = fresh
                self.warning_order.append(key)
            rec = self.warnings[key]
            rec["count"] = int(rec["count"]) + 1
            at: Json = {"line": n, "row": self._row(),
                        "segment": seg.index if seg else None}
            rec["first"] = rec["first"] or at
            rec["last"] = at
            segs: list[int] = rec["segments"]
            if seg is not None and seg.index not in segs:
                segs.append(seg.index)
            self.after_warning = True
            return
        m = RE_MARKER.match(text)
        if m:
            self._close_segment(n - 1)
            self.pending_marker = {"line": n, "stamp": m["stamp"],
                                   "label": m["label"]}
            return
        m = RE_START.match(text)
        if m:
            self._close_segment(n - 1)
            new = Segment(len(self.segments), n)
            new.total = int(m["n"])
            new.what = m["what"]
            new.wall = now
            if self.pending_marker and self.pending_marker["line"] == n - 1:
                new.marker = self.pending_marker
            self.pending_marker = None
            self.segments.append(new)
            return
        if RE_DONE.match(text):
            if seg is not None:
                seg.done = n
            self.final_lines.append(text)
            return
        if seg is not None and seg.done is not None:
            self.final_lines.append(text)
            if text.strip() == "logged":
                seg.end_line = n
            return
        self.other += 1
        if len(self.other_samples) < OTHER_SAMPLES:
            self.other_samples.append({"line": n, "text": text[:400]})

    def flush(self) -> None:
        """Close an open traceback (call when the log has gone quiet)."""
        if self.tb is not None:
            self._tb_close()

    def progress_cursor(self) -> dict[int, int]:
        return {s.index: len(s.progress) for s in self.segments}

    def to_json(self, progress_from: dict[int, int] | None = None) -> Json:
        """The parsed log; ``progress_from`` skips progress lines a reader
        already holds (segment index -> count)."""
        since = progress_from or {}
        return {"lines": self.lines,
                "segments": [s.to_json(since.get(s.index, 0))
                             for s in self.segments],
                "warnings": [self.warnings[k] for k in self.warning_order],
                "crashes": self.crashes,
                "other": {"count": self.other,
                          "samples": self.other_samples},
                "final": self.final_lines,
                "openTraceback": self.tb is not None}


def parse_text(text: str) -> LogParser:
    """Parse a whole log at once (for files and tests)."""
    p = LogParser()
    for line in text.splitlines():
        p.feed(line)
    p.flush()
    return p
