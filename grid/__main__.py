"""Command line: serve a live sweep, or write a static pack.

    python3 -m grid serve --results data/pocketA/results.jsonl \\
        --log pocketA_sweep.log \\
        --run "pre-P0=data/pocketA/results_preP0.jsonl#0"

    python3 -m grid serve --ssh root@s0 --results /srv/.../results.jsonl \\
        --log /srv/.../pocketA_sweep.log

    python3 -m grid pack --results ... --log ... --out pocketA.pack.json.gz

    python3 -m grid serve --limen results/dev/lightgbm_binary_full_...

``--results`` is the run the sweep is writing now; its rows belong to the
latest segment of ``--log``. ``--limen`` takes a Limen result directory
instead: its results.csv is the run, and its metadata.json holds the
manifest that says which columns are parameters.

``--run`` adds another results file, either as ``LABEL=PATH#SEGMENT`` (an
earlier run of the same log, kept under another name, and the log segment
its rows came from) or as
``label=NAME,results=PATH[,log=PATH][,segment=N][,live=1]`` (a run with a
log of its own, such as a second sweep from the same sampler).
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import posixpath
import subprocess
import sys
import threading
import time
import webbrowser
from typing import Any

from . import __version__
from .follow import (
    FileFollower,
    HistoryFn,
    LineFn,
    ResetFn,
    SSHFollower,
    list_remote,
    read_remote,
    remote_mtimes,
)
from .limen import ROUND_LOG, experiment_name, manifest_copy, read_experiment
from .server import serve
from .sweep import Json, Run, Sweep

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(os.path.dirname(HERE), "dist", "grid.html")
CONFIG_MARK = '<script id="grid-config" type="application/json">'


RUN_KEYS = ("label", "results", "log", "segment", "live")


def parse_run(spec: str) -> dict[str, str]:
    """--run as LABEL=PATH[#SEGMENT] or label=..,results=..[,log=..]."""
    if spec.startswith("label=") and ",results=" in spec:
        out: dict[str, str] = {}
        for part in spec.split(","):
            k, _, v = part.partition("=")
            if k not in RUN_KEYS or not v:
                raise SystemExit("--run: unknown or empty key %r in %r"
                                 % (k, spec))
            out[k] = v
        return out
    if "=" not in spec:
        raise SystemExit("--run takes LABEL=PATH[#SEGMENT] or "
                         "label=..,results=..[,log=..], got %r" % spec)
    label, rest = spec.split("=", 1)
    out = {"label": label, "results": rest}
    if "#" in rest:
        out["results"], out["segment"] = rest.rsplit("#", 1)
    return out


def default_name(path: str) -> str:
    parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
    return parent or os.path.splitext(os.path.basename(path))[0]


class Wiring:
    """Followers that feed a sweep."""

    def __init__(self, args: argparse.Namespace, follow: bool) -> None:
        self.args = args
        self.follow = follow
        self.experiment: Json | None = None
        name = args.name
        if args.limen:
            self.experiment = self.read_experiment(args.limen)
            # where the run's directory is, for the command that replays a
            # round of it (Limen's Trainer reads the directory itself); a
            # local one in full, so that the command works from anywhere
            self.experiment["dir"] = (args.limen if args.ssh
                                      else os.path.abspath(args.limen))
            self.experiment["host"] = args.ssh or None
            name = name or experiment_name(self.experiment)
        self.sweep = Sweep(name or default_name(self.results_path()))
        self.followers: list[FileFollower | SSHFollower] = []

    def results_path(self) -> str:
        a = self.args
        if a.limen:
            join = posixpath.join if a.ssh else os.path.join
            return join(a.limen, "results.csv")
        return a.results

    def read_experiment(self, directory: str) -> Json:
        """A Limen result directory's experiment, from its metadata.json
        and the copy of its manifest."""
        a = self.args
        try:
            if a.ssh:
                meta = posixpath.join(directory, "metadata.json")
                name = manifest_copy(list_remote(a.ssh, directory),
                                     self.shown(directory))
                return read_experiment(
                    read_remote(a.ssh, meta), self.shown(meta), name,
                    read_remote(a.ssh, posixpath.join(directory, name)))
            meta = os.path.join(directory, "metadata.json")
            if not os.path.exists(meta):
                raise SystemExit("%s has no metadata.json: not a Limen "
                                 "result directory" % directory)
            name = manifest_copy(os.listdir(directory), directory)
            with open(meta, encoding="utf-8") as f:
                meta_text = f.read()
            with open(os.path.join(directory, name), encoding="utf-8") as f:
                return read_experiment(meta_text, meta, name, f.read())
        except ValueError as err:
            raise SystemExit(str(err)) from err

    def shown(self, path: str) -> str:
        """The path as the page names it (``--as`` rewrites a prefix, for
        files copied from the sweep's host)."""
        where = "%s:%s" % (self.args.ssh, path) if self.args.ssh else path
        specs: list[str] = self.args.as_ or []
        for spec in specs:
            local, _, shown = spec.partition("=")
            if not shown:
                raise SystemExit("--as takes LOCAL=SHOWN, got %r" % spec)
            if where.startswith(local):
                return shown + where[len(local):]
        return where

    def written_at(self, paths: list[str]) -> float | None:
        """When the latest of these files (those that exist) was last
        written, or None when that cannot be read: for the files a run
        writes beside the ones followed (whose followers say when they were
        last written, from the look that bounds their history)."""
        try:
            if self.args.ssh:
                times = remote_mtimes(self.args.ssh, paths)
            else:
                times = [os.stat(p).st_mtime for p in paths
                         if os.path.exists(p)]
        except (OSError, RuntimeError, subprocess.SubprocessError):
            return None
        return max(times) if times else None

    def _follower(self, path: str, on_line: LineFn, on_reset: ResetFn,
                  on_history: HistoryFn | None = None
                  ) -> FileFollower | SSHFollower:
        if self.args.ssh:
            return SSHFollower(self.args.ssh, path, on_line, on_reset,
                               self.sweep.error, on_history)
        if not os.path.exists(path):
            raise SystemExit("no such file: %s" % path)
        return FileFollower(path, on_line, on_reset, self.sweep.error,
                            follow=self.follow, on_history=on_history)

    def add_run(self, run_id: str, label: str, path: str,
                segment: int | None, live: bool,
                log_id: str | None, fmt: str = "jsonl",
                experiment: Json | None = None) -> Run:
        run = Run(run_id, label, self.shown(path), segment, live, log_id,
                  fmt, experiment)
        self.sweep.add_run(run)
        sweep = self.sweep
        self.followers.append(self._follower(
            path, lambda text, pre: sweep.run_line(run, text, pre),
            lambda reason: sweep.run_reset(run, reason),
            lambda mtime: sweep.run_written(run, mtime)))
        return run

    def add_round_log(self, run: Run, directory: str) -> None:
        """Follow a Limen run's round_data.jsonl, when its directory has
        one; the experiment says which (``roundLog``, or None)."""
        a = self.args
        assert run.experiment is not None
        names = (list_remote(a.ssh, directory) if a.ssh
                 else os.listdir(directory))
        if ROUND_LOG not in names:
            run.experiment["roundLog"] = None
            return
        join = posixpath.join if a.ssh else os.path.join
        path = join(directory, ROUND_LOG)
        run.experiment["roundLog"] = self.shown(path)
        sweep = self.sweep
        self.followers.append(self._follower(
            path, lambda text, pre: sweep.round_line(run, text, pre),
            lambda reason: sweep.round_reset(run, reason),
            lambda mtime: sweep.run_written(run, mtime)))

    def add_log(self, path: str) -> str:
        """Follow a log once, however many runs share it; its id."""
        for k, v in self.sweep.log_sources.items():
            if v == self.shown(path):
                return k
        log_id = "l%d" % len(self.sweep.logs)
        self.sweep.add_log(log_id, self.shown(path))
        sweep = self.sweep
        self.followers.append(self._follower(
            path, lambda text, pre: sweep.log_line(log_id, text, pre),
            lambda reason: sweep.log_reset(log_id, reason)))
        return log_id

    def build(self) -> Sweep:
        a = self.args
        main_log = self.add_log(a.log) if a.log else None
        for i, spec in enumerate(a.run or []):
            r = parse_run(spec)
            log_id = self.add_log(r["log"]) if "log" in r else main_log
            seg = int(r["segment"]) if "segment" in r else None
            live = r.get("live") == "1" or ("log" in r and "segment" not in r)
            self.add_run("r%d" % (i + 1), r["label"], r["results"], seg, live,
                         log_id)
        if a.limen:
            label = a.label or os.path.basename(a.limen.rstrip("/"))
            run = self.add_run("r0", label, self.results_path(), None, True,
                               main_log, "csv", self.experiment)
            self.add_round_log(run, a.limen)
            # the checkpoint and the feedback audit are written after some
            # rounds; the results file and the round log, followed, add
            # theirs as their followers first look at them
            join = posixpath.join if a.ssh else os.path.join
            extra = self.written_at([join(a.limen, n) for n in (
                "checkpoint.json", "audit.jsonl")])
            if extra is not None:
                self.sweep.run_written(run, extra)
        else:
            self.add_run("r0", a.label or "current", a.results, None, True,
                         main_log)
        return self.sweep

    def read_once(self) -> None:
        """Read every file to its end (no threads)."""
        for f in self.followers:
            assert isinstance(f, FileFollower)
            while f.read_available():
                pass
        self.sweep.log_flush()

    def start(self) -> None:
        for f in self.followers:
            f.start()
        threading.Thread(target=self._flush_quiet_log, daemon=True).start()

    def _flush_quiet_log(self) -> None:
        """A traceback at the end of a log closes once the log is quiet."""
        last: dict[str, int] = {}
        while True:
            time.sleep(2.0)
            now = {k: v.lines for k, v in self.sweep.logs.items()}
            if any(now[k] == last.get(k) and self.sweep.logs[k].tb
                   for k in now):
                self.sweep.log_flush()
            last = now


def page_bytes(config: dict[str, Any]) -> bytes:
    if not os.path.exists(PAGE):
        raise SystemExit("the page is not built: run python3 tools/build.py")
    with open(PAGE, encoding="utf-8") as f:
        html = f.read()
    return fill_config(html, config)


class LivePage:
    """The built page with the live config, read again when it changes."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.mtime = -1.0
        self.body = b""

    def __call__(self) -> bytes:
        mtime = os.path.getmtime(PAGE)
        if mtime != self.mtime:
            self.body = page_bytes(self.config)
            self.mtime = mtime
        return self.body


def fill_config(html: str, config: dict[str, Any]) -> bytes:
    if CONFIG_MARK not in html:
        raise SystemExit("%s has no %s block" % (PAGE, CONFIG_MARK))
    start = html.index(CONFIG_MARK) + len(CONFIG_MARK)
    end = html.index("</script>", start)
    text = json.dumps(config).replace("</", "<\\/")
    return (html[:start] + text + html[end:]).encode("utf-8")


def cmd_serve(a: argparse.Namespace) -> int:
    w = Wiring(a, follow=True)
    sweep = w.build()
    page = LivePage({"mode": "live", "pack": "api/pack",
                     "stream": "api/stream", "row": "api/row"})
    page()  # fail now, not on the first request, when the page is missing
    w.start()
    httpd = serve(sweep, page, a.bind, a.port)
    host, port = httpd.server_address[:2]
    url = "http://%s:%d/" % (host, port)
    print("grid %s serving %s at %s" % (__version__, sweep.name, url),
          flush=True)
    if a.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def cmd_pack(a: argparse.Namespace) -> int:
    if a.ssh:
        raise SystemExit("pack reads local files; copy them first or use "
                         "serve --ssh")
    w = Wiring(a, follow=False)
    sweep = w.build()
    w.read_once()
    parts, _ = sweep.pack_parts(mode="recorded")
    def opener(path: str) -> Any:
        if path.endswith(".gz"):
            return gzip.open(path, "wb", compresslevel=6)
        return open(path, "wb")

    with opener(a.out) as f:
        for part in parts:
            f.write(part.encode("utf-8"))
    rows = sum(r.store.rows for r in sweep.runs)
    print("wrote %s: %d runs, %d rows, %d bytes" % (
        a.out, len(sweep.runs), rows, os.path.getsize(a.out)))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="grid",
                                 description="Monitor a parameter sweep.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("serve", "pack"):
        p = sub.add_parser(name)
        source = p.add_mutually_exclusive_group(required=True)
        source.add_argument("--results",
                            help="results JSONL the sweep is writing now")
        source.add_argument("--limen", metavar="DIR",
                            help="a Limen result directory (results.csv "
                                 "and metadata.json)")
        p.add_argument("--label", help="name of the current run")
        p.add_argument("--log", help="the sweep's stdout log")
        p.add_argument("--run", action="append",
                       help="another results file: LABEL=PATH[#SEGMENT]")
        p.add_argument("--name", help="sweep name (default: results folder)")
        p.add_argument("--ssh", help="read the files on this host over ssh")
        p.add_argument("--as", dest="as_", action="append",
                       metavar="LOCAL=SHOWN",
                       help="name files under LOCAL as SHOWN (copied files)")
        if name == "serve":
            p.add_argument("--bind", default="127.0.0.1")
            p.add_argument("--port", type=int, default=0,
                           help="0 picks a free port")
            p.add_argument("--open", action="store_true",
                           help="open the page in a browser")
        else:
            p.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    return cmd_serve(a) if a.cmd == "serve" else cmd_pack(a)


if __name__ == "__main__":
    sys.exit(main())
