"""Command line: serve a live sweep, or write a static pack.

    python3 -m tessera serve --results data/pocketA/results.jsonl \\
        --log pocketA_sweep.log --space pocketA_space.yaml \\
        --source pocket_a.py --run "pre-P0=data/pocketA/results_preP0.jsonl#0"

    python3 -m tessera serve --ssh root@s0 --results /srv/.../results.jsonl \\
        --log /srv/.../pocketA_sweep.log

    python3 -m tessera pack --results ... --log ... --out pocketA.pack.json.gz

``--results`` is the run the sweep is writing now; its rows belong to the
log's latest segment. ``--run LABEL=PATH#SEGMENT`` adds another results
file (an earlier run kept under another name) and the log segment its rows
came from.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import threading
import time
import webbrowser
from typing import Any

from . import __version__
from .follow import FileFollower, LineFn, ResetFn, SSHFollower, read_remote
from .server import serve
from .sweep import Run, Sweep

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(os.path.dirname(HERE), "dist", "tessera.html")
CONFIG_MARK = '<script id="tessera-config" type="application/json">'


def parse_run(spec: str) -> tuple[str, str, int | None]:
    if "=" not in spec:
        raise SystemExit("--run takes LABEL=PATH[#SEGMENT], got %r" % spec)
    label, rest = spec.split("=", 1)
    seg: int | None = None
    if "#" in rest:
        rest, s = rest.rsplit("#", 1)
        seg = int(s)
    return label, rest, seg


def default_name(path: str) -> str:
    parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
    return parent or os.path.splitext(os.path.basename(path))[0]


class Wiring:
    """Followers that feed a sweep."""

    def __init__(self, args: argparse.Namespace, follow: bool) -> None:
        self.args = args
        self.follow = follow
        self.sweep = Sweep(args.name or default_name(args.results))
        self.followers: list[FileFollower | SSHFollower] = []

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

    def _follower(self, path: str, on_line: LineFn,
                  on_reset: ResetFn) -> FileFollower | SSHFollower:
        if self.args.ssh:
            return SSHFollower(self.args.ssh, path, on_line, on_reset,
                               self.sweep.error)
        if not os.path.exists(path):
            raise SystemExit("no such file: %s" % path)
        return FileFollower(path, on_line, on_reset, self.sweep.error,
                            follow=self.follow)

    def add_run(self, run_id: str, label: str, path: str,
                segment: int | None, live: bool) -> None:
        run = Run(run_id, label, self.shown(path), segment, live)
        self.sweep.add_run(run)
        sweep = self.sweep
        self.followers.append(self._follower(
            path, lambda text, pre: sweep.run_line(run, text, pre),
            lambda reason: sweep.run_reset(run, reason)))

    def add_log(self, path: str) -> None:
        self.sweep.set_log(self.shown(path))
        sweep = self.sweep
        self.followers.append(self._follower(
            path, lambda text, pre: sweep.log_line(text, pre),
            lambda reason: sweep.log_reset(reason)))

    def add_doc(self, key: str, path: str) -> None:
        if self.args.ssh:
            text = read_remote(self.args.ssh, path)
        else:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        self.sweep.docs[key] = {"path": self.shown(path), "text": text}

    def build(self) -> Sweep:
        a = self.args
        for i, spec in enumerate(a.run or []):
            label, path, seg = parse_run(spec)
            self.add_run("r%d" % (i + 1), label, path, seg, False)
        self.add_run("r0", a.label or "current", a.results, None, True)
        if a.log:
            self.add_log(a.log)
        if a.space:
            self.add_doc("space", a.space)
        if a.source:
            self.add_doc("source", a.source)
        return self.sweep

    def read_once(self) -> None:
        """Read every file to its end (no threads)."""
        for f in self.followers:
            assert isinstance(f, FileFollower)
            while f.read_available():
                pass
        if self.sweep.log is not None:
            self.sweep.log_flush()

    def start(self) -> None:
        for f in self.followers:
            f.start()
        threading.Thread(target=self._flush_quiet_log, daemon=True).start()

    def _flush_quiet_log(self) -> None:
        last = -1
        while True:
            time.sleep(2.0)
            log = self.sweep.log
            if log is None:
                continue
            if log.lines == last:
                self.sweep.log_flush()
            last = log.lines


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
    print("tessera %s serving %s at %s" % (__version__, sweep.name, url),
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
    text, _ = sweep.pack_text()
    pack = json.loads(text)
    pack["mode"] = "recorded"
    data = json.dumps(pack, separators=(",", ":")).encode("utf-8")
    if a.out.endswith(".gz"):
        data = gzip.compress(data, 9)
    with open(a.out, "wb") as f:
        f.write(data)
    rows = sum(int(r["rows"]) for r in pack["runs"])
    print("wrote %s: %d runs, %d rows, %d bytes" % (
        a.out, len(pack["runs"]), rows, len(data)))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tessera",
                                 description="Monitor a parameter sweep.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("serve", "pack"):
        p = sub.add_parser(name)
        p.add_argument("--results", required=True,
                       help="results JSONL the sweep is writing now")
        p.add_argument("--label", help="name of the current run")
        p.add_argument("--log", help="the sweep's stdout log")
        p.add_argument("--space", help="the sweep space file (shown as is)")
        p.add_argument("--source", help="the sampler source (shown as is)")
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
