"""Follow a growing text file, locally or over SSH, line by line.

A follower calls ``on_line(text, preload)`` for every complete line and
``on_reset(reason)`` when the file starts over (it was truncated or
replaced, as a relaunched sweep does when it reopens its results file for
writing). ``preload`` is True for lines that were already in the file when
following began: they are history, and get no arrival time. An incomplete
last line waits until its newline arrives.

``FileFollower`` polls the local file. ``SSHFollower`` runs
``tail -c +1 -F <path>`` on the remote host, so nothing is installed there;
GNU tail reports truncation and replacement on stderr, and both become a
reset.
"""

from __future__ import annotations

import os
import subprocess
import threading
from typing import IO, Callable

LineFn = Callable[[str, bool], None]
ResetFn = Callable[[str], None]
ErrorFn = Callable[[str], None]
SSH_BASE = ("ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15")
CHUNK = 4 << 20


def _quote(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


class _LineBuffer:
    """Split a byte stream into lines, knowing each line's end offset."""

    def __init__(self, on_line: LineFn) -> None:
        self.on_line = on_line
        self.partial = b""
        self.offset = 0          # bytes consumed in this generation
        self.preload_end = 0     # lines ending at or before this are history

    def feed(self, chunk: bytes) -> None:
        data = self.partial + chunk
        start = self.offset - len(self.partial)
        lines = data.split(b"\n")
        self.partial = lines.pop()
        pos = start
        for raw in lines:
            pos += len(raw) + 1
            self.on_line(raw.decode("utf-8", errors="replace"),
                         pos <= self.preload_end)
        self.offset += len(chunk)

    def restart(self) -> None:
        self.partial = b""
        self.offset = 0
        self.preload_end = 0


class FileFollower:
    """Poll a local file for appended lines."""

    def __init__(self, path: str, on_line: LineFn, on_reset: ResetFn,
                 on_error: ErrorFn, interval: float = 0.5,
                 follow: bool = True) -> None:
        self.path = path
        self.buffer = _LineBuffer(on_line)
        self.on_reset = on_reset
        self.on_error = on_error
        self.interval = interval
        self.follow = follow
        self.pos = 0
        self.ino: int | None = None
        self.stopped = threading.Event()
        self.caught_up = threading.Event()   # the preloaded part is read

    def read_available(self) -> int:
        """Read everything appended since the last call; return bytes read."""
        st = os.stat(self.path)
        if self.ino is None:
            self.buffer.preload_end = st.st_size
        elif st.st_ino != self.ino or st.st_size < self.pos:
            reason = "replaced" if st.st_ino != self.ino else "truncated"
            self.pos = 0
            self.buffer.restart()
            self.on_reset(reason)
        self.ino = st.st_ino
        if st.st_size <= self.pos:
            return 0
        got = 0
        end = st.st_size
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            # in chunks, up to the size seen above: a large file is never
            # held in memory whole
            while self.pos < end:
                chunk = f.read(min(CHUNK, end - self.pos))
                if not chunk:
                    break
                self.pos += len(chunk)
                got += len(chunk)
                self.buffer.feed(chunk)
        return got

    def run(self) -> None:
        try:
            while not self.stopped.is_set():
                n = self.read_available()
                if n == 0 or self.buffer.offset >= self.buffer.preload_end:
                    self.caught_up.set()
                if n == 0:
                    if not self.follow:
                        return
                    self.stopped.wait(self.interval)
        except Exception as exc:  # surfaced to the page, then re-raised
            self.on_error("following %s: %s: %s" % (
                self.path, type(exc).__name__, exc))
            raise

    def start(self) -> None:
        threading.Thread(target=self.run, daemon=True,
                         name="follow:" + self.path).start()

    def stop(self) -> None:
        self.stopped.set()


class SSHFollower:
    """Follow a file on another host with ``ssh HOST tail -c +1 -F PATH``."""

    def __init__(self, host: str, path: str, on_line: LineFn,
                 on_reset: ResetFn, on_error: ErrorFn) -> None:
        self.host = host
        self.path = path
        self.buffer = _LineBuffer(on_line)
        self.on_reset = on_reset
        self.on_error = on_error
        self.proc: subprocess.Popen[bytes] | None = None
        self.stopped = threading.Event()
        self.caught_up = threading.Event()

    def command(self) -> list[str]:
        return [*SSH_BASE, "-C", self.host, "--", "tail", "-c", "+1", "-F",
                _quote(self.path)]

    def _stderr(self, stream: IO[bytes]) -> None:
        for raw in stream:
            text = raw.decode("utf-8", errors="replace").strip()
            if "file truncated" in text:
                self.buffer.restart()
                self.on_reset("truncated")
            elif "has been replaced" in text or "has appeared" in text:
                self.buffer.restart()
                self.on_reset("replaced")
            elif text:
                self.on_error("ssh %s: %s" % (self.host, text))

    def run(self) -> None:
        try:
            self.buffer.preload_end = remote_size(self.host, self.path)
            self.proc = subprocess.Popen(
                self.command(), stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
            assert self.proc.stdout is not None
            assert self.proc.stderr is not None
            threading.Thread(target=self._stderr, args=(self.proc.stderr,),
                             daemon=True).start()
            fd = self.proc.stdout.fileno()
            if self.buffer.preload_end == 0:
                self.caught_up.set()
            while not self.stopped.is_set():
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                self.buffer.feed(chunk)
                if self.buffer.offset >= self.buffer.preload_end:
                    self.caught_up.set()
            code = self.proc.wait()
            if not self.stopped.is_set():
                self.on_error("ssh %s exited with status %d while following "
                              "%s" % (self.host, code, self.path))
        except Exception as exc:
            self.on_error("following %s:%s: %s: %s" % (
                self.host, self.path, type(exc).__name__, exc))
            raise

    def start(self) -> None:
        threading.Thread(target=self.run, daemon=True,
                         name="ssh:" + self.path).start()

    def stop(self) -> None:
        self.stopped.set()
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()


def _ssh(host: str, *argv: str, timeout: float = 30.0) -> bytes:
    res = subprocess.run([*SSH_BASE, host, "--", *argv],
                         capture_output=True, timeout=timeout)
    if res.returncode != 0:
        raise RuntimeError("ssh %s %s failed (%d): %s" % (
            host, " ".join(argv), res.returncode,
            res.stderr.decode("utf-8", errors="replace").strip()))
    return res.stdout


def remote_size(host: str, path: str) -> int:
    return int(_ssh(host, "stat", "-c", "%s", _quote(path)).strip())


def read_remote(host: str, path: str) -> str:
    """Read a whole remote text file once (a Limen run's metadata)."""
    return _ssh(host, "cat", _quote(path)).decode("utf-8", errors="replace")
